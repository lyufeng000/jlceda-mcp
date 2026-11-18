import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type VfsMode = "asar" | "directory";

interface AsarFileNode {
  size: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
}

interface AsarDirNode {
  files: Record<string, AsarNode>;
}

type AsarNode = AsarFileNode | AsarDirNode;

interface IndexedEntry {
  relPath: string;
  size: number;
  /** Offset from ASAR dataOffset (only in asar mode). */
  offset: number;
  unpacked: boolean;
  absPath?: string;
}

function isDirNode(node: AsarNode): node is AsarDirNode {
  return "files" in node && typeof node.files === "object" && node.files !== null;
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Dual-mode Read-Only Virtual File System (VFS) for JLCEDA Pro:
 * 1) Standard Electron `.asar` archive via Header Pickle parsing and byte-range slicing.
 * 2) Unpacked `resources/app/` directory via lazy on-demand streaming reads.
 *
 * Strictly read-only; reads are burned (zeroed) immediately after callback completion
 * via `withFileBuffer` / `withFileText` so no raw source stays cached in memory or on disk.
 */
export class AsarMemoryVfs {
  readonly mode: VfsMode;
  readonly sourcePath: string;
  private readonly entries = new Map<string, IndexedEntry>();
  private fd: number | null = null;
  private dataOffset = 0;
  private cachedSha256: string | null = null;
  private headerBytesForHash: Buffer | null = null;

  private constructor(mode: VfsMode, sourcePath: string) {
    this.mode = mode;
    this.sourcePath = sourcePath;
  }

  /**
   * Open an Electron `.asar` file or unpacked `resources/app` directory in read-only mode.
   */
  static open(sourcePath: string): AsarMemoryVfs {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`VFS source path does not exist: ${sourcePath}`);
    }
    const stat = fs.statSync(sourcePath);
    if (stat.isFile()) {
      const vfs = new AsarMemoryVfs("asar", sourcePath);
      vfs.loadAsarHeader();
      return vfs;
    }
    if (stat.isDirectory()) {
      const vfs = new AsarMemoryVfs("directory", sourcePath);
      vfs.scanDirectory();
      return vfs;
    }
    throw new Error(`Unsupported VFS source type at: ${sourcePath}`);
  }

  /**
   * Build a valid Electron ASAR binary buffer in memory (primarily for tests & fixtures).
   */
  static buildAsarBuffer(files: Record<string, Buffer | string>): Buffer {
    const root: AsarDirNode = { files: {} };
    const dataChunks: Buffer[] = [];
    let currentOffset = 0;

    const sortedPaths = Object.keys(files).sort();
    for (const rawPath of sortedPaths) {
      const norm = normalizeRelPath(rawPath);
      const parts = norm.split("/").filter(Boolean);
      const rawVal = files[rawPath];
      const buf = Buffer.isBuffer(rawVal) ? rawVal : Buffer.from(rawVal, "utf8");

      let dirCursor = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        const existing = dirCursor.files[seg];
        if (!existing || !isDirNode(existing)) {
          const nextDir: AsarDirNode = { files: {} };
          dirCursor.files[seg] = nextDir;
          dirCursor = nextDir;
        } else {
          dirCursor = existing;
        }
      }

      const fileName = parts[parts.length - 1];
      dirCursor.files[fileName] = {
        size: buf.length,
        offset: String(currentOffset),
      };
      dataChunks.push(buf);
      currentOffset += buf.length;
    }

    const jsonBuf = Buffer.from(JSON.stringify(root), "utf8");
    const paddedJsonLen = Math.ceil(jsonBuf.length / 4) * 4;
    const headerPayloadSize = 4 + paddedJsonLen;
    const headerTotalSize = 4 + headerPayloadSize;

    const sizePickle = Buffer.alloc(8);
    sizePickle.writeUInt32LE(4, 0);
    sizePickle.writeUInt32LE(headerTotalSize, 4);

    const headerPickle = Buffer.alloc(headerTotalSize, 0);
    headerPickle.writeUInt32LE(headerPayloadSize, 0);
    headerPickle.writeUInt32LE(jsonBuf.length, 4);
    jsonBuf.copy(headerPickle, 8);

    return Buffer.concat([sizePickle, headerPickle, ...dataChunks]);
  }

  private loadAsarHeader(): void {
    const fd = fs.openSync(this.sourcePath, "r");
    this.fd = fd;
    try {
      const sizeBuf = Buffer.allocUnsafe(8);
      const sizeBytesRead = fs.readSync(fd, sizeBuf, 0, 8, 0);
      if (sizeBytesRead < 8) {
        throw new Error(`Invalid ASAR file (too small): ${this.sourcePath}`);
      }

      const sizePicklePayloadLen = sizeBuf.readUInt32LE(0);
      if (sizePicklePayloadLen !== 4) {
        throw new Error(
          `Invalid ASAR size pickle payload length (${sizePicklePayloadLen}) in ${this.sourcePath}`
        );
      }

      const headerPickleTotalSize = sizeBuf.readUInt32LE(4);
      if (headerPickleTotalSize < 12 || headerPickleTotalSize > 128 * 1024 * 1024) {
        throw new Error(`Corrupt ASAR header size: ${headerPickleTotalSize}`);
      }

      const headerBuf = Buffer.allocUnsafe(headerPickleTotalSize);
      const headerRead = fs.readSync(fd, headerBuf, 0, headerPickleTotalSize, 8);
      if (headerRead < headerPickleTotalSize) {
        throw new Error(`Truncated ASAR header in ${this.sourcePath}`);
      }

      const headerJsonLen = headerBuf.readUInt32LE(4);
      if (8 + headerJsonLen > headerBuf.length) {
        throw new Error(`Invalid ASAR header JSON length (${headerJsonLen})`);
      }

      const jsonText = headerBuf.subarray(8, 8 + headerJsonLen).toString("utf8");
      const parsed = JSON.parse(jsonText) as AsarDirNode;
      this.dataOffset = 8 + headerPickleTotalSize;
      this.headerBytesForHash = Buffer.from(jsonText, "utf8");

      const walkTree = (node: AsarDirNode, prefix: string): void => {
        for (const [name, child] of Object.entries(node.files)) {
          const relPath = prefix ? `${prefix}/${name}` : name;
          if (isDirNode(child)) {
            walkTree(child, relPath);
          } else {
            const offsetNum = child.offset !== undefined ? Number(child.offset) : 0;
            this.entries.set(relPath, {
              relPath,
              size: Number(child.size ?? 0),
              offset: Number.isFinite(offsetNum) ? offsetNum : 0,
              unpacked: Boolean(child.unpacked),
            });
          }
        }
      };

      walkTree(parsed, "");
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private scanDirectory(): void {
    const skipDirNames = new Set(["node_modules", ".git", "cache", "logs"]);
    const walk = (absDir: string, relPrefix: string): void => {
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of dirEntries) {
        if (ent.isDirectory() && skipDirNames.has(ent.name)) {
          continue;
        }
        const absPath = path.join(absDir, ent.name);
        const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          walk(absPath, relPath);
        } else if (ent.isFile()) {
          const st = fs.statSync(absPath);
          this.entries.set(relPath, {
            relPath,
            size: st.size,
            offset: 0,
            unpacked: true,
            absPath,
          });
        }
      }
    };
    walk(this.sourcePath, "");
  }

  /**
   * List indexed virtual paths, optionally filtered by path prefix and/or file extensions.
   */
  listFiles(prefix?: string, extensions?: string[]): string[] {
    const normPrefix = prefix ? normalizeRelPath(prefix) : null;
    const extLower = extensions?.map((e) => e.toLowerCase()) ?? null;
    const out: string[] = [];

    for (const key of this.entries.keys()) {
      if (normPrefix && !key.startsWith(normPrefix)) {
        continue;
      }
      if (extLower && !extLower.some((ext) => key.toLowerCase().endsWith(ext))) {
        continue;
      }
      out.push(key);
    }

    return out.sort();
  }

  exists(relPath: string): boolean {
    return this.entries.has(normalizeRelPath(relPath));
  }

  stat(relPath: string): { size: number; isFile: boolean } | null {
    const entry = this.entries.get(normalizeRelPath(relPath));
    if (!entry) {
      return null;
    }
    return { size: entry.size, isFile: true };
  }

  /**
   * Read a virtual file as an ephemeral `Buffer`. Callers preferring automatic memory zeroing
   * should use `withFileBuffer` or `withFileText`.
   */
  readFileBuffer(relPath: string): Buffer {
    const norm = normalizeRelPath(relPath);
    const entry = this.entries.get(norm);
    if (!entry) {
      throw new Error(`Virtual file not found in VFS: ${norm}`);
    }

    if (this.mode === "directory") {
      if (!entry.absPath) {
        throw new Error(`Missing disk path for VFS entry: ${norm}`);
      }
      return fs.readFileSync(entry.absPath);
    }

    if (entry.unpacked) {
      const unpackedPath = path.join(`${this.sourcePath}.unpacked`, norm);
      if (fs.existsSync(unpackedPath)) {
        return fs.readFileSync(unpackedPath);
      }
    }

    if (this.fd === null) {
      throw new Error("ASAR VFS is closed.");
    }

    const buf = Buffer.allocUnsafe(entry.size);
    if (entry.size > 0) {
      const readPos = this.dataOffset + entry.offset;
      let totalRead = 0;
      while (totalRead < entry.size) {
        const chunk = fs.readSync(
          this.fd,
          buf,
          totalRead,
          entry.size - totalRead,
          readPos + totalRead
        );
        if (chunk <= 0) {
          throw new Error(`Unexpected EOF reading ${norm} from ASAR at offset ${readPos}`);
        }
        totalRead += chunk;
      }
    }
    return buf;
  }

  /**
   * Stream a virtual file buffer to `consumer` and zero-fill the temporary buffer immediately after.
   */
  withFileBuffer<T>(relPath: string, consumer: (buf: Buffer) => T): T {
    const buf = this.readFileBuffer(relPath);
    try {
      return consumer(buf);
    } finally {
      buf.fill(0);
    }
  }

  /**
   * Stream a virtual UTF-8 file to `consumer` and burn the underlying buffer immediately after.
   */
  withFileText<T>(relPath: string, consumer: (text: string) => T): T {
    return this.withFileBuffer(relPath, (buf) => consumer(buf.toString("utf8")));
  }

  readFileText(relPath: string): string {
    return this.withFileBuffer(relPath, (buf) => buf.toString("utf8"));
  }

  readFileJson<T = unknown>(relPath: string): T {
    return this.withFileText(relPath, (txt) => JSON.parse(txt) as T);
  }

  /**
   * Extract client version from `version.txt` or `package.json`.
   */
  getClientVersion(): string | null {
    if (this.exists("package.json")) {
      try {
        const pkg = this.readFileJson<{ version?: string }>("package.json");
        if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
          return pkg.version.trim();
        }
      } catch {
        // Fall through to version.txt
      }
    }
    if (this.exists("version.txt")) {
      try {
        const raw = this.readFileText("version.txt").trim();
        const firstToken = raw.split(/[,\s]+/)[0]?.trim();
        if (firstToken) {
          return firstToken;
        }
      } catch {
        // Ignore version.txt failure
      }
    }
    return null;
  }

  /**
   * Compute a deterministic SHA-256 fingerprint for the current client artifact:
   * - ASAR mode: SHA-256 of the ASAR header JSON tree (offsets, sizes, file hierarchy).
   * - Unpacked directory mode: SHA-256 over `version.txt`, `package.json`, `editor.ini`,
   *   and all sorted `extension.json` files.
   */
  getSha256(): string {
    if (this.cachedSha256) {
      return this.cachedSha256;
    }
    const hash = crypto.createHash("sha256");

    if (this.mode === "asar" && this.headerBytesForHash) {
      hash.update("asar-v1:");
      hash.update(this.headerBytesForHash);
      this.cachedSha256 = hash.digest("hex");
      return this.cachedSha256;
    }

    hash.update("dir-v1:");
    const manifestCandidates = this.listFiles().filter(
      (p) =>
        p === "version.txt" ||
        p === "package.json" ||
        p === "editor.ini" ||
        p.endsWith("/extension.json")
    );

    if (manifestCandidates.length > 0) {
      for (const rel of manifestCandidates) {
        hash.update(rel);
        hash.update("\0");
        this.withFileBuffer(rel, (buf) => {
          hash.update(buf);
        });
        hash.update("\0");
      }
    } else {
      for (const rel of this.listFiles()) {
        const st = this.entries.get(rel);
        hash.update(`${rel}:${st?.size ?? 0}\n`);
      }
    }

    this.cachedSha256 = hash.digest("hex");
    return this.cachedSha256;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Ignore close error.
      }
      this.fd = null;
    }
    if (this.headerBytesForHash) {
      this.headerBytesForHash.fill(0);
      this.headerBytesForHash = null;
    }
  }
}

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClientEnvironmentInfo,
  PathDiscoverySource,
  ReaCatalogStats,
  ResolvedClientPaths,
} from "../types/index.js";
import { loadEnvAndInfoConfig, type LoadConfigOptions } from "./info-config.js";
import { AsarMemoryVfs } from "../rea/asar-memory-vfs.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 3000;
const EXE_NAME = "lceda-pro.exe";

export interface PathProbeAdapters {
  /** L1: Query running `lceda-pro.exe` main process executable path. */
  probeRunningProcess?: (timeoutMs: number) => Promise<string | null>;
  /** L2a: Query Windows Uninstall registry keys. */
  probeRegistryUninstall?: (timeoutMs: number) => Promise<string | null>;
  /** L2b: Query Windows URL scheme / file association registry keys. */
  probeRegistryProtocol?: (timeoutMs: number) => Promise<string | null>;
  /** L3: Scan Start Menu and Desktop `.lnk` shortcuts. */
  probeShortcuts?: (timeoutMs: number) => Promise<string | null>;
  /** L4: Shallow disk scan across fixed drive candidate directories. */
  probeDefaultDiskLocations?: () => Promise<string | null>;
}

export interface ResolveClientOptions extends LoadConfigOptions {
  /** Watchdog timeout in milliseconds for external probes (clamped <= 3000ms). */
  timeoutMs?: number;
  /** Skip L1~L4 OS probes (useful for deterministic unit tests of L0 or offline fallback). */
  skipSystemProbes?: boolean;
  /** Optional probe overrides for testing individual L1~L4 stages. */
  probes?: PathProbeAdapters;
  /** Optional custom drive roots for L4 disk scan. */
  scanDrives?: string[];
}

interface ExecResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Execute an external binary with a hard watchdog timeout (`<= 3000 ms` by default)
 * so probing hung CIM/registry/COM processes can never deadlock MCP startup.
 */
export function execFileWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<ExecResult> {
  const effectiveTimeout = Math.max(200, Math.min(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS));
  return new Promise((resolve) => {
    let settled = false;
    const child = execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() || err.message,
            timedOut: false,
          });
          return;
        }
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          timedOut: false,
        });
      }
    );

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort process cleanup.
      }
      resolve({ stdout: "", stderr: "Watchdog timeout exceeded", timedOut: true });
    }, effectiveTimeout);
  });
}

/**
 * Validate whether `installDir` contains `lceda-pro.exe` AND either
 * `resources/app.asar` (packed mode) or `resources/app/package.json` (unpacked mode).
 */
export function isValidClientInstallDir(installDir: string | null | undefined): boolean {
  if (!installDir) {
    return false;
  }
  const exePath = path.join(installDir, EXE_NAME);
  if (!fs.existsSync(exePath)) {
    return false;
  }
  const asarPath = path.join(installDir, "resources", "app.asar");
  const unpackedPkgPath = path.join(installDir, "resources", "app", "package.json");
  return fs.existsSync(asarPath) || fs.existsSync(unpackedPkgPath);
}

/**
 * Extract a directory path from an executable path, quoted command line, or install location string.
 */
export function normalizeCandidateInstallDir(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  let cleaned = raw.trim();
  if (!cleaned) {
    return null;
  }

  const quotedExeMatch = cleaned.match(/"([^"]+\.exe)"/i);
  if (quotedExeMatch) {
    cleaned = quotedExeMatch[1];
  } else {
    const bareExeMatch = cleaned.match(/([A-Za-z]:\\[^"]*?\.exe)/i);
    if (bareExeMatch) {
      cleaned = bareExeMatch[1];
    }
  }

  cleaned = cleaned.replace(/^"+|"+$/g, "").trim();
  if (!cleaned) {
    return null;
  }

  if (/\.exe$/i.test(cleaned)) {
    return path.dirname(cleaned);
  }
  return cleaned.replace(/[\\/]+$/, "");
}

async function defaultProbeRunningProcess(timeoutMs: number): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'lceda-pro.exe'\"",
    "foreach ($p in $procs) {",
    "  if ($p.ExecutablePath -and ($p.CommandLine -notmatch '--type=')) {",
    "    Write-Output $p.ExecutablePath; break",
    "  }",
    "}",
  ].join("; ");

  const res = await execFileWithTimeout(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    timeoutMs
  );
  if (res.timedOut || !res.stdout.trim()) {
    return null;
  }
  const firstLine = res.stdout.trim().split(/\r?\n/)[0]?.trim();
  const dir = normalizeCandidateInstallDir(firstLine);
  return isValidClientInstallDir(dir) ? dir : null;
}

async function defaultProbeRegistryUninstall(timeoutMs: number): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }
  const uninstallRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const perCallTimeout = Math.min(timeoutMs, 1000);

  for (const root of uninstallRoots) {
    for (const term of ["lceda-pro", "嘉立创EDA"]) {
      const res = await execFileWithTimeout(
        "reg.exe",
        ["query", root, "/s", "/f", term],
        perCallTimeout
      );
      if (res.timedOut || !res.stdout) {
        continue;
      }
      for (const line of res.stdout.split(/\r?\n/)) {
        const match = line.match(
          /^\s*(?:InstallLocation|Inno Setup: App Path|DisplayIcon|UninstallString)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i
        );
        if (match) {
          const dir = normalizeCandidateInstallDir(match[1]);
          if (isValidClientInstallDir(dir)) {
            return dir;
          }
        }
      }
    }
  }
  return null;
}

async function defaultProbeRegistryProtocol(timeoutMs: number): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }
  const keys = [
    "HKCU\\Software\\Classes\\lceda-pro\\shell\\open\\command",
    "HKCR\\lceda-pro\\shell\\open\\command",
    "HKCU\\Software\\Classes\\easyeda-pro\\shell\\open\\command",
    "HKCR\\easyeda-pro\\shell\\open\\command",
    "HKCR\\LCEDA.Library.File\\shell\\open\\command",
    "HKCR\\LCEDA.Project.File\\shell\\open\\command",
  ];
  for (const regKey of keys) {
    const res = await execFileWithTimeout("reg.exe", ["query", regKey, "/ve"], Math.min(timeoutMs, 1000));
    if (res.timedOut || !res.stdout) {
      continue;
    }
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
      if (match) {
        const dir = normalizeCandidateInstallDir(match[1]);
        if (isValidClientInstallDir(dir)) {
          return dir;
        }
      }
    }
  }
  return null;
}

function collectCandidateShortcuts(dirs: string[], maxDepth: number = 2): string[] {
  const results: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || !fs.existsSync(dir)) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (
        ent.isFile() &&
        ent.name.toLowerCase().endsWith(".lnk") &&
        /(?:嘉立创EDA|LCEDA|EasyEDA)/i.test(ent.name) &&
        !/(?:卸载|uninstall)/i.test(ent.name)
      ) {
        results.push(fullPath);
      }
    }
  };

  for (const d of dirs) {
    visit(d, 0);
  }
  return results;
}

/**
 * Resolve `.lnk` TargetPath via PowerShell `WScript.Shell` with bounded timeout.
 */
export async function resolveShortcutTargetPath(
  lnkPath: string,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<string | null> {
  if (process.platform !== "win32" || !fs.existsSync(lnkPath)) {
    return null;
  }
  const escaped = lnkPath.replace(/'/g, "''");
  const psScript = `$sh = New-Object -ComObject WScript.Shell; $s = $sh.CreateShortcut('${escaped}'); Write-Output $s.TargetPath`;
  const res = await execFileWithTimeout(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    timeoutMs
  );
  if (res.timedOut || !res.stdout.trim()) {
    return null;
  }
  return res.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
}

async function defaultProbeShortcuts(timeoutMs: number): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }
  const env = process.env;
  const searchDirs = [
    env.APPDATA ? path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs") : "",
    env.ProgramData
      ? path.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")
      : "",
    path.join(os.homedir(), "Desktop"),
    env.PUBLIC ? path.join(env.PUBLIC, "Desktop") : "",
  ].filter(Boolean);

  const shortcuts = collectCandidateShortcuts(searchDirs);
  if (shortcuts.length === 0) {
    return null;
  }

  for (const lnk of shortcuts) {
    const target = await resolveShortcutTargetPath(lnk, timeoutMs);
    const dir = normalizeCandidateInstallDir(target);
    if (isValidClientInstallDir(dir)) {
      return dir;
    }
  }
  return null;
}

async function defaultProbeDefaultDiskLocations(scanDrives?: string[]): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "lceda-pro"));
  }
  const drives = scanDrives ?? ["C:", "D:", "E:", "F:"];
  const relCandidates = [
    "lceda-pro",
    path.join("Program Files", "lceda-pro"),
    path.join("Program Files", "Development Tools", "lceda-pro"),
    path.join("Program Files (x86)", "lceda-pro"),
    path.join("Software", "lceda-pro"),
    path.join("Development Tools", "lceda-pro"),
  ];
  for (const drive of drives) {
    const cleanDrive = drive.endsWith("\\") ? drive : `${drive}\\`;
    for (const rel of relCandidates) {
      candidates.push(path.join(cleanDrive, rel));
    }
  }
  for (const dir of candidates) {
    if (isValidClientInstallDir(dir)) {
      return dir;
    }
  }
  return null;
}

function readDataAndUserDirs(
  configuredDataDir: string | null,
  configuredLibDir: string | null,
  configuredProjectsDir: string | null,
  configuredUserDataDir: string | null
): {
  dataDir: string | null;
  libDir: string | null;
  projectsDir: string | null;
  userDataDir: string | null;
} {
  const home = os.homedir();
  const defaultDataDir = path.join(home, "Documents", "LCEDA-Pro");
  const dataDir =
    configuredDataDir ?? (fs.existsSync(defaultDataDir) ? defaultDataDir : null);

  let projectsDir = configuredProjectsDir;
  if (!projectsDir && dataDir) {
    const configJsonPath = path.join(dataDir, "config.json");
    if (fs.existsSync(configJsonPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configJsonPath, "utf8")) as {
          APP_PROJECT_DIR?: unknown;
        };
        if (Array.isArray(cfg.APP_PROJECT_DIR) && typeof cfg.APP_PROJECT_DIR[0] === "string") {
          projectsDir = cfg.APP_PROJECT_DIR[0];
        }
      } catch {
        // Ignore invalid user config.json
      }
    }
    if (!projectsDir && fs.existsSync(path.join(dataDir, "projects"))) {
      projectsDir = path.join(dataDir, "projects");
    }
  }

  let libDir = configuredLibDir;
  if (!libDir && dataDir && fs.existsSync(path.join(dataDir, "libraries"))) {
    libDir = path.join(dataDir, "libraries");
  }

  let userDataDir = configuredUserDataDir;
  if (!userDataDir) {
    const candidates = [
      process.env.APPDATA ? path.join(process.env.APPDATA, "lceda-pro") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "LCEDA-Pro") : "",
      dataDir ?? "",
    ].filter(Boolean);
    userDataDir = candidates.find((c) => fs.existsSync(c)) ?? null;
  }

  return { dataDir, libDir, projectsDir, userDataDir };
}

function detectSolverPath(
  configuredPath: string | null,
  candidates: string[]
): string | null {
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readExistingCatalogStats(
  indexDir: string,
  expectedSha256: string | null
): ReaCatalogStats {
  const empty: ReaCatalogStats = {
    totalApis: 0,
    l1Count: 0,
    l2Count: 0,
    l3Count: 0,
    l4Count: 0,
    degradedCapabilities: [],
    asarSha256: expectedSha256,
    indexPath: null,
    indexedAt: null,
  };

  const sqlitePath = path.join(indexDir, "api_catalog.sqlite");
  if (!fs.existsSync(sqlitePath)) {
    return empty;
  }

  try {
    // Dynamically use Node v26 built-in node:sqlite without top-level native side effects.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(sqlitePath, { open: true, readOnly: true });
    try {
      const rows = db
        .prepare("SELECT tier, COUNT(*) AS cnt FROM api_entries GROUP BY tier")
        .all() as Array<{ tier: string; cnt: number }>;
      const counts: Record<string, number> = {};
      let total = 0;
      for (const r of rows) {
        counts[r.tier] = Number(r.cnt);
        total += Number(r.cnt);
      }

      let indexedAt: string | null = null;
      let storedSha: string | null = expectedSha256;
      try {
        const metaRow = db
          .prepare("SELECT value FROM api_catalog_meta WHERE key = 'stats'")
          .get() as { value?: string } | undefined;
        if (metaRow?.value) {
          const parsed = JSON.parse(metaRow.value) as Partial<ReaCatalogStats>;
          indexedAt = parsed.indexedAt ?? null;
          if (!storedSha && parsed.asarSha256) {
            storedSha = parsed.asarSha256;
          }
        }
      } catch {
        // Ignore optional meta read failures.
      }

      let degradedCapabilities: string[] = [];
      if (storedSha) {
        const bindingsPath = path.join(indexDir, `adapter_bindings.${storedSha}.json`);
        if (fs.existsSync(bindingsPath)) {
          try {
            const bindingJson = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as {
              degradedCapabilities?: string[];
            };
            if (Array.isArray(bindingJson.degradedCapabilities)) {
              degradedCapabilities = bindingJson.degradedCapabilities;
            }
          } catch {
            // Ignore malformed binding json.
          }
        }
      }

      return {
        totalApis: total,
        l1Count: counts.L1_PUBLIC ?? 0,
        l2Count: counts.L2_COMMAND ?? 0,
        l3Count: counts.L3_ENGINE ?? 0,
        l4Count: counts.L4_IPC ?? 0,
        degradedCapabilities,
        asarSha256: storedSha,
        indexPath: sqlitePath,
        indexedAt,
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

/**
 * Five-level waterfall environment probe (L0 -> L4) resolving JLCEDA Pro client paths,
 * version signature, SHA-256 fingerprint, solver readiness, and REA catalog stats.
 * Gracefully degrades with `clientInstalled: false` when client is absent.
 */
export async function resolveClientEnvironment(
  options: ResolveClientOptions = {}
): Promise<ClientEnvironmentInfo> {
  const timeoutMs = Math.max(200, Math.min(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS));
  const cfg = loadEnvAndInfoConfig(options);
  const diagnostics = [...cfg.diagnostics];

  let resolvedInstallDir: string | null = null;
  let discoverySource: PathDiscoverySource = "UNRESOLVED";

  // L0: Explicit env / ~/information.json / workspace .jlceda-mcp.json
  const l0Candidates: Array<string | null> = [
    cfg.installDir,
    normalizeCandidateInstallDir(cfg.exePath),
    cfg.asarPath
      ? path.resolve(
          cfg.asarPath,
          path.basename(cfg.asarPath) === "app" ? "../.." : "../.."
        )
      : null,
  ];
  for (const cand of l0Candidates) {
    if (isValidClientInstallDir(cand)) {
      resolvedInstallDir = cand;
      discoverySource = cfg.explicitSource ?? "L0_INFO_JSON";
      break;
    }
  }

  // L1 -> L4 system probes (if not already resolved and probes not skipped)
  if (!resolvedInstallDir && !options.skipSystemProbes) {
    const probes = options.probes ?? {};

    // L1: Running Win32_Process
    const l1Dir = await (probes.probeRunningProcess ?? defaultProbeRunningProcess)(timeoutMs);
    if (isValidClientInstallDir(l1Dir)) {
      resolvedInstallDir = l1Dir;
      discoverySource = "L1_PROCESS";
    }

    // L2a: Registry Uninstall
    if (!resolvedInstallDir) {
      const l2UninstallDir = await (probes.probeRegistryUninstall ?? defaultProbeRegistryUninstall)(
        timeoutMs
      );
      if (isValidClientInstallDir(l2UninstallDir)) {
        resolvedInstallDir = l2UninstallDir;
        discoverySource = "L2_REGISTRY_UNINSTALL";
      }
    }

    // L2b: Registry Protocol / File Association
    if (!resolvedInstallDir) {
      const l2ProtocolDir = await (probes.probeRegistryProtocol ?? defaultProbeRegistryProtocol)(
        timeoutMs
      );
      if (isValidClientInstallDir(l2ProtocolDir)) {
        resolvedInstallDir = l2ProtocolDir;
        discoverySource = "L2_REGISTRY_PROTOCOL";
      }
    }

    // L3: Start Menu & Desktop Shortcuts (.lnk)
    if (!resolvedInstallDir) {
      const l3Dir = await (probes.probeShortcuts ?? defaultProbeShortcuts)(timeoutMs);
      if (isValidClientInstallDir(l3Dir)) {
        resolvedInstallDir = l3Dir;
        discoverySource = "L3_SHORTCUT";
      }
    }

    // L4: Fixed Drive Candidate Scan
    if (!resolvedInstallDir) {
      const l4Dir = probes.probeDefaultDiskLocations
        ? await probes.probeDefaultDiskLocations()
        : await defaultProbeDefaultDiskLocations(options.scanDrives);
      if (isValidClientInstallDir(l4Dir)) {
        resolvedInstallDir = l4Dir;
        discoverySource = "L4_DEFAULT_SCAN";
      }
    }
  }

  const clientInstalled = resolvedInstallDir !== null;
  let exePath: string | null = null;
  let asarPath: string | null = null;
  let unpackedDir: string | null = null;
  let builtinExtDir: string | null = null;
  let clientVersion: string | null = null;
  let asarSha256: string | null = null;

  if (resolvedInstallDir) {
    exePath = path.join(resolvedInstallDir, EXE_NAME);
    const packedAsar = path.join(resolvedInstallDir, "resources", "app.asar");
    const packedUnpacked = path.join(resolvedInstallDir, "resources", "app.asar.unpacked");
    const unpackedAppDir = path.join(resolvedInstallDir, "resources", "app");
    const extDir = path.join(resolvedInstallDir, "resources", "extensions");
    const unpackedAssetsDir = path.join(unpackedAppDir, "assets");

    if (fs.existsSync(packedAsar)) {
      asarPath = packedAsar;
      unpackedDir = fs.existsSync(packedUnpacked) ? packedUnpacked : null;
    } else if (fs.existsSync(path.join(unpackedAppDir, "package.json"))) {
      asarPath = unpackedAppDir;
      unpackedDir = unpackedAppDir;
    }

    builtinExtDir = fs.existsSync(extDir)
      ? extDir
      : fs.existsSync(unpackedAssetsDir)
        ? unpackedAssetsDir
        : null;

    if (asarPath) {
      try {
        const vfs = AsarMemoryVfs.open(asarPath);
        try {
          clientVersion = vfs.getClientVersion();
          asarSha256 = vfs.getSha256();
        } finally {
          vfs.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push(`Failed to inspect VFS metadata at ${asarPath}: ${msg}`);
      }
    }
  } else {
    diagnostics.push(
      "JLCEDA Pro desktop client not found via L0-L4 probes; running in offline/degraded mode."
    );
  }

  const { dataDir, libDir, projectsDir, userDataDir } = readDataAndUserDirs(
    cfg.dataDir,
    cfg.libDir,
    cfg.projectsDir,
    cfg.userDataDir
  );

  const paths: ResolvedClientPaths = {
    installDir: resolvedInstallDir,
    exePath,
    asarPath,
    unpackedDir,
    builtinExtDir,
    dataDir,
    libDir,
    projectsDir,
    userDataDir,
    headlessProfileDir: cfg.headlessProfileDir,
    cdpPort: cfg.cdpPort,
    indexDir: cfg.indexDir,
    tempDir: cfg.tempDir,
    freeroutingJarPath: detectSolverPath(cfg.freeroutingJarPath, [
      "D:\\Tools\\freerouting.jar",
      path.join(os.homedir(), "Tools", "freerouting.jar"),
    ]),
    ngspiceExePath: detectSolverPath(cfg.ngspiceExePath, [
      "C:\\Spice64\\bin\\ngspice_con.exe",
      "D:\\Tools\\ngspice\\bin\\ngspice_con.exe",
    ]),
  };

  const catalogStats = readExistingCatalogStats(cfg.indexDir, asarSha256);

  return {
    clientInstalled,
    discoverySource,
    clientVersion,
    asarSha256,
    paths,
    catalogStats,
    solvers: {
      freeroutingReady: paths.freeroutingJarPath !== null,
      freeroutingPath: paths.freeroutingJarPath,
      ngspiceReady: paths.ngspiceExePath !== null,
      ngspicePath: paths.ngspiceExePath,
    },
    unitSystem: {
      highLevel: "mm/deg",
      nativePcb: "mil",
    },
    degradedMode: !clientInstalled || catalogStats.degradedCapabilities.length > 0,
    diagnostics,
  };
}

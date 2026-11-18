import type {
  ArrayCursorPage,
  ObjectHandleInfo,
  PersistentRefPayload,
  TargetDocType,
} from "../types/index.js";

export const DEFAULT_EPHEMERAL_OBJECT_GROUP = "jlc-mcp-ephemeral";
export const DEFAULT_MAX_HANDLES = 2000;
export const ARRAY_PAGINATION_THRESHOLD = 200;
export const ARRAY_PREVIEW_LIMIT = 50;
export const DEFAULT_MAX_ARRAY_CURSORS = 256;

export class CdpHandleError extends Error {
  public readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "CdpHandleError";
    this.errorCode = errorCode;
  }
}

interface InternalHandleEntry {
  info: ObjectHandleInfo;
  targetId?: string;
  sessionId?: string;
  docUuid?: string;
  createdAt: number;
  lastAccessedAt: number;
}

interface InternalArrayCursorEntry<T = unknown> {
  handle: string;
  items: T[];
  createdAt: number;
}

export interface HandlePoolOptions {
  maxHandles?: number;
  maxArrayCursors?: number;
  defaultObjectGroup?: string;
  onEvict?: (evicted: ObjectHandleInfo) => void;
}

export interface CreatePersistentRefInput {
  projUuid: string;
  docUuid: string;
  docType: TargetDocType;
  primType: string;
  primId: string;
  naturalKey: PersistentRefPayload["naturalKey"];
  geomAnchorMm?: [number, number] | null;
  topologyHash?: string;
}

export interface PersistentRefCandidate {
  primId: string;
  primType: string;
  naturalKey: PersistentRefPayload["naturalKey"];
  geomAnchorMm?: [number, number] | null;
  topologyHash?: string;
  objectId?: string;
  summary?: Record<string, unknown>;
}

export interface ResolvePersistentRefOptions {
  base64: string;
  targetDocUuid: string;
  candidates: PersistentRefCandidate[];
  /** Optional handle registration helper when resolved */
  registerHandle?: boolean;
}

export interface ResolvePersistentRefResult {
  resolved: boolean;
  errorCode?: string;
  reason?: string;
  payload?: PersistentRefPayload;
  candidate?: PersistentRefCandidate;
  primitiveId?: string;
  handle?: string;
  handleInfo?: ObjectHandleInfo;
  reboundByNaturalKey: boolean;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Pure TypeScript IEEE 802.3 CRC32 checksum formatted as 8-char lowercase hex.
 */
export function computeCrc32Hex(input: string): string {
  const bytes = Buffer.from(input, "utf8");
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function canonicalizeNaturalKey(
  key: PersistentRefPayload["naturalKey"] | undefined | null
): PersistentRefPayload["naturalKey"] {
  return {
    designator: key?.designator ?? null,
    lcsc: key?.lcsc ?? null,
    padNumber: key?.padNumber ?? null,
    netName: key?.netName ?? null,
    pinNumber: key?.pinNumber ?? null,
  };
}

function canonicalPayloadBodyForCrc(
  payload: Omit<PersistentRefPayload, "crc">
): string {
  const normalized = {
    v: payload.v,
    projUuid: payload.projUuid,
    docUuid: payload.docUuid,
    docType: payload.docType,
    primType: payload.primType,
    primId: payload.primId,
    naturalKey: canonicalizeNaturalKey(payload.naturalKey),
    geomAnchorMm: payload.geomAnchorMm ?? null,
    topologyHash: payload.topologyHash ?? null,
  };
  return JSON.stringify(normalized);
}

function formatNaturalKeySummary(
  primType: string,
  primId: string,
  key: PersistentRefPayload["naturalKey"]
): string {
  const parts: string[] = [primType, `id=${primId}`];
  if (key.designator) parts.push(`designator=${key.designator}`);
  if (key.padNumber) parts.push(`pad=${key.padNumber}`);
  if (key.pinNumber) parts.push(`pin=${key.pinNumber}`);
  if (key.netName) parts.push(`net=${key.netName}`);
  if (key.lcsc) parts.push(`lcsc=${key.lcsc}`);
  return parts.join(" ");
}

const NATURAL_KEY_FIELDS: Array<keyof PersistentRefPayload["naturalKey"]> = [
  "designator",
  "lcsc",
  "padNumber",
  "netName",
  "pinNumber",
];

function hasNonEmptyNaturalKey(key: PersistentRefPayload["naturalKey"]): boolean {
  return NATURAL_KEY_FIELDS.some((field) => {
    const val = key[field];
    return typeof val === "string" && val.length > 0;
  });
}

function isNaturalKeyConflict(
  expected: PersistentRefPayload["naturalKey"],
  actual: PersistentRefPayload["naturalKey"]
): boolean {
  for (const field of NATURAL_KEY_FIELDS) {
    const expVal = expected[field];
    const actVal = actual[field];
    if (expVal !== null && expVal !== undefined && expVal !== "" &&
        actVal !== null && actVal !== undefined && actVal !== "" &&
        expVal !== actVal) {
      return true;
    }
  }
  return false;
}

function isNaturalKeyExactMatch(
  expected: PersistentRefPayload["naturalKey"],
  actual: PersistentRefPayload["naturalKey"]
): boolean {
  if (!hasNonEmptyNaturalKey(expected)) {
    return false;
  }
  for (const field of NATURAL_KEY_FIELDS) {
    const expVal = expected[field];
    if (expVal !== null && expVal !== undefined && expVal !== "") {
      if (actual[field] !== expVal) {
        return false;
      }
    }
  }
  return true;
}

export function encodePersistentReference(
  input: CreatePersistentRefInput
): {
  base64: string;
  payload: PersistentRefPayload;
  naturalKeySummary: string;
} {
  const normalizedNaturalKey = canonicalizeNaturalKey(input.naturalKey);
  const body: Omit<PersistentRefPayload, "crc"> = {
    v: 1,
    projUuid: input.projUuid,
    docUuid: input.docUuid,
    docType: input.docType,
    primType: input.primType,
    primId: input.primId,
    naturalKey: normalizedNaturalKey,
    geomAnchorMm: input.geomAnchorMm ?? null,
    ...(input.topologyHash !== undefined ? { topologyHash: input.topologyHash } : {}),
  };
  const crc = computeCrc32Hex(canonicalPayloadBodyForCrc(body));
  const payload: PersistentRefPayload = { ...body, crc };
  const base64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return {
    base64,
    payload,
    naturalKeySummary: formatNaturalKeySummary(
      input.primType,
      input.primId,
      normalizedNaturalKey
    ),
  };
}

export function decodeAndVerifyPersistentReference(base64: string): {
  valid: boolean;
  payload?: PersistentRefPayload;
  errorCode?: string;
  reason?: string;
} {
  if (!base64 || typeof base64 !== "string") {
    return {
      valid: false,
      errorCode: "ERR_REF_CORRUPT",
      reason: "Persistent reference token must be a non-empty Base64 string.",
    };
  }

  let decodedJson: unknown;
  try {
    const normalizedB64 = base64.trim().replace(/-/g, "+").replace(/_/g, "/");
    const jsonText = Buffer.from(normalizedB64, "base64").toString("utf8");
    decodedJson = JSON.parse(jsonText);
  } catch {
    return {
      valid: false,
      errorCode: "ERR_REF_CORRUPT",
      reason: "Persistent reference token is not valid Base64/JSON.",
    };
  }

  if (typeof decodedJson !== "object" || decodedJson === null || Array.isArray(decodedJson)) {
    return {
      valid: false,
      errorCode: "ERR_REF_CORRUPT",
      reason: "Persistent reference payload is not an object.",
    };
  }

  const p = decodedJson as Partial<PersistentRefPayload>;
  if (
    p.v !== 1 ||
    typeof p.projUuid !== "string" ||
    typeof p.docUuid !== "string" ||
    typeof p.docType !== "string" ||
    typeof p.primType !== "string" ||
    typeof p.primId !== "string" ||
    typeof p.crc !== "string" ||
    typeof p.naturalKey !== "object" ||
    p.naturalKey === null
  ) {
    return {
      valid: false,
      errorCode: "ERR_REF_CORRUPT",
      reason: "Persistent reference payload is missing required fields.",
    };
  }

  const expectedCrc = computeCrc32Hex(
    canonicalPayloadBodyForCrc({
      v: 1,
      projUuid: p.projUuid,
      docUuid: p.docUuid,
      docType: p.docType,
      primType: p.primType,
      primId: p.primId,
      naturalKey: p.naturalKey,
      geomAnchorMm: p.geomAnchorMm ?? null,
      topologyHash: p.topologyHash,
    })
  );

  if (expectedCrc !== p.crc.toLowerCase()) {
    return {
      valid: false,
      errorCode: "ERR_REF_CORRUPT",
      reason: `CRC32 checksum mismatch (expected ${expectedCrc}, got ${p.crc}).`,
    };
  }

  return {
    valid: true,
    payload: p as PersistentRefPayload,
  };
}

/**
 * Dual-layer handle pool managing:
 * 1) Ephemeral `jlc_obj:<seq>` LRU handles (default max 2000, `jlc-mcp-ephemeral` group)
 * 2) Paginated array cursors `jlc_arr:<cursorId>` for arrays > 200 items
 * 3) CRC32-signed Base64 persistent entity references with strict `ERR_REF_STALE` enforcement
 */
export class HandlePool {
  private readonly maxHandles: number;
  private readonly maxArrayCursors: number;
  private readonly defaultObjectGroup: string;
  private readonly onEvict?: (evicted: ObjectHandleInfo) => void;

  private readonly handles = new Map<string, InternalHandleEntry>();
  private readonly arrayCursors = new Map<string, InternalArrayCursorEntry>();

  private handleSeq = 0;
  private cursorSeq = 0;

  constructor(options: HandlePoolOptions = {}) {
    this.maxHandles = Math.max(1, options.maxHandles ?? DEFAULT_MAX_HANDLES);
    this.maxArrayCursors = Math.max(
      1,
      options.maxArrayCursors ?? DEFAULT_MAX_ARRAY_CURSORS
    );
    this.defaultObjectGroup =
      options.defaultObjectGroup ?? DEFAULT_EPHEMERAL_OBJECT_GROUP;
    this.onEvict = options.onEvict;
  }

  public registerHandle(
    info: Omit<ObjectHandleInfo, "handle"> & {
      handle?: string;
      targetId?: string;
      sessionId?: string;
      docUuid?: string;
    }
  ): ObjectHandleInfo {
    const handle = info.handle ?? `jlc_obj:${++this.handleSeq}`;
    const objectGroup = info.objectGroup ?? this.defaultObjectGroup;
    const now = Date.now();

    const storedInfo: ObjectHandleInfo = {
      handle,
      ...(info.objectId !== undefined ? { objectId: info.objectId } : {}),
      objectGroup,
      ...(info.primitiveId !== undefined ? { primitiveId: info.primitiveId } : {}),
      type: info.type,
      ...(info.designator !== undefined ? { designator: info.designator } : {}),
      ...(info.net !== undefined ? { net: info.net } : {}),
      ...(info.layer !== undefined ? { layer: info.layer } : {}),
      ...(info.centerMm !== undefined ? { centerMm: info.centerMm } : {}),
      ...(info.bboxMm !== undefined ? { bboxMm: info.bboxMm } : {}),
      ...(info.summary !== undefined ? { summary: info.summary } : {}),
    };

    if (this.handles.has(handle)) {
      this.handles.delete(handle);
    } else {
      while (this.handles.size >= this.maxHandles) {
        const oldestKey = this.handles.keys().next().value;
        if (oldestKey === undefined) break;
        const evicted = this.handles.get(oldestKey);
        this.handles.delete(oldestKey);
        if (evicted) {
          this.onEvict?.(evicted.info);
        }
      }
    }

    this.handles.set(handle, {
      info: storedInfo,
      targetId: info.targetId,
      sessionId: info.sessionId,
      docUuid: info.docUuid,
      createdAt: now,
      lastAccessedAt: now,
    });

    return storedInfo;
  }

  public getHandle(handle: string): ObjectHandleInfo | undefined {
    const entry = this.handles.get(handle);
    if (!entry) {
      return undefined;
    }
    // Refresh LRU order (delete + re-insert moves to most-recently-used tail)
    this.handles.delete(handle);
    entry.lastAccessedAt = Date.now();
    this.handles.set(handle, entry);
    return entry.info;
  }

  public requireHandle(handle: string): ObjectHandleInfo {
    const found = this.getHandle(handle);
    if (!found) {
      throw new CdpHandleError(
        "ERR_HANDLE_NOT_FOUND",
        `Ephemeral object handle '${handle}' does not exist or has been evicted/released.`
      );
    }
    return found;
  }

  public hasHandle(handle: string): boolean {
    return this.handles.has(handle);
  }

  public removeHandle(handle: string): boolean {
    return this.handles.delete(handle);
  }

  public resolveObjectId(handle: string): string | undefined {
    return this.getHandle(handle)?.objectId;
  }

  public getHandleBinding(handle: string): {
    info: ObjectHandleInfo;
    targetId?: string;
    sessionId?: string;
    docUuid?: string;
  } | undefined {
    const entry = this.handles.get(handle);
    if (!entry) {
      return undefined;
    }
    this.handles.delete(handle);
    entry.lastAccessedAt = Date.now();
    this.handles.set(handle, entry);
    return {
      info: entry.info,
      targetId: entry.targetId,
      sessionId: entry.sessionId,
      docUuid: entry.docUuid,
    };
  }

  /**
   * Release all handles belonging to `objectGroup` (defaults to `jlc-mcp-ephemeral`)
   * and optionally notify CDP `Runtime.releaseObjectGroup`.
   */
  public async releaseObjectGroup(
    objectGroup = this.defaultObjectGroup,
    cdpReleaseFn?: (group: string) => Promise<void>
  ): Promise<number> {
    let removed = 0;
    for (const [handle, entry] of this.handles.entries()) {
      if ((entry.info.objectGroup ?? this.defaultObjectGroup) === objectGroup) {
        this.handles.delete(handle);
        removed++;
      }
    }
    if (cdpReleaseFn) {
      await cdpReleaseFn(objectGroup);
    }
    return removed;
  }

  /**
   * Automatically slice arrays larger than `threshold` (default 200) and return
   * a 50-item preview plus a `jlc_arr:<cursorId>` pagination cursor.
   */
  public paginateArray<T>(
    items: T[],
    options: { threshold?: number; previewLimit?: number } = {}
  ): {
    paginated: boolean;
    totalCount: number;
    items: T[];
    arrayCursor?: ArrayCursorPage<T>;
  } {
    const threshold = options.threshold ?? ARRAY_PAGINATION_THRESHOLD;
    const previewLimit = Math.max(1, options.previewLimit ?? ARRAY_PREVIEW_LIMIT);
    const totalCount = items.length;

    if (totalCount <= threshold) {
      return {
        paginated: false,
        totalCount,
        items,
      };
    }

    const handle = `jlc_arr:${++this.cursorSeq}`;
    while (this.arrayCursors.size >= this.maxArrayCursors) {
      const oldestKey = this.arrayCursors.keys().next().value;
      if (oldestKey === undefined) break;
      this.arrayCursors.delete(oldestKey);
    }
    this.arrayCursors.set(handle, {
      handle,
      items: items.slice(),
      createdAt: Date.now(),
    });

    const preview = items.slice(0, previewLimit);
    return {
      paginated: true,
      totalCount,
      items: preview,
      arrayCursor: {
        handle,
        totalCount,
        offset: 0,
        limit: previewLimit,
        hasMore: preview.length < totalCount,
        items: preview,
      },
    };
  }

  public readArrayCursor<T = unknown>(
    handle: string,
    offset = 0,
    limit = 100
  ): ArrayCursorPage<T> {
    const entry = this.arrayCursors.get(handle);
    if (!entry) {
      throw new CdpHandleError(
        "ERR_CURSOR_NOT_FOUND",
        `Array pagination cursor '${handle}' does not exist or has expired.`
      );
    }
    // Refresh cursor LRU position
    this.arrayCursors.delete(handle);
    this.arrayCursors.set(handle, entry);

    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    const totalCount = entry.items.length;
    const slice = entry.items.slice(safeOffset, safeOffset + safeLimit) as T[];

    return {
      handle,
      totalCount,
      offset: safeOffset,
      limit: safeLimit,
      hasMore: safeOffset + slice.length < totalCount,
      items: slice,
    };
  }

  public releaseArrayCursor(handle: string): boolean {
    return this.arrayCursors.delete(handle);
  }

  public createPersistentReference(input: CreatePersistentRefInput): {
    base64: string;
    payload: PersistentRefPayload;
    naturalKeySummary: string;
  } {
    return encodePersistentReference(input);
  }

  public resolvePersistentReference(
    options: ResolvePersistentRefOptions
  ): ResolvePersistentRefResult {
    const verified = decodeAndVerifyPersistentReference(options.base64);
    if (!verified.valid || !verified.payload) {
      return {
        resolved: false,
        errorCode: verified.errorCode ?? "ERR_REF_CORRUPT",
        reason: verified.reason ?? "Invalid persistent reference.",
        reboundByNaturalKey: false,
      };
    }

    const payload = verified.payload;
    if (options.targetDocUuid && payload.docUuid !== options.targetDocUuid) {
      return {
        resolved: false,
        errorCode: "ERR_REF_STALE",
        reason: `Document UUID mismatch: reference targets '${payload.docUuid}', active document is '${options.targetDocUuid}'.`,
        payload,
        reboundByNaturalKey: false,
      };
    }

    const directMatch = options.candidates.find(
      (c) => c.primId === payload.primId && c.primType === payload.primType
    );

    if (
      directMatch &&
      !isNaturalKeyConflict(payload.naturalKey, directMatch.naturalKey)
    ) {
      let handleInfo: ObjectHandleInfo | undefined;
      if (options.registerHandle !== false) {
        handleInfo = this.registerHandle({
          objectId: directMatch.objectId,
          primitiveId: directMatch.primId,
          type: directMatch.primType,
          designator: directMatch.naturalKey.designator ?? null,
          net: directMatch.naturalKey.netName ?? null,
          centerMm: directMatch.geomAnchorMm ?? null,
          summary: directMatch.summary,
          docUuid: payload.docUuid,
        });
      }
      return {
        resolved: true,
        payload,
        candidate: directMatch,
        primitiveId: directMatch.primId,
        handle: handleInfo?.handle,
        handleInfo,
        reboundByNaturalKey: false,
      };
    }

    // Fallback: unique rebind by naturalKey (e.g. after schematic-to-PCB ID renumbering)
    const naturalMatches = options.candidates.filter(
      (c) =>
        c.primType === payload.primType &&
        isNaturalKeyExactMatch(payload.naturalKey, c.naturalKey)
    );

    if (naturalMatches.length === 1) {
      const rebound = naturalMatches[0];
      let handleInfo: ObjectHandleInfo | undefined;
      if (options.registerHandle !== false) {
        handleInfo = this.registerHandle({
          objectId: rebound.objectId,
          primitiveId: rebound.primId,
          type: rebound.primType,
          designator: rebound.naturalKey.designator ?? null,
          net: rebound.naturalKey.netName ?? null,
          centerMm: rebound.geomAnchorMm ?? null,
          summary: rebound.summary,
          docUuid: payload.docUuid,
        });
      }
      return {
        resolved: true,
        payload,
        candidate: rebound,
        primitiveId: rebound.primId,
        handle: handleInfo?.handle,
        handleInfo,
        reboundByNaturalKey: true,
      };
    }

    if (naturalMatches.length > 1) {
      return {
        resolved: false,
        errorCode: "ERR_REF_STALE",
        reason: `ERR_REF_STALE: Ambiguous rebind for '${formatNaturalKeySummary(
          payload.primType,
          payload.primId,
          payload.naturalKey
        )}' (${naturalMatches.length} candidates matched); refusing to guess.`,
        payload,
        reboundByNaturalKey: false,
      };
    }

    return {
      resolved: false,
      errorCode: "ERR_REF_STALE",
      reason: `ERR_REF_STALE: Primitive '${payload.primId}' (${payload.primType}) was deleted or changed and no unique naturalKey match exists.`,
      payload,
      reboundByNaturalKey: false,
    };
  }

  public clear(): void {
    this.handles.clear();
    this.arrayCursors.clear();
  }

  public stats(): {
    handleCount: number;
    maxHandles: number;
    arrayCursorCount: number;
    maxArrayCursors: number;
  } {
    return {
      handleCount: this.handles.size,
      maxHandles: this.maxHandles,
      arrayCursorCount: this.arrayCursors.size,
      maxArrayCursors: this.maxArrayCursors,
    };
  }
}

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  ArrayCursorPage,
  CdpCallFunctionOptions,
  CdpEvaluateOptions,
  ICdpRpcExecutor,
  ObjectHandleInfo,
  ReaParameterSpec,
  ReaUnitContract,
  TargetDocType,
  UnitMode,
} from "../types/index.js";
import {
  DEFAULT_EPHEMERAL_OBJECT_GROUP,
  HandlePool,
} from "./handle-pool.js";
import {
  CanvasTransactionGuard,
  CdpTransactionError,
  type TransactionTargetBinding,
} from "./transaction-guard.js";
import {
  convertParamsToNative,
  convertResultFromNative,
  isPlainObject,
  isRefToken,
  resolveSpecialTokens,
  type LengthUnit,
} from "./unit-converter.js";

export const DEFAULT_RPC_SOFT_TIMEOUT_MS = 15_000;
export const DEFAULT_RPC_HARD_TERMINATE_GRACE_MS = 3_000;

export class CdpRpcError extends Error {
  public readonly errorCode: string;
  public readonly rolledBack: boolean;
  public readonly hardTerminated: boolean;
  public readonly details?: unknown;

  constructor(
    errorCode: string,
    message: string,
    options: {
      rolledBack?: boolean;
      hardTerminated?: boolean;
      details?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "CdpRpcError";
    this.errorCode = errorCode;
    this.rolledBack = options.rolledBack ?? false;
    this.hardTerminated = options.hardTerminated ?? false;
    this.details = options.details;
  }
}

export interface CdpProtocolCallArg {
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
}

export interface CdpRemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
}

export interface CdpExceptionDetails {
  exceptionId?: number;
  text: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: CdpRemoteObject;
}

export interface CdpRuntimeEvalResult {
  result: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}

export interface CdpProtocolTransport {
  isOpen(): boolean;
  sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>;
  onEvent(listener: (event: CdpProtocolEvent) => void): () => void;
  close(): Promise<void>;
}

export interface CdpProtocolEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface PendingRequest {
  method: string;
  sessionId?: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Native WebSocket CDP JSON-RPC transport using `ws` (no `--remote-allow-origins` required).
 * Supports both root connection commands and Flat Session multiplexed `sessionId` commands.
 */
export class WebSocketCdpTransport implements CdpProtocolTransport {
  private readonly ws: WebSocket;
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      const err = new CdpRpcError(
        "ERR_CDP_DISCONNECTED",
        `CDP WebSocket closed (code=${code}, reason=${reason.toString("utf8") || "none"})`
      );
      for (const req of this.pending.values()) {
        req.reject(err);
      }
      this.pending.clear();
      this.emitter.emit("disconnected", { code, reason: reason.toString("utf8") });
    });
    this.ws.on("error", (err) => {
      this.emitter.emit("transportError", err);
    });
  }

  public static async connect(
    wsUrl: string,
    connectTimeoutMs = 5000
  ): Promise<WebSocketCdpTransport> {
    return new Promise<WebSocketCdpTransport>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        perMessageDeflate: false,
        handshakeTimeout: connectTimeoutMs,
      });

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          // Ignore terminate error
        }
        reject(
          new CdpRpcError(
            "ERR_CDP_CONNECT_TIMEOUT",
            `Timed out connecting to CDP WebSocket '${wsUrl}' after ${connectTimeoutMs}ms.`
          )
        );
      }, connectTimeoutMs);

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new WebSocketCdpTransport(ws));
      });

      ws.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new CdpRpcError(
            "ERR_CDP_CONNECT_FAILED",
            `Failed connecting to CDP WebSocket '${wsUrl}': ${err.message}`,
            { details: err }
          )
        );
      });
    });
  }

  public isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  public sendCommand<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (!this.isOpen()) {
      return Promise.reject(
        new CdpRpcError(
          "ERR_CDP_DISCONNECTED",
          `Cannot send CDP command '${method}': WebSocket is not open.`
        )
      );
    }

    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) {
      frame.sessionId = sessionId;
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        sessionId,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify(frame), (sendErr) => {
        if (sendErr) {
          this.pending.delete(id);
          reject(
            new CdpRpcError(
              "ERR_CDP_SEND_FAILED",
              `Failed sending CDP command '${method}': ${sendErr.message}`,
              { details: sendErr }
            )
          );
        }
      });
    });
  }

  public onEvent(listener: (event: CdpProtocolEvent) => void): () => void {
    this.emitter.on("cdpEvent", listener);
    return () => {
      this.emitter.off("cdpEvent", listener);
    };
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.ws.terminate();
        } catch {
          // Ignore
        }
        resolve();
      }, 800);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.ws.close();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    try {
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString("utf8");
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const req = this.pending.get(msg.id);
      if (!req) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        req.reject(
          new CdpRpcError(
            "ERR_CDP_PROTOCOL_ERROR",
            msg.error.message ?? `CDP protocol error on '${req.method}'`,
            { details: msg.error }
          )
        );
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      this.emitter.emit("cdpEvent", {
        method: msg.method,
        params: msg.params,
        sessionId: msg.sessionId,
      } satisfies CdpProtocolEvent);
    }
  }
}

export interface TargetSessionResolution extends TransactionTargetBinding {
  docType?: TargetDocType;
  docUuid?: string | null;
}

export interface CdpRpcExecutorOptions {
  transport: CdpProtocolTransport;
  handlePool?: HandlePool;
  softTimeoutMs?: number;
  hardTerminateGraceMs?: number;
  resolveSession?: (
    document?: string | null
  ) => Promise<TargetSessionResolution>;
}

const FN_DISPATCH_EDA_API = `async function(spec) {
  var g = globalThis;
  var refObjects = Array.prototype.slice.call(arguments, 1);

  function hydrate(node) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) {
      return node.map(hydrate);
    }
    if (typeof node === "object") {
      if (typeof node.__jlcRefSlot === "number") {
        return refObjects[node.__jlcRefSlot];
      }
      if (typeof node.__jlcEnum === "string") {
        var cleaned = node.__jlcEnum.replace(/^(?:window\\.|globalThis\\.|eda\\.)/, "");
        var segs = cleaned.split(".");
        var cur = g[segs[0]] || (g.eda && g.eda[segs[0]]);
        for (var i = 1; i < segs.length && cur !== undefined && cur !== null; i++) {
          cur = cur[segs[i]];
        }
        return cur;
      }
      var copy = {};
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        copy[key] = hydrate(node[key]);
      }
      return copy;
    }
    return node;
  }

  var timeoutMs = (spec && typeof spec.timeoutMs === "number") ? spec.timeoutMs : 15000;
  var op = (spec && spec.operation) ? spec.operation : "call";
  var apiPath = (spec && spec.apiPath) ? String(spec.apiPath) : "";
  var args = hydrate((spec && Array.isArray(spec.args)) ? spec.args : []);

  var rootTarget = (this && this !== g) ? this : null;
  var targetObj = rootTarget;
  var propName = "";

  if (apiPath) {
    var pathStr = apiPath.replace(/^(?:window\\.|globalThis\\.)/, "");
    var parts = pathStr.split(".").filter(Boolean);
    if (!targetObj) {
      if (parts[0] === "eda") {
        targetObj = g.eda;
        parts = parts.slice(1);
      } else if (g.eda && Object.prototype.hasOwnProperty.call(g.eda, parts[0])) {
        targetObj = g.eda;
      } else {
        targetObj = g;
      }
    }
    for (var p = 0; p < parts.length - 1; p++) {
      if (targetObj === undefined || targetObj === null) {
        break;
      }
      targetObj = targetObj[parts[p]];
    }
    propName = parts.length > 0 ? parts[parts.length - 1] : "";
  }

  if (targetObj === undefined || targetObj === null) {
    return {
      __jlcDispatchError: {
        errorCode: "ERR_API_NOT_FOUND",
        message: "Target namespace not found for API path '" + apiPath + "'."
      }
    };
  }

  var ac = typeof AbortController === "function" ? new AbortController() : null;
  var timerId = null;

  var execPromise = (async function() {
    if (op === "get") {
      return propName ? targetObj[propName] : targetObj;
    }
    if (op === "set") {
      if (!propName) {
        return {
          __jlcDispatchError: {
            errorCode: "ERR_INVALID_OPERATION",
            message: "Property name required for 'set' operation."
          }
        };
      }
      targetObj[propName] = args[0];
      return true;
    }
    var fn = propName ? targetObj[propName] : targetObj;
    if (typeof fn !== "function") {
      return {
        __jlcDispatchError: {
          errorCode: "ERR_API_NOT_FOUND",
          message: "Callable method not found at '" + apiPath + "'."
        }
      };
    }
    return await fn.apply(targetObj, args);
  })();

  var timeoutPromise = new Promise(function(resolve) {
    timerId = setTimeout(function() {
      if (ac) {
        try { ac.abort(); } catch (e) {}
      }
      resolve({
        __jlcAsyncTimeout: true,
        timeoutMs: timeoutMs
      });
    }, timeoutMs);
  });

  try {
    var out = await Promise.race([execPromise, timeoutPromise]);
    if (timerId !== null) clearTimeout(timerId);
    return out;
  } catch (err) {
    if (timerId !== null) clearTimeout(timerId);
    return {
      __jlcDispatchError: {
        errorCode: (err && err.errorCode) ? String(err.errorCode) : "ERR_EDA_API_THREW",
        message: (err && err.message) ? String(err.message) : String(err)
      }
    };
  }
}`;

function extractRefSlots(
  input: unknown,
  handlePool: HandlePool,
  slotObjectIds: string[]
): unknown {
  if (isRefToken(input)) {
    const objectId = handlePool.resolveObjectId(input.$ref.trim());
    if (!objectId) {
      throw new CdpRpcError(
        "ERR_HANDLE_NOT_FOUND",
        `Cannot resolve object handle '${input.$ref}' to a live V8 objectId.`
      );
    }
    const slot = slotObjectIds.length;
    slotObjectIds.push(objectId);
    return { __jlcRefSlot: slot };
  }

  if (Array.isArray(input)) {
    return input.map((item) => extractRefSlots(item, handlePool, slotObjectIds));
  }

  if (isPlainObject(input)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = extractRefSlots(v, handlePool, slotObjectIds);
    }
    return out;
  }

  return input;
}

function toCdpCallArgument(arg: unknown): CdpProtocolCallArg {
  if (
    isPlainObject(arg) &&
    typeof arg.objectId === "string" &&
    Object.keys(arg).length === 1
  ) {
    return { objectId: arg.objectId };
  }
  if (arg === undefined) {
    return { unserializableValue: "undefined" };
  }
  if (typeof arg === "number") {
    if (Number.isNaN(arg)) return { unserializableValue: "NaN" };
    if (arg === Infinity) return { unserializableValue: "Infinity" };
    if (arg === -Infinity) return { unserializableValue: "-Infinity" };
    if (Object.is(arg, -0)) return { unserializableValue: "-0" };
  }
  return { value: arg };
}

function summarizeRemoteObject(
  remote: CdpRemoteObject,
  handlePool: HandlePool,
  binding: TransactionTargetBinding
): ObjectHandleInfo | undefined {
  if (!remote.objectId) {
    return undefined;
  }
  const valObj =
    isPlainObject(remote.value) ? remote.value : undefined;
  const primitiveId =
    valObj && typeof valObj.primitiveId === "string"
      ? valObj.primitiveId
      : undefined;
  return handlePool.registerHandle({
    objectId: remote.objectId,
    objectGroup: DEFAULT_EPHEMERAL_OBJECT_GROUP,
    primitiveId,
    type: remote.className ?? remote.subtype ?? remote.type ?? "Object",
    targetId: binding.targetId,
    sessionId: binding.sessionId,
    summary: remote.description ? { description: remote.description } : undefined,
  });
}

function formatCdpException(details: CdpExceptionDetails): string {
  const excText =
    details.exception?.description ??
    details.exception?.value ??
    details.text ??
    "CDP Runtime exception";
  return typeof excText === "string" ? excText : JSON.stringify(excText);
}

/**
 * Core CDP RPC executor implementing `ICdpRpcExecutor`:
 * - Strict `Runtime.callFunctionOn` structured argument invocation (zero JS string injection)
 * - Dual-layer watchdog (async soft timeout + hard `Runtime.terminateExecution` circuit breaker)
 * - Automatic unit conversion (`mm/deg` <-> `mil/10mil/rad`), handle pooling & 200-item pagination
 * - Atomic Undo transaction wrapping & rollback via `CanvasTransactionGuard`
 */
export class CdpRpcExecutor implements ICdpRpcExecutor {
  private readonly transport: CdpProtocolTransport;
  public readonly handlePool: HandlePool;
  public readonly transactionGuard: CanvasTransactionGuard;
  private readonly defaultSoftTimeoutMs: number;
  private readonly defaultHardTerminateGraceMs: number;
  private readonly resolveSessionFn?: (
    document?: string | null
  ) => Promise<TargetSessionResolution>;

  private readonly sessionContexts = new Map<string, number>();
  private readonly sessionGlobalObjectIds = new Map<string, string>();
  private rpcQueueDepth = 0;

  constructor(options: CdpRpcExecutorOptions) {
    this.transport = options.transport;
    this.handlePool = options.handlePool ?? new HandlePool();
    this.defaultSoftTimeoutMs =
      options.softTimeoutMs ?? DEFAULT_RPC_SOFT_TIMEOUT_MS;
    this.defaultHardTerminateGraceMs =
      options.hardTerminateGraceMs ?? DEFAULT_RPC_HARD_TERMINATE_GRACE_MS;
    this.resolveSessionFn = options.resolveSession;

    this.transport.onEvent((ev) => this.handleProtocolEvent(ev));

    this.transactionGuard = new CanvasTransactionGuard(
      {
        callFunction: (fn, args, opts) =>
          this.callFunction(fn, args, {
            ...opts,
            isBypass: false,
          }),
      },
      async (doc) => {
        if (this.resolveSessionFn) {
          return await this.resolveSessionFn(doc || null);
        }
        return {};
      }
    );
  }

  public getRpcQueueDepth(): number {
    return this.rpcQueueDepth;
  }

  public setSessionExecutionContext(
    sessionKey: string,
    executionContextId: number
  ): void {
    this.sessionContexts.set(sessionKey, executionContextId);
  }

  public clearSessionCache(sessionKey?: string): void {
    if (sessionKey) {
      this.sessionContexts.delete(sessionKey);
      this.sessionGlobalObjectIds.delete(sessionKey);
    } else {
      this.sessionContexts.clear();
      this.sessionGlobalObjectIds.clear();
    }
  }

  /**
   * Direct bypass CDP evaluation used by health probes (`getSessionStatus`)
   * without inflating or blocking on the main RPC queue.
   */
  public async evaluateBypass<T = unknown>(
    functionDeclaration: string,
    args: unknown[] = [],
    options: CdpCallFunctionOptions & { timeoutMs?: number } = {}
  ): Promise<T> {
    return this.callFunctionInternal<T>(functionDeclaration, args, options, false);
  }

  public async evaluate<T = unknown>(
    expression: string,
    options: CdpEvaluateOptions = {}
  ): Promise<T> {
    const softMs = options.timeoutMs ?? this.defaultSoftTimeoutMs;
    const params: Record<string, unknown> = {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: true,
      objectGroup: options.objectGroup ?? DEFAULT_EPHEMERAL_OBJECT_GROUP,
    };
    if (options.executionContextId !== undefined) {
      params.contextId = options.executionContextId;
    }

    this.rpcQueueDepth++;
    try {
      const res = await this.executeWithHardWatchdog<CdpRuntimeEvalResult>(
        () =>
          this.transport.sendCommand<CdpRuntimeEvalResult>(
            "Runtime.evaluate",
            params,
            options.sessionId
          ),
        softMs,
        options.sessionId
      );
      if (res.exceptionDetails) {
        throw new CdpRpcError(
          "ERR_CDP_EXCEPTION",
          formatCdpException(res.exceptionDetails),
          { details: res.exceptionDetails }
        );
      }
      return res.result?.value as T;
    } finally {
      this.rpcQueueDepth = Math.max(0, this.rpcQueueDepth - 1);
    }
  }

  public async callFunction<T = unknown>(
    functionDeclaration: string,
    args: unknown[] = [],
    options: CdpCallFunctionOptions & { isBypass?: boolean } = {}
  ): Promise<T> {
    return this.callFunctionInternal<T>(
      functionDeclaration,
      args,
      options,
      options.isBypass !== false
    );
  }

  private async callFunctionInternal<T = unknown>(
    functionDeclaration: string,
    args: unknown[],
    options: CdpCallFunctionOptions,
    trackQueueDepth: boolean
  ): Promise<T> {
    const softMs = options.timeoutMs ?? this.defaultSoftTimeoutMs;
    const sessionKey = options.sessionId ?? options.targetId ?? "__root__";
    const cdpArgs = args.map(toCdpCallArgument);

    const params: Record<string, unknown> = {
      functionDeclaration,
      arguments: cdpArgs,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: true,
      objectGroup: options.objectGroup ?? DEFAULT_EPHEMERAL_OBJECT_GROUP,
    };

    if (options.objectId) {
      params.objectId = options.objectId;
    } else if (options.executionContextId !== undefined) {
      params.executionContextId = options.executionContextId;
    } else if (this.sessionContexts.has(sessionKey)) {
      params.executionContextId = this.sessionContexts.get(sessionKey);
    } else {
      const globalObjId = await this.ensureGlobalObjectId(
        sessionKey,
        options.sessionId
      );
      if (globalObjId) {
        params.objectId = globalObjId;
      } else {
        params.executionContextId = 1;
      }
    }

    if (trackQueueDepth) {
      this.rpcQueueDepth++;
    }
    try {
      const res = await this.executeWithHardWatchdog<CdpRuntimeEvalResult>(
        () =>
          this.transport.sendCommand<CdpRuntimeEvalResult>(
            "Runtime.callFunctionOn",
            params,
            options.sessionId
          ),
        softMs,
        options.sessionId
      );

      if (res.exceptionDetails) {
        const msg = formatCdpException(res.exceptionDetails);
        const code = msg.includes("terminated")
          ? "ERR_RPC_EXECUTION_TERMINATED"
          : "ERR_CDP_EXCEPTION";
        throw new CdpRpcError(code, msg, {
          hardTerminated: code === "ERR_RPC_EXECUTION_TERMINATED",
          details: res.exceptionDetails,
        });
      }

      if (options.returnByValue === false && res.result?.objectId) {
        return res.result as unknown as T;
      }
      return res.result?.value as T;
    } finally {
      if (trackQueueDepth) {
        this.rpcQueueDepth = Math.max(0, this.rpcQueueDepth - 1);
      }
    }
  }

  public async invokeEdaApi<T = unknown>(
    apiPath: string,
    args: unknown[] = [],
    options: {
      document?: string | null;
      unitMode?: UnitMode;
      transactional?: boolean;
      timeoutMs?: number;
      transactionLabel?: string;
      operation?: "call" | "get" | "set";
      targetHandle?: string | null;
      unitContract?: Partial<ReaUnitContract>;
      parameterSpecs?: ReaParameterSpec[];
      returnByValue?: boolean;
    } = {}
  ): Promise<{
    result: T;
    rolledBack: boolean;
    durationMs: number;
    handle?: ObjectHandleInfo;
    arrayCursor?: ArrayCursorPage<unknown>;
  }> {
    const startMs = Date.now();
    const resolvedSession: TargetSessionResolution = this.resolveSessionFn
      ? await this.resolveSessionFn(options.document ?? null)
      : {};

    const defaultNativeLengthUnit: LengthUnit =
      resolvedSession.docType === "SCH" || resolvedSession.docType === "SYMBOL"
        ? "10mil"
        : "mil";

    const unitMode: UnitMode = options.unitMode ?? "mm_deg";
    const softMs = options.timeoutMs ?? this.defaultSoftTimeoutMs;
    const docKey = options.document ?? resolvedSession.docUuid ?? "active";
    const txLabel = options.transactionLabel ?? `MCP: ${apiPath}`;

    // 1. Resolve {$enum} tokens locally when known, keeping unknown enums as {__jlcEnum}
    //    for renderer runtime evaluation, and resolve {$ref} handles into objectId slots.
    const enumResolved = resolveSpecialTokens(args, {
      unresolvedEnumMode: "marker",
      unresolvedRefMode: "keep",
    });

    // 2. Convert mm/deg -> native units (mil / 10mil / rad) when unitMode === "mm_deg"
    const unitConvertedArgs = convertParamsToNative(enumResolved, {
      unitMode,
      contract: options.unitContract,
      parameterSpecs: options.parameterSpecs,
      defaultNativeLengthUnit,
    }) as unknown[];

    const refSlotObjectIds: string[] = [];
    const preparedArgs = extractRefSlots(
      unitConvertedArgs,
      this.handlePool,
      refSlotObjectIds
    ) as unknown[];

    let targetObjectId: string | undefined;
    if (options.targetHandle) {
      const bound = this.handlePool.resolveObjectId(options.targetHandle);
      if (!bound) {
        throw new CdpRpcError(
          "ERR_HANDLE_NOT_FOUND",
          `Target handle '${options.targetHandle}' not found in handle pool.`
        );
      }
      targetObjectId = bound;
    }

    const runCall = async (): Promise<{
      rawValue: unknown;
      remoteObject?: CdpRemoteObject;
    }> => {
      const callArgs: unknown[] = [
        {
          apiPath,
          operation: options.operation ?? "call",
          args: preparedArgs,
          timeoutMs: softMs,
        },
        ...refSlotObjectIds.map((objectId) => ({ objectId })),
      ];

      const returnByValue = options.returnByValue ?? true;
      const raw = await this.callFunctionInternal<unknown>(
        FN_DISPATCH_EDA_API,
        callArgs,
        {
          targetId: resolvedSession.targetId,
          sessionId: resolvedSession.sessionId,
          executionContextId: resolvedSession.executionContextId,
          objectId: targetObjectId,
          awaitPromise: true,
          returnByValue,
          timeoutMs: softMs,
        },
        true
      );

      if (!returnByValue && isPlainObject(raw) && typeof raw.objectId === "string") {
        return { rawValue: raw, remoteObject: raw as unknown as CdpRemoteObject };
      }

      if (isPlainObject(raw)) {
        if (raw.__jlcAsyncTimeout === true) {
          throw new CdpRpcError(
            "ERR_RPC_ASYNC_TIMEOUT",
            `API '${apiPath}' async execution exceeded soft timeout (${softMs}ms).`
          );
        }
        if (isPlainObject(raw.__jlcDispatchError)) {
          const dErr = raw.__jlcDispatchError;
          throw new CdpRpcError(
            String(dErr.errorCode ?? "ERR_EDA_API_THREW"),
            String(dErr.message ?? `API '${apiPath}' threw an error.`)
          );
        }
      }

      return { rawValue: raw };
    };

    let rawResult: { rawValue: unknown; remoteObject?: CdpRemoteObject };
    let rolledBack = false;

    if (options.transactional) {
      const txRes = await this.transactionGuard.runInTransaction(
        docKey,
        txLabel,
        runCall
      );
      rawResult = txRes.result;
      rolledBack = txRes.rolledBack;
    } else {
      rawResult = await runCall();
    }

    let handle: ObjectHandleInfo | undefined;
    let arrayCursor: ArrayCursorPage<unknown> | undefined;
    let finalValue: unknown = rawResult.rawValue;

    if (rawResult.remoteObject) {
      handle = summarizeRemoteObject(
        rawResult.remoteObject,
        this.handlePool,
        resolvedSession
      );
      finalValue = handle ?? rawResult.remoteObject;
    } else {
      finalValue = convertResultFromNative(finalValue, {
        unitMode,
        contract: options.unitContract,
        defaultNativeLengthUnit,
      });

      if (Array.isArray(finalValue)) {
        const paged = this.handlePool.paginateArray(finalValue);
        if (paged.paginated && paged.arrayCursor) {
          finalValue = paged.items;
          arrayCursor = paged.arrayCursor;
        }
      }
    }

    return {
      result: finalValue as T,
      rolledBack,
      durationMs: Date.now() - startMs,
      ...(handle ? { handle } : {}),
      ...(arrayCursor ? { arrayCursor } : {}),
    };
  }

  public async runInTransaction<T = unknown>(
    document: string,
    label: string,
    fn: () => Promise<T>
  ): Promise<{ result: T; checkpointId: string; rolledBack: boolean }> {
    return this.transactionGuard.runInTransaction(document, label, fn);
  }

  public async captureScreenshot(
    options: {
      clip?: { x: number; y: number; width: number; height: number; scale?: number };
      format?: "png" | "jpeg";
      document?: string | null;
    } = {}
  ): Promise<Buffer> {
    const resolvedSession: TargetSessionResolution = this.resolveSessionFn
      ? await this.resolveSessionFn(options.document ?? null)
      : {};

    const params: Record<string, unknown> = {
      format: options.format ?? "png",
      captureBeyondViewport: false,
    };
    if (options.clip) {
      params.clip = {
        x: options.clip.x,
        y: options.clip.y,
        width: options.clip.width,
        height: options.clip.height,
        scale: options.clip.scale ?? 1,
      };
    }

    const res = await this.transport.sendCommand<{ data?: string }>(
      "Page.captureScreenshot",
      params,
      resolvedSession.sessionId
    );
    if (!res?.data) {
      throw new CdpRpcError(
        "ERR_SCREENSHOT_FAILED",
        "Page.captureScreenshot returned empty image data."
      );
    }
    return Buffer.from(res.data, "base64");
  }

  public async releaseObjectGroup(
    objectGroup = DEFAULT_EPHEMERAL_OBJECT_GROUP
  ): Promise<void> {
    await this.handlePool.releaseObjectGroup(objectGroup, async (group) => {
      if (!this.transport.isOpen()) {
        return;
      }
      try {
        await this.transport.sendCommand("Runtime.releaseObjectGroup", {
          objectGroup: group,
        });
      } catch {
        // Ignore if session already closed
      }
    });
  }

  private async ensureGlobalObjectId(
    sessionKey: string,
    sessionId?: string
  ): Promise<string | undefined> {
    const cached = this.sessionGlobalObjectIds.get(sessionKey);
    if (cached) {
      return cached;
    }
    try {
      const res = await this.transport.sendCommand<CdpRuntimeEvalResult>(
        "Runtime.evaluate",
        {
          expression: "globalThis",
          returnByValue: false,
          objectGroup: DEFAULT_EPHEMERAL_OBJECT_GROUP,
        },
        sessionId
      );
      if (res?.result?.objectId) {
        this.sessionGlobalObjectIds.set(sessionKey, res.result.objectId);
        return res.result.objectId;
      }
    } catch {
      // Fallback to executionContextId=1 if Runtime.evaluate("globalThis") unsupported
    }
    return undefined;
  }

  /**
   * Dual-layer timeout watchdog:
   * - Soft timer at `softTimeoutMs`: allows in-page Promise.race / AbortController to resolve cleanly
   * - Hard circuit breaker at `softTimeoutMs + hardTerminateGraceMs`: sends CDP `Runtime.terminateExecution`
   *   to break synchronous V8 deadlocks without killing the Electron renderer process.
   */
  private async executeWithHardWatchdog<T>(
    invokeFn: () => Promise<T>,
    softTimeoutMs: number,
    sessionId?: string
  ): Promise<T> {
    const safeSoftMs = Math.max(10, softTimeoutMs);
    const hardMs = safeSoftMs + Math.max(10, this.defaultHardTerminateGraceMs);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      const clearAll = (): void => {
        if (hardTimer) {
          clearTimeout(hardTimer);
          hardTimer = undefined;
        }
      };

      hardTimer = setTimeout(async () => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          if (this.transport.isOpen()) {
            await this.transport.sendCommand(
              "Runtime.terminateExecution",
              {},
              sessionId
            );
          }
        } catch {
          // Best-effort termination signal
        }
        reject(
          new CdpRpcError(
            "ERR_RPC_EXECUTION_TERMINATED",
            `CDP execution exceeded soft timeout (${safeSoftMs}ms) + grace (${this.defaultHardTerminateGraceMs}ms) and was forcibly interrupted via Runtime.terminateExecution.`,
            { hardTerminated: true }
          )
        );
      }, hardMs);

      invokeFn().then(
        (res) => {
          if (settled) return;
          settled = true;
          clearAll();
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearAll();
          reject(err);
        }
      );
    });
  }

  private handleProtocolEvent(ev: CdpProtocolEvent): void {
    const sessionKey = ev.sessionId ?? "__root__";
    if (ev.method === "Runtime.executionContextCreated") {
      const ctx = ev.params?.context as
        | { id?: number; auxData?: { isDefault?: boolean } }
        | undefined;
      if (ctx && typeof ctx.id === "number") {
        if (ctx.auxData?.isDefault !== false || !this.sessionContexts.has(sessionKey)) {
          this.sessionContexts.set(sessionKey, ctx.id);
        }
      }
    } else if (ev.method === "Runtime.executionContextDestroyed") {
      const destroyedId = ev.params?.executionContextId as number | undefined;
      if (destroyedId !== undefined && this.sessionContexts.get(sessionKey) === destroyedId) {
        this.sessionContexts.delete(sessionKey);
      }
      this.sessionGlobalObjectIds.delete(sessionKey);
    } else if (ev.method === "Runtime.executionContextsCleared") {
      this.sessionContexts.delete(sessionKey);
      this.sessionGlobalObjectIds.delete(sessionKey);
    }
  }
}

export { CdpTransactionError };

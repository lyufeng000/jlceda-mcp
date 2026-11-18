import { errEnvelope, okEnvelope, type McpEnvelope } from "../types/index.js";

export interface TransactionBridge {
  callFunction<T = unknown>(
    functionDeclaration: string,
    args?: unknown[],
    options?: {
      targetId?: string;
      sessionId?: string;
      executionContextId?: number;
      awaitPromise?: boolean;
      returnByValue?: boolean;
      timeoutMs?: number;
    }
  ): Promise<T>;
}

export interface TransactionTargetBinding {
  targetId?: string;
  sessionId?: string;
  executionContextId?: number;
}

export interface TransactionHistoryEntry {
  id: string;
  document: string;
  label: string;
  timestamp: string;
  status: "active" | "committed" | "rolled_back";
}

export interface TransactionBeginResult {
  checkpointId: string;
  historyDepth: number;
  mechanism: "l3_adapter" | "eda_history" | "shim";
}

export interface TransactionActionResult {
  checkpointId: string;
  historyDepth: number;
  status: string;
  recentSteps?: TransactionHistoryEntry[];
}

export class CdpTransactionError extends Error {
  public readonly errorCode: string;
  public readonly rolledBack: boolean;
  public readonly checkpointId?: string;
  public readonly cause?: unknown;

  constructor(
    errorCode: string,
    message: string,
    options: {
      rolledBack?: boolean;
      checkpointId?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "CdpTransactionError";
    this.errorCode = errorCode;
    this.rolledBack = options.rolledBack ?? false;
    this.checkpointId = options.checkpointId;
    this.cause = options.cause;
  }
}

const FN_PROBE_INTERACTIVE_TOOL = `function(payload) {
  try {
    var g = globalThis;
    if (typeof g.__jlcMcpActiveInteractiveTool === "string" && g.__jlcMcpActiveInteractiveTool.length > 0) {
      return { activeInteractiveTool: g.__jlcMcpActiveInteractiveTool };
    }
    var eda = g.eda;
    if (eda) {
      if (eda.sys_Environment && typeof eda.sys_Environment.getActiveInteractiveTool === "function") {
        var t1 = eda.sys_Environment.getActiveInteractiveTool();
        if (t1) return { activeInteractiveTool: String(t1) };
      }
      if (eda.pcb_SelectControl && typeof eda.pcb_SelectControl.getActiveInteractiveTool === "function") {
        var t2 = eda.pcb_SelectControl.getActiveInteractiveTool();
        if (t2) return { activeInteractiveTool: String(t2) };
      }
      if (eda.sch_SelectControl && typeof eda.sch_SelectControl.getActiveInteractiveTool === "function") {
        var t3 = eda.sch_SelectControl.getActiveInteractiveTool();
        if (t3) return { activeInteractiveTool: String(t3) };
      }
    }
    var doc = g.document;
    if (doc && doc.body && doc.body.dataset && doc.body.dataset.interactiveTool) {
      return { activeInteractiveTool: String(doc.body.dataset.interactiveTool) };
    }
    return { activeInteractiveTool: null };
  } catch (e) {
    return { activeInteractiveTool: null };
  }
}`;

const FN_BEGIN_TRANSACTION = `async function(payload) {
  var g = globalThis;
  var label = (payload && payload.label) ? String(payload.label) : "MCP_Transaction";
  var docId = (payload && payload.document) ? String(payload.document) : "";
  var ckptId = (payload && payload.checkpointId) ? String(payload.checkpointId) : ("ckpt_" + Date.now());
  var eda = g.eda;

  var adapter = g.__jlcMcpAdapter && g.__jlcMcpAdapter.history;
  if (adapter && typeof adapter.beginCompositeStep === "function") {
    var res = await adapter.beginCompositeStep(label, docId, ckptId);
    var resolvedId = (res && typeof res === "object" && res.checkpointId) ? String(res.checkpointId) : (typeof res === "string" ? res : ckptId);
    var depth = (res && typeof res === "object" && typeof res.historyDepth === "number") ? res.historyDepth : 0;
    return { checkpointId: resolvedId, historyDepth: depth, mechanism: "l3_adapter" };
  }

  if (eda && eda.sys_History) {
    var hist = eda.sys_History;
    var depthBefore = 0;
    if (typeof hist.getUndoStackLength === "function") {
      depthBefore = Number(await hist.getUndoStackLength()) || 0;
    } else if (typeof hist.getHistoryList === "function") {
      var items = await hist.getHistoryList();
      depthBefore = Array.isArray(items) ? items.length : 0;
    }
    if (typeof hist.beginCompositeStep === "function") {
      var idFromHist = await hist.beginCompositeStep(label);
      return {
        checkpointId: idFromHist ? String(idFromHist) : ckptId,
        historyDepth: depthBefore,
        mechanism: "eda_history"
      };
    }
    if (!g.__jlcMcpTxCheckpoints) g.__jlcMcpTxCheckpoints = Object.create(null);
    g.__jlcMcpTxCheckpoints[ckptId] = { label: label, document: docId, depthBefore: depthBefore };
    return { checkpointId: ckptId, historyDepth: depthBefore, mechanism: "eda_history" };
  }

  if (!g.__jlcMcpTxShim) {
    g.__jlcMcpTxShim = { checkpoints: Object.create(null), steps: [] };
  }
  var currentDepth = g.__jlcMcpTxShim.steps.length;
  g.__jlcMcpTxShim.checkpoints[ckptId] = {
    label: label,
    document: docId,
    depthBefore: currentDepth
  };
  return { checkpointId: ckptId, historyDepth: currentDepth, mechanism: "shim" };
}`;

const FN_COMMIT_TRANSACTION = `async function(payload) {
  var g = globalThis;
  var ckptId = String(payload.checkpointId || "");
  var label = String(payload.label || "MCP_Transaction");
  var eda = g.eda;

  var adapter = g.__jlcMcpAdapter && g.__jlcMcpAdapter.history;
  if (adapter && typeof adapter.commitTransaction === "function") {
    var res = await adapter.commitTransaction(ckptId, label);
    return {
      checkpointId: ckptId,
      historyDepth: (res && typeof res.historyDepth === "number") ? res.historyDepth : 1,
      status: "committed"
    };
  }

  if (eda && eda.sys_History && typeof eda.sys_History.commitTransaction === "function") {
    await eda.sys_History.commitTransaction(ckptId, label);
    return { checkpointId: ckptId, historyDepth: 1, status: "committed" };
  }

  if (g.__jlcMcpTxShim) {
    g.__jlcMcpTxShim.steps.push({ id: ckptId, label: label, timestamp: new Date().toISOString() });
    delete g.__jlcMcpTxShim.checkpoints[ckptId];
    return {
      checkpointId: ckptId,
      historyDepth: g.__jlcMcpTxShim.steps.length,
      status: "committed"
    };
  }

  return { checkpointId: ckptId, historyDepth: 0, status: "committed" };
}`;

const FN_ROLLBACK_TRANSACTION = `async function(payload) {
  var g = globalThis;
  var ckptId = String(payload.checkpointId || "");
  var eda = g.eda;

  var adapter = g.__jlcMcpAdapter && g.__jlcMcpAdapter.history;
  if (adapter && typeof adapter.rollbackTo === "function") {
    var res = await adapter.rollbackTo(ckptId);
    return {
      checkpointId: ckptId,
      historyDepth: (res && typeof res.historyDepth === "number") ? res.historyDepth : 0,
      status: "rolled_back"
    };
  }

  if (eda && eda.sys_History) {
    var hist = eda.sys_History;
    if (typeof hist.rollbackTo === "function") {
      await hist.rollbackTo(ckptId);
      return { checkpointId: ckptId, historyDepth: 0, status: "rolled_back" };
    }
    var meta = g.__jlcMcpTxCheckpoints && g.__jlcMcpTxCheckpoints[ckptId];
    if (meta && typeof hist.undo === "function") {
      var currentLen = typeof hist.getUndoStackLength === "function"
        ? (Number(await hist.getUndoStackLength()) || 0)
        : (Array.isArray(await hist.getHistoryList?.()) ? (await hist.getHistoryList()).length : meta.depthBefore);
      var delta = Math.max(0, currentLen - meta.depthBefore);
      for (var i = 0; i < delta; i++) {
        await hist.undo();
      }
      delete g.__jlcMcpTxCheckpoints[ckptId];
      return { checkpointId: ckptId, historyDepth: meta.depthBefore, status: "rolled_back" };
    }
  }

  if (g.__jlcMcpTxShim && g.__jlcMcpTxShim.checkpoints && g.__jlcMcpTxShim.checkpoints[ckptId]) {
    var cp = g.__jlcMcpTxShim.checkpoints[ckptId];
    g.__jlcMcpTxShim.steps.length = Math.min(g.__jlcMcpTxShim.steps.length, cp.depthBefore);
    delete g.__jlcMcpTxShim.checkpoints[ckptId];
    return { checkpointId: ckptId, historyDepth: cp.depthBefore, status: "rolled_back" };
  }

  return { checkpointId: ckptId, historyDepth: 0, status: "rolled_back" };
}`;

/**
 * Guards write operations with:
 * 1) Interactive drawing yield lock (`ERR_USER_INTERACTIVE_BUSY`)
 * 2) Composite Undo transaction wrapping with atomic `rollbackTo` on failure/timeout
 */
export class CanvasTransactionGuard {
  private readonly bridge: TransactionBridge;
  private readonly resolveBinding?: (
    document: string
  ) => Promise<TransactionTargetBinding> | TransactionTargetBinding;

  private checkpointSeq = 0;
  private readonly history: TransactionHistoryEntry[] = [];

  constructor(
    bridge: TransactionBridge,
    resolveBinding?: (
      document: string
    ) => Promise<TransactionTargetBinding> | TransactionTargetBinding
  ) {
    this.bridge = bridge;
    this.resolveBinding = resolveBinding;
  }

  private async getTargetOptions(
    document: string
  ): Promise<TransactionTargetBinding> {
    if (!this.resolveBinding) {
      return {};
    }
    return await this.resolveBinding(document);
  }

  /**
   * Detect whether the user is currently holding an active interactive tool
   * (dragging a component, routing a wire/track, etc.).
   */
  public async getActiveInteractiveTool(
    document = ""
  ): Promise<string | null> {
    const binding = await this.getTargetOptions(document);
    const probe = await this.bridge.callFunction<{
      activeInteractiveTool?: string | null;
    }>(FN_PROBE_INTERACTIVE_TOOL, [{ document }], {
      ...binding,
      awaitPromise: false,
      returnByValue: true,
      timeoutMs: 2000,
    });
    const tool = probe?.activeInteractiveTool;
    return typeof tool === "string" && tool.length > 0 ? tool : null;
  }

  /**
   * Enforce the interactive drawing yield lock before executing a canvas mutation.
   * Throws `ERR_USER_INTERACTIVE_BUSY` if the user is mid-drag/route.
   */
  public async assertNotInteractiveBusy(document = ""): Promise<void> {
    const activeTool = await this.getActiveInteractiveTool(document);
    if (activeTool !== null) {
      throw new CdpTransactionError(
        "ERR_USER_INTERACTIVE_BUSY",
        `User is currently using interactive tool '${activeTool}' on '${document || "active document"}'. Wait until user finishes (Right-Click / ESC) before mutating canvas.`,
        { rolledBack: false }
      );
    }
  }

  public async beginTransaction(
    document: string,
    label: string,
    options: { skipInteractiveCheck?: boolean } = {}
  ): Promise<TransactionBeginResult> {
    if (!options.skipInteractiveCheck) {
      await this.assertNotInteractiveBusy(document);
    }

    const checkpointId = `ckpt_${++this.checkpointSeq}`;
    const binding = await this.getTargetOptions(document);
    const res = await this.bridge.callFunction<TransactionBeginResult>(
      FN_BEGIN_TRANSACTION,
      [{ document, label, checkpointId }],
      {
        ...binding,
        awaitPromise: true,
        returnByValue: true,
        timeoutMs: 5000,
      }
    );

    const finalId = res?.checkpointId || checkpointId;
    this.history.push({
      id: finalId,
      document,
      label,
      timestamp: new Date().toISOString(),
      status: "active",
    });

    return {
      checkpointId: finalId,
      historyDepth: res?.historyDepth ?? 0,
      mechanism: res?.mechanism ?? "shim",
    };
  }

  public async commitTransaction(
    document: string,
    checkpointId: string,
    label = "MCP_Transaction"
  ): Promise<TransactionActionResult> {
    const binding = await this.getTargetOptions(document);
    const res = await this.bridge.callFunction<TransactionActionResult>(
      FN_COMMIT_TRANSACTION,
      [{ document, checkpointId, label }],
      {
        ...binding,
        awaitPromise: true,
        returnByValue: true,
        timeoutMs: 5000,
      }
    );

    const entry = this.history.find((h) => h.id === checkpointId);
    if (entry) {
      entry.status = "committed";
    }

    return {
      checkpointId,
      historyDepth: res?.historyDepth ?? 0,
      status: res?.status ?? "committed",
      recentSteps: this.listRecentHistory(document),
    };
  }

  public async rollbackTo(
    document: string,
    checkpointId: string
  ): Promise<TransactionActionResult> {
    const binding = await this.getTargetOptions(document);
    const res = await this.bridge.callFunction<TransactionActionResult>(
      FN_ROLLBACK_TRANSACTION,
      [{ document, checkpointId }],
      {
        ...binding,
        awaitPromise: true,
        returnByValue: true,
        timeoutMs: 5000,
      }
    );

    const entry = this.history.find((h) => h.id === checkpointId);
    if (entry) {
      entry.status = "rolled_back";
    }

    return {
      checkpointId,
      historyDepth: res?.historyDepth ?? 0,
      status: res?.status ?? "rolled_back",
      recentSteps: this.listRecentHistory(document),
    };
  }

  public listRecentHistory(document?: string): TransactionHistoryEntry[] {
    const filtered = document
      ? this.history.filter((h) => h.document === document)
      : this.history;
    return filtered.slice(-20);
  }

  /**
   * Execute `fn` inside an atomic Undo transaction.
   * On any exception or timeout, triggers `rollbackTo(checkpointId)` and throws
   * `CdpTransactionError` with `rolledBack: true`.
   */
  public async runInTransaction<T = unknown>(
    document: string,
    label: string,
    fn: () => Promise<T>,
    options: { skipInteractiveCheck?: boolean } = {}
  ): Promise<{ result: T; checkpointId: string; rolledBack: boolean }> {
    const { checkpointId } = await this.beginTransaction(
      document,
      label,
      options
    );

    try {
      const result = await fn();
      await this.commitTransaction(document, checkpointId, label);
      return {
        result,
        checkpointId,
        rolledBack: false,
      };
    } catch (err) {
      let rollbackSucceeded = false;
      try {
        await this.rollbackTo(document, checkpointId);
        rollbackSucceeded = true;
      } catch (rbErr) {
        const origCode = extractErrorCode(err) ?? "ERR_TRANSACTION_FAILED";
        const origMsg = err instanceof Error ? err.message : String(err);
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        throw new CdpTransactionError(
          origCode,
          `${origMsg} (rollback attempt also encountered: ${rbMsg})`,
          {
            rolledBack: false,
            checkpointId,
            cause: err,
          }
        );
      }

      const origCode = extractErrorCode(err) ?? "ERR_TRANSACTION_FAILED";
      const origMsg = err instanceof Error ? err.message : String(err);
      throw new CdpTransactionError(origCode, origMsg, {
        rolledBack: rollbackSucceeded,
        checkpointId,
        cause: err,
      });
    }
  }

  /**
   * Convenience wrapper returning a standardized `McpEnvelope` with `rolledBack` populated.
   */
  public async runInTransactionEnvelope<T = unknown>(
    document: string,
    label: string,
    fn: () => Promise<T>
  ): Promise<
    McpEnvelope<{ result: T; checkpointId: string } | { checkpointId?: string }>
  > {
    try {
      const res = await this.runInTransaction(document, label, fn);
      return okEnvelope({ result: res.result, checkpointId: res.checkpointId });
    } catch (err) {
      if (err instanceof CdpTransactionError) {
        return errEnvelope(err.errorCode, err.message, {
          rolledBack: err.rolledBack,
          data: { checkpointId: err.checkpointId },
        });
      }
      return errEnvelope(
        extractErrorCode(err) ?? "ERR_TRANSACTION_FAILED",
        err instanceof Error ? err.message : String(err),
        { rolledBack: false, data: {} }
      );
    }
  }
}

function extractErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "errorCode" in err) {
    const code = (err as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  if (err instanceof Error) {
    const match = err.message.match(/\b(ERR_[A-Z0-9_]+)\b/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

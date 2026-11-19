import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type {
  CdpConnectOptions,
  CdpConnectResult,
  CdpLaunchOptions,
  CdpLaunchResult,
  CdpProcessInfo,
  CdpTargetDescriptor,
  CollaborationMode,
  DocumentSummary,
  ICdpRpcExecutor,
  ICdpSessionManager,
  ModalDialogInfo,
  SessionStatusData,
  TargetDocType,
} from "../types/index.js";
import { HandlePool } from "./handle-pool.js";
import {
  CdpRpcExecutor,
  WebSocketCdpTransport,
  type CdpProtocolTransport,
  type TargetSessionResolution,
} from "./rpc-executor.js";
import {
  scanLcedaWin32State,
  type Win32ScanOptions,
  type Win32ScanSnapshot,
} from "./win32-window-scanner.js";

export const DEFAULT_CDP_PORT_START = 19222;
export const DEFAULT_CDP_PORT_END = 19229;

/**
 * Flags that MUST NEVER be passed to `lceda-pro.exe` (verified to trigger UNKNOWN_FLAG exit).
 */
export const FORBIDDEN_LCEDA_FLAGS = [
  "--remote-debugging-address",
  "--remote-allow-origins",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
] as const;

export interface BuildLaunchArgsOptions {
  cdpPort: number;
  userDataDir?: string | null;
  inspectPort?: number | null;
}

/**
 * Build the strictly whitelisted cold-launch CLI argument list for `lceda-pro.exe`.
 */
export function buildLcedaLaunchArgs(options: BuildLaunchArgsOptions): string[] {
  const args = [
    `--remote-debugging-port=${options.cdpPort}`,
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  ];
  if (options.userDataDir) {
    args.push(`--user-data-dir=${options.userDataDir}`);
  }
  if (options.inspectPort && options.inspectPort > 0) {
    args.push(`--inspect=${options.inspectPort}`);
  }
  for (const arg of args) {
    for (const forbidden of FORBIDDEN_LCEDA_FLAGS) {
      if (arg.startsWith(forbidden)) {
        throw new Error(`Forbidden launch flag detected: ${arg}`);
      }
    }
  }
  return args;
}

export interface DevToolsActivePortInfo {
  port: number;
  browserWsPath: string;
}

/**
 * Read Chromium's `DevToolsActivePort` file if present (optional channel;
 * some JLCEDA Pro builds do not emit it).
 */
export function readDevToolsActivePort(
  userDataDir?: string | null
): DevToolsActivePortInfo | null {
  if (!userDataDir) {
    return null;
  }
  const filePath = path.join(userDataDir, "DevToolsActivePort");
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return null;
    }
    const port = Number.parseInt(lines[0], 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return null;
    }
    return {
      port,
      browserWsPath: lines[1] ?? "",
    };
  } catch {
    return null;
  }
}

export interface CdpVersionInfo {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
}

export interface RawCdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface HttpEndpointSnapshot {
  port: number;
  version: CdpVersionInfo | null;
  targets: RawCdpTarget[];
}

export interface ProbedTargetInfo {
  targetId: string;
  port: number;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  isUnactivated: boolean;
  hasEda: boolean;
  docType: TargetDocType;
  docUuid: string | null;
  projectUuid: string | null;
  projectName: string | null;
  primitiveCount: number;
  isActive: boolean;
  isDirty: boolean;
  readOnly: boolean;
  selectionCount: number;
  activeInteractiveTool: string | null;
  executionContextId?: number;
  domModals: ModalDialogInfo[];
}

export interface CdpConnectDiagnosticResult extends CdpConnectResult {
  errorCode?: string;
  message?: string;
}

export interface CdpSessionManagerOptions {
  exePath?: string | null;
  defaultUserDataDir?: string | null;
  headlessProfileDir?: string | null;
  portRange?: [number, number];
  probeTimeoutMs?: number;
  httpTimeoutMs?: number;
  softTimeoutMs?: number;
  hardTerminateGraceMs?: number;
  win32Scanner?: (options?: Win32ScanOptions) => Promise<Win32ScanSnapshot>;
  win32ScanOptions?: Win32ScanOptions;
  processSpawner?: (
    exePath: string,
    args: string[]
  ) => { pid?: number; unref?: () => void };
  httpFetcher?: (port: number, endpoint: string, timeoutMs: number) => Promise<unknown>;
  wsConnector?: (wsUrl: string, timeoutMs?: number) => Promise<CdpProtocolTransport>;
}

interface TabRouteEntry {
  targetId: string;
  sessionId?: string;
  executionContextId?: number;
  docType: TargetDocType;
  docUuid: string;
  title: string;
  projectUuid?: string | null;
  wsUrl?: string;
}

interface ConnectedInstanceState {
  pid: number;
  cdpPort: number;
  clientVersion: string | null;
  projectUuid: string | null;
  browserWsUrl?: string;
  browserTransport?: CdpProtocolTransport;
  activeTargetId: string;
  activeSessionId?: string;
  activeDocHandle: string | null;
  activeDocUuid: string | null;
  activeDocType: TargetDocType;
  collaborationMode: CollaborationMode;
  flatSessionSupported: boolean;
}

const FN_PROBE_TARGET_CONTEXT = `async function() {
  var g = globalThis;
  var href = (g.location && g.location.href) ? String(g.location.href) : "";
  var docTitle = (g.document && g.document.title) ? String(g.document.title) : "";
  var isUnactivated = /entry=regist|activated=not/i.test(href);
  var eda = g.eda;
  var hasEda = typeof eda !== "undefined" && eda !== null;

  var docType = "UNKNOWN";
  var docUuid = null;
  var projectUuid = null;
  var projectName = null;
  var primitiveCount = 0;
  var isActive = false;
  var isDirty = false;
  var readOnly = false;
  var selectionCount = 0;
  var activeInteractiveTool = null;

  if (isUnactivated && !hasEda) {
    return {
      isUnactivated: true,
      hasEda: false,
      docType: "UNKNOWN",
      docUuid: null,
      projectUuid: null,
      projectName: null,
      primitiveCount: 0,
      isActive: false,
      isDirty: false,
      readOnly: false,
      selectionCount: 0,
      activeInteractiveTool: null,
      domModals: []
    };
  }

  // Optional test/hook override or live window.eda probing
  if (g.__jlcMcpMockContext && typeof g.__jlcMcpMockContext === "object") {
    var mc = g.__jlcMcpMockContext;
    return {
      isUnactivated: Boolean(mc.isUnactivated || isUnactivated),
      hasEda: mc.hasEda !== undefined ? Boolean(mc.hasEda) : hasEda,
      docType: mc.docType || "UNKNOWN",
      docUuid: mc.docUuid || null,
      projectUuid: mc.projectUuid || null,
      projectName: mc.projectName || null,
      primitiveCount: Number(mc.primitiveCount || 0),
      isActive: Boolean(mc.isActive),
      isDirty: Boolean(mc.isDirty),
      readOnly: Boolean(mc.readOnly),
      selectionCount: Number(mc.selectionCount || 0),
      activeInteractiveTool: mc.activeInteractiveTool || null,
      domModals: Array.isArray(mc.domModals) ? mc.domModals : []
    };
  }

  try {
    if (hasEda) {
      if (eda.dmt_Project && typeof eda.dmt_Project.getCurrentProjectInfo === "function") {
        var proj = await eda.dmt_Project.getCurrentProjectInfo();
        if (proj) {
          projectUuid = proj.uuid || null;
          projectName = proj.friendlyName || proj.name || null;
        }
      }
      if (eda.dmt_EditorControl && typeof eda.dmt_EditorControl.getSplitScreenTree === "function") {
        var tree = await eda.dmt_EditorControl.getSplitScreenTree();
        var stack = tree ? [tree] : [];
        while (stack.length > 0) {
          var node = stack.pop();
          if (node.tabs && Array.isArray(node.tabs)) {
            for (var i = 0; i < node.tabs.length; i++) {
              var tab = node.tabs[i];
              if (tab.active || !docUuid) {
                docUuid = tab.documentUuid || tab.uuid || tab.id || docUuid;
                docTitle = tab.title || docTitle;
                isActive = Boolean(tab.active);
                var dt = String(tab.documentType || "").toUpperCase();
                if (dt.indexOf("PCB") >= 0 || tab.documentType === 2) docType = "PCB";
                else if (dt.indexOf("SCH") >= 0 || tab.documentType === 1) docType = "SCH";
                else if (dt.indexOf("SYMBOL") >= 0 || tab.documentType === 3) docType = "SYMBOL";
                else if (dt.indexOf("FOOTPRINT") >= 0 || tab.documentType === 4) docType = "FOOTPRINT";
                else if (dt.indexOf("PANEL") >= 0 || tab.documentType === 5) docType = "PANEL";
              }
            }
          }
          if (node.children && Array.isArray(node.children)) {
            for (var c = 0; c < node.children.length; c++) stack.push(node.children[c]);
          }
        }
      }
      if (docType === "UNKNOWN" && eda.pcb_Document && typeof eda.pcb_Document.getAllPrimitives === "function") {
        docType = "PCB";
      }
      if (docType === "PCB" && eda.pcb_PrimitiveComponent && typeof eda.pcb_PrimitiveComponent.getAllPrimitiveId === "function") {
        var pcbIds = await eda.pcb_PrimitiveComponent.getAllPrimitiveId();
        if (Array.isArray(pcbIds)) primitiveCount = pcbIds.length;
      } else if (docType === "SCH" && eda.sch_PrimitiveComponent && typeof eda.sch_PrimitiveComponent.getAllPrimitiveId === "function") {
        var schIds = await eda.sch_PrimitiveComponent.getAllPrimitiveId();
        if (Array.isArray(schIds)) primitiveCount = schIds.length;
      }
      if (eda.pcb_SelectControl && typeof eda.pcb_SelectControl.getAllSelectedPrimitives === "function" && docType === "PCB") {
        var selPcb = await eda.pcb_SelectControl.getAllSelectedPrimitives();
        if (Array.isArray(selPcb)) selectionCount = selPcb.length;
      } else if (eda.sch_SelectControl && typeof eda.sch_SelectControl.getAllSelectedPrimitives === "function" && docType === "SCH") {
        var selSch = await eda.sch_SelectControl.getAllSelectedPrimitives();
        if (Array.isArray(selSch)) selectionCount = selSch.length;
      }
    }
  } catch (e) {}

  if (docType === "UNKNOWN") {
    if (/home|welcome|start|index\\.html/i.test(href) || /欢迎|首页|Start/i.test(docTitle)) {
      docType = "HOME";
    } else if (/\\bpcb\\b/i.test(docTitle) || /editor=pcb/i.test(href)) {
      docType = "PCB";
    } else if (/\\bsch\\b|原理图/i.test(docTitle) || /editor=sch/i.test(href)) {
      docType = "SCH";
    }
  }

  return {
    isUnactivated: isUnactivated,
    hasEda: hasEda,
    docType: docType,
    docUuid: docUuid,
    projectUuid: projectUuid,
    projectName: projectName,
    primitiveCount: primitiveCount,
    isActive: isActive,
    isDirty: isDirty,
    readOnly: readOnly,
    selectionCount: selectionCount,
    activeInteractiveTool: activeInteractiveTool,
    domModals: []
  };
}`;

const FN_PROBE_BYPASS_STATUS = `async function() {
  var g = globalThis;
  var doc = g.document;
  var eda = g.eda;
  var modals = [];
  var progressBar = null;

  if (g.__jlcMcpMockStatus && typeof g.__jlcMcpMockStatus === "object") {
    return g.__jlcMcpMockStatus;
  }

  if (doc && typeof doc.querySelectorAll === "function") {
    var selectors = [".ant-modal-wrap", ".el-dialog__wrapper", ".el-dialog", "[role='dialog']"];
    for (var s = 0; s < selectors.length; s++) {
      var els = doc.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var style = g.getComputedStyle ? g.getComputedStyle(el) : null;
        var visible = style ? (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") : true;
        if (!visible) continue;
        var titleEl = el.querySelector(".ant-modal-title, .el-dialog__title, h1, h2, h3");
        var title = titleEl ? String(titleEl.textContent || "").trim() : "Modal Dialog";
        var bodyEl = el.querySelector(".ant-modal-body, .el-dialog__body");
        var summary = bodyEl ? String(bodyEl.textContent || "").trim().slice(0, 240) : String(el.textContent || "").trim().slice(0, 240);
        var btnEls = el.querySelectorAll("button");
        var buttons = [];
        for (var b = 0; b < btnEls.length; b++) {
          var bt = String(btnEls[b].textContent || "").trim();
          if (bt) buttons.push(bt);
        }
        modals.push({
          source: "dom",
          title: title || "DOM Modal",
          textSummary: summary,
          buttons: buttons
        });
      }
    }

    var progEl = doc.querySelector("[role='progressbar'], .ant-progress, .el-progress, .eda-progress-bar");
    if (progEl) {
      var pStyle = g.getComputedStyle ? g.getComputedStyle(progEl) : null;
      var pVisible = pStyle ? (pStyle.display !== "none" && pStyle.visibility !== "hidden") : true;
      if (pVisible) {
        var ariaVal = progEl.getAttribute("aria-valuenow");
        var pct = ariaVal !== null ? Number(ariaVal) : null;
        progressBar = {
          visible: true,
          percent: Number.isFinite(pct) ? pct : null,
          label: String(progEl.getAttribute("aria-label") || progEl.textContent || "Processing").trim().slice(0, 120)
        };
      }
    }
  }

  if (!progressBar && eda && eda.sys_LoadingAndProgressBar && typeof eda.sys_LoadingAndProgressBar.getProgress === "function") {
    try {
      var p = await eda.sys_LoadingAndProgressBar.getProgress();
      if (p && p.visible) {
        progressBar = {
          visible: Boolean(p.visible),
          percent: typeof p.percent === "number" ? p.percent : null,
          label: String(p.label || "")
        };
      }
    } catch (e) {}
  }

  return {
    activeModalDialogs: modals,
    activeProgressBar: progressBar
  };
}`;

const FN_LIST_DOCUMENTS = `async function(filterPayload) {
  var g = globalThis;
  var eda = g.eda;
  var filterProjUuid = filterPayload && filterPayload.projectUuid ? String(filterPayload.projectUuid) : null;

  if (g.__jlcMcpMockDocuments && typeof g.__jlcMcpMockDocuments === "object") {
    var mock = g.__jlcMcpMockDocuments;
    var docs = Array.isArray(mock.documents) ? mock.documents : [];
    if (filterProjUuid) {
      docs = docs.filter(function(d) { return d.projectUuid === filterProjUuid; });
    }
    return {
      projects: Array.isArray(mock.projects) ? mock.projects : [],
      documents: docs
    };
  }

  var projects = [];
  var documents = [];
  if (!eda) {
    return { projects: projects, documents: documents };
  }

  try {
    var proj = eda.dmt_Project && typeof eda.dmt_Project.getCurrentProjectInfo === "function"
      ? await eda.dmt_Project.getCurrentProjectInfo()
      : null;
    if (proj) {
      projects.push({
        projectUuid: String(proj.uuid || ""),
        name: String(proj.friendlyName || proj.name || ""),
        path: String(proj.path || "")
      });
    }
    if (!filterProjUuid || (proj && proj.uuid === filterProjUuid)) {
      if (eda.dmt_Schematic && typeof eda.dmt_Schematic.getAllSchematicPagesInfo === "function") {
        var pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
        if (Array.isArray(pages)) {
          for (var i = 0; i < pages.length; i++) {
            var pg = pages[i];
            documents.push({
              handle: String(pg.name || pg.uuid),
              uuid: String(pg.uuid),
              title: String(pg.name || pg.uuid),
              type: "SCH",
              projectUuid: proj ? String(proj.uuid || "") : null,
              isActive: false,
              isDirty: false,
              readOnly: false,
              selectionCount: 0,
              activeInteractiveTool: null
            });
          }
        }
      }
      if (eda.dmt_Pcb && typeof eda.dmt_Pcb.getAllPcbsInfo === "function") {
        var pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
        if (Array.isArray(pcbs)) {
          for (var j = 0; j < pcbs.length; j++) {
            var pcb = pcbs[j];
            documents.push({
              handle: String(pcb.name || pcb.uuid),
              uuid: String(pcb.uuid),
              title: String(pcb.name || pcb.uuid),
              type: "PCB",
              projectUuid: proj ? String(proj.uuid || "") : null,
              isActive: false,
              isDirty: false,
              readOnly: false,
              selectionCount: 0,
              activeInteractiveTool: null
            });
          }
        }
      }
    }
  } catch (e) {}

  return { projects: projects, documents: documents };
}`;

const FN_ACTIVATE_DOCUMENT = `async function(payload) {
  var g = globalThis;
  var docKey = payload && payload.document ? String(payload.document) : "";
  var eda = g.eda;

  if (g.__jlcMcpMockActivate && typeof g.__jlcMcpMockActivate === "function") {
    return await g.__jlcMcpMockActivate(docKey);
  }
  if (eda && eda.dmt_EditorControl) {
    if (typeof eda.dmt_EditorControl.activateDocument === "function") {
      await eda.dmt_EditorControl.activateDocument(docKey);
    } else if (typeof eda.dmt_EditorControl.openDocument === "function") {
      await eda.dmt_EditorControl.openDocument(docKey);
    }
    return { activated: true, handle: docKey };
  }
  return { activated: true, handle: docKey };
}`;

const FN_CLOSE_DOCUMENT = `async function(payload) {
  var g = globalThis;
  var docKey = payload && payload.document ? String(payload.document) : "";
  var discard = Boolean(payload && payload.discardChanges);
  var eda = g.eda;

  if (g.__jlcMcpMockCloseDocument && typeof g.__jlcMcpMockCloseDocument === "function") {
    return await g.__jlcMcpMockCloseDocument(docKey, discard);
  }

  var closed = false;
  if (eda && eda.dmt_EditorControl && typeof eda.dmt_EditorControl.closeDocument === "function") {
    closed = Boolean(await eda.dmt_EditorControl.closeDocument(docKey));
  } else {
    closed = true;
  }

  var remainingOpen = 0;
  if (eda && eda.dmt_EditorControl && typeof eda.dmt_EditorControl.getSplitScreenTree === "function") {
    var tree = await eda.dmt_EditorControl.getSplitScreenTree();
    var stack = tree ? [tree] : [];
    while (stack.length > 0) {
      var node = stack.pop();
      if (node.tabs && Array.isArray(node.tabs)) {
        remainingOpen += node.tabs.length;
      }
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) stack.push(node.children[i]);
      }
    }
  }
  return { closed: closed, remainingOpenCount: remainingOpen };
}`;

async function defaultHttpJsonFetch(
  port: number,
  endpoint: string,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: endpoint,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode ?? "ERR"} on 127.0.0.1:${port}${endpoint}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function defaultProcessSpawner(
  exePath: string,
  args: string[]
): { pid?: number; unref?: () => void } {
  const child: ChildProcess = spawn(exePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child;
}

function isUnactivatedUrl(url: string): boolean {
  return /entry=regist|activated=not/i.test(url);
}

function isIgnoredTarget(target: RawCdpTarget): boolean {
  const t = (target.type || "").toLowerCase();
  const u = (target.url || "").toLowerCase();
  if (
    t === "service_worker" ||
    t === "shared_worker" ||
    t === "worker" ||
    t === "background_page" ||
    t === "other"
  ) {
    return true;
  }
  if (u.startsWith("devtools://") || u.startsWith("chrome-extension://")) {
    return true;
  }
  return false;
}

function matchesEditorType(
  docType: TargetDocType,
  editorType: "any" | "sch" | "pcb" | undefined
): boolean {
  if (!editorType || editorType === "any") {
    return false;
  }
  if (editorType === "pcb") {
    return docType === "PCB" || docType === "FOOTPRINT";
  }
  if (editorType === "sch") {
    return docType === "SCH" || docType === "SYMBOL";
  }
  return false;
}

function isActiveEditorDocType(docType: TargetDocType): boolean {
  return (
    docType === "SCH" ||
    docType === "PCB" ||
    docType === "SYMBOL" ||
    docType === "FOOTPRINT" ||
    docType === "PANEL"
  );
}

function scoreTargetCandidate(
  target: ProbedTargetInfo,
  processInfo: CdpProcessInfo | undefined,
  options: CdpConnectOptions
): number {
  let score = 0;

  if (options.targetDocument) {
    const wanted = options.targetDocument.trim().toLowerCase();
    const fields = [
      target.docUuid,
      target.title,
      target.projectUuid,
      target.projectName,
    ]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => s.toLowerCase());

    if (fields.some((f) => f === wanted)) {
      score += 1000;
    } else if (fields.some((f) => f.includes(wanted))) {
      score += 700;
    }
  }

  if (matchesEditorType(target.docType, options.editorType)) {
    score += 500;
  }

  if (isActiveEditorDocType(target.docType)) {
    score += 300;
  } else if (target.docType === "HOME") {
    score += 0;
  } else {
    score -= 50;
  }

  if (target.primitiveCount > 0) {
    score += 50;
  }
  if (target.isActive) {
    score += 25;
  }

  if (processInfo) {
    score += Math.max(10, 100 - processInfo.zOrder * 15);
    if (processInfo.isForeground) {
      score += 30;
    }
    if (options.processId && processInfo.pid === options.processId) {
      score += 2000;
    }
  }

  if (options.cdpPort && target.port === options.cdpPort) {
    score += 2000;
  }

  return score;
}

/**
 * Multi-instance & multi-tab CDP router implementing `ICdpSessionManager`:
 * - Multi-channel CDP port discovery (Win32 cmdline + optional `DevToolsActivePort` + HTTP `/json/version` 19222..19229)
 * - Strictly whitelisted cold launch flags (forbids UNKNOWN_FLAG triggers)
 * - Compliant `entry=regist` / `activated=not` gating (`ERR_CLIENT_NOT_ACTIVATED`)
 * - Non-destructive handling of existing instances without CDP (`ERR_INSTANCE_WITHOUT_CDP`)
 * - 4-step scoring to skip `service_worker`, `devtools://`, and `HOME` welcome screens
 * - Flat Session (`Target.attachToTarget({ flatten: true })`) hot-switching + bypass `getSessionStatus()`
 */
export class CdpTargetRouter implements ICdpSessionManager {
  private readonly options: CdpSessionManagerOptions;
  private readonly handlePool = new HandlePool();
  private readonly launchedByMcpPids = new Set<number>();

  private activeTransport: CdpProtocolTransport | null = null;
  private activeExecutor: CdpRpcExecutor | null = null;
  private boundInstance: ConnectedInstanceState | null = null;
  private tabRoutes = new Map<string, TabRouteEntry>();
  private lastKnownInstances: CdpProcessInfo[] = [];

  constructor(options: CdpSessionManagerOptions = {}) {
    this.options = { ...options };
  }

  /**
   * Hot-update client executable, profile paths, or CDP port range at runtime
   * (used by `jlc_configure` so users don't have to restart the MCP server).
   */
  public updateRuntimeOptions(patch: {
    exePath?: string | null;
    defaultUserDataDir?: string | null;
    headlessProfileDir?: string | null;
    portRange?: [number, number];
  }): void {
    if ("exePath" in patch) {
      this.options.exePath = patch.exePath;
    }
    if ("defaultUserDataDir" in patch) {
      this.options.defaultUserDataDir = patch.defaultUserDataDir;
    }
    if ("headlessProfileDir" in patch) {
      this.options.headlessProfileDir = patch.headlessProfileDir;
    }
    if (patch.portRange !== undefined) {
      this.options.portRange = patch.portRange;
    }
  }

  /**
   * Launch JLCEDA Pro with strictly whitelisted CDP flags, or reuse an existing CDP instance.
   * Never kills a user's non-CDP instance.
   */
  public async launchClient(options: CdpLaunchOptions = {}): Promise<CdpLaunchResult> {
    const exePath = this.options.exePath ?? null;
    if (!exePath) {
      return {
        launched: false,
        alreadyRunning: false,
        pid: null,
        exePath: null,
        cdpPort: null,
        cdpReady: false,
        activationRequired: false,
        launchArgs: [],
        errorCode: "ERR_CLIENT_PATH_REQUIRED",
        message:
          "未配置嘉立创EDA 专业版路径。请先调用 jlc_configure 自动扫描或输入安装路径。",
      };
    }

    const win32Scanner = this.options.win32Scanner ?? scanLcedaWin32State;
    const win32Snap = await win32Scanner(this.options.win32ScanOptions);
    const discovered = await this.discoverEndpoints(
      win32Snap.processes,
      options.cdpPort ?? undefined
    );

    // 1. Reuse existing CDP-enabled instance unless caller explicitly requests a new/isolated one
    if (
      discovered.endpoints.length > 0 &&
      !options.forceNewInstance &&
      !options.isolatedHeadless
    ) {
      const existing =
        (options.cdpPort
          ? discovered.endpoints.find((e) => e.port === options.cdpPort)
          : undefined) ?? discovered.endpoints[0];
      const matchedProc = win32Snap.processes.find((p) => p.cdpPort === existing.port);
      const activationRequired =
        existing.targets.length > 0 &&
        existing.targets.every((t) => isUnactivatedUrl(t.url) || isIgnoredTarget(t)) &&
        existing.targets.some((t) => isUnactivatedUrl(t.url));
      return {
        launched: false,
        alreadyRunning: true,
        pid: matchedProc?.pid ?? null,
        exePath,
        cdpPort: existing.port,
        cdpReady: true,
        activationRequired,
        launchArgs: [],
        message: activationRequired
          ? `嘉立创EDA 专业版已在运行（CDP 端口 ${existing.port}），当前停留在首次登录/激活界面，请在软件窗口内完成登录激活。`
          : `嘉立创EDA 专业版已在运行（CDP 端口 ${existing.port}），可直接调用 jlc_connect 连接。`,
      };
    }

    // 2. Existing non-CDP instance detected and caller did not ask for isolatedHeadless/forceNewInstance
    if (
      discovered.endpoints.length === 0 &&
      win32Snap.processes.length > 0 &&
      !options.isolatedHeadless &&
      !options.forceNewInstance
    ) {
      return {
        launched: false,
        alreadyRunning: true,
        pid: win32Snap.processes[0]?.pid ?? null,
        exePath,
        cdpPort: null,
        cdpReady: false,
        activationRequired: false,
        launchArgs: [],
        errorCode: "ERR_INSTANCE_WITHOUT_CDP",
        message:
          "检测到嘉立创EDA 专业版已在运行但未开启 CDP 调试端口。为保护未保存工程，未强行关闭现有窗口；请关闭现有窗口后重试，或传 isolatedHeadless=true 使用独立配置并行拉起。",
      };
    }

    // 3. Allocate port and spawn with strictly whitelisted flags
    const [startPort, endPort] = this.options.portRange ?? [
      DEFAULT_CDP_PORT_START,
      DEFAULT_CDP_PORT_END,
    ];
    const occupiedPorts = new Set(discovered.endpoints.map((e) => e.port));
    let port = options.cdpPort ?? startPort;
    if (!options.cdpPort) {
      while (occupiedPorts.has(port) && port <= endPort) {
        port++;
      }
    }

    const args = buildLcedaLaunchArgs({
      cdpPort: port,
      userDataDir: options.isolatedHeadless
        ? this.options.headlessProfileDir ?? undefined
        : undefined,
    });

    const spawner = this.options.processSpawner ?? defaultProcessSpawner;
    const child = spawner(exePath, args);
    const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
    if (pid !== null) {
      this.launchedByMcpPids.add(pid);
    }

    const waitMs = Math.max(500, Math.min(options.waitForCdpMs ?? 10000, 30000));
    const fetcher = this.options.httpFetcher ?? defaultHttpJsonFetch;
    const deadline = Date.now() + waitMs;
    let cdpReady = false;
    let activationRequired = false;

    while (Date.now() < deadline) {
      try {
        const raw = await fetcher(port, "/json/list", 400);
        if (Array.isArray(raw)) {
          cdpReady = true;
          const targets = raw as RawCdpTarget[];
          activationRequired =
            targets.length > 0 &&
            targets.some((t) => isUnactivatedUrl(t.url)) &&
            targets.every((t) => isUnactivatedUrl(t.url) || isIgnoredTarget(t));
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    return {
      launched: true,
      alreadyRunning: false,
      pid,
      exePath,
      cdpPort: port,
      cdpReady,
      activationRequired,
      launchArgs: args,
      message: !cdpReady
        ? `已启动嘉立创EDA 专业版（PID=${pid ?? "unknown"}），但 CDP 端口 ${port} 在 ${waitMs}ms 内尚未就绪，可稍后调用 jlc_connect。`
        : activationRequired
          ? `已启动嘉立创EDA 专业版（PID=${pid ?? "unknown"}，CDP 端口 ${port}），当前停留在首次登录/激活界面，请在软件窗口完成登录激活后再调用 jlc_connect。`
          : `已成功启动嘉立创EDA 专业版（PID=${pid ?? "unknown"}，CDP 端口 ${port}）。`,
    };
  }

  public isConnected(): boolean {
    return (
      this.boundInstance !== null &&
      this.activeTransport !== null &&
      this.activeTransport.isOpen()
    );
  }

  public getCollaborationMode(): CollaborationMode | null {
    return this.boundInstance?.collaborationMode ?? null;
  }

  public getExecutor(): ICdpRpcExecutor {
    if (!this.activeExecutor) {
      throw new Error(
        "ERR_NOT_CONNECTED: CDP session is not connected. Call connect() first."
      );
    }
    return this.activeExecutor;
  }

  public getHandlePool(): HandlePool {
    return this.handlePool;
  }

  public async disconnect(): Promise<void> {
    if (this.activeExecutor) {
      await this.activeExecutor.releaseObjectGroup().catch(() => undefined);
    }
    if (this.activeTransport) {
      await this.activeTransport.close().catch(() => undefined);
    }
    this.activeTransport = null;
    this.activeExecutor = null;
    this.boundInstance = null;
    this.tabRoutes.clear();
  }

  public async connect(
    connectOptions: CdpConnectOptions = {}
  ): Promise<CdpConnectDiagnosticResult> {
    const win32Scanner = this.options.win32Scanner ?? scanLcedaWin32State;
    const win32Snap = await win32Scanner(this.options.win32ScanOptions);

    const discovered = await this.discoverEndpoints(
      win32Snap.processes,
      connectOptions.cdpPort ?? undefined
    );

    // Handle launching if no CDP endpoints found (or isolated parallel instance requested)
    const shouldLaunchIsolated =
      connectOptions.isolatedHeadless === true &&
      connectOptions.launch !== false &&
      (discovered.endpoints.length === 0 ||
        win32Snap.processes.some((p) => !p.hasCdp));

    if (
      (discovered.endpoints.length === 0 && connectOptions.launch === true) ||
      shouldLaunchIsolated
    ) {
      const launchedPort = await this.launchClientInstance({
        preferredPort: connectOptions.cdpPort ?? undefined,
        isolatedHeadless: Boolean(connectOptions.isolatedHeadless),
        occupiedPorts: new Set(discovered.endpoints.map((e) => e.port)),
      });

      const refreshedWin32 = await win32Scanner(this.options.win32ScanOptions);
      const refreshed = await this.discoverEndpoints(
        refreshedWin32.processes,
        launchedPort
      );

      return this.finishConnect(
        refreshedWin32,
        refreshed.endpoints,
        connectOptions,
        true
      );
    }

    // Running instance(s) detected without CDP and launch=false -> strictly do NOT kill user process!
    if (
      discovered.endpoints.length === 0 &&
      win32Snap.processes.length > 0 &&
      connectOptions.launch !== true
    ) {
      this.lastKnownInstances = win32Snap.processes;
      const titles = win32Snap.processes
        .map((p) => p.windowTitle || `PID ${p.pid}`)
        .join(", ");
      return {
        connected: false,
        errorCode: "ERR_INSTANCE_WITHOUT_CDP",
        collaborationMode: "interactive_copilot",
        boundInstance: null,
        instances: win32Snap.processes,
        closedEmptyPids: [],
        remediation: `检测到用户已打开嘉立创EDA专业版实例（${titles}），但未开启 --remote-debugging-port。严禁强杀用户进程！请先保存工程并带调试参数重启，或传 launch=true 与 isolatedHeadless=true 启动独立并行实例。`,
      };
    }

    if (discovered.endpoints.length === 0) {
      this.lastKnownInstances = win32Snap.processes;
      return {
        connected: false,
        errorCode: "ERR_NO_CDP_INSTANCE",
        collaborationMode: "interactive_copilot",
        boundInstance: null,
        instances: win32Snap.processes,
        closedEmptyPids: [],
        remediation:
          "未检测到任何正在运行或开启 CDP 的嘉立创EDA专业版实例。请先启动客户端或调用 jlc_connect({ launch: true })。",
      };
    }

    return this.finishConnect(
      win32Snap,
      discovered.endpoints,
      connectOptions,
      false
    );
  }

  private async finishConnect(
    win32Snap: Win32ScanSnapshot,
    endpoints: HttpEndpointSnapshot[],
    connectOptions: CdpConnectOptions,
    wasJustLaunched: boolean
  ): Promise<CdpConnectDiagnosticResult> {
    const probedByPort = new Map<number, ProbedTargetInfo[]>();
    const allProbed: ProbedTargetInfo[] = [];

    // Probe all endpoints concurrently (Step 1 + Step 2)
    await Promise.all(
      endpoints.map(async (ep) => {
        const filtered = ep.targets.filter((t) => !isIgnoredTarget(t));
        const probedList = await Promise.all(
          filtered.map((raw) => this.probeSingleTarget(ep, raw))
        );
        probedByPort.set(ep.port, probedList);
        allProbed.push(...probedList);
      })
    );

    const instances = this.mergeInstancesWithTargets(
      win32Snap.processes,
      endpoints,
      probedByPort
    );
    this.lastKnownInstances = instances;

    // Check unactivated first-install state (`entry=regist` / `activated=not`)
    const hasActiveEditor = allProbed.some(
      (t) => !t.isUnactivated && isActiveEditorDocType(t.docType)
    );
    const hasUnactivated = allProbed.some((t) => t.isUnactivated);
    if (!hasActiveEditor && hasUnactivated) {
      return {
        connected: false,
        errorCode: "ERR_CLIENT_NOT_ACTIVATED",
        collaborationMode: "interactive_copilot",
        boundInstance: null,
        instances,
        closedEmptyPids: [],
        remediation:
          "检测到嘉立创EDA专业版处于首次安装未激活/未登录状态（URL 包含 entry=regist 或 activated=not，且无活跃编辑器上下文）。严禁绕过登录激活！请在客户端窗口内手动完成账号登录激活后重试。",
      };
    }

    // Step 3: Score & rank candidates
    const candidates = allProbed.filter((t) => !t.isUnactivated);
    if (candidates.length === 0) {
      return {
        connected: false,
        errorCode: "ERR_NO_ACTIVE_TARGET",
        collaborationMode: "interactive_copilot",
        boundInstance: null,
        instances,
        closedEmptyPids: [],
        remediation: "未发现可附着的页面 Target。",
      };
    }

    const procByPort = new Map<number, CdpProcessInfo>();
    for (const inst of instances) {
      if (inst.cdpPort !== null) {
        procByPort.set(inst.cdpPort, inst);
      }
    }

    const scored = candidates
      .map((target) => ({
        target,
        proc: procByPort.get(target.port),
        score: scoreTargetCandidate(
          target,
          procByPort.get(target.port),
          connectOptions
        ),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const bestEndpoint = endpoints.find((e) => e.port === best.target.port)!;

    // Step 4: Optionally close idle HOME-only empty instances
    const closedEmptyPids: number[] = [];
    if (connectOptions.closeEmptyInstances) {
      for (const inst of instances) {
        if (inst.cdpPort === null || inst.cdpPort === best.target.port) {
          continue;
        }
        const portTargets = probedByPort.get(inst.cdpPort) ?? [];
        const onlyHomeOrEmpty =
          portTargets.length > 0 &&
          portTargets.every(
            (t) =>
              t.docType === "HOME" &&
              !t.projectUuid &&
              t.domModals.length === 0
          );
        const hasWin32Modals = win32Snap.modalDialogs.length > 0;
        if (onlyHomeOrEmpty && !hasWin32Modals) {
          const epToClose = endpoints.find((e) => e.port === inst.cdpPort);
          if (epToClose && (await this.closeInstanceGracefully(epToClose))) {
            closedEmptyPids.push(inst.pid);
          }
        }
      }
    }

    // Establish persistent WebSocket connection to winning instance/target
    await this.disconnect();

    const wsConnector = this.options.wsConnector ?? WebSocketCdpTransport.connect;
    let transport: CdpProtocolTransport;
    let activeSessionId: string | undefined;
    let flatSessionSupported = false;

    if (bestEndpoint.version?.webSocketDebuggerUrl) {
      const browserTransport = await wsConnector(
        bestEndpoint.version.webSocketDebuggerUrl,
        3000
      );
      try {
        const attachRes = await browserTransport.sendCommand<{ sessionId?: string }>(
          "Target.attachToTarget",
          { targetId: best.target.targetId, flatten: true }
        );
        if (attachRes?.sessionId) {
          transport = browserTransport;
          activeSessionId = attachRes.sessionId;
          flatSessionSupported = true;
        } else {
          await browserTransport.close().catch(() => undefined);
          transport = await wsConnector(
            best.target.webSocketDebuggerUrl ??
              `ws://127.0.0.1:${best.target.port}/devtools/page/${best.target.targetId}`,
            3000
          );
        }
      } catch {
        await browserTransport.close().catch(() => undefined);
        transport = await wsConnector(
          best.target.webSocketDebuggerUrl ??
            `ws://127.0.0.1:${best.target.port}/devtools/page/${best.target.targetId}`,
          3000
        );
      }
    } else {
      transport = await wsConnector(
        best.target.webSocketDebuggerUrl ??
          `ws://127.0.0.1:${best.target.port}/devtools/page/${best.target.targetId}`,
        3000
      );
    }

    this.activeTransport = transport;
    this.activeExecutor = new CdpRpcExecutor({
      transport,
      handlePool: this.handlePool,
      softTimeoutMs: this.options.softTimeoutMs,
      hardTerminateGraceMs: this.options.hardTerminateGraceMs,
      resolveSession: (doc) => this.resolveTargetSession(doc),
    });

    // Enable Runtime/Page/Target events best-effort
    await transport
      .sendCommand("Runtime.enable", {}, activeSessionId)
      .catch(() => undefined);
    await transport
      .sendCommand("Page.enable", {}, activeSessionId)
      .catch(() => undefined);

    if (best.target.executionContextId !== undefined) {
      this.activeExecutor.setSessionExecutionContext(
        activeSessionId ?? best.target.targetId,
        best.target.executionContextId
      );
    }

    const boundPid = best.proc?.pid ?? 0;
    const isOfflineMode =
      wasJustLaunched ||
      connectOptions.isolatedHeadless === true ||
      this.launchedByMcpPids.has(boundPid);

    const collaborationMode: CollaborationMode = isOfflineMode
      ? "offline_delivery"
      : "interactive_copilot";

    const docHandle = best.target.title || best.target.docUuid || null;

    this.boundInstance = {
      pid: boundPid,
      cdpPort: best.target.port,
      clientVersion: bestEndpoint.version?.Browser ?? null,
      projectUuid: best.target.projectUuid,
      browserWsUrl: bestEndpoint.version?.webSocketDebuggerUrl,
      browserTransport: flatSessionSupported ? transport : undefined,
      activeTargetId: best.target.targetId,
      activeSessionId,
      activeDocHandle: docHandle,
      activeDocUuid: best.target.docUuid,
      activeDocType: best.target.docType,
      collaborationMode,
      flatSessionSupported,
    };

    // Populate Flat Session multi-tab routing table for this instance
    this.tabRoutes.clear();
    const samePortTargets = probedByPort.get(best.target.port) ?? [];
    for (const pt of samePortTargets) {
      if (pt.isUnactivated) continue;
      let sessId = pt.targetId === best.target.targetId ? activeSessionId : undefined;
      if (!sessId && flatSessionSupported && pt.targetId !== best.target.targetId) {
        try {
          const attached = await transport.sendCommand<{ sessionId?: string }>(
            "Target.attachToTarget",
            { targetId: pt.targetId, flatten: true }
          );
          sessId = attached?.sessionId;
          if (sessId) {
            await transport
              .sendCommand("Runtime.enable", {}, sessId)
              .catch(() => undefined);
          }
        } catch {
          // Ignore attach failure on secondary tab
        }
      }
      const routeEntry: TabRouteEntry = {
        targetId: pt.targetId,
        sessionId: sessId,
        executionContextId: pt.executionContextId,
        docType: pt.docType,
        docUuid: pt.docUuid ?? pt.targetId,
        title: pt.title || pt.docUuid || pt.targetId,
        projectUuid: pt.projectUuid,
        wsUrl: pt.webSocketDebuggerUrl,
      };
      this.tabRoutes.set(routeEntry.docUuid, routeEntry);
      if (routeEntry.title) {
        this.tabRoutes.set(routeEntry.title, routeEntry);
      }
      this.tabRoutes.set(routeEntry.targetId, routeEntry);
    }

    return {
      connected: true,
      collaborationMode,
      boundInstance: {
        pid: boundPid,
        cdpPort: best.target.port,
        clientVersion: bestEndpoint.version?.Browser ?? null,
        projectUuid: best.target.projectUuid,
        activeDocHandle: docHandle,
        activeDocType: best.target.docType,
      },
      instances,
      closedEmptyPids,
    };
  }

  public async getSessionStatus(): Promise<SessionStatusData> {
    const win32Scanner = this.options.win32Scanner ?? scanLcedaWin32State;
    const win32Promise = win32Scanner(this.options.win32ScanOptions).catch(
      () =>
        ({
          platformSupported: false,
          processes: [],
          windows: [],
          modalDialogs: [],
          timedOut: false,
        }) satisfies Win32ScanSnapshot
    );

    let domModals: ModalDialogInfo[] = [];
    let progressBar: SessionStatusData["activeProgressBar"] = null;

    const domProbePromise = (async () => {
      if (!this.activeExecutor || !this.activeTransport?.isOpen()) {
        return;
      }
      try {
        const res = await this.activeExecutor.evaluateBypass<{
          activeModalDialogs?: ModalDialogInfo[];
          activeProgressBar?: SessionStatusData["activeProgressBar"];
        }>(FN_PROBE_BYPASS_STATUS, [], {
          targetId: this.boundInstance?.activeTargetId,
          sessionId: this.boundInstance?.activeSessionId,
          timeoutMs: 800,
        });
        if (Array.isArray(res?.activeModalDialogs)) {
          domModals = res.activeModalDialogs;
        }
        if (res?.activeProgressBar) {
          progressBar = res.activeProgressBar;
        }
      } catch {
        // Bypass status must remain non-blocking even if target is temporarily frozen
      }
    })();

    const [win32Snap] = await Promise.all([win32Promise, domProbePromise]);

    const allProcesses =
      win32Snap.processes.length > 0
        ? win32Snap.processes
        : this.lastKnownInstances;

    return {
      connectedPid: this.boundInstance?.pid ?? null,
      connectedPort: this.boundInstance?.cdpPort ?? null,
      collaborationMode: this.boundInstance?.collaborationMode ?? null,
      rpcQueueDepth: this.activeExecutor?.getRpcQueueDepth() ?? 0,
      activeModalDialogs: [...win32Snap.modalDialogs, ...domModals],
      activeProgressBar: progressBar,
      allProcesses,
    };
  }

  public async listDocuments(projectUuid?: string | null): Promise<{
    projects: Array<{ projectUuid: string; name: string; path: string }>;
    documents: DocumentSummary[];
  }> {
    const exec = this.getExecutor() as CdpRpcExecutor;
    const session = await this.resolveTargetSession(null);

    const inPage = await exec.callFunction<{
      projects: Array<{ projectUuid: string; name: string; path: string }>;
      documents: DocumentSummary[];
    }>(FN_LIST_DOCUMENTS, [{ projectUuid: projectUuid ?? null }], {
      targetId: session.targetId,
      sessionId: session.sessionId,
      executionContextId: session.executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });

    const docs = Array.isArray(inPage?.documents) ? [...inPage.documents] : [];
    const seenUuids = new Set(docs.map((d) => d.uuid));

    // Also include distinct multi-target CDP tabs known to the router
    const uniqueRoutes = new Map<string, TabRouteEntry>();
    for (const entry of this.tabRoutes.values()) {
      uniqueRoutes.set(entry.targetId, entry);
    }
    for (const route of uniqueRoutes.values()) {
      if (route.docType === "HOME" || seenUuids.has(route.docUuid)) {
        continue;
      }
      if (projectUuid && route.projectUuid && route.projectUuid !== projectUuid) {
        continue;
      }
      docs.push({
        handle: route.title,
        uuid: route.docUuid,
        title: route.title,
        type: route.docType,
        projectUuid: route.projectUuid ?? null,
        isActive: route.targetId === this.boundInstance?.activeTargetId,
        isDirty: false,
        readOnly: false,
        selectionCount: 0,
        activeInteractiveTool: null,
      });
    }

    return {
      projects: Array.isArray(inPage?.projects) ? inPage.projects : [],
      documents: docs,
    };
  }

  public async activateDocument(document: string): Promise<{
    activeDocumentHandle: string;
    type: TargetDocType;
    targetContextId: string;
  }> {
    const exec = this.getExecutor() as CdpRpcExecutor;
    if (!this.boundInstance || !this.activeTransport) {
      throw new Error("ERR_NOT_CONNECTED: Not connected to any CDP instance.");
    }

    // Check if `document` maps to a different CDP target tab in this instance
    const route = this.findTabRoute(document);
    if (route) {
      if (
        this.boundInstance.flatSessionSupported &&
        route.targetId !== this.boundInstance.activeTargetId
      ) {
        let sessionId = route.sessionId;
        if (!sessionId) {
          const attached = await this.activeTransport.sendCommand<{
            sessionId?: string;
          }>("Target.attachToTarget", {
            targetId: route.targetId,
            flatten: true,
          });
          sessionId = attached?.sessionId;
          route.sessionId = sessionId;
          if (sessionId) {
            await this.activeTransport
              .sendCommand("Runtime.enable", {}, sessionId)
              .catch(() => undefined);
          }
        }
        await this.activeTransport
          .sendCommand("Target.activateTarget", { targetId: route.targetId })
          .catch(() => undefined);

        this.boundInstance.activeTargetId = route.targetId;
        this.boundInstance.activeSessionId = sessionId;
        this.boundInstance.activeDocHandle = route.title;
        this.boundInstance.activeDocUuid = route.docUuid;
        this.boundInstance.activeDocType = route.docType;

        return {
          activeDocumentHandle: route.title,
          type: route.docType,
          targetContextId: sessionId ?? route.targetId,
        };
      }
    }

    // Fallback: switch tab inside active renderer via eda.dmt_EditorControl
    await exec.callFunction(FN_ACTIVATE_DOCUMENT, [{ document }], {
      targetId: this.boundInstance.activeTargetId,
      sessionId: this.boundInstance.activeSessionId,
      awaitPromise: true,
      returnByValue: true,
    });

    const docType = route?.docType ?? this.boundInstance.activeDocType;
    this.boundInstance.activeDocHandle = document;
    if (route) {
      this.boundInstance.activeDocUuid = route.docUuid;
      this.boundInstance.activeDocType = route.docType;
    }

    return {
      activeDocumentHandle: document,
      type: docType,
      targetContextId:
        this.boundInstance.activeSessionId ?? this.boundInstance.activeTargetId,
    };
  }

  public async resolveTargetSession(
    document?: string | null
  ): Promise<{
    targetId: string;
    sessionId?: string;
    executionContextId?: number;
    docType: TargetDocType;
    docUuid?: string | null;
  }> {
    if (!this.boundInstance) {
      throw new Error("ERR_NOT_CONNECTED: Not connected to any CDP instance.");
    }

    if (document) {
      const route = this.findTabRoute(document);
      if (route) {
        return {
          targetId: route.targetId,
          sessionId: route.sessionId ?? this.boundInstance.activeSessionId,
          executionContextId: route.executionContextId,
          docType: route.docType,
          docUuid: route.docUuid,
        };
      }
    }

    return {
      targetId: this.boundInstance.activeTargetId,
      sessionId: this.boundInstance.activeSessionId,
      docType: this.boundInstance.activeDocType,
      docUuid: this.boundInstance.activeDocUuid,
    };
  }

  public async closeDocument(options: {
    document: string;
    discardChanges?: boolean;
    releaseProcess?: boolean;
  }): Promise<{
    closed: boolean;
    lockReleased: boolean;
    processExited: boolean;
  }> {
    const exec = this.getExecutor() as CdpRpcExecutor;
    const session = await this.resolveTargetSession(options.document);

    const closeRes = await exec.callFunction<{
      closed?: boolean;
      remainingOpenCount?: number;
    }>(
      FN_CLOSE_DOCUMENT,
      [
        {
          document: options.document,
          discardChanges: Boolean(options.discardChanges),
        },
      ],
      {
        targetId: session.targetId,
        sessionId: session.sessionId,
        executionContextId: session.executionContextId,
        awaitPromise: true,
        returnByValue: true,
      }
    );

    const closed = closeRes?.closed !== false;
    await exec.releaseObjectGroup().catch(() => undefined);

    let remainingOpen = closeRes?.remainingOpenCount ?? 0;
    if (remainingOpen === 0 && this.boundInstance) {
      // Also check if other non-HOME targets remain on this port
      const remainingTabs = Array.from(
        new Map(
          Array.from(this.tabRoutes.values()).map((r) => [r.targetId, r])
        ).values()
      ).filter(
        (r) =>
          r.docType !== "HOME" &&
          r.title !== options.document &&
          r.docUuid !== options.document
      );
      remainingOpen = remainingTabs.length;
    }

    let processExited = false;
    let lockReleased = closed;

    const mayExitProcess =
      options.releaseProcess === true &&
      remainingOpen === 0 &&
      this.boundInstance !== null &&
      (this.launchedByMcpPids.has(this.boundInstance.pid) ||
        this.boundInstance.collaborationMode === "offline_delivery");

    if (mayExitProcess && this.activeTransport) {
      try {
        await this.activeTransport.sendCommand("Browser.close", {});
        processExited = true;
        lockReleased = true;
      } catch {
        processExited = false;
      }
      await this.disconnect();
    }

    return {
      closed,
      lockReleased,
      processExited,
    };
  }

  private findTabRoute(document: string): TabRouteEntry | undefined {
    const direct = this.tabRoutes.get(document);
    if (direct) {
      return direct;
    }
    const lower = document.trim().toLowerCase();
    for (const route of this.tabRoutes.values()) {
      if (
        route.docUuid.toLowerCase() === lower ||
        route.title.toLowerCase() === lower ||
        route.targetId.toLowerCase() === lower
      ) {
        return route;
      }
    }
    return undefined;
  }

  private async discoverEndpoints(
    win32Processes: CdpProcessInfo[],
    explicitPort?: number
  ): Promise<{ endpoints: HttpEndpointSnapshot[] }> {
    const candidatePorts = new Set<number>();

    if (explicitPort && explicitPort > 0) {
      candidatePorts.add(explicitPort);
    }

    for (const proc of win32Processes) {
      if (proc.cdpPort) {
        candidatePorts.add(proc.cdpPort);
      }
      const activePort = readDevToolsActivePort(proc.userDataDir);
      if (activePort) {
        candidatePorts.add(activePort.port);
      }
    }

    const defaultActive = readDevToolsActivePort(this.options.defaultUserDataDir);
    if (defaultActive) {
      candidatePorts.add(defaultActive.port);
    }
    const headlessActive = readDevToolsActivePort(this.options.headlessProfileDir);
    if (headlessActive) {
      candidatePorts.add(headlessActive.port);
    }

    const [startPort, endPort] = this.options.portRange ?? [
      DEFAULT_CDP_PORT_START,
      DEFAULT_CDP_PORT_END,
    ];
    for (let p = startPort; p <= endPort; p++) {
      candidatePorts.add(p);
    }

    const fetcher = this.options.httpFetcher ?? defaultHttpJsonFetch;
    const httpTimeout = this.options.httpTimeoutMs ?? 450;

    const results = await Promise.all(
      Array.from(candidatePorts).map(
        async (port): Promise<HttpEndpointSnapshot | null> => {
          try {
            const [versionRes, listRes] = await Promise.all([
              fetcher(port, "/json/version", httpTimeout).catch(() => null),
              fetcher(port, "/json/list", httpTimeout).catch(() => null),
            ]);
            if (!versionRes && !Array.isArray(listRes)) {
              return null;
            }
            const targets = Array.isArray(listRes)
              ? (listRes as RawCdpTarget[])
              : [];
            return {
              port,
              version: (versionRes as CdpVersionInfo | null) ?? null,
              targets,
            };
          } catch {
            return null;
          }
        }
      )
    );

    return {
      endpoints: results.filter((r): r is HttpEndpointSnapshot => r !== null),
    };
  }

  private async probeSingleTarget(
    endpoint: HttpEndpointSnapshot,
    raw: RawCdpTarget
  ): Promise<ProbedTargetInfo> {
    const base: ProbedTargetInfo = {
      targetId: raw.id,
      port: endpoint.port,
      type: raw.type,
      title: raw.title ?? "",
      url: raw.url ?? "",
      webSocketDebuggerUrl: raw.webSocketDebuggerUrl,
      isUnactivated: isUnactivatedUrl(raw.url ?? ""),
      hasEda: false,
      docType: "UNKNOWN",
      docUuid: null,
      projectUuid: null,
      projectName: null,
      primitiveCount: 0,
      isActive: false,
      isDirty: false,
      readOnly: false,
      selectionCount: 0,
      activeInteractiveTool: null,
      domModals: [],
    };

    const wsUrl =
      raw.webSocketDebuggerUrl ??
      `ws://127.0.0.1:${endpoint.port}/devtools/page/${raw.id}`;
    const wsConnector = this.options.wsConnector ?? WebSocketCdpTransport.connect;
    const probeTimeout = this.options.probeTimeoutMs ?? 300;

    let transport: CdpProtocolTransport | null = null;
    try {
      transport = await wsConnector(wsUrl, Math.max(probeTimeout, 1000));
      const probeExec = new CdpRpcExecutor({
        transport,
        softTimeoutMs: probeTimeout,
        hardTerminateGraceMs: 200,
      });
      const res = await probeExec.callFunction<Partial<ProbedTargetInfo>>(
        FN_PROBE_TARGET_CONTEXT,
        [],
        {
          awaitPromise: true,
          returnByValue: true,
          timeoutMs: probeTimeout,
          isBypass: true,
        }
      );

      if (res && typeof res === "object") {
        return {
          ...base,
          isUnactivated: Boolean(res.isUnactivated || base.isUnactivated),
          hasEda: Boolean(res.hasEda),
          docType: (res.docType as TargetDocType) ?? base.docType,
          docUuid: res.docUuid ?? null,
          projectUuid: res.projectUuid ?? null,
          projectName: res.projectName ?? null,
          primitiveCount: Number(res.primitiveCount ?? 0),
          isActive: Boolean(res.isActive),
          isDirty: Boolean(res.isDirty),
          readOnly: Boolean(res.readOnly),
          selectionCount: Number(res.selectionCount ?? 0),
          activeInteractiveTool: res.activeInteractiveTool ?? null,
          domModals: Array.isArray(res.domModals) ? res.domModals : [],
        };
      }
      return base;
    } catch {
      // Fallback heuristic if probe timed out or target has no runtime yet
      if (!base.isUnactivated) {
        if (/home|welcome|start/i.test(base.title) || /home|welcome/i.test(base.url)) {
          base.docType = "HOME";
        } else if (/pcb/i.test(base.title)) {
          base.docType = "PCB";
        } else if (/sch|原理图/i.test(base.title)) {
          base.docType = "SCH";
        }
      }
      return base;
    } finally {
      if (transport) {
        await transport.close().catch(() => undefined);
      }
    }
  }

  private mergeInstancesWithTargets(
    win32Processes: CdpProcessInfo[],
    endpoints: HttpEndpointSnapshot[],
    probedByPort: Map<number, ProbedTargetInfo[]>
  ): CdpProcessInfo[] {
    const merged: CdpProcessInfo[] = [];
    const matchedPorts = new Set<number>();

    for (const proc of win32Processes) {
      const port = proc.cdpPort;
      const targets =
        port !== null
          ? (probedByPort.get(port) ?? []).map(toTargetDescriptor)
          : undefined;
      if (port !== null && probedByPort.has(port)) {
        matchedPorts.add(port);
      }
      merged.push({
        ...proc,
        hasCdp: port !== null && (probedByPort.has(port) || proc.hasCdp),
        targets,
      });
    }

    // Add HTTP-discovered CDP endpoints that didn't match a Win32 process (e.g. non-Windows or test mock)
    for (const ep of endpoints) {
      if (matchedPorts.has(ep.port)) {
        continue;
      }
      const targets = (probedByPort.get(ep.port) ?? []).map(toTargetDescriptor);
      const primary = targets.find((t) => isActiveEditorDocType(t.docType ?? "UNKNOWN")) ?? targets[0];
      merged.push({
        pid: 100000 + ep.port,
        exePath: this.options.exePath ?? null,
        commandLine: buildLcedaLaunchArgs({ cdpPort: ep.port }).join(" "),
        hasCdp: true,
        cdpPort: ep.port,
        userDataDir: null,
        windowTitle: primary?.title ?? `JLCEDA Pro (CDP :${ep.port})`,
        hwnd: null,
        zOrder: merged.length,
        isForeground: merged.length === 0,
        targets,
      });
    }

    return merged.sort((a, b) => a.zOrder - b.zOrder);
  }

  private async closeInstanceGracefully(
    endpoint: HttpEndpointSnapshot
  ): Promise<boolean> {
    const wsConnector = this.options.wsConnector ?? WebSocketCdpTransport.connect;
    const wsUrl =
      endpoint.version?.webSocketDebuggerUrl ??
      endpoint.targets[0]?.webSocketDebuggerUrl;
    if (!wsUrl) {
      return false;
    }
    let transport: CdpProtocolTransport | null = null;
    try {
      transport = await wsConnector(wsUrl, 1500);
      await transport.sendCommand("Browser.close", {});
      return true;
    } catch {
      return false;
    } finally {
      if (transport) {
        await transport.close().catch(() => undefined);
      }
    }
  }

  private async launchClientInstance(opts: {
    preferredPort?: number;
    isolatedHeadless: boolean;
    occupiedPorts: Set<number>;
  }): Promise<number> {
    const exePath = this.options.exePath;
    if (!exePath) {
      throw new Error(
        "ERR_CLIENT_NOT_INSTALLED: JLCEDA Pro executable path is not configured; cannot launch client."
      );
    }

    const [startPort, endPort] = this.options.portRange ?? [
      DEFAULT_CDP_PORT_START,
      DEFAULT_CDP_PORT_END,
    ];
    let port = opts.preferredPort ?? startPort;
    if (!opts.preferredPort) {
      while (opts.occupiedPorts.has(port) && port <= endPort) {
        port++;
      }
    }

    const args = buildLcedaLaunchArgs({
      cdpPort: port,
      userDataDir: opts.isolatedHeadless
        ? this.options.headlessProfileDir ?? undefined
        : undefined,
    });

    const spawner = this.options.processSpawner ?? defaultProcessSpawner;
    const child = spawner(exePath, args);
    if (typeof child.pid === "number" && child.pid > 0) {
      this.launchedByMcpPids.add(child.pid);
    }

    // Wait up to 8s for HTTP `/json/version` to start listening
    const fetcher = this.options.httpFetcher ?? defaultHttpJsonFetch;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        await fetcher(port, "/json/list", 400);
        return port;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return port;
  }
}

function toTargetDescriptor(t: ProbedTargetInfo): CdpTargetDescriptor {
  return {
    targetId: t.targetId,
    type: t.type,
    title: t.title,
    url: t.url,
    webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    docType: t.docType,
    docUuid: t.docUuid,
    projectUuid: t.projectUuid,
    projectName: t.projectName,
    primitiveCount: t.primitiveCount,
  };
}

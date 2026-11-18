import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type {
  ReaApiCatalogEntry,
  ReaApiDomain,
  ReaSecurityPolicy,
  ReaTargetContext,
} from "../types/index.js";
import type { AsarMemoryVfs } from "./asar-memory-vfs.js";

export type BundleRole = "main" | "preload" | "ui" | "pcb" | "sch" | "mgr" | "worker" | "api" | "other";

export interface BundleInput {
  fileName: string;
  code: string;
  role?: BundleRole;
}

export interface ClassMethodFingerprint {
  name: string;
  arity: number;
  isAsync: boolean;
}

export interface ClassFingerprintProfile {
  symbolName: string;
  bundleFile: string;
  moduleId: string | number;
  methods: ClassMethodFingerprint[];
  accessedProperties: string[];
  invariantStrings: string[];
  calledFunctions: string[];
}

export interface BundleScanResult {
  scannedFiles: string[];
  skippedFiles: string[];
  classProfiles: ClassFingerprintProfile[];
  l2Entries: ReaApiCatalogEntry[];
  l3Entries: ReaApiCatalogEntry[];
  l4Entries: ReaApiCatalogEntry[];
  drcRuleKeys: string[];
  errorConstants: string[];
  stateAccessors: string[];
  commandGraphEdges: Record<string, string[]>;
}

const SKIP_BUNDLE_RE =
  /(?:ocrSymbol|ocrTraining|tesseractCore|tesseractWorker|ocrsWorker|pcb3dview|pcb3d|panel3d|worker-3d|pdfViewer|pdfWorker|pdfSandbox|smt-gl-engine|chameleon-|welding-tools|silkViewer|potrace-worker|zipWorker)/i;

const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;

const SENSITIVE_CHANNEL_RE =
  /(?:auth|login|logout|token|cookie|passport|payment|credential|password|setuserinfo|clearuserinfo|authorization)/i;

const MODAL_COMMAND_RE =
  /(?:dialog|dlg|saveas|export\(|exportdsn|importses|importfile|openfile|print|about|setting|order|login|register|serial)/i;

const DRC_RULE_KEY_RE =
  /^(?:netClass(?:es|Manager|Compared)?|trackWidth(?:Setting)?|viaDiameter|viaDrill(?:ing)?|boardOutline(?:Inner)?|clearance(?:Error)?|safeSpacing|trackPhysics|radiusPhysics|padToLayerExpansion|diffPair(?:SpacingTables|EqualLengthTun(?:e|ing)|Flag)?|solderMaskExpansion|copperTo|pourClearance)/i;

const CODE_LIKE_STRING_RE =
  /(?:\bfunction\s*\w*\s*\([^)]*\)\s*\{|=>\s*\{|\b(?:var|let|const)\s+\w+\s*=|;\s*(?:return|if|for|while|throw)\b|__webpack_require__|module\.exports)/;

function sanitizeShortToken(raw: string, maxLen: number = 96): string | null {
  if (!raw || raw.length > maxLen) {
    return null;
  }
  if (/[\r\n\0]/.test(raw)) {
    return null;
  }
  if (CODE_LIKE_STRING_RE.test(raw)) {
    return null;
  }
  return raw;
}

function inferRoleFromPath(filePath: string): BundleRole {
  const lower = filePath.toLowerCase();
  if (lower === "app.js") return "main";
  if (lower.endsWith("preload.js")) return "preload";
  if (lower.includes("worker")) return "worker";
  if (lower.includes("pro-ui/")) return "ui";
  if (lower.includes("pro-pcb/")) return "pcb";
  if (lower.includes("pro-sch/")) return "sch";
  if (lower.includes("pro-mgr/")) return "mgr";
  if (lower.includes("pro-api/")) return "api";
  return "other";
}

function inferDomainFromText(text: string, role: BundleRole): ReaApiDomain {
  const lower = text.toLowerCase();
  if (/(?:drc|rule|clearance|spacing|width|via|netclass)/.test(lower)) return "DRC";
  if (/(?:simulat|spice|ngspice)/.test(lower)) return "SIM";
  if (/(?:zoom|view|viewport|pan|fit|grid|theme|render|camera)/.test(lower)) return "VIEW";
  if (/(?:pcb|dsn|ses|pour|copper|track|pad|footprint|diffpair|router|silk)/.test(lower)) return "PCB";
  if (/(?:sch|schematic|wire|symbol|netlist|bus|sheet)/.test(lower)) return "SCH";
  if (/(?:lib|device|footprint|lcsc|component|catalog)/.test(lower)) return "LIB";
  if (/(?:project|board|document|tab|folder|panel)/.test(lower)) return "DMT";
  if (role === "pcb") return "PCB";
  if (role === "sch") return "SCH";
  if (role === "worker") return "IPC";
  if (role === "main" || role === "preload") return "IPC";
  return "SYS";
}

function inferTargetContext(role: BundleRole, domain: ReaApiDomain): ReaTargetContext {
  if (role === "main") return "main_process";
  if (domain === "SCH" || domain === "SIM" || role === "sch") return "sch_renderer";
  if (domain === "PCB" || role === "pcb") return "pcb_renderer";
  return "any_editor_renderer";
}

function normalizeCapabilitySlug(raw: string): string {
  return raw
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitKeywords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[/\\:_.-]+/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function getStringLiteralValue(node: acorn.AnyNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function getPropertyKeyName(key: acorn.Expression | acorn.PrivateIdentifier): string | null {
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return getStringLiteralValue(key);
}

function getMemberCalleeName(callee: acorn.Expression | acorn.Super): {
  objectName: string | null;
  propName: string | null;
} {
  if (callee.type === "Identifier") {
    return { objectName: null, propName: callee.name };
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    const propName = callee.property.type === "Identifier" ? callee.property.name : null;
    if (callee.object.type === "Identifier") {
      return { objectName: callee.object.name, propName };
    }
    if (callee.object.type === "MemberExpression" && !callee.object.computed) {
      const innerProp =
        callee.object.property.type === "Identifier" ? callee.object.property.name : null;
      return { objectName: innerProp, propName };
    }
    return { objectName: null, propName };
  }
  return { objectName: null, propName: null };
}

function parseBundleAst(code: string): acorn.Program | null {
  for (const sourceType of ["script", "module"] as const) {
    try {
      return acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
      });
    } catch {
      // Try alternate sourceType.
    }
  }
  return null;
}

function loadLocaleDictionaryFromVfs(vfs: AsarMemoryVfs): Record<string, string> {
  const dict: Record<string, string> = {};
  const localeCandidates = [
    "assets/locale/zh-cn.json",
    "assets/locale/app-menu-cn.json",
    ...vfs.listFiles("assets/eext-common/", [".json"]).filter((p) => p.endsWith("zh-Hans.json")),
  ];

  for (const rel of localeCandidates) {
    if (!vfs.exists(rel)) continue;
    try {
      const json = vfs.readFileJson<Record<string, unknown>>(rel);
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === "string" && k.length <= 120 && v.length <= 120) {
          dict[k] = v;
        }
      }
    } catch {
      // Ignore malformed locale file.
    }
  }
  return dict;
}

function extractInlineLocaleStrings(ast: acorn.Program, dict: Record<string, string>): void {
  walk.simple(ast, {
    Property(node) {
      const key = getPropertyKeyName(node.key);
      if (key === "@@topMenu" && node.value.type === "ObjectExpression") {
        for (const prop of node.value.properties) {
          if (prop.type === "Property") {
            const k = getPropertyKeyName(prop.key);
            const v = getStringLiteralValue(prop.value);
            if (k && v && v.length <= 80) {
              dict[k] = v;
            }
          }
        }
      }
    },
  });
}

function collectClassProfileFromNode(
  classNode: acorn.Class,
  symbolName: string,
  bundleFile: string,
  moduleId: string | number
): ClassFingerprintProfile {
  const methods: ClassMethodFingerprint[] = [];
  const propsSet = new Set<string>();
  const stringsSet = new Set<string>();
  const callsSet = new Set<string>();

  for (const elem of classNode.body.body) {
    if (elem.type === "MethodDefinition") {
      const name = getPropertyKeyName(elem.key) ?? "anonymous";
      methods.push({
        name,
        arity: elem.value.params.length,
        isAsync: elem.value.async,
      });
    } else if (elem.type === "PropertyDefinition") {
      const pName = getPropertyKeyName(elem.key);
      if (pName) propsSet.add(pName);
    }
  }

  walk.simple(classNode.body, {
    MemberExpression(node) {
      if (!node.computed && node.property.type === "Identifier") {
        propsSet.add(node.property.name);
      }
    },
    AssignmentExpression(node) {
      if (
        node.left.type === "MemberExpression" &&
        node.left.object.type === "ThisExpression" &&
        !node.left.computed &&
        node.left.property.type === "Identifier"
      ) {
        propsSet.add(node.left.property.name);
      }
    },
    Literal(node) {
      if (typeof node.value === "string") {
        const clean = sanitizeShortToken(node.value, 96);
        if (clean && clean.length >= 2) {
          stringsSet.add(clean);
        }
      }
    },
    TemplateElement(node) {
      const cooked = node.value.cooked;
      if (cooked) {
        const clean = sanitizeShortToken(cooked, 96);
        if (clean && clean.length >= 2) {
          stringsSet.add(clean);
        }
      }
    },
    CallExpression(node) {
      const { propName } = getMemberCalleeName(node.callee);
      if (propName && propName.length >= 2) {
        callsSet.add(propName);
      }
    },
  });

  return {
    symbolName,
    bundleFile,
    moduleId,
    methods,
    accessedProperties: Array.from(propsSet).slice(0, 120),
    invariantStrings: Array.from(stringsSet).slice(0, 160),
    calledFunctions: Array.from(callsSet).slice(0, 80),
  };
}

function makeCommandEntry(
  cmdId: string,
  labelEn: string | null,
  labelZh: string | null,
  shortcut: string | null,
  role: BundleRole
): ReaApiCatalogEntry {
  const isBlocked = SENSITIVE_CHANNEL_RE.test(cmdId);
  const domain = inferDomainFromText(`${cmdId} ${labelEn ?? ""}`, role);
  const targetContext = inferTargetContext(role, domain);
  const triggersModal = MODAL_COMMAND_RE.test(cmdId);
  const slug = normalizeCapabilitySlug(cmdId);
  const apiId = `cap:cmd.${slug}`;

  const securityPolicy: ReaSecurityPolicy = isBlocked
    ? "BLOCKED"
    : triggersModal
      ? "CONFIRM_REQUIRED"
      : /^(?:view|zoom|check|find|search|get|show|toggle|switch)/i.test(cmdId)
        ? "READ_ONLY_SAFE"
        : "ALLOW";

  const summaryParts: string[] = [];
  if (labelZh) summaryParts.push(labelZh);
  else if (labelEn) summaryParts.push(labelEn);
  else summaryParts.push(`内部命令 ${cmdId}`);
  if (shortcut) summaryParts.push(`快捷键: ${shortcut}`);
  if (triggersModal) summaryParts.push("（可能触发交互弹窗）");

  return {
    apiId,
    tier: "L2_COMMAND",
    domain,
    kind: "command",
    namespace: "CommandDispatcher",
    memberName: cmdId,
    summaryZh: `内部命令 [${cmdId}]：${summaryParts.join("，")}`,
    keywordsEn: Array.from(
      new Set([
        cmdId,
        ...splitKeywords(cmdId),
        ...(labelEn ? splitKeywords(labelEn) : []),
        "command",
        "action",
      ])
    ),
    invocation: {
      targetContext,
      asyncMode: "promise",
      bindingStrategy: "command_dispatcher",
      globalPath: null,
      commandKey: cmdId,
      fingerprintAnchor: null,
    },
    unitContract: {
      nativeLengthUnit: "none",
      nativeAngleUnit: "none",
      autoConvertFromMmDeg: false,
    },
    parameters: [
      {
        name: "payload",
        required: false,
        physicalDimension: null,
        descriptionZh: "可选命令上下文参数对象",
        schema: { type: "object", additionalProperties: true },
      },
    ],
    returns: {
      descriptionZh: "命令分发执行结果状态",
      wrapAsHandleIfComplex: false,
      paginatedArray: false,
      schema: { type: "object", additionalProperties: true },
    },
    preconditions: {
      requiresOpenProject: domain === "PCB" || domain === "SCH" || domain === "DRC",
      requiredActiveDocumentType:
        domain === "PCB" ? ["PCB"] : domain === "SCH" ? ["SCH"] : ["ANY"],
      requiresBoardOutline: false,
      disallowDuringInteractiveDraw: false,
    },
    sideEffects: {
      mutatesCanvas: !/^(?:view|zoom|check|find|search|get|export|print)/i.test(cmdId),
      pushesUndoStep: !/^(?:view|zoom|check|find|search|get|export|print)/i.test(cmdId),
      writesLocalDisk: /(?:export|save|print|generate)/i.test(cmdId),
      triggersModalDialog: triggersModal,
      networkRequest: /(?:order|cloud|online|login|sync)/i.test(cmdId),
      mustWrapInTransaction: false,
    },
    securityPolicy,
  };
}

function makeIpcOrWorkerEntry(
  channel: string,
  kind: "ipc_channel" | "worker_rpc",
  direction: string,
  payloadKeys: string[],
  role: BundleRole
): ReaApiCatalogEntry {
  const isBlocked = SENSITIVE_CHANNEL_RE.test(channel);
  const domain: ReaApiDomain = kind === "ipc_channel" ? "IPC" : inferDomainFromText(channel, role);
  const slug = normalizeCapabilitySlug(channel);
  const prefix = kind === "worker_rpc" ? "cap:worker" : "cap:ipc";
  const apiId = `${prefix}.${slug}`;

  const isReadOnly = /(?:get|query|read|search|check|list|log|status|decode)/i.test(channel);
  const securityPolicy: ReaSecurityPolicy = isBlocked
    ? "BLOCKED"
    : isReadOnly
      ? "READ_ONLY_SAFE"
      : "ALLOW";

  return {
    apiId,
    tier: "L4_IPC",
    domain,
    kind,
    namespace: kind === "worker_rpc" ? "WebWorkerBus" : "ElectronIpcBridge",
    memberName: channel,
    summaryZh: isBlocked
      ? `受限敏感跨进程信道 [${channel}]（已由安全门禁标记 BLOCKED 禁止调用）`
      : `${kind === "worker_rpc" ? "Web Worker 计算信道" : "Electron 跨进程信道"} [${channel}]（方向: ${direction}）`,
    keywordsEn: Array.from(
      new Set([
        channel,
        ...splitKeywords(channel),
        ...payloadKeys,
        kind === "worker_rpc" ? "worker" : "ipc",
        ...(isBlocked ? ["blocked", "sensitive"] : []),
      ])
    ),
    invocation: {
      targetContext: role === "main" ? "main_process" : "any_editor_renderer",
      asyncMode: "promise",
      bindingStrategy: "ipc_invoke",
      globalPath: null,
      commandKey: channel,
      fingerprintAnchor: {
        invariantStrings: [channel],
        requiredPeerProperties: payloadKeys.slice(0, 8),
        arity: 1,
        parentCommandAnchor: null,
        fallbackCapabilityId: null,
      },
    },
    unitContract: {
      nativeLengthUnit: "none",
      nativeAngleUnit: "none",
      autoConvertFromMmDeg: false,
    },
    parameters: [
      {
        name: "message",
        required: false,
        physicalDimension: null,
        descriptionZh:
          payloadKeys.length > 0
            ? `消息负载字段: ${payloadKeys.slice(0, 8).join(", ")}`
            : "跨进程调用消息负载",
        schema: {
          type: "object",
          properties: Object.fromEntries(payloadKeys.slice(0, 12).map((k) => [k, {}])),
          additionalProperties: true,
        },
      },
    ],
    returns: {
      descriptionZh: "异步通信响应载荷",
      wrapAsHandleIfComplex: false,
      paginatedArray: false,
      schema: { type: "object", additionalProperties: true },
    },
    preconditions: {
      requiresOpenProject: false,
      requiredActiveDocumentType: ["ANY"],
      requiresBoardOutline: false,
      disallowDuringInteractiveDraw: false,
    },
    sideEffects: {
      mutatesCanvas: false,
      pushesUndoStep: false,
      writesLocalDisk: /(?:save|write|export|delete)/i.test(channel),
      triggersModalDialog: /(?:dialog|openwindow)/i.test(channel),
      networkRequest: isBlocked || /(?:ws|http|online|upload)/i.test(channel),
      mustWrapInTransaction: false,
    },
    securityPolicy,
  };
}

function buildCoreL3Entries(
  drcRuleKeys: string[],
  errorConstants: string[],
  stateAccessors: string[]
): ReaApiCatalogEntry[] {
  const entries: ReaApiCatalogEntry[] = [
    {
      apiId: "cap:core.history.beginCompositeStep",
      tier: "L3_ENGINE",
      domain: "SYS",
      kind: "method",
      namespace: "InternalHistoryTransaction",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: "开启编辑器内部原子历史命令事务组（Composite Undo Checkpoint），供批量修改失败时一键原子回滚。",
      keywordsEn: ["history", "undo", "transaction", "composite", "begin", "checkpoint"],
      invocation: {
        targetContext: "any_editor_renderer",
        asyncMode: "sync",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["api command group: ", "GROUP_NOT_FOUND", "CONFLICT"],
          requiredPeerProperties: ["begin", "commit", "rollback", "requireOpen", "ensureAggregate"],
          arity: 1,
          parentCommandAnchor: null,
          fallbackCapabilityId: "eda.sys_MessageBus.publish",
        },
      },
      unitContract: { nativeLengthUnit: "none", nativeAngleUnit: "none", autoConvertFromMmDeg: false },
      parameters: [
        {
          name: "name",
          required: false,
          physicalDimension: null,
          descriptionZh: "事务组标签名称",
          schema: { type: "string" },
        },
      ],
      returns: {
        descriptionZh: "返回包含 groupId 的事务句柄",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: {
          type: "object",
          required: ["groupId"],
          properties: { groupId: { type: "string" } },
        },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["ANY"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "ALLOW",
    },
    {
      apiId: "cap:core.history.commitTransaction",
      tier: "L3_ENGINE",
      domain: "SYS",
      kind: "method",
      namespace: "InternalHistoryTransaction",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: "提交当前开启的内部原子命令事务组，将批处理所有图元修改折叠为单步 Ctrl+Z 撤销记录。",
      keywordsEn: ["history", "undo", "transaction", "commit", "group"],
      invocation: {
        targetContext: "any_editor_renderer",
        asyncMode: "sync",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["api command group: ", "CONFLICT"],
          requiredPeerProperties: ["begin", "commit", "rollback", "ensureAggregate"],
          arity: 1,
          parentCommandAnchor: null,
          fallbackCapabilityId: null,
        },
      },
      unitContract: { nativeLengthUnit: "none", nativeAngleUnit: "none", autoConvertFromMmDeg: false },
      parameters: [
        {
          name: "groupId",
          required: true,
          physicalDimension: null,
          descriptionZh: "已开启的事务组 ID",
          schema: { type: "string" },
        },
      ],
      returns: {
        descriptionZh: "提交是否成功",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "boolean" },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["ANY"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: true,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "ALLOW",
    },
    {
      apiId: "cap:core.history.rollbackTo",
      tier: "L3_ENGINE",
      domain: "SYS",
      kind: "method",
      namespace: "InternalHistoryTransaction",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: "原子回滚未提交的命令事务组，逆序撤销已写入图元并刷新画布服务状态。",
      keywordsEn: ["history", "undo", "rollback", "abort", "restore", "transaction"],
      invocation: {
        targetContext: "any_editor_renderer",
        asyncMode: "sync",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["HistoryFlushService", "flushService", "GROUP_NOT_FOUND"],
          requiredPeerProperties: ["begin", "commit", "rollback", "requireOpen", "ensureAggregate"],
          arity: 1,
          parentCommandAnchor: null,
          fallbackCapabilityId: null,
        },
      },
      unitContract: { nativeLengthUnit: "none", nativeAngleUnit: "none", autoConvertFromMmDeg: false },
      parameters: [
        {
          name: "groupId",
          required: true,
          physicalDimension: null,
          descriptionZh: "待回滚的事务组 ID",
          schema: { type: "string" },
        },
      ],
      returns: {
        descriptionZh: "回滚是否完成",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "boolean" },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["ANY"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: true,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "ALLOW",
    },
    {
      apiId: "cap:pcb.dsn.exportSilent",
      tier: "L3_ENGINE",
      domain: "PCB",
      kind: "method",
      namespace: "InternalDsnSerializer",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: "跳过原生另存为弹窗，直接从当前活动 PCB 内存模型序列化生成标准 Specctra DSN 文本供无头 FreeRouting 求解。",
      keywordsEn: ["dsn", "specctra", "autoroute", "freerouting", "export", "silent", "headless"],
      invocation: {
        targetContext: "pcb_renderer",
        asyncMode: "promise",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["(PCB ", "(parser", "(resolution", "(structure", "(placement", "(wiring"],
          requiredPeerProperties: ["exportDSN", "exportDSN1", "initRouterConfig", "getSpecctraNetClass"],
          arity: 2,
          parentCommandAnchor: "exportDSN",
          fallbackCapabilityId: "cap:cmd.exportDSN",
        },
      },
      unitContract: { nativeLengthUnit: "mil", nativeAngleUnit: "deg", autoConvertFromMmDeg: false },
      parameters: [
        {
          name: "config",
          required: false,
          physicalDimension: null,
          descriptionZh: "Specctra 导出配置对象（含 netClass 与 skipNets）",
          schema: { type: "object", additionalProperties: true },
        },
        {
          name: "boardName",
          required: false,
          physicalDimension: null,
          descriptionZh: "PCB 板名称标识",
          schema: { type: "string" },
        },
      ],
      returns: {
        descriptionZh: "Specctra DSN 内容文本及导出状态",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "object", additionalProperties: true },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["PCB"],
        requiresBoardOutline: true,
        disallowDuringInteractiveDraw: true,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "READ_ONLY_SAFE",
    },
    {
      apiId: "cap:pcb.ses.importSilent",
      tier: "L3_ENGINE",
      domain: "PCB",
      kind: "method",
      namespace: "InternalSesImporter",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: "跳过文件选择弹窗，在当前 PCB 事务上下文静默回导 Specctra SES 自动布线结果（导线与过孔）。",
      keywordsEn: ["ses", "specctra", "autoroute", "import", "silent", "freerouting"],
      invocation: {
        targetContext: "pcb_renderer",
        asyncMode: "promise",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["importSession", "viaNetMap", "padStackMap", "padStackCache"],
          requiredPeerProperties: ["importSession", "exportDSN", "padStackCache", "viaNetMap"],
          arity: 5,
          parentCommandAnchor: "importSes",
          fallbackCapabilityId: "cap:cmd.importSes",
        },
      },
      unitContract: { nativeLengthUnit: "mil", nativeAngleUnit: "deg", autoConvertFromMmDeg: false },
      parameters: [
        {
          name: "sessionData",
          required: true,
          physicalDimension: null,
          descriptionZh: "解析后的 SES 走线与过孔网络映射数据",
          schema: { type: "object", additionalProperties: true },
        },
      ],
      returns: {
        descriptionZh: "导入是否成功",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "boolean" },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["PCB"],
        requiresBoardOutline: true,
        disallowDuringInteractiveDraw: true,
      },
      sideEffects: {
        mutatesCanvas: true,
        pushesUndoStep: true,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: true,
      },
      securityPolicy: "ALLOW",
    },
    {
      apiId: "cap:pcb.drc.readWriteRuleTree",
      tier: "L3_ENGINE",
      domain: "DRC",
      kind: "method",
      namespace: "InternalDrcRuleManager",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: `读取与双向同步当前工程 PCB DRC 规则树与 NetClass 网络类规则（识别规则键: ${drcRuleKeys.slice(0, 10).join(", ") || "netClasses, trackWidth, clearance, viaDiameter"}；错误常量数: ${errorConstants.length}）`,
      keywordsEn: Array.from(
        new Set(["drc", "rule", "netclass", "clearance", "width", "via", ...drcRuleKeys.slice(0, 20)])
      ),
      invocation: {
        targetContext: "pcb_renderer",
        asyncMode: "promise",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["netClasses", "trackWidth", "viaDiameter", "BoardOutline", "ClearanceError"],
          requiredPeerProperties: ["getNet", "getSpecctraNetClass", "getTrackPhysics", "getSafeSpacing", "getRadiusPhysics"],
          arity: 1,
          parentCommandAnchor: null,
          fallbackCapabilityId: "eda.pcb_Drc.getCurrentRuleConfiguration",
        },
      },
      unitContract: { nativeLengthUnit: "mil", nativeAngleUnit: "none", autoConvertFromMmDeg: true },
      parameters: [
        {
          name: "rulePatch",
          required: false,
          physicalDimension: null,
          descriptionZh: "可选合并更新的 DRC / NetClass 配置树",
          schema: { type: "object", additionalProperties: true },
        },
      ],
      returns: {
        descriptionZh: "当前工程 DRC 与 NetClass 规则树",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "object", additionalProperties: true },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["PCB"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "ALLOW",
    },
    {
      apiId: "cap:pcb.router.internalDiffRoute",
      tier: "L3_ENGINE",
      domain: "PCB",
      kind: "method",
      namespace: "InternalDiffPairRouter",
      memberName: "<dynamic_bound_by_fingerprint>",
      summaryZh: "调用嘉立创EDA 内置差分对管理器与蛇形等长调谐控制器，执行差分线对布线与对内等长补偿。",
      keywordsEn: ["diffpair", "differential", "meander", "tuning", "equal", "length", "router"],
      invocation: {
        targetContext: "pcb_renderer",
        asyncMode: "promise",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: ["getAllNetDifferentials", "getAllInnerPlane", "getAllCopperPlane", "getDifferentialPairSpacingMin"],
          requiredPeerProperties: ["getAllNetDifferentials", "getAllNetDifferentialsGroup", "getSpecctraNetClass", "getSafeSpacing", "getTrackPhysics"],
          arity: 1,
          parentCommandAnchor: "diffPairEqualLengthTuning",
          fallbackCapabilityId: "cap:cmd.diffPairEqualLengthTuning",
        },
      },
      unitContract: { nativeLengthUnit: "mil", nativeAngleUnit: "deg", autoConvertFromMmDeg: true },
      parameters: [
        {
          name: "diffPairOptions",
          required: false,
          physicalDimension: null,
          descriptionZh: "差分对等长调谐与间距参数",
          schema: { type: "object", additionalProperties: true },
        },
      ],
      returns: {
        descriptionZh: "差分调谐结果",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "object", additionalProperties: true },
      },
      preconditions: {
        requiresOpenProject: true,
        requiredActiveDocumentType: ["PCB"],
        requiresBoardOutline: true,
        disallowDuringInteractiveDraw: true,
      },
      sideEffects: {
        mutatesCanvas: true,
        pushesUndoStep: true,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: true,
      },
      securityPolicy: "ALLOW",
    },
  ];

  // Add discovered getState_*/setState_* accessors as L3_ENGINE entries
  for (const acc of stateAccessors.slice(0, 120)) {
    const isGetter = acc.startsWith("getState_");
    const slug = normalizeCapabilitySlug(acc);
    entries.push({
      apiId: `cap:state.${slug}`,
      tier: "L3_ENGINE",
      domain: "SYS",
      kind: "method",
      namespace: "InternalStateStore",
      memberName: acc,
      summaryZh: `内部状态访问器 [${acc}]`,
      keywordsEn: Array.from(new Set([acc, ...splitKeywords(acc), "state"])),
      invocation: {
        targetContext: "any_editor_renderer",
        asyncMode: "sync",
        bindingStrategy: "fingerprint_singleton",
        globalPath: null,
        commandKey: null,
        fingerprintAnchor: {
          invariantStrings: [acc],
          requiredPeerProperties: [acc],
          arity: isGetter ? 0 : 1,
          parentCommandAnchor: null,
          fallbackCapabilityId: null,
        },
      },
      unitContract: { nativeLengthUnit: "none", nativeAngleUnit: "none", autoConvertFromMmDeg: false },
      parameters: isGetter
        ? []
        : [
            {
              name: "value",
              required: true,
              physicalDimension: null,
              descriptionZh: "目标状态值",
              schema: {},
            },
          ],
      returns: {
        descriptionZh: "状态值或更新确认",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: {},
      },
      preconditions: {
        requiresOpenProject: false,
        requiredActiveDocumentType: ["ANY"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: isGetter ? "READ_ONLY_SAFE" : "ALLOW",
    });
  }

  return entries;
}

/**
 * Execute the 5-pass Acorn AST scan on an array of in-memory JS bundles.
 * Never persists raw AST nodes or JS source code.
 */
export function scanBundlesFromCode(
  bundles: BundleInput[],
  initialLocaleDict: Record<string, string> = {}
): BundleScanResult {
  const localeDict: Record<string, string> = { ...initialLocaleDict };
  const classProfiles: ClassFingerprintProfile[] = [];
  const commandEntriesMap = new Map<string, ReaApiCatalogEntry>();
  const l4EntriesMap = new Map<string, ReaApiCatalogEntry>();
  const drcKeysSet = new Set<string>();
  const errorConstSet = new Set<string>();
  const stateAccessorsSet = new Set<string>();
  const commandGraphEdges: Record<string, string[]> = {};
  const scannedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const bundle of bundles) {
    const role = bundle.role ?? inferRoleFromPath(bundle.fileName);
    if (SKIP_BUNDLE_RE.test(bundle.fileName) || Buffer.byteLength(bundle.code, "utf8") > MAX_BUNDLE_BYTES) {
      skippedFiles.push(bundle.fileName);
      continue;
    }

    const ast = parseBundleAst(bundle.code);
    if (!ast) {
      skippedFiles.push(bundle.fileName);
      continue;
    }

    scannedFiles.push(bundle.fileName);
    if (role === "ui") {
      extractInlineLocaleStrings(ast, localeDict);
    }

    // Track class index within file for deterministic moduleId
    let classIdx = 0;

    // Pass 1: Module exports, class declarations/expressions, prototype/static assignments & structural fingerprints
    const webpackExports = new Map<string, string>();
    const fileProfilesByName = new Map<string, ClassFingerprintProfile>();
    const registerProfile = (profile: ClassFingerprintProfile): void => {
      classProfiles.push(profile);
      fileProfilesByName.set(profile.symbolName, profile);
    };

    walk.simple(ast, {
      ClassDeclaration(node) {
        const name = node.id?.name ?? `anon_class_${++classIdx}`;
        registerProfile(
          collectClassProfileFromNode(node, name, bundle.fileName, `${bundle.fileName}#cls_${classIdx++}`)
        );
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          node.init &&
          node.init.type === "ClassExpression"
        ) {
          registerProfile(
            collectClassProfileFromNode(
              node.init,
              node.id.name,
              bundle.fileName,
              `${bundle.fileName}#cls_${++classIdx}`
            )
          );
        }
        if (node.id.type === "Identifier" && /^ERR_[A-Z0-9_]+$/.test(node.id.name)) {
          errorConstSet.add(node.id.name);
        }
        if (node.id.type === "Identifier" && /^(?:get|set)State_[A-Za-z0-9_]+$/.test(node.id.name)) {
          stateAccessorsSet.add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        if (
          node.left.type === "MemberExpression" &&
          node.left.object.type === "Identifier" &&
          node.left.object.name === "__webpack_modules__" &&
          node.right.type === "ArrowFunctionExpression"
        ) {
          const modKey =
            node.left.property.type === "Literal"
              ? String(node.left.property.value)
              : node.left.property.type === "Identifier"
                ? node.left.property.name
                : `wp_${++classIdx}`;
          walk.simple(node.right, {
            ClassDeclaration(cls) {
              const name = cls.id?.name ?? `wp_class_${modKey}`;
              registerProfile(collectClassProfileFromNode(cls, name, bundle.fileName, modKey));
            },
          });
          return;
        }

        // Merge static/prototype property & method assignments onto existing ClassFingerprintProfile
        if (node.left.type === "MemberExpression" && !node.left.computed && node.left.property.type === "Identifier") {
          let targetClassName: string | null = null;
          if (node.left.object.type === "Identifier") {
            targetClassName = node.left.object.name;
          } else if (
            node.left.object.type === "MemberExpression" &&
            !node.left.object.computed &&
            node.left.object.object.type === "Identifier" &&
            node.left.object.property.type === "Identifier" &&
            node.left.object.property.name === "prototype"
          ) {
            targetClassName = node.left.object.object.name;
          }

          if (targetClassName) {
            const targetProfile = fileProfilesByName.get(targetClassName);
            if (targetProfile) {
              const propName = node.left.property.name;
              if (!targetProfile.accessedProperties.includes(propName)) {
                targetProfile.accessedProperties.push(propName);
              }
              if (
                node.right.type === "FunctionExpression" ||
                node.right.type === "ArrowFunctionExpression"
              ) {
                targetProfile.methods.push({
                  name: propName,
                  arity: node.right.params.length,
                  isAsync: node.right.async,
                });
              } else if (
                node.right.type === "CallExpression" &&
                (node.right.callee.type === "FunctionExpression" ||
                  node.right.callee.type === "ArrowFunctionExpression")
              ) {
                // Static IIFE method assignment (e.g. Rt.importSession = (function(){ ... return d; })())
                let inferredArity = node.right.arguments.length;
                const fnBody = node.right.callee.body;
                if (fnBody.type === "BlockStatement") {
                  const localFnArities = new Map<string, number>();
                  let returnedId: string | null = null;
                  for (const stmt of fnBody.body) {
                    if (stmt.type === "FunctionDeclaration" && stmt.id) {
                      localFnArities.set(stmt.id.name, stmt.params.length);
                    } else if (stmt.type === "ReturnStatement" && stmt.argument) {
                      if (stmt.argument.type === "Identifier") {
                        returnedId = stmt.argument.name;
                      } else if (
                        stmt.argument.type === "FunctionExpression" ||
                        stmt.argument.type === "ArrowFunctionExpression"
                      ) {
                        inferredArity = stmt.argument.params.length;
                      }
                    }
                  }
                  if (returnedId && localFnArities.has(returnedId)) {
                    inferredArity = localFnArities.get(returnedId)!;
                  }
                }
                targetProfile.methods.push({
                  name: propName,
                  arity: inferredArity,
                  isAsync: false,
                });
              }
              walk.simple(node.right, {
                Literal(lit) {
                  if (typeof lit.value === "string") {
                    const clean = sanitizeShortToken(lit.value, 96);
                    if (clean && clean.length >= 2 && !targetProfile.invariantStrings.includes(clean)) {
                      targetProfile.invariantStrings.push(clean);
                    }
                  }
                },
              });
            }
          }
        }
      },
      CallExpression(node) {
        const { objectName, propName } = getMemberCalleeName(node.callee);
        if (objectName === "__webpack_require__" && propName === "d" && node.arguments.length >= 2) {
          const mapArg = node.arguments[1];
          if (mapArg.type === "ObjectExpression") {
            for (const prop of mapArg.properties) {
              if (prop.type === "Property") {
                const k = getPropertyKeyName(prop.key);
                if (k) webpackExports.set(k, bundle.fileName);
              }
            }
          }
        }
      },
    });

    // Pass 2: Command Registry, UI Menu/Hotkey tables, switch dispatchers -> L2_COMMAND
    const hotkeys = new Map<string, string>();
    walk.simple(ast, {
      Property(node) {
        const propName = getPropertyKeyName(node.key);
        if (!propName) return;

        // Pattern A: JLCEDA ui.js hotkey entries: { hotkey: "Ctrl+S", hotkeyCmd: "save" }
        if (node.value.type === "ObjectExpression") {
          let funcE: string | null = null;
          let hasRangeOrScene = false;
          let hotkeyCmd: string | null = null;
          let hotkeyVal: string | null = null;
          let labelKey: string | null = null;
          let menuId: string | null = null;
          let actionKey: string | null = null;

          for (const p of node.value.properties) {
            if (p.type !== "Property") continue;
            const k = getPropertyKeyName(p.key);
            const v = getStringLiteralValue(p.value);
            if (k === "funcE" && v) funcE = v;
            if (k === "range" || k === "scene") hasRangeOrScene = true;
            if (k === "hotkeyCmd" && v) hotkeyCmd = v;
            if (k === "hotkey" && v) hotkeyVal = v;
            if (k === "labelKey" && v) labelKey = v;
            if (k === "id" && v) menuId = v;
            if (k === "action" && v) actionKey = v;
          }

          if (hotkeyCmd && hotkeyVal) {
            hotkeys.set(hotkeyCmd, hotkeyVal);
          }

          if (funcE && hasRangeOrScene && propName.length <= 64) {
            const labelZh = localeDict[funcE] ?? localeDict[propName] ?? null;
            const apiId = `cap:cmd.${normalizeCapabilitySlug(propName)}`;
            if (!commandEntriesMap.has(apiId)) {
              commandEntriesMap.set(
                apiId,
                makeCommandEntry(propName, funcE, labelZh, hotkeys.get(propName) ?? null, role)
              );
            }
          } else if (menuId && labelKey && actionKey) {
            const labelZh = localeDict[labelKey] ?? null;
            const apiId = `cap:cmd.${normalizeCapabilitySlug(menuId)}`;
            if (!commandEntriesMap.has(apiId)) {
              commandEntriesMap.set(
                apiId,
                makeCommandEntry(menuId, labelKey, labelZh, hotkeyVal, role)
              );
            }
          }
        }
      },
      CallExpression(node) {
        const { objectName, propName } = getMemberCalleeName(node.callee);
        const cmdArg = getStringLiteralValue(node.arguments[0]);
        if (
          cmdArg &&
          cmdArg.length >= 2 &&
          cmdArg.length <= 64 &&
          (propName === "registerCommand" ||
            propName === "registerAction" ||
            propName === "doCommand" ||
            propName === "executeCommand" ||
            propName === "dispatchCommand" ||
            (objectName === "commandRegistry" && propName === "register"))
        ) {
          const apiId = `cap:cmd.${normalizeCapabilitySlug(cmdArg)}`;
          if (!commandEntriesMap.has(apiId)) {
            const labelZh = localeDict[cmdArg] ?? null;
            commandEntriesMap.set(
              apiId,
              makeCommandEntry(cmdArg, null, labelZh, hotkeys.get(cmdArg) ?? null, role)
            );
          }

          // Collect call-graph edges from handler argument (if function expression)
          const handler = node.arguments[1];
          if (
            handler &&
            (handler.type === "FunctionExpression" || handler.type === "ArrowFunctionExpression")
          ) {
            const callees = new Set<string>();
            walk.simple(handler.body, {
              CallExpression(innerCall) {
                const { propName: innerFn } = getMemberCalleeName(innerCall.callee);
                if (innerFn) callees.add(innerFn);
              },
            });
            if (callees.size > 0) {
              commandGraphEdges[cmdArg] = Array.from(callees);
            }
          }
        }
      },
      SwitchCase(node) {
        const caseVal = getStringLiteralValue(node.test);
        if (
          caseVal &&
          caseVal.length >= 3 &&
          caseVal.length <= 48 &&
          /^(?:export|import|view|diffPair|unroute|clearAll|place|route|pour|drc|check|open|close)/i.test(
            caseVal
          )
        ) {
          const apiId = `cap:cmd.${normalizeCapabilitySlug(caseVal)}`;
          if (!commandEntriesMap.has(apiId)) {
            const labelZh = localeDict[caseVal] ?? null;
            commandEntriesMap.set(
              apiId,
              makeCommandEntry(caseVal, caseVal, labelZh, hotkeys.get(caseVal) ?? null, role)
            );
          }
          const callees = new Set<string>();
          for (const stmt of node.consequent) {
            walk.simple(stmt, {
              CallExpression(innerCall) {
                const { propName: innerFn } = getMemberCalleeName(innerCall.callee);
                if (innerFn) callees.add(innerFn);
              },
            });
          }
          if (callees.size > 0) {
            commandGraphEdges[caseVal] = Array.from(callees);
          }
        }
      },
    });

    // Attach discovered hotkeys to any commands registered before hotkey table was visited
    for (const [cmdId, hk] of hotkeys.entries()) {
      const entry = commandEntriesMap.get(`cap:cmd.${normalizeCapabilitySlug(cmdId)}`);
      if (entry && !entry.summaryZh.includes("快捷键:")) {
        entry.summaryZh = `${entry.summaryZh}，快捷键: ${hk}`;
      }
    }

    // Pass 3: State accessors, DRC rule keys, ERR_* constants
    walk.simple(ast, {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const val = node.value;
        if (/^ERR_[A-Z0-9_]{2,64}$/.test(val)) {
          errorConstSet.add(val);
        } else if (val.length <= 48 && DRC_RULE_KEY_RE.test(val)) {
          drcKeysSet.add(val);
        }
      },
      Identifier(node) {
        if (/^(?:get|set)State_[A-Za-z0-9_]+$/.test(node.name)) {
          stateAccessorsSet.add(node.name);
        }
      },
      FunctionDeclaration(node) {
        if (node.id && /^(?:get|set)State_[A-Za-z0-9_]+$/.test(node.id.name)) {
          stateAccessorsSet.add(node.id.name);
        }
      },
      MethodDefinition(node) {
        const mName = getPropertyKeyName(node.key);
        if (mName && /^(?:get|set)State_[A-Za-z0-9_]+$/.test(mName)) {
          stateAccessorsSet.add(mName);
        }
      },
      Property(node) {
        const pName = getPropertyKeyName(node.key);
        if (pName && /^(?:get|set)State_[A-Za-z0-9_]+$/.test(pName)) {
          stateAccessorsSet.add(pName);
        }
      },
    });

    // Pass 4 & Pass 5: Worker protocols + Electron ipcMain/ipcRenderer/contextBridge + MessageBus RPC
    const extractHandlerPayloadKeys = (fnNode: acorn.AnyNode | undefined): string[] => {
      if (!fnNode) return [];
      const keys = new Set<string>();
      walk.simple(fnNode, {
        MemberExpression(m) {
          if (!m.computed && m.property.type === "Identifier") {
            const p = m.property.name;
            if (!["data", "payload", "message", "type", "length", "then"].includes(p)) {
              keys.add(p);
            }
          }
        },
      });
      return Array.from(keys).slice(0, 12);
    };

    walk.simple(ast, {
      CallExpression(node) {
        const { objectName, propName } = getMemberCalleeName(node.callee);
        const firstArg = getStringLiteralValue(node.arguments[0]);

        // Electron IPC
        if (
          (objectName === "ipcMain" || objectName === "ipcRenderer") &&
          propName &&
          ["handle", "on", "once", "invoke", "send", "sendSync"].includes(propName) &&
          firstArg
        ) {
          const payloadKeys = extractHandlerPayloadKeys(node.arguments[1]);
          const entry = makeIpcOrWorkerEntry(
            firstArg,
            "ipc_channel",
            `${objectName}.${propName}`,
            payloadKeys,
            role
          );
          if (!l4EntriesMap.has(entry.apiId)) {
            l4EntriesMap.set(entry.apiId, entry);
          }
        }

        // contextBridge.exposeInMainWorld(ns, obj)
        if (
          objectName === "contextBridge" &&
          propName === "exposeInMainWorld" &&
          firstArg &&
          node.arguments[1]?.type === "ObjectExpression"
        ) {
          for (const prop of node.arguments[1].properties) {
            if (prop.type === "Property") {
              const methodKey = getPropertyKeyName(prop.key);
              if (methodKey) {
                const channelName = `${firstArg}.${methodKey}`;
                const entry = makeIpcOrWorkerEntry(
                  channelName,
                  "ipc_channel",
                  "contextBridge.exposeInMainWorld",
                  [],
                  role
                );
                if (!l4EntriesMap.has(entry.apiId)) {
                  l4EntriesMap.set(entry.apiId, entry);
                }
              }
            }
          }
        }

        // Worker / Internal rpcService("topic", handler)
        if (propName === "rpcService" && firstArg && firstArg.length <= 96) {
          const payloadKeys = extractHandlerPayloadKeys(node.arguments[1]);
          const isWorker = role === "worker" || firstArg.startsWith("/worker/") || firstArg.includes("Worker/");
          const kind: "worker_rpc" | "ipc_channel" = isWorker ? "worker_rpc" : "ipc_channel";
          const entry = makeIpcOrWorkerEntry(
            firstArg,
            kind,
            isWorker ? "workerBus.rpcService" : "messageBus.rpcService",
            payloadKeys,
            role
          );
          if (!l4EntriesMap.has(entry.apiId)) {
            l4EntriesMap.set(entry.apiId, entry);
          }
        }

        // MessageBus publish/subscribe for sensitive auth/login/token/cookie/payment monitoring
        if (
          (propName === "subscribe" || propName === "publish") &&
          firstArg &&
          SENSITIVE_CHANNEL_RE.test(firstArg)
        ) {
          const entry = makeIpcOrWorkerEntry(
            firstArg,
            "ipc_channel",
            `messageBus.${propName}`,
            [],
            role
          );
          entry.securityPolicy = "BLOCKED";
          if (!l4EntriesMap.has(entry.apiId)) {
            l4EntriesMap.set(entry.apiId, entry);
          }
        }
      },

      // Standard Web Worker `onmessage` switch(e.data.type)
      AssignmentExpression(node) {
        const leftIsOnMessage =
          (node.left.type === "Identifier" && node.left.name === "onmessage") ||
          (node.left.type === "MemberExpression" &&
            !node.left.computed &&
            node.left.property.type === "Identifier" &&
            node.left.property.name === "onmessage");
        if (!leftIsOnMessage) return;

        walk.simple(node.right, {
          SwitchCase(sc) {
            const msgType = getStringLiteralValue(sc.test);
            if (msgType && msgType.length <= 64) {
              const payloadKeys = extractHandlerPayloadKeys(sc);
              const entry = makeIpcOrWorkerEntry(
                msgType,
                "worker_rpc",
                "worker.onmessage",
                payloadKeys,
                "worker"
              );
              if (!l4EntriesMap.has(entry.apiId)) {
                l4EntriesMap.set(entry.apiId, entry);
              }
            }
          },
        });
      },
    });
  }

  // Ensure canonical local SQLite catalog query IPC capability exists in L4
  if (!l4EntriesMap.has("cap:ipc.localLib.querySqliteCatalog")) {
    const localLibExists =
      l4EntriesMap.has("cap:worker.mgr_libWorker_getDevice") ||
      l4EntriesMap.has("cap:ipc.local-db:query-device-catalog");
    l4EntriesMap.set("cap:ipc.localLib.querySqliteCatalog", {
      apiId: "cap:ipc.localLib.querySqliteCatalog",
      tier: "L4_IPC",
      domain: "IPC",
      kind: "ipc_channel",
      namespace: "ElectronIpcBridge",
      memberName: localLibExists ? "/mgr/libWorker/getDevice" : "local-db:query-device-catalog",
      summaryZh:
        "通过预加载或离线库 Worker 信道受控只读检索本地离线库 SQLite 器件元数据索引（C 编号封装与引脚信息）。",
      keywordsEn: ["ipc", "sqlite", "local", "library", "offline", "lcsc", "footprint", "device"],
      invocation: {
        targetContext: "any_editor_renderer",
        asyncMode: "promise",
        bindingStrategy: "ipc_invoke",
        globalPath: null,
        commandKey: "/mgr/libWorker/getDevice",
        fingerprintAnchor: {
          invariantStrings: ["/mgr/libWorker/getDevice", "/mgr/libWorker/getFootprint", "local-db:query-device-catalog"],
          requiredPeerProperties: ["getDevice", "getFootprint", "getSymbol"],
          arity: 1,
          parentCommandAnchor: null,
          fallbackCapabilityId: "eda.lib_Device.search",
        },
      },
      unitContract: { nativeLengthUnit: "mm", nativeAngleUnit: "deg", autoConvertFromMmDeg: false },
      parameters: [
        {
          name: "lcscCodes",
          required: true,
          physicalDimension: null,
          descriptionZh: "立创商城器件 C 编号列表（如 ['C2040']）",
          schema: { type: "array", items: { type: "string" } },
        },
      ],
      returns: {
        descriptionZh: "命中的本地离线库器件元数据字典",
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: { type: "object", additionalProperties: true },
      },
      preconditions: {
        requiresOpenProject: false,
        requiredActiveDocumentType: ["ANY"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "READ_ONLY_SAFE",
    });
  }

  const drcRuleKeys = Array.from(drcKeysSet).sort();
  const errorConstants = Array.from(errorConstSet).sort();
  const stateAccessors = Array.from(stateAccessorsSet).sort();
  const l3Entries = buildCoreL3Entries(drcRuleKeys, errorConstants, stateAccessors);

  return {
    scannedFiles,
    skippedFiles,
    classProfiles,
    l2Entries: Array.from(commandEntriesMap.values()),
    l3Entries,
    l4Entries: Array.from(l4EntriesMap.values()),
    drcRuleKeys,
    errorConstants,
    stateAccessors,
    commandGraphEdges,
  };
}

/**
 * Select core JS bundles from an `AsarMemoryVfs`, read each bundle in memory,
 * run the 5-pass AST scan, and immediately release/zero each buffer after scanning.
 */
export function scanVfsBundlesAst(
  vfs: AsarMemoryVfs,
  options: { targetFiles?: string[] } = {}
): BundleScanResult {
  const localeDict = loadLocaleDictionaryFromVfs(vfs);
  const allJsFiles = options.targetFiles ?? vfs.listFiles("", [".js"]);

  const targetFiles = allJsFiles.filter((rel) => {
    if (SKIP_BUNDLE_RE.test(rel)) {
      return false;
    }
    const lower = rel.toLowerCase();
    return (
      lower === "app.js" ||
      lower === "preload.js" ||
      lower.startsWith("assets/js/") ||
      lower.startsWith("assets/pro-api/") ||
      lower.startsWith("assets/pro-ui/") ||
      lower.startsWith("assets/pro-pcb/") ||
      lower.startsWith("assets/pro-sch/") ||
      lower.startsWith("assets/pro-mgr/") ||
      lower.startsWith("assets/pro-panel/") ||
      options.targetFiles !== undefined
    );
  });

  const merged: BundleScanResult = {
    scannedFiles: [],
    skippedFiles: [],
    classProfiles: [],
    l2Entries: [],
    l3Entries: [],
    l4Entries: [],
    drcRuleKeys: [],
    errorConstants: [],
    stateAccessors: [],
    commandGraphEdges: {},
  };

  const l2ById = new Map<string, ReaApiCatalogEntry>();
  const l4ById = new Map<string, ReaApiCatalogEntry>();
  const drcSet = new Set<string>();
  const errSet = new Set<string>();
  const stateSet = new Set<string>();

  for (const rel of allJsFiles) {
    if (!targetFiles.includes(rel)) {
      if (SKIP_BUNDLE_RE.test(rel)) {
        merged.skippedFiles.push(rel);
      }
      continue;
    }

    const st = vfs.stat(rel);
    if (!st || st.size > MAX_BUNDLE_BYTES) {
      merged.skippedFiles.push(rel);
      continue;
    }

    // Stream single bundle into memory, parse AST, extract metadata, and burn buffer immediately.
    const singleResult = vfs.withFileText(rel, (code) =>
      scanBundlesFromCode([{ fileName: rel, code }], localeDict)
    );

    merged.scannedFiles.push(...singleResult.scannedFiles);
    merged.skippedFiles.push(...singleResult.skippedFiles);
    merged.classProfiles.push(...singleResult.classProfiles);
    for (const e of singleResult.l2Entries) {
      if (!l2ById.has(e.apiId)) l2ById.set(e.apiId, e);
    }
    for (const e of singleResult.l4Entries) {
      if (!l4ById.has(e.apiId)) l4ById.set(e.apiId, e);
    }
    for (const k of singleResult.drcRuleKeys) drcSet.add(k);
    for (const err of singleResult.errorConstants) errSet.add(err);
    for (const sa of singleResult.stateAccessors) stateSet.add(sa);
    Object.assign(merged.commandGraphEdges, singleResult.commandGraphEdges);
  }

  merged.drcRuleKeys = Array.from(drcSet).sort();
  merged.errorConstants = Array.from(errSet).sort();
  merged.stateAccessors = Array.from(stateSet).sort();
  merged.l2Entries = Array.from(l2ById.values());
  merged.l4Entries = Array.from(l4ById.values());
  merged.l3Entries = buildCoreL3Entries(
    merged.drcRuleKeys,
    merged.errorConstants,
    merged.stateAccessors
  );

  return merged;
}

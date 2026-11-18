import fs from "node:fs";
import path from "node:path";
import {
  errEnvelope,
  okEnvelope,
  type AdapterBindingEntry,
  type McpToolHandler,
  type ReaApiDomain,
  type ReaApiTier,
  type UnitMode,
} from "../types/index.js";
import { describeReaApi, searchReaCatalog } from "../rea/catalog-builder.js";
import { loadCachedAdapterBindings } from "../rea/fingerprint-adapter.js";
import {
  convertParamsToNative,
  resolveSpecialTokens,
  type LengthUnit,
} from "../cdp/unit-converter.js";
import { getWorkspaceState } from "./state.js";

function findAdapterBindingForEntry(
  indexDir: string,
  sha256: string | null | undefined,
  apiId: string
): AdapterBindingEntry | null {
  if (!sha256) return null;
  const cached = loadCachedAdapterBindings(indexDir, sha256);
  if (!cached) return null;
  return cached.bindings[apiId] ?? null;
}

export const jlcApiSearchTool: McpToolHandler = {
  name: "jlc_api_search",
  layer: 2,
  description:
    "在 REA 构建的无伪源码全量接口索引（SQLite FTS5）中按英文/中文关键词、领域及接口等级（L1~L4）执行 BM25 分页检索。",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      domain: {
        type: "string",
        enum: ["ALL", "SYS", "DMT", "LIB", "SCH", "PCB", "DRC", "SIM", "VIEW", "IPC"],
        default: "ALL",
      },
      tiers: {
        type: "array",
        items: { type: "string", enum: ["L1_PUBLIC", "L2_COMMAND", "L3_ENGINE", "L4_IPC"] },
        default: ["L1_PUBLIC", "L2_COMMAND", "L3_ENGINE"],
      },
      offset: { type: "integer", default: 0 },
      limit: { type: "integer", default: 25 },
      includeBlocked: { type: "boolean", default: false },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const envInfo = await state.ensureEnvInfo(context);
    const sqlitePath = state.getCatalogSqlitePath(envInfo);
    if (!fs.existsSync(sqlitePath)) {
      return errEnvelope(
        "ERR_CATALOG_NOT_FOUND",
        `REA catalog not found at '${sqlitePath}'. Run 'jlceda-mcp index' first.`
      );
    }

    const query = String(args.query ?? "");
    const domain =
      typeof args.domain === "string" && args.domain !== "ALL"
        ? (args.domain as ReaApiDomain)
        : undefined;
    const tiers = Array.isArray(args.tiers)
      ? new Set(args.tiers as ReaApiTier[])
      : new Set<ReaApiTier>(["L1_PUBLIC", "L2_COMMAND", "L3_ENGINE"]);
    const offset = Math.max(0, Number(args.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Number(args.limit ?? 25)));

    const searchRes = searchReaCatalog(sqlitePath, query, {
      domain,
      tier: tiers.size === 1 ? [...tiers][0] : undefined,
      includeBlocked: Boolean(args.includeBlocked),
      limit: 100,
    });

    const filtered = searchRes.hits.filter((h) => tiers.has(h.entry.tier));
    const paged = filtered.slice(offset, offset + limit);

    return okEnvelope({
      totalMatches: filtered.length,
      elapsedMs: Number(searchRes.elapsedMs.toFixed(3)),
      items: paged.map((h) => {
        const binding = findAdapterBindingForEntry(
          envInfo.paths.indexDir,
          envInfo.asarSha256,
          h.entry.apiId
        );
        return {
          apiId: h.entry.apiId,
          tier: h.entry.tier,
          domain: h.entry.domain,
          kind: h.entry.kind,
          summaryZh: h.entry.summaryZh,
          securityPolicy: h.entry.securityPolicy,
          adapterHealthy: binding ? binding.bound && !binding.degraded : h.entry.tier === "L1_PUBLIC",
        };
      }),
    });
  },
};

export const jlcApiDescribeTool: McpToolHandler = {
  name: "jlc_api_describe",
  layer: 2,
  description:
    "读取指定接口、逻辑能力或枚举的完整机器签名（参数类型、物理量单位契约、前置文档状态、副作用与适配器置信度）。调用 jlc_api_invoke 前必须先读取。",
  inputSchema: {
    type: "object",
    required: ["apiId"],
    properties: {
      apiId: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const envInfo = await state.ensureEnvInfo(context);
    const sqlitePath = state.getCatalogSqlitePath(envInfo);
    if (!fs.existsSync(sqlitePath)) {
      return errEnvelope("ERR_CATALOG_NOT_FOUND", `REA catalog not found at '${sqlitePath}'.`);
    }

    const apiId = String(args.apiId);
    const entry = describeReaApi(sqlitePath, apiId);
    if (!entry) {
      return errEnvelope("ERR_API_NOT_FOUND", `API '${apiId}' not found in REA catalog.`);
    }

    state.describedApis.add(apiId);
    const binding = findAdapterBindingForEntry(
      envInfo.paths.indexDir,
      envInfo.asarSha256,
      apiId
    );

    return okEnvelope({
      ...entry,
      adapterBindingStatus: binding
        ? {
            bound: binding.bound,
            confidence: binding.confidenceScore,
            degraded: binding.degraded,
            reason: binding.reason,
          }
        : {
            bound: entry.tier === "L1_PUBLIC" || entry.tier === "L2_COMMAND",
            confidence: entry.tier === "L1_PUBLIC" ? 1.0 : 0.95,
            degraded: false,
          },
    });
  },
};

export const jlcApiInvokeTool: McpToolHandler = {
  name: "jlc_api_invoke",
  layer: 2,
  description:
    "高级动态反射入口：调用经 jlc_api_search / jlc_api_describe 检索确认的 L1 官方 eda.* 接口、L2 内部命令、L3 防混淆适配引擎能力或 L4 受控白名单 IPC。强制拦截 BLOCKED 信道，按 unitMode 自动换算 mm/mil，支持 $ref/$enum 与事务回滚。",
  inputSchema: {
    type: "object",
    required: ["apiId"],
    properties: {
      apiId: { type: "string" },
      operation: { type: "string", enum: ["call", "get", "set"], default: "call" },
      targetHandle: { type: ["string", "null"], default: null },
      arguments: { type: "object", default: {} },
      expectedDocument: { type: ["string", "null"], default: null },
      unitMode: { type: "string", enum: ["mm_deg", "native"], default: "mm_deg" },
      transactional: { type: "boolean", default: true },
      timeoutMs: { type: "integer", default: 15000 },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const envInfo = await state.ensureEnvInfo(context);
    const sqlitePath = state.getCatalogSqlitePath(envInfo);
    if (!fs.existsSync(sqlitePath)) {
      return errEnvelope("ERR_CATALOG_NOT_FOUND", `REA catalog not found at '${sqlitePath}'.`);
    }

    const apiId = String(args.apiId);
    const entry = describeReaApi(sqlitePath, apiId);
    if (!entry) {
      return errEnvelope("ERR_API_NOT_FOUND", `API '${apiId}' not found in REA catalog.`);
    }

    // 1. Hard security gate for BLOCKED channels
    if (entry.securityPolicy === "BLOCKED") {
      return errEnvelope(
        "ERR_API_BLOCKED",
        `API '${apiId}' (${entry.tier}) has securityPolicy='BLOCKED' and cannot be invoked.`
      );
    }

    // 2. Enforce describe-before-invoke contract
    if (!state.describedApis.has(apiId)) {
      return errEnvelope(
        "ERR_API_NOT_DESCRIBED",
        `Contract gate: call jlc_api_describe({ apiId: "${apiId}" }) before invoking jlc_api_invoke.`
      );
    }

    // 3. Validate required parameters
    const rawArgsObj =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    for (const pSpec of entry.parameters) {
      if (pSpec.required && !(pSpec.name in rawArgsObj)) {
        return errEnvelope(
          "ERR_MISSING_ARGUMENT",
          `Missing required argument '${pSpec.name}' for '${apiId}'.`
        );
      }
    }

    // 4. Resolve $enum / $ref tokens and convert mm/deg -> native units
    const unitMode = (args.unitMode === "native" ? "native" : "mm_deg") as UnitMode;
    const orderedArgValues = entry.parameters.length > 0
      ? entry.parameters.map((p) => rawArgsObj[p.name])
      : Object.values(rawArgsObj);

    const resolvedTokens = resolveSpecialTokens(orderedArgValues, {
      unresolvedEnumMode: "marker",
      unresolvedRefMode: "keep",
      resolveRef: (handle) => state.handlePool.getHandle(handle)?.objectId ?? { $ref: handle },
    }) as unknown[];

    const defaultNativeUnit: LengthUnit =
      entry.invocation.targetContext === "sch_renderer" ? "10mil" : "mil";
    const nativeArgs = convertParamsToNative(resolvedTokens, {
      unitMode,
      contract: entry.unitContract,
      parameterSpecs: entry.parameters,
      defaultNativeLengthUnit: defaultNativeUnit,
    }) as unknown[];

    // 5. Execute via live CDP executor if connected
    const apiPath = entry.invocation.globalPath ?? apiId;
    if (context.sessionManager.isConnected()) {
      try {
        const exec = context.sessionManager.getExecutor();
        const res = await exec.invokeEdaApi(apiPath, nativeArgs, {
          document:
            typeof args.expectedDocument === "string" ? args.expectedDocument : null,
          unitMode,
          transactional:
            args.transactional !== false &&
            (entry.sideEffects.mustWrapInTransaction || entry.sideEffects.mutatesCanvas),
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 15000,
          transactionLabel: `MCP invoke ${apiId}`,
        });
        return okEnvelope({
          executedTier: entry.tier,
          durationMs: res.durationMs,
          rolledBack: res.rolledBack,
          result: res.result,
          ...(res.handle ? { handle: res.handle.handle } : {}),
          ...(res.arrayCursor ? { arrayCursor: res.arrayCursor.handle } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errEnvelope("ERR_API_INVOKE_FAILED", msg, { rolledBack: true });
      }
    }

    return errEnvelope(
      "ERR_NOT_CONNECTED",
      `API '${apiId}' validated (tier=${entry.tier}, unitMode=${unitMode}), but no live CDP client session is connected. Call jlc_connect first to execute against JLCEDA Pro.`,
      {
        data: {
          validatedApiId: apiId,
          executedTier: entry.tier,
          unitMode,
          convertedArgs: nativeArgs,
        },
      }
    );
  },
};

export const LAYER2_TOOLS: McpToolHandler[] = [
  jlcApiSearchTool,
  jlcApiDescribeTool,
  jlcApiInvokeTool,
];

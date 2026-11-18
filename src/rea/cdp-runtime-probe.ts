import type { ReaApiCatalogEntry } from "../types/index.js";

/**
 * Minimal structural CDP evaluation interface (decoupled from `src/cdp/`).
 */
export interface CdpEvalTransport {
  evaluate<T = unknown>(
    expression: string,
    options?: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number }
  ): Promise<T>;
}

export interface RuntimeMemberSignature {
  namespace: string;
  memberName: string;
  kind: "method" | "property" | "object";
  arity: number;
  isAsync: boolean;
}

export interface RuntimeCatalogDiff {
  verifiedCount: number;
  missingInRuntime: string[];
  undocumentedInRuntime: RuntimeMemberSignature[];
}

export interface JsonSchemaNode {
  type: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
}

export interface CapturedCallTrace {
  traceId: string;
  uiTrigger: { commandId?: string; menuLabel?: string; timestamp: number };
  targetLogicalRole: string;
  methodKey: string;
  argSchemas: JsonSchemaNode[];
  returnSchema: JsonSchemaNode;
  undoStackDelta: number;
  ipcChannelsTriggered: string[];
}

/**
 * Pure metadata JSON Schema type inference helper (never retains raw user data or source strings).
 */
export function inferRuntimeJsonSchema(value: unknown, depth: number = 0): JsonSchemaNode {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 && depth < 3 ? inferRuntimeJsonSchema(value[0], depth + 1) : { type: "unknown" },
    };
  }
  const t = typeof value;
  if (t === "object") {
    if (depth >= 3) {
      return { type: "object" };
    }
    const props: Record<string, JsonSchemaNode> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      props[k] = inferRuntimeJsonSchema(v, depth + 1);
    }
    return { type: "object", properties: props };
  }
  return { type: t };
}

/**
 * Return a safe non-destructive JS expression that enumerates `window.eda` prototype chains
 * and `contextBridge` metadata ONLY (explicitly avoids calling `fn.toString()`).
 */
export function buildRuntimeReflectionExpression(): string {
  return `(() => {
    const out = [];
    const eda = typeof window !== 'undefined' ? window.eda : undefined;
    if (!eda || typeof eda !== 'object') return out;
    const nsKeys = Object.getOwnPropertyNames(eda);
    for (const ns of nsKeys) {
      if (ns === 'extensionUuid' || ns.startsWith('_')) continue;
      let inst;
      try { inst = eda[ns]; } catch { continue; }
      if (!inst || (typeof inst !== 'object' && typeof inst !== 'function')) continue;
      const seen = new Set();
      let cur = inst;
      for (let d = 0; d < 3 && cur && cur !== Object.prototype; d++) {
        for (const key of Object.getOwnPropertyNames(cur)) {
          if (seen.has(key) || key === 'constructor' || key.startsWith('_')) continue;
          seen.add(key);
          const desc = Object.getOwnPropertyDescriptor(cur, key);
          if (!desc || desc.get) {
            out.push({ namespace: ns, memberName: key, kind: 'property', arity: 0, isAsync: false });
            continue;
          }
          const val = desc.value;
          if (typeof val === 'function') {
            const isAsync = val.constructor && val.constructor.name === 'AsyncFunction';
            out.push({ namespace: ns, memberName: key, kind: 'method', arity: val.length, isAsync: Boolean(isAsync) });
          } else {
            out.push({ namespace: ns, memberName: key, kind: typeof val === 'object' ? 'object' : 'property', arity: 0, isAsync: false });
          }
        }
        cur = Object.getPrototypeOf(cur);
      }
    }
    return out;
  })()`;
}

/**
 * Probe a live CDP target for `window.eda` runtime members (strictly no source extraction).
 */
export async function probeGlobalEdaNamespace(
  transport: CdpEvalTransport
): Promise<RuntimeMemberSignature[]> {
  const result = await transport.evaluate<RuntimeMemberSignature[]>(
    buildRuntimeReflectionExpression(),
    { awaitPromise: false, returnByValue: true, timeoutMs: 3000 }
  );
  return Array.isArray(result) ? result : [];
}

/**
 * Compare live runtime `window.eda` signatures against static `.d.ts` L1 catalog entries.
 */
export function diffRuntimeVsStaticCatalog(
  runtimeMembers: RuntimeMemberSignature[],
  staticEntries: ReaApiCatalogEntry[]
): RuntimeCatalogDiff {
  const runtimeSet = new Set(runtimeMembers.map((m) => `eda.${m.namespace}.${m.memberName}`));
  const staticSet = new Set(
    staticEntries
      .filter((e) => e.tier === "L1_PUBLIC" && e.kind !== "enum")
      .map((e) => e.apiId)
  );

  let verifiedCount = 0;
  const missingInRuntime: string[] = [];
  for (const apiId of staticSet) {
    if (runtimeSet.has(apiId)) {
      verifiedCount++;
    } else {
      missingInRuntime.push(apiId);
    }
  }

  const undocumentedInRuntime = runtimeMembers.filter(
    (m) => !staticSet.has(`eda.${m.namespace}.${m.memberName}`)
  );

  return {
    verifiedCount,
    missingInRuntime,
    undocumentedInRuntime,
  };
}

/**
 * Generate a safe AOP Proxy sniffer script for calibration sessions that records only
 * argument/return JSON Schemas (`inferSchema`), never storing raw secrets or source code.
 */
export function buildAopProxySnifferScript(): string {
  return `(() => {
    if (window.__JLC_REA_TRACES__) return true;
    const traces = [];
    window.__JLC_REA_TRACES__ = traces;
    const infer = (v, d = 0) => {
      if (v === null) return { type: 'null' };
      if (Array.isArray(v)) return { type: 'array', items: v.length && d < 2 ? infer(v[0], d + 1) : { type: 'unknown' } };
      if (typeof v === 'object') {
        if (d >= 2) return { type: 'object' };
        const props = {};
        for (const k of Object.keys(v).slice(0, 16)) props[k] = infer(v[k], d + 1);
        return { type: 'object', properties: props };
      }
      return { type: typeof v };
    };
    window.__JLC_REA_RECORD__ = (role, methodKey, args, ret, undoDelta = 0, cmdId) => {
      if (traces.length >= 200) traces.shift();
      traces.push({
        traceId: 'tr_' + Date.now() + '_' + traces.length,
        uiTrigger: { commandId: cmdId, timestamp: Date.now() },
        targetLogicalRole: String(role),
        methodKey: String(methodKey),
        argSchemas: Array.isArray(args) ? args.map((a) => infer(a)) : [],
        returnSchema: infer(ret),
        undoStackDelta: Number(undoDelta) || 0,
        ipcChannelsTriggered: []
      });
    };
    return true;
  })()`;
}

/**
 * Retrieve and clear recorded calibration traces from a live CDP target.
 */
export async function collectSniffedTraces(
  transport: CdpEvalTransport
): Promise<CapturedCallTrace[]> {
  const traces = await transport.evaluate<CapturedCallTrace[]>(
    `(() => { const t = window.__JLC_REA_TRACES__ || []; window.__JLC_REA_TRACES__ = []; return t; })()`,
    { awaitPromise: false, returnByValue: true, timeoutMs: 3000 }
  );
  return Array.isArray(traces) ? traces : [];
}

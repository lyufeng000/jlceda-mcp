import fs from "node:fs";
import path from "node:path";
import type {
  AdapterBindingEntry,
  AdapterBindingFile,
  LogicalCapabilityId,
  ReaApiCatalogEntry,
  ReaApiTier,
} from "../types/index.js";
import type { BundleScanResult, ClassFingerprintProfile } from "./bundle-ast-scanner.js";

export const FINGERPRINT_CONFIDENCE_THRESHOLD = 0.92;

export interface CapabilityBlueprint {
  capabilityId: LogicalCapabilityId;
  tier: ReaApiTier;
  /** Anchor 1: Unobfuscated invariant strings / protocol literals. */
  invariantStrings: string[];
  /** Anchor 2: Class duck-typing properties & methods + arity. */
  requiredPeerProperties: string[];
  arity: number;
  /** Anchor 3: Stable L2 command ID whose call graph reaches this engine capability. */
  parentCommandAnchor: string | null;
  /** Optional fallback capability when confidence < 0.92 trips circuit breaker. */
  fallbackCapabilityId: LogicalCapabilityId | null;
  /** Preferred symbol name hint for IPC/direct lookup when matched. */
  preferredMethodNames?: string[];
}

export const CORE_CAPABILITY_BLUEPRINTS: CapabilityBlueprint[] = [
  {
    capabilityId: "cap:core.history.beginCompositeStep",
    tier: "L3_ENGINE",
    invariantStrings: ["api command group: ", "GROUP_NOT_FOUND", "CONFLICT"],
    requiredPeerProperties: ["begin", "commit", "rollback", "requireOpen", "ensureAggregate"],
    arity: 1,
    parentCommandAnchor: null,
    fallbackCapabilityId: "eda.sys_MessageBus.publish",
    preferredMethodNames: ["begin", "beginCompositeStep"],
  },
  {
    capabilityId: "cap:core.history.commitTransaction",
    tier: "L3_ENGINE",
    invariantStrings: ["api command group: ", "CONFLICT"],
    requiredPeerProperties: ["begin", "commit", "rollback", "ensureAggregate"],
    arity: 1,
    parentCommandAnchor: null,
    fallbackCapabilityId: null,
    preferredMethodNames: ["commit", "commitTransaction"],
  },
  {
    capabilityId: "cap:core.history.rollbackTo",
    tier: "L3_ENGINE",
    invariantStrings: ["HistoryFlushService", "flushService", "GROUP_NOT_FOUND"],
    requiredPeerProperties: ["begin", "commit", "rollback", "requireOpen", "ensureAggregate"],
    arity: 1,
    parentCommandAnchor: null,
    fallbackCapabilityId: null,
    preferredMethodNames: ["rollback", "rollbackTo"],
  },
  {
    capabilityId: "cap:pcb.dsn.exportSilent",
    tier: "L3_ENGINE",
    invariantStrings: ["(PCB ", "(parser", "(resolution", "(structure", "(placement", "(wiring"],
    requiredPeerProperties: ["exportDSN", "exportDSN1", "initRouterConfig", "getSpecctraNetClass"],
    arity: 2,
    parentCommandAnchor: "exportDSN",
    fallbackCapabilityId: "cap:cmd.exportDSN",
    preferredMethodNames: ["exportDSN1", "exportDSN", "generateDsnContent"],
  },
  {
    capabilityId: "cap:pcb.ses.importSilent",
    tier: "L3_ENGINE",
    invariantStrings: ["importSession", "viaNetMap", "padStackMap", "padStackCache"],
    requiredPeerProperties: ["importSession", "exportDSN", "padStackCache", "viaNetMap"],
    arity: 5,
    parentCommandAnchor: "importSes",
    fallbackCapabilityId: "cap:cmd.importSes",
    preferredMethodNames: ["importSession", "exportDSN", "importSes"],
  },
  {
    capabilityId: "cap:pcb.drc.readWriteRuleTree",
    tier: "L3_ENGINE",
    invariantStrings: ["netClasses", "trackWidth", "viaDiameter", "BoardOutline", "ClearanceError"],
    requiredPeerProperties: ["getNet", "getSpecctraNetClass", "getTrackPhysics", "getSafeSpacing", "getRadiusPhysics"],
    arity: 1,
    parentCommandAnchor: null,
    fallbackCapabilityId: "eda.pcb_Drc.getCurrentRuleConfiguration",
    preferredMethodNames: ["getSpecctraNetClass", "getNet"],
  },
  {
    capabilityId: "cap:pcb.router.internalDiffRoute",
    tier: "L3_ENGINE",
    invariantStrings: ["getAllNetDifferentials", "getAllInnerPlane", "getAllCopperPlane", "getDifferentialPairSpacingMin"],
    requiredPeerProperties: ["getAllNetDifferentials", "getAllNetDifferentialsGroup", "getSpecctraNetClass", "getSafeSpacing", "getTrackPhysics"],
    arity: 1,
    parentCommandAnchor: "diffPairEqualLengthTuning",
    fallbackCapabilityId: "cap:cmd.diffPairEqualLengthTuning",
    preferredMethodNames: ["getAllNetDifferentials", "getDifferentialPairSpacingMin", "getAllNetDifferentialsGroup"],
  },
  {
    capabilityId: "cap:ipc.localLib.querySqliteCatalog",
    tier: "L4_IPC",
    invariantStrings: ["/mgr/libWorker/getDevice", "/mgr/libWorker/getFootprint"],
    requiredPeerProperties: ["getDevice", "getFootprint", "getSymbol"],
    arity: 1,
    parentCommandAnchor: null,
    fallbackCapabilityId: "eda.lib_Device.search",
    preferredMethodNames: ["getDevice", "queryDeviceCatalog"],
  },
];

function normalizeToken(s: string): string {
  return s.toLowerCase();
}

function scoreProfileAgainstBlueprint(
  profile: ClassFingerprintProfile,
  blueprint: CapabilityBlueprint,
  scanResult: BundleScanResult
): {
  confidenceScore: number;
  invariantStringsMatched: number;
  peerPropertiesMatched: number;
  arityMatched: boolean;
  commandCallGraphHops: number;
  bestMethodName: string | null;
} {
  // Anchor 1: Invariant strings matched across profile strings + global bundle error/drc/l4 pools
  const profileStringsLower = new Set(profile.invariantStrings.map(normalizeToken));
  const profilePropsAndMethods = new Set([
    ...profile.accessedProperties,
    ...profile.methods.map((m) => m.name),
    ...profile.calledFunctions,
  ]);
  const globalDrcLower = new Set(scanResult.drcRuleKeys.map(normalizeToken));
  const globalL4Names = new Set(
    scanResult.l4Entries.map((e) => normalizeToken(e.memberName ?? e.apiId))
  );

  let invariantMatched = 0;
  for (const inv of blueprint.invariantStrings) {
    const invLower = normalizeToken(inv);
    const hitInProfile =
      profileStringsLower.has(invLower) ||
      Array.from(profileStringsLower).some((s) => s.includes(invLower) || invLower.includes(s)) ||
      profilePropsAndMethods.has(inv) ||
      Array.from(profilePropsAndMethods).some((p) => normalizeToken(p) === invLower);

    const hitInDrcOrL4 =
      (blueprint.capabilityId === "cap:pcb.drc.readWriteRuleTree" && globalDrcLower.has(invLower)) ||
      (blueprint.tier === "L4_IPC" &&
        (globalL4Names.has(invLower) ||
          Array.from(globalL4Names).some((x) => x.includes(invLower))));

    if (hitInProfile || hitInDrcOrL4) {
      invariantMatched++;
    }
  }
  const invRatio =
    blueprint.invariantStrings.length > 0
      ? invariantMatched / blueprint.invariantStrings.length
      : 1;

  // Anchor 2: Class duck-typing peer properties & methods + arity
  let peerMatched = 0;
  for (const prop of blueprint.requiredPeerProperties) {
    if (
      profilePropsAndMethods.has(prop) ||
      Array.from(profilePropsAndMethods).some((p) => p.toLowerCase() === prop.toLowerCase())
    ) {
      peerMatched++;
    }
  }
  const peerRatio =
    blueprint.requiredPeerProperties.length > 0
      ? peerMatched / blueprint.requiredPeerProperties.length
      : 1;

  // Find best method & arity check
  let bestMethodName: string | null = null;
  let arityMatched = false;
  for (const preferred of blueprint.preferredMethodNames ?? []) {
    const found = profile.methods.find((m) => m.name === preferred);
    if (found) {
      bestMethodName = found.name;
      arityMatched = Math.abs(found.arity - blueprint.arity) <= 1 || found.arity === blueprint.arity;
      break;
    }
  }
  if (!bestMethodName) {
    const arityMatch = profile.methods.find((m) => m.arity === blueprint.arity);
    if (arityMatch) {
      bestMethodName = arityMatch.name;
      arityMatched = true;
    } else if (profile.methods[0]) {
      bestMethodName = profile.methods[0].name;
    }
  }

  // Anchor 3: Command-to-Engine Call-Graph Anchor
  let cmdHopMatched = false;
  let hops = 0;
  if (blueprint.parentCommandAnchor) {
    const cmdExists = scanResult.l2Entries.some(
      (e) =>
        e.invocation.commandKey === blueprint.parentCommandAnchor ||
        e.memberName === blueprint.parentCommandAnchor
    );
    const graphTargets = scanResult.commandGraphEdges[blueprint.parentCommandAnchor] ?? [];
    const directEdgeHit =
      graphTargets.some((fn) => profilePropsAndMethods.has(fn)) ||
      (bestMethodName !== null && profileStringsLower.has(normalizeToken(blueprint.parentCommandAnchor)));

    if (cmdExists && directEdgeHit) {
      cmdHopMatched = true;
      hops = 1;
    } else if (cmdExists) {
      cmdHopMatched = true;
      hops = 2;
    }
  }

  // Weighted confidence score in [0, 1]
  let score: number;
  if (blueprint.parentCommandAnchor) {
    score =
      invRatio * 0.45 +
      peerRatio * 0.30 +
      (arityMatched ? 0.10 : 0) +
      (cmdHopMatched ? (hops === 1 ? 0.15 : 0.12) : 0);
  } else {
    score = invRatio * 0.50 + peerRatio * 0.40 + (arityMatched ? 0.10 : 0);
  }

  return {
    confidenceScore: Math.round(Math.min(1, Math.max(0, score)) * 10000) / 10000,
    invariantStringsMatched: invariantMatched,
    peerPropertiesMatched: peerMatched,
    arityMatched,
    commandCallGraphHops: hops,
    bestMethodName,
  };
}

/**
 * Evaluate a single blueprint against scanned AST profiles and global L2/L4 evidence,
 * applying the `< 0.92` confidence circuit breaker.
 */
export function matchCapabilityBlueprint(
  blueprint: CapabilityBlueprint,
  scanResult: BundleScanResult
): AdapterBindingEntry {
  // Fast-path for L4 IPC channels already directly extracted in Pass 4/5
  if (blueprint.tier === "L4_IPC") {
    const matchedL4 = scanResult.l4Entries.filter((e) =>
      blueprint.invariantStrings.some(
        (inv) =>
          e.memberName === inv ||
          e.invocation.commandKey === inv ||
          e.apiId.includes(inv.replace(/[^A-Za-z0-9_]/g, "_"))
      )
    );
    if (matchedL4.length > 0) {
      const primary = matchedL4[0];
      const invRatio = Math.min(1, matchedL4.length / blueprint.invariantStrings.length);
      const score = Math.round((0.6 + invRatio * 0.4) * 10000) / 10000;
      const bound = score >= FINGERPRINT_CONFIDENCE_THRESHOLD;
      return {
        capabilityId: blueprint.capabilityId,
        tier: blueprint.tier,
        bound,
        degraded: !bound,
        confidenceScore: score,
        resolvedPath: bound ? primary.invocation.commandKey ?? primary.memberName ?? null : null,
        resolvedSymbol: bound ? primary.memberName ?? null : null,
        moduleId: bound ? "ipc-channel" : null,
        commandKey: primary.invocation.commandKey ?? null,
        fallbackCapabilityId: blueprint.fallbackCapabilityId,
        matchedAnchors: {
          invariantStringsMatched: matchedL4.length,
          peerPropertiesMatched: blueprint.requiredPeerProperties.length,
          arityMatched: true,
          commandCallGraphHops: 0,
        },
        reason: bound
          ? `Matched ${matchedL4.length} IPC/worker channel anchors cleanly.`
          : `Confidence ${score} < ${FINGERPRINT_CONFIDENCE_THRESHOLD}; degraded to fallback.`,
      };
    }
  }

  let bestScore = -1;
  let bestProfile: ClassFingerprintProfile | null = null;
  let bestStats: ReturnType<typeof scoreProfileAgainstBlueprint> | null = null;

  for (const profile of scanResult.classProfiles) {
    const stats = scoreProfileAgainstBlueprint(profile, blueprint, scanResult);
    if (stats.confidenceScore > bestScore) {
      bestScore = stats.confidenceScore;
      bestProfile = profile;
      bestStats = stats;
    }
  }

  // Fallback global scoring when an engine capability lives in top-level functions/DRC keys rather than a single class
  if ((!bestProfile || bestScore < FINGERPRINT_CONFIDENCE_THRESHOLD) && scanResult.classProfiles.length === 0) {
    bestScore = 0;
  }

  const finalScore = Math.max(0, bestScore);
  const bound = finalScore >= FINGERPRINT_CONFIDENCE_THRESHOLD && bestProfile !== null;

  return {
    capabilityId: blueprint.capabilityId,
    tier: blueprint.tier,
    bound,
    degraded: !bound,
    confidenceScore: finalScore,
    resolvedPath: bound && bestProfile ? `${bestProfile.bundleFile}::${bestProfile.symbolName}` : null,
    resolvedSymbol:
      bound && bestProfile
        ? bestStats?.bestMethodName
          ? `${bestProfile.symbolName}.${bestStats.bestMethodName}`
          : bestProfile.symbolName
        : null,
    moduleId: bound && bestProfile ? bestProfile.moduleId : null,
    commandKey: blueprint.parentCommandAnchor,
    fallbackCapabilityId: blueprint.fallbackCapabilityId,
    matchedAnchors: bestStats
      ? {
          invariantStringsMatched: bestStats.invariantStringsMatched,
          peerPropertiesMatched: bestStats.peerPropertiesMatched,
          arityMatched: bestStats.arityMatched,
          commandCallGraphHops: bestStats.commandCallGraphHops,
        }
      : {
          invariantStringsMatched: 0,
          peerPropertiesMatched: 0,
          arityMatched: false,
          commandCallGraphHops: 0,
        },
    reason: bound
      ? `Three-anchor fingerprint matched (${finalScore.toFixed(4)} >= ${FINGERPRINT_CONFIDENCE_THRESHOLD}).`
      : `Circuit breaker triggered: confidenceScore=${finalScore.toFixed(4)} < ${FINGERPRINT_CONFIDENCE_THRESHOLD}; degraded to ${blueprint.fallbackCapabilityId ?? "offline fallback"}.`,
  };
}

/**
 * Rebind all core L3/L4 capability blueprints against AST scan results and enforce `< 0.92`
 * confidence circuit-breaking. Also supports building from additional custom blueprints.
 */
export function buildAdapterBindings(options: {
  asarSha256: string;
  clientVersion: string | null;
  scanResult: BundleScanResult;
  additionalBlueprints?: CapabilityBlueprint[];
  l3CatalogEntries?: ReaApiCatalogEntry[];
}): AdapterBindingFile {
  const blueprints = [
    ...CORE_CAPABILITY_BLUEPRINTS,
    ...(options.additionalBlueprints ?? []),
  ];

  const bindings: Record<LogicalCapabilityId, AdapterBindingEntry> = {};
  const degradedCapabilities: LogicalCapabilityId[] = [];

  for (const bp of blueprints) {
    const entry = matchCapabilityBlueprint(bp, options.scanResult);
    bindings[bp.capabilityId] = entry;
    if (entry.degraded) {
      degradedCapabilities.push(bp.capabilityId);
    }
  }

  return {
    schemaVersion: "1.0.0",
    asarSha256: options.asarSha256,
    clientVersion: options.clientVersion,
    generatedAt: new Date().toISOString(),
    bindings,
    degradedCapabilities,
  };
}

/**
 * Load cached `adapter_bindings.<sha256>.json` if present and matching SHA-256, or null on cache miss.
 */
export function loadCachedAdapterBindings(
  indexDir: string,
  asarSha256: string
): AdapterBindingFile | null {
  const filePath = path.join(indexDir, `adapter_bindings.${asarSha256}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as AdapterBindingFile;
    if (parsed.asarSha256 === asarSha256 && parsed.bindings) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist `adapter_bindings.<sha256>.json` to `indexDir`.
 */
export function saveAdapterBindings(
  indexDir: string,
  bindingsFile: AdapterBindingFile
): string {
  fs.mkdirSync(indexDir, { recursive: true });
  const outPath = path.join(indexDir, `adapter_bindings.${bindingsFile.asarSha256}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(bindingsFile, null, 2)}\n`, "utf8");
  return outPath;
}

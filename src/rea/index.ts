export { AsarMemoryVfs, type VfsMode } from "./asar-memory-vfs.js";
export {
  extractDtsFromContent,
  extractL1FromVfsOrPackage,
  type DtsExtractionResult,
} from "./dts-extractor.js";
export {
  scanBundlesFromCode,
  scanVfsBundlesAst,
  type BundleInput,
  type BundleRole,
  type BundleScanResult,
  type ClassFingerprintProfile,
  type ClassMethodFingerprint,
} from "./bundle-ast-scanner.js";
export {
  buildAopProxySnifferScript,
  buildRuntimeReflectionExpression,
  collectSniffedTraces,
  diffRuntimeVsStaticCatalog,
  inferRuntimeJsonSchema,
  probeGlobalEdaNamespace,
  type CapturedCallTrace,
  type CdpEvalTransport,
  type JsonSchemaNode,
  type RuntimeCatalogDiff,
  type RuntimeMemberSignature,
} from "./cdp-runtime-probe.js";
export {
  CORE_CAPABILITY_BLUEPRINTS,
  FINGERPRINT_CONFIDENCE_THRESHOLD,
  buildAdapterBindings,
  loadCachedAdapterBindings,
  matchCapabilityBlueprint,
  saveAdapterBindings,
  type CapabilityBlueprint,
} from "./fingerprint-adapter.js";
export {
  buildReaCatalog,
  describeReaApi,
  expandSearchTokens,
  readReaCatalogStats,
  searchReaCatalog,
  type BuildCatalogOptions,
  type BuildCatalogResult,
  type SearchCatalogHit,
  type SearchCatalogOptions,
  type SearchCatalogResult,
} from "./catalog-builder.js";
export {
  verifyZeroSourceCatalog,
  type VerifyZeroSourceOptions,
  type ZeroSourceAuditReport,
  type ZeroSourceViolation,
} from "./zero-source-verifier.js";

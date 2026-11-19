/**
 * Global Frozen Contract Layer for JLCEDA Pro MCP Server.
 *
 * Wave 1 artifact owned by `scaffold`. Subsequent workers MUST treat this file
 * as read-only and import shared types, constants, and envelope helpers from here.
 */

// ============================================================================
// 1. Unified MCP Response Envelope
// ============================================================================

export interface McpEnvelope<T> {
  ok: boolean;
  errorCode?: string;
  message?: string;
  rolledBack?: boolean;
  data: T;
}

/**
 * Construct a successful MCP tool response envelope.
 */
export function okEnvelope<T>(data: T, message?: string): McpEnvelope<T> {
  return message !== undefined ? { ok: true, message, data } : { ok: true, data };
}

/**
 * Construct a standardized error MCP tool response envelope.
 */
export function errEnvelope<T = null>(
  errorCode: string,
  message: string,
  options?: { rolledBack?: boolean; data?: T }
): McpEnvelope<T> {
  return {
    ok: false,
    errorCode,
    message,
    ...(options?.rolledBack !== undefined ? { rolledBack: options.rolledBack } : {}),
    data: (options && "data" in options ? options.data : null) as T,
  };
}

// ============================================================================
// 2. REA Metadata Index & Anti-Obfuscation Fingerprint Binding Types
// ============================================================================

export type ReaApiTier = "L1_PUBLIC" | "L2_COMMAND" | "L3_ENGINE" | "L4_IPC";

export type ReaApiDomain =
  | "SYS"
  | "DMT"
  | "LIB"
  | "SCH"
  | "PCB"
  | "DRC"
  | "SIM"
  | "VIEW"
  | "IPC";

export type ReaApiKind =
  | "method"
  | "property"
  | "command"
  | "ipc_channel"
  | "worker_rpc"
  | "enum";

/**
 * Logical capability identifier for L2-L4 internal APIs (e.g. `cap:pcb.dsn.exportSilent`)
 * or full L1 identifier (`eda.<ns>.<member>`).
 */
export type LogicalCapabilityId = string;

export type ReaTargetContext =
  | "any_editor_renderer"
  | "sch_renderer"
  | "pcb_renderer"
  | "footprint_renderer"
  | "main_process";

export type ReaAsyncMode = "sync" | "promise" | "callback" | "event_stream";

export type ReaBindingStrategy =
  | "direct_global_path"
  | "command_dispatcher"
  | "fingerprint_singleton"
  | "ipc_invoke";

export interface ReaFingerprintAnchor {
  invariantStrings?: string[];
  requiredPeerProperties?: string[];
  arity?: number;
  parentCommandAnchor?: string | null;
  fallbackCapabilityId?: string | null;
}

export interface ReaInvocationSpec {
  targetContext: ReaTargetContext;
  asyncMode: ReaAsyncMode;
  bindingStrategy: ReaBindingStrategy;
  globalPath?: string | null;
  commandKey?: string | null;
  fingerprintAnchor?: ReaFingerprintAnchor | null;
}

export interface ReaUnitContract {
  nativeLengthUnit: "none" | "mm" | "mil" | "10mil" | "explicit_unit_param";
  nativeAngleUnit: "none" | "deg" | "rad";
  autoConvertFromMmDeg: boolean;
}

export type ReaPhysicalDimension =
  | "length"
  | "angle"
  | "voltage"
  | "current"
  | "resistance"
  | "capacitance";

export interface ReaParameterSpec {
  name: string;
  required: boolean;
  physicalDimension?: ReaPhysicalDimension | null;
  descriptionZh?: string;
  schema: Record<string, unknown>;
}

export interface ReaReturnSpec {
  descriptionZh: string;
  wrapAsHandleIfComplex: boolean;
  paginatedArray?: boolean;
  schema: Record<string, unknown>;
}

export type ReaDocumentTypeRequirement =
  | "ANY"
  | "SCH"
  | "PCB"
  | "SYMBOL"
  | "FOOTPRINT"
  | "PANEL";

export interface ReaPreconditions {
  requiresOpenProject: boolean;
  requiredActiveDocumentType: ReaDocumentTypeRequirement[];
  requiresBoardOutline?: boolean;
  disallowDuringInteractiveDraw: boolean;
}

export interface ReaSideEffects {
  mutatesCanvas: boolean;
  pushesUndoStep: boolean;
  writesLocalDisk: boolean;
  triggersModalDialog: boolean;
  networkRequest: boolean;
  mustWrapInTransaction?: boolean;
}

export type ReaSecurityPolicy =
  | "ALLOW"
  | "READ_ONLY_SAFE"
  | "CONFIRM_REQUIRED"
  | "BLOCKED";

export interface ReaApiCatalogEntry {
  apiId: string;
  tier: ReaApiTier;
  domain: ReaApiDomain;
  kind: ReaApiKind;
  namespace?: string;
  memberName?: string;
  summaryZh: string;
  keywordsEn: string[];
  invocation: ReaInvocationSpec;
  unitContract: ReaUnitContract;
  parameters: ReaParameterSpec[];
  returns: ReaReturnSpec;
  preconditions: ReaPreconditions;
  sideEffects: ReaSideEffects;
  securityPolicy: ReaSecurityPolicy;
}

export interface AdapterBindingEntry {
  capabilityId: LogicalCapabilityId;
  tier: ReaApiTier;
  bound: boolean;
  degraded: boolean;
  confidenceScore: number;
  resolvedPath?: string | null;
  resolvedSymbol?: string | null;
  moduleId?: string | number | null;
  commandKey?: string | null;
  fallbackCapabilityId?: LogicalCapabilityId | null;
  matchedAnchors?: {
    invariantStringsMatched: number;
    peerPropertiesMatched: number;
    arityMatched: boolean;
    commandCallGraphHops?: number;
  };
  reason?: string;
}

export interface AdapterBindingFile {
  schemaVersion: string;
  asarSha256: string;
  clientVersion?: string | null;
  generatedAt: string;
  bindings: Record<LogicalCapabilityId, AdapterBindingEntry>;
  degradedCapabilities: LogicalCapabilityId[];
}

export interface ReaCatalogStats {
  totalApis: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  l4Count: number;
  degradedCapabilities: LogicalCapabilityId[];
  asarSha256?: string | null;
  indexPath?: string | null;
  indexedAt?: string | null;
}

// ============================================================================
// 3. Client Environment & Path Resolution Types
// ============================================================================

export type PathDiscoverySource =
  | "L0_ENV"
  | "L0_INFO_JSON"
  | "L1_PROCESS"
  | "L2_REGISTRY_UNINSTALL"
  | "L2_REGISTRY_PROTOCOL"
  | "L3_SHORTCUT"
  | "L4_DEFAULT_SCAN"
  | "UNRESOLVED";

export interface ResolvedClientPaths {
  installDir: string | null;
  exePath: string | null;
  asarPath: string | null;
  unpackedDir: string | null;
  builtinExtDir: string | null;
  dataDir: string | null;
  libDir: string | null;
  projectsDir: string | null;
  userDataDir: string | null;
  headlessProfileDir: string;
  cdpPort: number;
  indexDir: string;
  tempDir: string;
  freeroutingJarPath: string | null;
  ngspiceExePath: string | null;
}

export interface ClientEnvironmentInfo {
  clientInstalled: boolean;
  discoverySource: PathDiscoverySource;
  clientVersion: string | null;
  asarSha256: string | null;
  paths: ResolvedClientPaths;
  catalogStats: ReaCatalogStats;
  solvers: {
    freeroutingReady: boolean;
    freeroutingPath: string | null;
    ngspiceReady: boolean;
    ngspicePath: string | null;
  };
  unitSystem: {
    highLevel: "mm/deg";
    nativePcb: "mil";
  };
  degradedMode: boolean;
  diagnostics: string[];
}

// ============================================================================
// 4. CDP Session, Handle Pool & RPC Core Types
// ============================================================================

export type CollaborationMode = "interactive_copilot" | "offline_delivery";

export type TargetDocType =
  | "SCH"
  | "PCB"
  | "SYMBOL"
  | "FOOTPRINT"
  | "PANEL"
  | "HOME"
  | "UNKNOWN";

export type UnitMode = "mm_deg" | "native";

export interface CdpTargetDescriptor {
  targetId: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  docType?: TargetDocType;
  docUuid?: string | null;
  projectUuid?: string | null;
  projectName?: string | null;
  primitiveCount?: number;
}

export interface CdpProcessInfo {
  pid: number;
  exePath?: string | null;
  commandLine?: string | null;
  hasCdp: boolean;
  cdpPort: number | null;
  userDataDir?: string | null;
  windowTitle: string;
  hwnd?: string | number | null;
  zOrder: number;
  isForeground: boolean;
  targets?: CdpTargetDescriptor[];
}

export interface ModalDialogInfo {
  source: "win32" | "dom";
  title: string;
  textSummary: string;
  buttons?: string[];
  hwnd?: string | number | null;
}

export interface SessionStatusData {
  connectedPid: number | null;
  connectedPort?: number | null;
  collaborationMode?: CollaborationMode | null;
  rpcQueueDepth: number;
  activeModalDialogs: ModalDialogInfo[];
  activeProgressBar: {
    visible: boolean;
    percent: number | null;
    label: string;
  } | null;
  allProcesses: CdpProcessInfo[];
}

export interface ObjectHandleInfo {
  handle: string;
  objectId?: string;
  objectGroup?: string;
  primitiveId?: string;
  type: string;
  designator?: string | null;
  net?: string | null;
  layer?: string | null;
  centerMm?: [number, number] | null;
  bboxMm?: [number, number, number, number] | null;
  summary?: Record<string, unknown>;
}

export interface ArrayCursorPage<T> {
  handle: string;
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  items: T[];
}

export interface PersistentRefPayload {
  v: 1;
  projUuid: string;
  docUuid: string;
  docType: TargetDocType;
  primType: string;
  primId: string;
  naturalKey: {
    designator?: string | null;
    lcsc?: string | null;
    padNumber?: string | null;
    netName?: string | null;
    pinNumber?: string | null;
  };
  geomAnchorMm?: [number, number] | null;
  topologyHash?: string;
  crc: string;
}

export interface CdpConnectOptions {
  launch?: boolean;
  processId?: number | null;
  cdpPort?: number | null;
  targetDocument?: string | null;
  editorType?: "any" | "sch" | "pcb";
  closeEmptyInstances?: boolean;
  isolatedHeadless?: boolean;
  visible?: boolean;
}

export interface CdpConnectResult {
  connected: boolean;
  collaborationMode: CollaborationMode;
  boundInstance: {
    pid: number;
    cdpPort: number;
    clientVersion: string | null;
    projectUuid: string | null;
    activeDocHandle: string | null;
    activeDocType: TargetDocType;
  } | null;
  instances: CdpProcessInfo[];
  closedEmptyPids: number[];
  remediation?: string;
}

export interface DocumentSummary {
  handle: string;
  uuid: string;
  title: string;
  type: TargetDocType;
  projectUuid?: string | null;
  isActive: boolean;
  isDirty: boolean;
  readOnly: boolean;
  selectionCount: number;
  activeInteractiveTool: string | null;
}

export interface CdpEvaluateOptions {
  targetId?: string;
  sessionId?: string;
  executionContextId?: number;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  timeoutMs?: number;
  objectGroup?: string;
}

export interface CdpCallFunctionOptions extends CdpEvaluateOptions {
  objectId?: string;
}

export interface ICdpRpcExecutor {
  evaluate<T = unknown>(expression: string, options?: CdpEvaluateOptions): Promise<T>;
  callFunction<T = unknown>(
    functionDeclaration: string,
    args?: unknown[],
    options?: CdpCallFunctionOptions
  ): Promise<T>;
  invokeEdaApi<T = unknown>(
    apiPath: string,
    args?: unknown[],
    options?: {
      document?: string | null;
      unitMode?: UnitMode;
      transactional?: boolean;
      timeoutMs?: number;
      transactionLabel?: string;
    }
  ): Promise<{
    result: T;
    rolledBack: boolean;
    durationMs: number;
    handle?: ObjectHandleInfo;
    arrayCursor?: ArrayCursorPage<unknown>;
  }>;
  runInTransaction<T = unknown>(
    document: string,
    label: string,
    fn: () => Promise<T>
  ): Promise<{ result: T; checkpointId: string; rolledBack: boolean }>;
  captureScreenshot(options?: {
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
    format?: "png" | "jpeg";
    document?: string | null;
  }): Promise<Buffer>;
  releaseObjectGroup(objectGroup?: string): Promise<void>;
}

export interface CdpLaunchOptions {
  cdpPort?: number | null;
  isolatedHeadless?: boolean;
  forceNewInstance?: boolean;
  waitForCdpMs?: number;
}

export interface CdpLaunchResult {
  launched: boolean;
  alreadyRunning: boolean;
  pid: number | null;
  exePath: string | null;
  cdpPort: number | null;
  cdpReady: boolean;
  activationRequired: boolean;
  launchArgs: string[];
  errorCode?: string;
  message?: string;
}

export interface ICdpSessionManager {
  connect(options?: CdpConnectOptions): Promise<CdpConnectResult>;
  launchClient?(options?: CdpLaunchOptions): Promise<CdpLaunchResult>;
  updateRuntimeOptions?(patch: {
    exePath?: string | null;
    defaultUserDataDir?: string | null;
    headlessProfileDir?: string | null;
    portRange?: [number, number];
  }): void;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getCollaborationMode(): CollaborationMode | null;
  getSessionStatus(): Promise<SessionStatusData>;
  listDocuments(projectUuid?: string | null): Promise<{
    projects: Array<{ projectUuid: string; name: string; path: string }>;
    documents: DocumentSummary[];
  }>;
  activateDocument(document: string): Promise<{
    activeDocumentHandle: string;
    type: TargetDocType;
    targetContextId: string;
  }>;
  resolveTargetSession(document?: string | null): Promise<{
    targetId: string;
    sessionId?: string;
    executionContextId?: number;
    docType: TargetDocType;
    docUuid?: string | null;
  }>;
  getExecutor(): ICdpRpcExecutor;
  closeDocument(options: {
    document: string;
    discardChanges?: boolean;
    releaseProcess?: boolean;
  }): Promise<{
    closed: boolean;
    lockReleased: boolean;
    processExited: boolean;
  }>;
}

// ============================================================================
// 5. Device Library, CESM Model, Calculators, Blocks & SPICE Types
// ============================================================================

export interface DeviceInspectResult {
  deviceUuid?: string;
  symbolUuid?: string;
  footprintUuid?: string;
  model3dUuid?: string | null;
  lcscCode: string;
  mpn: string;
  manufacturer?: string;
  package: string;
  symbolPins: Array<{
    pinNumber: string;
    pinName: string;
    elecType: string;
    relPosMm: [number, number];
  }>;
  footprintPads: Array<{
    padNumber: string;
    shape: string;
    centerMm: [number, number];
    sizeMm: [number, number];
    drillMm: number;
    layer: string;
  }>;
  courtyardBboxMm: [number, number, number, number];
  heightMm: number;
  polarityMarker?: {
    isPolarized: boolean;
    rule?: string;
    markerSide?: string;
    pin1LocationMm?: [number, number];
  } | null;
}

export type CesmCategory =
  | "MCU_SOC"
  | "PMIC_LDO"
  | "PMIC_DCDC"
  | "OPAMP_COMP"
  | "ADC_DAC_VREF"
  | "INTERFACE_XCVR"
  | "ISOLATOR_OPTO"
  | "MOSFET_BJT"
  | "DIODE_SCHOTTKY"
  | "TVS_ESD_MOV"
  | "LED"
  | "RES_CHIP"
  | "RES_SHUNT"
  | "CAP_MLCC"
  | "CAP_AL_ELEC"
  | "CAP_TANTALUM"
  | "IND_POWER"
  | "FERRITE_CMC"
  | "XTAL_PASSIVE"
  | "OSC_ACTIVE"
  | "RELAY_BUZZER"
  | "CONN_USB_TYPEC"
  | "CONN_GENERIC";

export type CesmPinElecType =
  | "POWER_IN"
  | "POWER_OUT"
  | "GND"
  | "PUSH_PULL"
  | "OPEN_DRAIN"
  | "INPUT_HIZ"
  | "BIDIR_IO"
  | "ANALOG_IN"
  | "ANALOG_OUT"
  | "SW_NODE"
  | "PASSIVE"
  | "NC";

export type CesmMandatoryExternal =
  | "NONE"
  | "DECOUPLING_100NF"
  | "PULLUP_RES"
  | "PULLDOWN_or_PULLUP"
  | "DEDICATED_5K1_GND"
  | "CAP_ONLY_NO_LOAD";

export interface CesmPin {
  pin_number: string;
  pin_name: string;
  elec_type: CesmPinElecType;
  supply_pin_ref?: string;
  v_abs_min?: number;
  v_abs_max?: number;
  five_volt_tolerant?: boolean;
  ft_lost_in_analog_mode?: boolean;
  vih_min_expr?: string;
  vil_max_expr?: string;
  iol_max_ma?: number;
  mandatory_external?: CesmMandatoryExternal;
}

export type CesmDielectric =
  | "C0G_NP0"
  | "X7R"
  | "X5R"
  | "Y5V"
  | "MNO2_TANT"
  | "POLYMER_TANT"
  | "AL_LIQUID"
  | "AL_SOLID";

export interface CesmRatings {
  v_working_max?: number;
  power_rated_w?: number;
  r_theta_ja_c_per_w?: number;
  tj_max_c?: number;
  dielectric?: CesmDielectric;
  dc_bias_retention_at_80pct_vr?: number;
  mlcc_output_stable?: boolean;
  i_rms_a?: number;
  i_sat_a?: number;
  v_rwm_v?: number;
  v_clamp_max_v?: number;
  c_junction_pf?: number;
  vgs_rated_for_rdson_min_v?: number;
  isolation_vrms?: number;
  default_output_state?: "HIGH" | "LOW" | "UNDETERMINED";
}

export interface CesmPolaritySpec {
  is_polarized: boolean;
  anode_pins?: string[];
  cathode_pins?: string[];
  silkscreen_rule?: string;
}

export interface CesmCopperZone {
  zoneRole:
    | "VIN_POLYGON"
    | "VOUT_POLYGON"
    | "SW_PH_COMPACT_ISLAND"
    | "TOPSIDE_GND_AREA"
    | "ANALOG_QUIET_GND";
  connectedPins: string[];
  relativeLayer: "MOUNT_LAYER" | "ADJACENT_REF_LAYER" | "OPPOSITE_LAYER";
  areaPolicy: "COMPACT_MIN_PARASITIC" | "WIDE_LOW_INDUCTANCE" | "THERMAL_SPREADING";
  maxAreaMm2?: number;
}

export interface CesmRelativePlacementHint {
  componentRole: string;
  targetPins: string[];
  preferredQuadrantDeg: number;
  maxDistanceMm: number;
  sameLayerMandatory?: boolean;
}

export interface CesmViaHint {
  viaRole:
    | "GND_RETURN_CLUSTER"
    | "BOOT_SIGNAL_VIA"
    | "FB_SENSE_ROUTING_VIA"
    | "FORBID_VIA_IN_HOT_LOOP";
  targetNetRole: string;
  policy: string;
}

export interface CesmThermalViaArray {
  epadPinNumber?: string;
  netRole?: string;
  gridRows?: number;
  gridCols?: number;
  drillMm?: number;
  pitchMm?: number;
  solderMaskTentingOrPlug?: boolean;
}

export interface CesmSensitiveRouteConstraint {
  pinOrNetRole: string;
  keepAwayFromRoles: string[];
  minClearanceMm: number;
  preferInnerOrOppositeLayer?: boolean;
  tapPointRule?: string;
}

export interface CesmLayoutExample {
  sourceSectionTitle?: string;
  referenceImageUri?: string;
  copperZones?: CesmCopperZone[];
  relativePlacementHints?: CesmRelativePlacementHint[];
  viaHints?: CesmViaHint[];
  thermalViaArray?: CesmThermalViaArray;
  sensitiveRouteConstraints?: CesmSensitiveRouteConstraint[];
}

export interface CesmModel {
  lcsc_id: string;
  mpn: string;
  category: CesmCategory;
  package: string;
  verified: boolean;
  polarity_spec?: CesmPolaritySpec;
  pins: CesmPin[];
  ratings: CesmRatings;
  typical_application_constraints?: string[];
  layout_guidelines?: string[];
  layoutExample?: CesmLayoutExample;
}

export const ELEC_CALCULATOR_NAMES = [
  "voltage_divider",
  "ldo_thermal",
  "dcdc_inductor_cap",
  "crystal_load_cap",
  "i2c_pullup",
  "rc_filter_damping",
  "led_optocoupler",
  "mosfet_loss_gate",
  "trace_current_irdrop",
] as const;

export type ElecCalculatorName = (typeof ELEC_CALCULATOR_NAMES)[number];

export interface RecommendedStandardValue {
  role: string;
  nominalValue: string | number;
  unit: string;
  eSeries?: "E24" | "E96";
  lcscCandidate?: string;
  package?: string;
}

export interface ElecCalcResult<TResults = Record<string, unknown>> {
  calculator: ElecCalculatorName;
  formulaUsed: string;
  results: TResults;
  recommendedStandardValues: RecommendedStandardValue[];
  deratingPass: boolean;
  status?: string;
  warnings: string[];
}

export const BLOCK_TEMPLATE_IDS = [
  "BLK_USB_TYPEC_UFP_5V",
  "BLK_PWR_REVERSE_PMOS",
  "BLK_DCDC_BUCK_SYNC",
  "BLK_LDO_LOWNOISE",
  "BLK_MCU_MIN_SYS",
  "BLK_XTAL_PASSIVE",
  "BLK_IND_RELAY_DRIVE",
  "BLK_BUS_RS485_CAN",
  "BLK_ETH_RJ45_BOBSMITH",
] as const;

export type BlockTemplateId = (typeof BLOCK_TEMPLATE_IDS)[number];

export interface BlockTemplateDefinition {
  blockTemplateId: BlockTemplateId | string;
  nameZh: string;
  descriptionZh: string;
  category: string;
  parametersSchema: Record<string, unknown>;
  defaultParameters: Record<string, unknown>;
  components: Array<{
    refRole: string;
    lcscId?: string;
    defaultPackage?: string;
    valueExpr?: string;
    relOffsetMm: [number, number];
    rotationDeg?: number;
    mirror?: boolean;
    mandatory?: boolean;
  }>;
  connections: Array<{
    from: string;
    to: string;
    netRole: string;
  }>;
  exposedPorts: Array<{
    portName: string;
    relOffsetMm: [number, number];
    defaultNetName?: string;
    direction: "IN" | "OUT" | "BIDIR" | "POWER" | "GND";
  }>;
  antiPitfalls?: string[];
}

export type SpiceAnalysisType = "OP" | "TRAN" | "AC" | "DC";

export interface SpiceAnalysisItem {
  type: SpiceAnalysisType;
  params: Record<string, unknown>;
  assertions?: string[];
}

export interface SpiceRunRequest {
  document?: string;
  spiceNetlist?: string;
  subcircuitNets?: string[];
  components?: string[];
  analysisSuite: SpiceAnalysisItem[];
  probeNodes?: string[];
}

export interface SpiceRunResult {
  converged: boolean;
  simulationPassed: boolean;
  engineUsed?: "ngspice" | "jlc_builtin";
  metrics: Record<string, number | string | boolean>;
  failedAssertions: Array<{
    assertion: string;
    actual: number | string;
    diagnosis: string;
    prescribed_action: string;
  }>;
  waveformDataCursor?: string;
}

// ============================================================================
// 6. Schematic Compiled Netlist & Electrical Linter (ELINT-001 ~ ELINT-028)
// ============================================================================

export interface CompiledPin {
  pinNumber: string;
  pinName: string;
  elecType?: CesmPinElecType | string;
  net: string | null;
  posMm?: [number, number];
  isConnected: boolean;
}

export interface CompiledComponent {
  primitiveId: string;
  designator: string;
  lcscId?: string | null;
  mpn?: string | null;
  value?: string | null;
  footprint?: string | null;
  sheetId?: string | null;
  posMm?: [number, number];
  rotationDeg?: number;
  clusterGroup?: string | null;
  pins: CompiledPin[];
  extraProps?: Record<string, unknown>;
}

export interface CompiledNet {
  netName: string;
  endpoints: Array<{
    designator: string;
    pinNumber: string;
    pinName?: string;
    elecType?: string;
  }>;
  fanout: number;
  isPowerOrGround?: boolean;
  sheetNames?: string[];
}

export interface SchGroupBox {
  id: string;
  title: string;
  sheetId?: string;
  rectMm: [number, number, number, number];
  memberDesignators?: string[];
}

/**
 * Authoritative compiled netlist.
 * Must originate exclusively from `eda.sch_Netlist` or `eda.pcb_Netlist`
 * (never reconstructed from 2D `sch_PrimitiveWire` segment intersections).
 */
export interface CompiledNetlist {
  netlistSource: "eda.sch_Netlist" | "eda.pcb_Netlist";
  projectUuid?: string;
  documentUuid?: string;
  documentName?: string;
  compiledAt?: string;
  componentCount: number;
  netCount: number;
  components: CompiledComponent[];
  nets: CompiledNet[];
  unconnectedPins: Array<{
    designator: string;
    pinNumber: string;
    pinName: string;
    reason?: string;
  }>;
  groupBoxes?: SchGroupBox[];
}

export const ELINT_RULE_IDS = [
  "ELINT-001",
  "ELINT-002",
  "ELINT-003",
  "ELINT-004",
  "ELINT-005",
  "ELINT-006",
  "ELINT-007",
  "ELINT-008",
  "ELINT-009",
  "ELINT-010",
  "ELINT-011",
  "ELINT-012",
  "ELINT-013",
  "ELINT-014",
  "ELINT-015",
  "ELINT-016",
  "ELINT-017",
  "ELINT-018",
  "ELINT-019",
  "ELINT-020",
  "ELINT-021",
  "ELINT-022",
  "ELINT-023",
  "ELINT-024",
  "ELINT-025",
  "ELINT-026",
  "ELINT-027",
  "ELINT-028",
] as const;

export type ElintRuleId = (typeof ELINT_RULE_IDS)[number];

export interface ElintDiagnostic {
  rule_id: ElintRuleId;
  severity: "BLOCKER" | "WARNING";
  category: string;
  offending_objects: string[];
  mathematical_evidence: string;
  prescribed_fix: {
    action: string;
    steps?: string[];
    tool?: string;
    blockTemplateId?: string;
    parameters?: Record<string, unknown>;
    recommended_lcsc_candidates?: Array<{
      lcsc_id: string;
      desc: string;
    }>;
  };
}

export interface PerNetRoutingRule {
  netName: string;
  netClass?: string;
  voltageRangeV?: {
    min: number;
    max: number;
    surge?: number;
  };
  maxCurrentA?: number;
  minWidthMm: number;
  preferredWidthMm: number;
  minClearanceMm: number;
  minParallelVias: number;
  creepageDistanceMm?: number;
  requiresIsolationSlot?: boolean;
  isolationDomain?: string;
}

export type EmiRoleTagKind =
  | "AGGRESSOR_SW_NODE"
  | "AGGRESSOR_MAGNETIC"
  | "VICTIM_HIGH_Z"
  | "SHUNT_KELVIN_SENSE"
  | "IMPEDANCE_CTRL_DIFF"
  | "RF_CONTROLLED"
  | "STANDARD_DIGITAL"
  | "POWER_RAIL";

export interface EmiRoleTag {
  netName: string;
  role: EmiRoleTagKind;
  targetDiffImpedanceOhm?: number;
  intraPairSkewMaxMm?: number;
  shuntTopology?: "LOW_SIDE_SINGLE_ENDED" | "HIGH_SIDE_KELVIN_PAIR";
  forbidRedundantGuardRing?: boolean;
  forbidBlindThermalVias?: boolean;
  compactPolygonOnly?: boolean;
  notes?: string;
}

export interface DatasheetLayoutExampleHandoff {
  designator: string;
  lcscId: string;
  mpn?: string;
  layoutGuidelines?: string[];
  layoutExample: CesmLayoutExample;
}

export interface DecouplingAndEsdAffinity {
  decouplingPairs: Array<{
    capacitorDesignator: string;
    targetIcDesignator: string;
    targetPinNumber: string;
    targetPinName?: string;
    powerNet: string;
    groundNet: string;
    maxPathLengthMm: number;
    enforcePowerViaToCapToPinOrder: boolean;
  }>;
  esdInlineChains: Array<{
    connectorDesignator: string;
    connectorPin: string;
    esdDesignator: string;
    esdPin: string;
    targetIcDesignator: string;
    targetIcPin: string;
    netName: string;
    maxStubMm: number;
    minGroundVias: number;
  }>;
}

export interface ConstraintHandoffPackage {
  schemaVersion?: string;
  schDocument?: string;
  generatedAt?: string;
  perNetRoutingRules: PerNetRoutingRule[];
  emiRoleTags: EmiRoleTag[];
  datasheetLayoutExamples: DatasheetLayoutExampleHandoff[];
  decouplingAndEsdAffinity: DecouplingAndEsdAffinity;
  keepoutZones25D: Keepout25DFiveTuple[];
}

export interface ElintAuditReport {
  audit_timestamp: string;
  schDocument: string;
  pass: boolean;
  gateStatus: "READY_FOR_PCB" | "BLOCKED_FOR_PCB";
  blockerCount: number;
  warningCount: number;
  diagnostics: ElintDiagnostic[];
  constraintHandoffPackage?: ConstraintHandoffPackage;
}

// ============================================================================
// 7. PCB Layout, Routing, 2.5D Keep-Out & Geometry Linter (PLINT-01 ~ PLINT-18)
// ============================================================================

export interface NetClassRule {
  name: string;
  nets: string[];
  minWidthMm: number;
  preferredWidthMm?: number;
  maxWidthMm?: number;
  minClearanceMm: number;
  viaDrillMm?: number;
  viaDiameterMm?: number;
  diffPairGapMm?: number;
  targetImpedanceOhm?: number;
  prioritySource: "project_drc" | "computed_handoff" | "merged";
}

export interface ProjectDesignRules {
  source: "JLC_PROJECT_DRC_ONLY" | "JLC_PROJECT_DRC_MERGED" | "MCP_DEFAULT_BASELINE";
  defaultTraceWidthMm: number;
  defaultClearanceMm: number;
  padToPadClearanceMm: number;
  viaToTrackClearanceMm: number;
  pourClearanceMm: number;
  componentClearanceMm: number;
  boardOutlineClearanceMm: number;
  minViaDrillMm: number;
  minViaOuterDiaMm: number;
  minSilkToPadClearanceMm: number;
  copperWeightOuterOz: number;
  netClasses: Record<string, NetClassRule>;
}

export type KeepoutDisallowKind =
  | "COPPER_POUR"
  | "TRACK"
  | "VIA"
  | "PAD"
  | "COMPONENT";

export type KeepoutMountSide = "TOP" | "BOTTOM" | "ALL";

export type Keepout25DCategory =
  | "POWER_INDUCTOR"
  | "FERRITE_OR_CMC"
  | "PASSIVE_CRYSTAL"
  | "SAFETY_ISOLATION_OR_ETH_HV"
  | "RF_ANTENNA"
  | "OPAMP_IN_MINUS"
  | "MOUNTING_HOLE"
  | "CONNECTOR_CLEARANCE";

/**
 * Layer- and object-mask-aware 2.5D Keep-out five-tuple:
 * K = (polygon2D, layerSet, disallowMask, allowedNets, mountSide).
 */
export interface Keepout25DFiveTuple {
  id?: string;
  category?: Keepout25DCategory;
  ownerDesignator?: string;
  polygon2D: Array<[number, number]>;
  layerSet: string[];
  disallowMask: KeepoutDisallowKind[];
  allowedNets: string[];
  mountSide: KeepoutMountSide;
}

export type FunctionalModuleType =
  | "DCDC_POWER_STAGE"
  | "LDO_REGULATOR"
  | "MCU_DIGITAL_CORE"
  | "CLOCK_OSCILLATOR"
  | "PRECISION_ANALOG_FE"
  | "HIGH_SPEED_IO_ESD"
  | "RF_ANTENNA_BLOCK"
  | "ELECTROMECH_DRIVER";

export type ClusterEdgeAffinity =
  | "LEFT_EDGE"
  | "RIGHT_EDGE"
  | "TOP_EDGE"
  | "BOTTOM_EDGE"
  | "CORNER"
  | "CENTER"
  | "NONE";

export interface ClusterMember {
  designator: string;
  footprint: string;
  role: string;
  bbox_mm: [number, number];
  clearance_front_mm?: number;
  target_anchor?: string;
  target_pin?: string;
  target_pins?: string[];
  max_dist_mm?: number;
  zero_stub?: boolean;
  same_layer_mandatory?: boolean;
  power_order?: string;
  guard_ring?: boolean;
}

export interface FunctionalClusterKeepoutZone {
  target?: string;
  type?: string;
  polygon2D?: Array<[number, number]>;
  layerSet: string[];
  disallowMask: KeepoutDisallowKind[];
  allowedNets: string[];
  mountSide: KeepoutMountSide;
}

export interface FunctionalCluster {
  cluster_id: string;
  module_type: FunctionalModuleType;
  semantic_label: string;
  anchor_designator: string;
  edge_affinity: ClusterEdgeAffinity;
  estimated_area_mm2: number;
  noise_role: string;
  thermal_power_w?: number;
  max_voltage_v?: number;
  sub_satellites?: string[];
  datasheet_layout_example?: {
    has_reference_layout: boolean;
    source_section?: string;
    reference_image_uri?: string;
    copper_zones?: string[];
    thermal_via_array?: {
      epad_pin?: string;
      grid_rows?: number;
      grid_cols?: number;
      drill_mm?: number;
      pitch_mm?: number;
    };
    sensitive_route_constraints?: string[];
  };
  keepout_zones?: FunctionalClusterKeepoutZone[];
  members: ClusterMember[];
}

export interface FunctionalClusterOutput {
  schema_version: string;
  board_outline: {
    shape: "RECTANGLE" | "POLYGON";
    width_mm: number;
    height_mm: number;
    layer_count: number;
    copper_weight_outer_oz?: number;
    stackup?: string[];
    polygon_mm?: Array<[number, number]>;
    fixed_mechanicals?: Array<{
      id: string;
      type: string;
      x_mm: number;
      y_mm: number;
      keepout_dia_mm: number;
    }>;
  };
  rigid_edge_anchors?: string[];
  functional_clusters: FunctionalCluster[];
  inter_cluster_edges: Array<{
    from: string;
    to: string;
    nets: string[];
    signal_class: string;
    weight: number;
  }>;
}

export const PLINT_RULE_IDS = [
  "PLINT-01",
  "PLINT-02",
  "PLINT-03",
  "PLINT-04",
  "PLINT-05",
  "PLINT-06",
  "PLINT-07",
  "PLINT-08",
  "PLINT-09",
  "PLINT-10",
  "PLINT-11",
  "PLINT-12",
  "PLINT-13",
  "PLINT-14",
  "PLINT-15",
  "PLINT-16",
  "PLINT-17",
  "PLINT-18",
] as const;

export type PlintRuleId = (typeof PLINT_RULE_IDS)[number];

export interface PlintFinding {
  ruleId: PlintRuleId;
  severity: "BLOCKER" | "WARNING";
  category: string;
  net?: string;
  involvedPrimitives: string[];
  locationMm: [number, number];
  layer: string;
  measuredValue: string | number;
  threshold: string | number;
  autoFixAction: string;
  prescription: string;
}

export interface PcbLintReport {
  pass: boolean;
  activeDesignRuleSource: string;
  effectiveDesignRules: ProjectDesignRules;
  unroutedRatlineCount: number;
  nativeDrcErrors: Array<{
    code?: string;
    message: string;
    layer?: string;
    locationMm?: [number, number];
    primitives?: string[];
  }>;
  custom_linter_summary?: {
    blocker_count: number;
    warning_count: number;
  };
  customGeoLintFindings: PlintFinding[];
  arrayCursor?: string;
}

export interface MasterValidationReport {
  pass: boolean;
  summaryScore: number;
  netlistInSync: boolean;
  electricalAuditPass: boolean;
  pcbDrcPass: boolean;
  unroutedNets: number;
  dfmSmtReady: boolean;
  blockers: Array<{
    stage: string;
    code: string;
    message: string;
    locationMm?: [number, number];
    prescription?: string;
  }>;
  warnings: Array<{
    stage: string;
    code: string;
    message: string;
  }>;
}

// ============================================================================
// 8. MCP Tool Registry (6 Layers, 43 Tools) & Handler Contract
// ============================================================================

const LAYER1_TOOL_NAMES = [
  "jlc_configure",
  "jlc_launch",
  "jlc_connect",
  "jlc_session_status",
  "jlc_capabilities",
  "jlc_documents",
  "jlc_document_new",
  "jlc_document_open",
  "jlc_document_activate",
  "jlc_document_save",
  "jlc_document_close",
  "jlc_select",
  "jlc_reference_create",
  "jlc_reference_resolve",
  "jlc_array_read",
  "jlc_transaction",
] as const;

const LAYER2_TOOL_NAMES = [
  "jlc_api_search",
  "jlc_api_describe",
  "jlc_api_invoke",
] as const;

const LAYER3_TOOL_NAMES = [
  "jlc_lib_search",
  "jlc_lib_device_inspect",
  "jlc_datasheet_extract",
  "jlc_lib_custom_create",
  "jlc_elec_calc",
] as const;

const LAYER4_TOOL_NAMES = [
  "jlc_sch_sheet_manage",
  "jlc_sch_component_place",
  "jlc_sch_block_instantiate",
  "jlc_sch_wire_connect",
  "jlc_sch_netlist_query",
  "jlc_spice_run",
  "jlc_sch_sync_to_pcb",
] as const;

const LAYER5_TOOL_NAMES = [
  "jlc_pcb_board_setup",
  "jlc_pcb_cluster_netlist",
  "jlc_pcb_layout_apply",
  "jlc_pcb_route_critical",
  "jlc_pcb_via_place",
  "jlc_pcb_autoroute",
  "jlc_pcb_pour_and_stitch",
  "jlc_pcb_silkscreen_tidy",
] as const;

const LAYER6_TOOL_NAMES = [
  "jlc_elec_lint",
  "jlc_pcb_drc_and_lint",
  "jlc_validate",
  "jlc_view_capture",
] as const;

export const JLC_TOOL_NAMES = {
  layer1: LAYER1_TOOL_NAMES,
  layer2: LAYER2_TOOL_NAMES,
  layer3: LAYER3_TOOL_NAMES,
  layer4: LAYER4_TOOL_NAMES,
  layer5: LAYER5_TOOL_NAMES,
  layer6: LAYER6_TOOL_NAMES,
  all: [
    ...LAYER1_TOOL_NAMES,
    ...LAYER2_TOOL_NAMES,
    ...LAYER3_TOOL_NAMES,
    ...LAYER4_TOOL_NAMES,
    ...LAYER5_TOOL_NAMES,
    ...LAYER6_TOOL_NAMES,
  ] as const,
} as const;

export type JlcToolName = (typeof JLC_TOOL_NAMES.all)[number];

export interface McpToolContentText {
  type: "text";
  text: string;
}

export interface McpToolContentImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type McpToolContentItem = McpToolContentText | McpToolContentImage;

export interface McpToolResponse {
  content: McpToolContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpToolContext {
  sessionManager: ICdpSessionManager;
  envInfo?: ClientEnvironmentInfo;
  abortSignal?: AbortSignal;
}

export interface McpToolHandler<
  TInput = Record<string, unknown>,
  TOutput = unknown,
> {
  readonly name: JlcToolName;
  readonly layer: 1 | 2 | 3 | 4 | 5 | 6;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly zodShape?: Record<string, unknown>;
  execute(
    args: TInput,
    context: McpToolContext
  ): Promise<McpEnvelope<TOutput> | McpToolResponse>;
}

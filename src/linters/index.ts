export {
  AuthoritativeNetlistError,
  buildElectricalHypergraph,
  findAnodePin,
  findCathodePin,
  getPackageDefaultRThetaJA,
  getPackagePowerRatedW,
  getPackageWorkingMaxV,
  getPinSupplyVoltage,
  isGroundNetName,
  normalizePackageCode,
  parseCapacitancePf,
  parseRatedVoltageV,
  parseResistanceOhms,
  parseVoltageFromNetName,
} from "./hypergraph-propagator.js";

export type {
  CesmResolver,
  ElectricalHypergraph,
  HypergraphComponentNode,
  HypergraphNetEdge,
  HypergraphPinRef,
  IsolatorBarrierInfo,
  NetSignalClass,
  VoltageRange,
} from "./hypergraph-propagator.js";

export {
  createBuiltInCesmResolver,
  runElectricalLinter,
} from "./electrical-linter.js";

export type { ElectricalLinterOptions } from "./electrical-linter.js";

export {
  buildEffectiveDesignRules,
  computePolygonAreaMm2,
  computePolygonOverlapAreaMm2,
  normalizeLayerName,
  resolveKeepoutLayers,
  runGeometryPcbLinter,
} from "./geometry-pcb-linter.js";

export type {
  PcbBoardGeometrySnapshot,
  PcbComponentGeom,
  PcbIsolationSlotGeom,
  PcbMountingHoleGeom,
  PcbNativeDrcInput,
  PcbObservationMeta,
  PcbPadGeom,
  PcbPourGeom,
  PcbTestPointGeom,
  PcbTrackGeom,
  PcbViaGeom,
} from "./geometry-pcb-linter.js";

export {
  MIL_TO_MM,
  classifyCopperSensitiveComponent,
  computeContoursBbox,
  parseEasyEdaContour,
  parseEasyEdaRect,
  parseEasyEdaSourceContours,
  pointInComplexContours,
  pointInContour2D,
  selfCheckSourceGeometry,
} from "./easyeda-source-geom.js";

export type {
  Bbox2D,
  Contour2D,
  CopperSensitiveKind,
  EasyEdaSourceParseOptions,
  Point2D,
  SourceGeomSelfCheckEntry,
  SourceGeomSelfCheckReport,
} from "./easyeda-source-geom.js";

export {
  normalizeAuditFindings,
  normalizeElintDiagnostics,
  normalizeMasterReport,
  normalizePlintFindings,
} from "./audit-normalizer.js";

export type {
  AuditNormalizeOptions,
  RawAuditFinding,
} from "./audit-normalizer.js";

export {
  runMasterValidation,
  runMasterValidationWithDetails,
} from "./master-validator.js";

export type {
  BomVerificationEntry,
  CplVerificationEntry,
  MasterValidationDetailedResult,
  MasterValidationInput,
} from "./master-validator.js";

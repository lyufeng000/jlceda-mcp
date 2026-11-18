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
  PcbPadGeom,
  PcbPourGeom,
  PcbTestPointGeom,
  PcbTrackGeom,
  PcbViaGeom,
} from "./geometry-pcb-linter.js";

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

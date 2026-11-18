import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type {
  CesmModel,
  ClientEnvironmentInfo,
  CompiledComponent,
  CompiledNet,
  CompiledNetlist,
  CompiledPin,
  DocumentSummary,
  ElintAuditReport,
  Keepout25DFiveTuple,
  McpToolContext,
  ObjectHandleInfo,
  PcbLintReport,
  ProjectDesignRules,
  SchGroupBox,
  TargetDocType,
} from "../types/index.js";
import { resolveClientEnvironment } from "../env/path-resolver.js";
import { readReaCatalogStats } from "../rea/catalog-builder.js";
import { loadCachedAdapterBindings } from "../rea/fingerprint-adapter.js";
import { HandlePool } from "../cdp/handle-pool.js";
import {
  CesmBinder,
  type OrthogonalWireSegment,
  type PlacedNetLabel,
  type TeeJunctionPoint,
} from "../electrical/index.js";
import {
  buildBaselineProjectRules,
  getRotatedDims,
  resolveStackupLayers,
  type BuiltCopperPour,
  type FiducialMarker,
  type LockedCopperZone,
  type LockedTrackSegment,
  type LockedVia,
  type ModularPlacementResult,
  type PadPourStyleAssignment,
  type PlacedComponent,
  type RoutedTrack,
  type RoutedVia,
  type SilkscreenTidyResult,
  type SubcircuitClusterResult,
} from "../layout-routing/index.js";
import type {
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
} from "../linters/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");

export interface ProjectRecord {
  projectUuid: string;
  name: string;
  path: string;
  documentHandles: string[];
}

export interface SchSheetRecord {
  sheetUuid: string;
  name: string;
  frameSize: "A4" | "A3";
  titleBlock: Record<string, unknown>;
}

export interface SchematicDocData {
  sheets: SchSheetRecord[];
  groupBoxes: SchGroupBox[];
  components: CompiledComponent[];
  wires: OrthogonalWireSegment[];
  junctions: TeeJunctionPoint[];
  netLabels: PlacedNetLabel[];
  noConnectPins: string[];
  lastElintReport?: ElintAuditReport;
}

export interface PcbBoardOutlineState {
  shape: "RECTANGLE" | "POLYGON";
  widthMm: number;
  heightMm: number;
  layerCount: number;
  copperWeightOuterOz: number;
  stackup: string[];
  polygonMm?: Array<[number, number]>;
  vCutLines?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  mouseBites?: Array<{ xMm: number; yMm: number; radiusMm: number }>;
  isolationSlots: PcbIsolationSlotGeom[];
  mountingHoles: PcbMountingHoleGeom[];
}

export interface PcbDocData {
  sourceSchDocument?: string;
  boardOutline: PcbBoardOutlineState;
  projectDesignRules: ProjectDesignRules;
  keepoutZones25D: Keepout25DFiveTuple[];
  clusterResult?: SubcircuitClusterResult;
  placementResult?: ModularPlacementResult;
  placements: PlacedComponent[];
  syncedNetlist?: CompiledNetlist;
  lockedTracks: LockedTrackSegment[];
  lockedCopperZones: LockedCopperZone[];
  lockedVias: LockedVia[];
  tracks: RoutedTrack[];
  vias: RoutedVia[];
  pours: BuiltCopperPour[];
  padPourStyles: PadPourStyleAssignment[];
  fiducials: FiducialMarker[];
  testPoints: PcbTestPointGeom[];
  silkscreenResult?: SilkscreenTidyResult;
  nativeDrcResult: PcbNativeDrcInput;
  lastPcbLintReport?: PcbLintReport;
}

export interface TxStepEntry {
  id: string;
  label: string;
  timestamp: string;
  status: "active" | "committed" | "rolled_back";
}

export interface WorkspaceDocument {
  handle: string;
  uuid: string;
  title: string;
  type: TargetDocType;
  projectUuid: string;
  path: string;
  isActive: boolean;
  isDirty: boolean;
  readOnly: boolean;
  selection: ObjectHandleInfo[];
  lastClickPointMm: [number, number] | null;
  activeInteractiveTool: string | null;
  txHistory: TxStepEntry[];
  activeCheckpoints: Map<string, { label: string; snapshotJson: string }>;
  sch?: SchematicDocData;
  pcb?: PcbDocData;
}

function makeUuid(prefix: string, seq: number): string {
  return `${prefix}-${seq.toString(16).padStart(8, "0")}`;
}

export function enrichEnvCatalogStats(info: ClientEnvironmentInfo): ClientEnvironmentInfo {
  const sqlitePath = path.join(info.paths.indexDir, "api_catalog.sqlite");
  if (!fs.existsSync(sqlitePath)) {
    return info;
  }
  try {
    const stats = readReaCatalogStats(sqlitePath);
    const sha = info.asarSha256 ?? stats.asarSha256 ?? null;
    let degradedCapabilities = stats.degradedCapabilities ?? [];
    if (sha) {
      const bindings = loadCachedAdapterBindings(info.paths.indexDir, sha);
      if (bindings) {
        degradedCapabilities = bindings.degradedCapabilities;
      }
    }
    return {
      ...info,
      catalogStats: {
        ...stats,
        asarSha256: sha,
        indexPath: sqlitePath,
        degradedCapabilities,
      },
      degradedMode: !info.clientInstalled || degradedCapabilities.length > 0,
    };
  } catch {
    return info;
  }
}

export function createDefaultSchData(name: string): SchematicDocData {
  return {
    sheets: [
      {
        sheetUuid: `sheet-${name}`,
        name: "Sheet1",
        frameSize: "A3",
        titleBlock: { title: name, revision: "1.0" },
      },
    ],
    groupBoxes: [],
    components: [],
    wires: [],
    junctions: [],
    netLabels: [],
    noConnectPins: [],
  };
}

export function createDefaultPcbData(): PcbDocData {
  const layerCount = 4;
  return {
    boardOutline: {
      shape: "RECTANGLE",
      widthMm: 100,
      heightMm: 80,
      layerCount,
      copperWeightOuterOz: 1.0,
      stackup: resolveStackupLayers(layerCount),
      isolationSlots: [],
      mountingHoles: [],
    },
    projectDesignRules: buildBaselineProjectRules("jlc_standard_multi", 1.0),
    keepoutZones25D: [],
    placements: [],
    lockedTracks: [],
    lockedCopperZones: [],
    lockedVias: [],
    tracks: [],
    vias: [],
    pours: [],
    padPourStyles: [],
    fiducials: [],
    testPoints: [],
    nativeDrcResult: {
      unroutedRatlineCount: 0,
      errors: [],
    },
  };
}

export class McpWorkspaceState {
  public envInfo: ClientEnvironmentInfo | null = null;
  public readonly handlePool = new HandlePool();
  public readonly cesmBinder: CesmBinder;
  public readonly customFootprintDimsMm = new Map<string, [number, number]>();
  public readonly describedApis = new Set<string>();
  public readonly projects = new Map<string, ProjectRecord>();
  public readonly documents = new Map<string, WorkspaceDocument>();
  public activeDocumentHandle: string | null = null;

  private seq = 1;

  constructor(options?: { cesmSqlitePath?: string; layoutImageDir?: string }) {
    this.cesmBinder = new CesmBinder({
      sqlitePath:
        options?.cesmSqlitePath ??
        process.env.JLC_CESM_SQLITE_PATH ??
        path.join(WORKSPACE_ROOT, "catalog", "cesm_cache.sqlite"),
      schemaPath: path.join(WORKSPACE_ROOT, "schemas", "cesm-v1.schema.json"),
      layoutImageDir:
        options?.layoutImageDir ??
        process.env.JLC_LAYOUT_IMG_DIR ??
        path.join(WORKSPACE_ROOT, "catalog", "layout_examples"),
      preloadGolden: true,
    });
  }

  public nextId(prefix: string): string {
    return `${prefix}_${this.seq++}`;
  }

  public async ensureEnvInfo(context?: McpToolContext): Promise<ClientEnvironmentInfo> {
    if (context?.envInfo) {
      this.envInfo = enrichEnvCatalogStats(context.envInfo);
      return this.envInfo;
    }
    if (!this.envInfo) {
      this.envInfo = enrichEnvCatalogStats(
        await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
      );
    }
    return this.envInfo;
  }

  public async refreshEnvInfo(context?: McpToolContext): Promise<ClientEnvironmentInfo> {
    if (context?.envInfo) {
      this.envInfo = enrichEnvCatalogStats(context.envInfo);
      return this.envInfo;
    }
    this.envInfo = enrichEnvCatalogStats(
      await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
    );
    return this.envInfo;
  }

  public getCatalogSqlitePath(envInfo?: ClientEnvironmentInfo | null): string {
    const indexDir =
      envInfo?.paths.indexDir ??
      this.envInfo?.paths.indexDir ??
      path.join(WORKSPACE_ROOT, "catalog");
    return path.join(indexDir, "api_catalog.sqlite");
  }

  public createProjectAndDocument(options: {
    kind: "project" | "schematic_sheet" | "pcb";
    name: string;
    saveDir?: string;
    parentProjectUuid?: string;
  }): { projectUuid: string; documentHandle: string; path: string; doc: WorkspaceDocument } {
    const seqNum = this.seq++;
    let project: ProjectRecord | undefined = options.parentProjectUuid
      ? this.projects.get(options.parentProjectUuid)
      : undefined;

    if (!project && options.kind !== "project") {
      // Reuse active document's project if parentProjectUuid omitted
      const active = this.activeDocumentHandle
        ? this.documents.get(this.activeDocumentHandle)
        : undefined;
      if (active) {
        project = this.projects.get(active.projectUuid);
      }
    }

    if (!project) {
      const projectUuid = makeUuid("proj", seqNum);
      const baseDir =
        options.saveDir ??
        this.envInfo?.paths.tempDir ??
        path.join(WORKSPACE_ROOT, ".tmp");
      const projPath = path.join(baseDir, `${options.name}.epro`);
      project = {
        projectUuid,
        name: options.name,
        path: projPath,
        documentHandles: [],
      };
      this.projects.set(projectUuid, project);
    }

    const docType: TargetDocType = options.kind === "pcb" ? "PCB" : "SCH";
    const docUuid = makeUuid(docType.toLowerCase(), seqNum);
    const handle = `${options.name}`;
    const finalHandle = this.documents.has(handle)
      ? `${options.name}_${seqNum}`
      : handle;

    // Deactivate previously active documents
    for (const d of this.documents.values()) {
      d.isActive = false;
    }

    const doc: WorkspaceDocument = {
      handle: finalHandle,
      uuid: docUuid,
      title: options.name,
      type: docType,
      projectUuid: project.projectUuid,
      path: project.path,
      isActive: true,
      isDirty: false,
      readOnly: false,
      selection: [],
      lastClickPointMm: null,
      activeInteractiveTool: null,
      txHistory: [],
      activeCheckpoints: new Map(),
      ...(docType === "SCH"
        ? { sch: createDefaultSchData(options.name) }
        : { pcb: createDefaultPcbData() }),
    };

    this.documents.set(finalHandle, doc);
    project.documentHandles.push(finalHandle);
    this.activeDocumentHandle = finalHandle;

    return {
      projectUuid: project.projectUuid,
      documentHandle: finalHandle,
      path: doc.path,
      doc,
    };
  }

  public resolveDocument(identifier?: string | null): WorkspaceDocument | undefined {
    if (!identifier) {
      return this.activeDocumentHandle
        ? this.documents.get(this.activeDocumentHandle)
        : undefined;
    }
    const direct = this.documents.get(identifier);
    if (direct) return direct;
    const lower = identifier.trim().toLowerCase();
    for (const doc of this.documents.values()) {
      if (
        doc.uuid.toLowerCase() === lower ||
        doc.title.toLowerCase() === lower ||
        doc.handle.toLowerCase() === lower
      ) {
        return doc;
      }
    }
    return undefined;
  }

  public listDocumentSummaries(projectUuid?: string | null): {
    projects: Array<{ projectUuid: string; name: string; path: string }>;
    documents: DocumentSummary[];
  } {
    const projs = Array.from(this.projects.values())
      .filter((p) => !projectUuid || p.projectUuid === projectUuid)
      .map((p) => ({ projectUuid: p.projectUuid, name: p.name, path: p.path }));

    const docs = Array.from(this.documents.values())
      .filter((d) => !projectUuid || d.projectUuid === projectUuid)
      .map((d) => ({
        handle: d.handle,
        uuid: d.uuid,
        title: d.title,
        type: d.type,
        projectUuid: d.projectUuid,
        isActive: d.isActive,
        isDirty: d.isDirty,
        readOnly: d.readOnly,
        selectionCount: d.selection.length,
        activeInteractiveTool: d.activeInteractiveTool,
      }));

    return { projects: projs, documents: docs };
  }

  public activateDocument(identifier: string): WorkspaceDocument {
    const doc = this.resolveDocument(identifier);
    if (!doc) {
      throw new Error(`ERR_DOCUMENT_NOT_FOUND: Document '${identifier}' does not exist in workspace.`);
    }
    for (const d of this.documents.values()) {
      d.isActive = d.handle === doc.handle;
    }
    this.activeDocumentHandle = doc.handle;
    return doc;
  }

  public beginLocalTx(doc: WorkspaceDocument, label: string): string {
    const ckptId = this.nextId("ckpt");
    const snapObj = {
      sch: doc.sch,
      pcb: doc.pcb,
      isDirty: doc.isDirty,
    };
    doc.activeCheckpoints.set(ckptId, {
      label,
      snapshotJson: JSON.stringify(snapObj),
    });
    doc.txHistory.push({
      id: ckptId,
      label,
      timestamp: new Date().toISOString(),
      status: "active",
    });
    return ckptId;
  }

  public commitLocalTx(doc: WorkspaceDocument, checkpointId?: string): string {
    const id = checkpointId ?? Array.from(doc.activeCheckpoints.keys()).pop() ?? this.nextId("ckpt");
    doc.activeCheckpoints.delete(id);
    const entry = doc.txHistory.find((t) => t.id === id);
    if (entry) entry.status = "committed";
    else {
      doc.txHistory.push({
        id,
        label: "Commit",
        timestamp: new Date().toISOString(),
        status: "committed",
      });
    }
    return id;
  }

  public rollbackLocalTx(doc: WorkspaceDocument, checkpointId?: string): string {
    const id = checkpointId ?? Array.from(doc.activeCheckpoints.keys()).pop();
    if (!id) {
      throw new Error(`ERR_TX_CHECKPOINT_NOT_FOUND: No active transaction checkpoint on '${doc.handle}'.`);
    }
    const cp = doc.activeCheckpoints.get(id);
    if (!cp) {
      throw new Error(`ERR_TX_CHECKPOINT_NOT_FOUND: Checkpoint '${id}' not found.`);
    }
    const parsed = JSON.parse(cp.snapshotJson) as {
      sch?: SchematicDocData;
      pcb?: PcbDocData;
      isDirty: boolean;
    };
    doc.sch = parsed.sch;
    doc.pcb = parsed.pcb;
    doc.isDirty = parsed.isDirty;
    doc.activeCheckpoints.delete(id);
    const entry = doc.txHistory.find((t) => t.id === id);
    if (entry) entry.status = "rolled_back";
    return id;
  }

  public getCesmResolver(): (lcscId: string) => CesmModel | undefined {
    return (lcscId: string) =>
      this.cesmBinder.getBoundCesm(lcscId) ?? this.cesmBinder.lookupCachedCesm(lcscId);
  }
}

const stateMap = new WeakMap<object, McpWorkspaceState>();
let globalDefaultState: McpWorkspaceState | null = null;

export function getWorkspaceState(context?: McpToolContext): McpWorkspaceState {
  if (context?.sessionManager) {
    let existing = stateMap.get(context.sessionManager as unknown as object);
    if (!existing) {
      existing = new McpWorkspaceState();
      stateMap.set(context.sessionManager as unknown as object, existing);
    }
    return existing;
  }
  if (!globalDefaultState) {
    globalDefaultState = new McpWorkspaceState();
  }
  return globalDefaultState;
}

export function resetWorkspaceState(
  context?: McpToolContext,
  options?: { cesmSqlitePath?: string; layoutImageDir?: string }
): void {
  if (context?.sessionManager) {
    const s = stateMap.get(context.sessionManager as unknown as object);
    s?.cesmBinder.close();
    stateMap.delete(context.sessionManager as unknown as object);
    if (options) {
      stateMap.set(context.sessionManager as unknown as object, new McpWorkspaceState(options));
    }
  }
  globalDefaultState?.cesmBinder.close();
  globalDefaultState = options ? new McpWorkspaceState(options) : null;
}

// ============================================================================
// Netlist Compilation & PCB Snapshot Builders (Authoritative Only)
// ============================================================================

export function compileSchematicNetlist(doc: WorkspaceDocument): CompiledNetlist {
  if (!doc.sch) {
    throw new Error(`Document '${doc.handle}' is not a schematic document.`);
  }
  const components = doc.sch.components;
  const netEndpoints = new Map<string, CompiledNet["endpoints"]>();
  const netSheets = new Map<string, Set<string>>();
  const unconnectedPins: CompiledNetlist["unconnectedPins"] = [];

  for (const comp of components) {
    const sheet = comp.sheetId ?? "Sheet1";
    for (const pin of comp.pins) {
      if (pin.isConnected && pin.net) {
        const arr = netEndpoints.get(pin.net) ?? [];
        arr.push({
          designator: comp.designator,
          pinNumber: pin.pinNumber,
          pinName: pin.pinName,
          elecType: pin.elecType,
        });
        netEndpoints.set(pin.net, arr);

        const sSet = netSheets.get(pin.net) ?? new Set<string>();
        sSet.add(sheet);
        netSheets.set(pin.net, sSet);
      } else {
        unconnectedPins.push({
          designator: comp.designator,
          pinNumber: pin.pinNumber,
          pinName: pin.pinName,
          reason: doc.sch.noConnectPins.includes(`${comp.designator}.${pin.pinNumber}`)
            ? "Marked NoConnect"
            : "Unconnected",
        });
      }
    }
  }

  const nets: CompiledNet[] = Array.from(netEndpoints.entries()).map(
    ([netName, endpoints]) => {
      const upper = netName.toUpperCase();
      const isPowerOrGround =
        /^(?:GND|AGND|PGND|DGND|SGND|VSS|VSSA|VCC|VDD|VDDA|VBUS|VIN|VOUT|3V3|5V|12V|24V)/i.test(
          upper
        ) || upper.includes("GND");
      return {
        netName,
        endpoints,
        fanout: endpoints.length,
        isPowerOrGround,
        sheetNames: Array.from(netSheets.get(netName) ?? []),
      };
    }
  );

  return {
    netlistSource: "eda.sch_Netlist",
    projectUuid: doc.projectUuid,
    documentUuid: doc.uuid,
    documentName: doc.title,
    compiledAt: new Date().toISOString(),
    componentCount: components.length,
    netCount: nets.length,
    components: structuredClone(components),
    nets,
    unconnectedPins,
    groupBoxes: structuredClone(doc.sch.groupBoxes),
  };
}

function resolvePadPourStyle(
  padPourStyles: PadPourStyleAssignment[],
  designator: string,
  padNumber: string,
  pkg: string
): "THERMAL_RELIEF" | "DIRECT_CONNECT" {
  const matched = padPourStyles.find(
    (s) => s.designator === designator && s.padNumber === padNumber
  );
  if (matched) {
    return matched.connectStyle === "direct" ? "DIRECT_CONNECT" : "THERMAL_RELIEF";
  }
  const upperPkg = pkg.toUpperCase();
  if (upperPkg.includes("0603") || upperPkg.includes("0402") || upperPkg.includes("0201")) {
    return "THERMAL_RELIEF";
  }
  return "THERMAL_RELIEF";
}

function classifySensorType(
  mpn: string | null | undefined,
  category?: CesmModel["category"]
): PcbComponentGeom["sensorType"] {
  const up = (mpn ?? "").toUpperCase();
  if (/SHT3|SHT4|AHT20|HDC10|SI7021/.test(up)) return "TEMP_HUMIDITY";
  if (/MPU|ICM|BMI|BMP|BME|LPS|LIS|SPH|INMP/.test(up)) return "MEMS";
  if (/REF30|ADR45|LM4040|MAX6126/.test(up)) return "VREF";
  if (category === "ADC_DAC_VREF" && /REF/.test(up)) return "VREF";
  return undefined;
}

export function buildPcbGeometrySnapshot(
  doc: WorkspaceDocument,
  state: McpWorkspaceState,
  options?: {
    checkScope?: "full_board" | "selection_neighborhood";
    useProjectDesignRulesFirst?: boolean;
    fabCapability?: "jlc_standard_multi" | "jlc_2layer_basic";
    selectedDesignators?: string[];
  }
): PcbBoardGeometrySnapshot {
  if (!doc.pcb) {
    throw new Error(`Document '${doc.handle}' is not a PCB document.`);
  }
  const pcb = doc.pcb;
  const netlist = pcb.syncedNetlist;
  const compByDes = new Map<string, CompiledComponent>();
  for (const c of netlist?.components ?? []) {
    compByDes.set(c.designator, c);
  }
  const cesmResolver = state.getCesmResolver();
  const sourceSch = pcb.sourceSchDocument
    ? state.resolveDocument(pcb.sourceSchDocument)
    : undefined;
  const handoff = sourceSch?.sch?.lastElintReport?.constraintHandoffPackage;

  const components: PcbComponentGeom[] = pcb.placements.map((pl) => {
    const schComp = compByDes.get(pl.designator);
    const cesm = schComp?.lcscId ? cesmResolver(schComp.lcscId) : undefined;
    const [rw, rh] = getRotatedDims(pl.bboxMm, pl.rotationDeg);
    const layer = pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer";
    const mpn = schComp?.mpn ?? cesm?.mpn ?? pl.role;
    const pkg = schComp?.footprint ?? pl.footprint;

    const pads: PcbPadGeom[] = pl.pads.map((pad) => {
      const schPin = schComp?.pins.find((p) => p.pinNumber === pad.padNumber);
      const pinName = schPin?.pinName ?? pad.padNumber;
      const isEpad =
        pad.padNumber.toUpperCase() === "EP" ||
        pinName.toUpperCase().includes("EPAD");
      return {
        primitiveId: `pad_${pl.designator}_${pad.padNumber}`,
        designator: pl.designator,
        padNumber: pad.padNumber,
        pinName,
        elecType: schPin?.elecType,
        net: pad.net,
        layer,
        centerMm: pad.xMm !== undefined ? [pad.xMm, pad.yMm] : [pl.xMm, pl.yMm],
        sizeMm: pad.sizeMm,
        copperConnection: resolvePadPourStyle(pcb.padPourStyles, pl.designator, pad.padNumber, pkg),
        isEpad,
        isGrounded: pad.net ? /^(?:GND|AGND|PGND|DGND|VSS)/i.test(pad.net) : false,
      };
    });

    const isPassiveOrDiode =
      cesm?.category === "RES_CHIP" ||
      cesm?.category === "RES_SHUNT" ||
      cesm?.category === "CAP_MLCC" ||
      cesm?.category === "CAP_AL_ELEC" ||
      cesm?.category === "TVS_ESD_MOV" ||
      cesm?.category === "DIODE_SCHOTTKY";
    const isEdgeConn =
      !isPassiveOrDiode &&
      (cesm?.category === "CONN_USB_TYPEC" ||
        cesm?.category === "CONN_GENERIC" ||
        /^(?:J|CN|CON|P)\d|^J_|RJ45/i.test(pl.designator));

    const thermalPowerW =
      typeof schComp?.extraProps?.thermalPowerW === "number"
        ? schComp.extraProps.thermalPowerW
        : undefined;

    return {
      primitiveId: schComp?.primitiveId ?? `pcb_${pl.designator}`,
      designator: pl.designator,
      lcscId: schComp?.lcscId,
      mpn,
      value: schComp?.value,
      package: pkg,
      category: cesm?.category,
      layer,
      centerMm: [pl.xMm, pl.yMm],
      rotationDeg: pl.rotationDeg,
      bboxMm: [pl.xMm - rw / 2, pl.yMm - rh / 2, pl.xMm + rw / 2, pl.yMm + rh / 2],
      heightMm: typeof schComp?.extraProps?.heightMm === "number" ? schComp.extraProps.heightMm : 1.6,
      pads,
      ...(isEdgeConn ? { frontClearanceMm: 3.5 } : {}),
      ...(cesm?.polarity_spec?.is_polarized
        ? {
            expectedPolarityAngleDeg: pl.rotationDeg,
            polarityAngleDeg: pl.rotationDeg,
          }
        : {}),
      originAnchorType: "CENTER",
      sensorType: classifySensorType(mpn, cesm?.category),
      ...(thermalPowerW !== undefined ? { thermalPowerW } : {}),
      extraProps: schComp?.extraProps,
    };
  });

  const tracks: PcbTrackGeom[] = [];
  const pushPolyline = (
    idPrefix: string,
    net: string,
    layer: string,
    widthMm: number,
    pts: Array<[number, number]>,
    isLocked: boolean
  ) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-5) continue;
      tracks.push({
        primitiveId: `${idPrefix}_seg${i}`,
        net,
        layer,
        startMm: a,
        endMm: b,
        widthMm,
        isLocked,
      });
    }
  };

  for (const lt of pcb.lockedTracks) {
    pushPolyline(lt.id, lt.net, lt.layer, lt.widthMm, lt.pointsMm, true);
  }
  for (const rt of pcb.tracks) {
    pushPolyline(rt.id, rt.net, rt.layer, rt.widthMm, rt.pointsMm, Boolean(rt.locked));
  }

  const vias: PcbViaGeom[] = [
    ...pcb.lockedVias.map((v): PcbViaGeom => {
      let purpose: PcbViaGeom["purpose"] = "SIGNAL";
      if (v.viaRole === "EPAD_THERMAL_GND") purpose = "THERMAL_EPAD";
      else if (v.viaRole === "GND_RETURN_CLUSTER" || v.viaRole === "GUARD_RING_STITCH")
        purpose = "GND_STITCH";
      else if (v.viaRole === "POWER_TRUNK_PARALLEL" || v.viaRole === "POWER_FEED_VIA")
        purpose = "POWER_TRANSITION";
      return {
        primitiveId: v.id,
        net: v.net,
        centerMm: [v.xMm, v.yMm],
        drillMm: v.drillMm,
        outerDiaMm: v.outerDiaMm,
        startLayer: v.startLayer,
        endLayer: v.endLayer,
        purpose,
      };
    }),
    ...pcb.vias.map((v): PcbViaGeom => ({
      primitiveId: v.id,
      net: v.net,
      centerMm: [v.xMm, v.yMm],
      drillMm: v.drillMm,
      outerDiaMm: v.outerDiaMm,
      startLayer: v.startLayer,
      endLayer: v.endLayer,
      purpose: /^(?:GND|AGND|PGND|DGND|VSS)/i.test(v.net)
        ? "GND_STITCH"
        : "SIGNAL",
    })),
  ];

  const pours: PcbPourGeom[] = [];
  for (const cz of pcb.lockedCopperZones) {
    pours.push({
      primitiveId: cz.id,
      net: cz.net,
      layer: cz.layer,
      polygon2D: cz.polygonMm,
      areaMm2: cz.areaMm2,
      isSolid: true,
    });
  }
  for (const bp of pcb.pours) {
    bp.polygonsMm.forEach((poly, idx) => {
      const holes2D = bp.polygonHolesMm?.[idx] ?? bp.holesMm;
      pours.push({
        primitiveId: `${bp.id}_p${idx}`,
        net: bp.net,
        layer: bp.layer,
        polygon2D: poly,
        ...(holes2D && holes2D.length > 0 ? { holes2D } : {}),
        isSolid: true,
      });
    });
  }

  return {
    pcbDocument: doc.handle,
    boardOutline: {
      widthMm: pcb.boardOutline.widthMm,
      heightMm: pcb.boardOutline.heightMm,
      layerCount: pcb.boardOutline.layerCount,
      copperWeightOuterOz: pcb.boardOutline.copperWeightOuterOz,
      stackup: pcb.boardOutline.stackup,
      polygonMm: pcb.boardOutline.polygonMm,
      vCutLines: pcb.boardOutline.vCutLines,
      mouseBites: pcb.boardOutline.mouseBites,
      isolationSlots: pcb.boardOutline.isolationSlots,
    },
    projectDesignRules: pcb.projectDesignRules,
    components,
    tracks,
    vias,
    pours,
    keepoutZones: pcb.keepoutZones25D,
    mountingHoles: pcb.boardOutline.mountingHoles,
    testPoints: pcb.testPoints,
    nativeDrcResult: pcb.nativeDrcResult,
    netlist,
    clusters: pcb.clusterResult?.output,
    constraintHandoff: handoff,
    cesmResolver,
    options: {
      checkScope: options?.checkScope ?? "full_board",
      selectedDesignators: options?.selectedDesignators,
      useProjectDesignRulesFirst: options?.useProjectDesignRulesFirst ?? true,
      fabCapability: options?.fabCapability ?? "jlc_standard_multi",
    },
  };
}

// ============================================================================
// Headless 2D Board Canvas PNG Renderer (for jlc_view_capture offline/test)
// ============================================================================

function drawPixel(
  png: PNG,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= png.width || iy >= png.height) return;
  const idx = (png.width * iy + ix) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function fillRectPx(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: [number, number, number, number]
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(png.width, Math.ceil(x + w));
  const y1 = Math.min(png.height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      drawPixel(png, px, py, rgba[0], rgba[1], rgba[2], rgba[3]);
    }
  }
}

function drawLinePx(
  png: PNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  rgba: [number, number, number, number]
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  const rad = Math.max(1, Math.round(thickness / 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    fillRectPx(png, cx - rad, cy - rad, rad * 2, rad * 2, rgba);
  }
}

function drawCirclePx(
  png: PNG,
  cx: number,
  cy: number,
  radius: number,
  rgba: [number, number, number, number],
  filled = true
): void {
  const rInt = Math.max(1, Math.ceil(radius));
  for (let dy = -rInt; dy <= rInt; dy++) {
    for (let dx = -rInt; dx <= rInt; dx++) {
      const d = Math.hypot(dx, dy);
      if (filled ? d <= radius : Math.abs(d - radius) <= 1.2) {
        drawPixel(png, cx + dx, cy + dy, rgba[0], rgba[1], rgba[2], rgba[3]);
      }
    }
  }
}

export function renderWorkspaceDocumentPng(
  doc: WorkspaceDocument,
  options: {
    width: number;
    height: number;
    regionMm?: [number, number, number, number] | null;
    overlayGridMm?: number | null;
    visibleLayers?: string[] | null;
    highlightPointsMm?: Array<{ posMm: [number, number]; label?: string }>;
  }
): {
  pngBuffer: Buffer;
  capturedBboxMm: [number, number, number, number];
  pixelPerMm: number;
} {
  const width = Math.max(320, Math.min(2400, options.width));
  const height = Math.max(240, Math.min(1800, options.height));
  const png = new PNG({ width, height, fill: true });

  // Deep EDA canvas background (#121820)
  fillRectPx(png, 0, 0, width, height, [18, 24, 32, 255]);

  let bbox: [number, number, number, number] = [0, 0, 100, 80];
  if (options.regionMm) {
    bbox = options.regionMm;
  } else if (doc.pcb) {
    bbox = [-4, -4, doc.pcb.boardOutline.widthMm + 4, doc.pcb.boardOutline.heightMm + 4];
  } else if (doc.sch && doc.sch.components.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of doc.sch.components) {
      const [x, y] = c.posMm ?? [0, 0];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    bbox = [minX - 15, minY - 15, maxX + 15, maxY + 15];
  }

  const spanX = Math.max(1, bbox[2] - bbox[0]);
  const spanY = Math.max(1, bbox[3] - bbox[1]);
  const pixelPerMm = Math.min(width / spanX, height / spanY);
  const offsetX = (width - spanX * pixelPerMm) / 2;
  const offsetY = (height - spanY * pixelPerMm) / 2;

  const toPx = (xMm: number, yMm: number): [number, number] => [
    offsetX + (xMm - bbox[0]) * pixelPerMm,
    offsetY + (bbox[3] - yMm) * pixelPerMm,
  ];

  // Draw metric grid
  if (options.overlayGridMm && options.overlayGridMm > 0) {
    let step = options.overlayGridMm;
    while (spanX / step > 40 || spanY / step > 40) step *= 2;
    for (let x = Math.ceil(bbox[0] / step) * step; x <= bbox[2]; x += step) {
      const [px] = toPx(x, bbox[1]);
      drawLinePx(png, px, 0, px, height, 1, [34, 48, 64, 255]);
    }
    for (let y = Math.ceil(bbox[1] / step) * step; y <= bbox[3]; y += step) {
      const [, py] = toPx(bbox[0], y);
      drawLinePx(png, 0, py, width, py, 1, [34, 48, 64, 255]);
    }
  }

  if (doc.pcb) {
    const pcb = doc.pcb;
    const layerFilter = options.visibleLayers?.length
      ? new Set(options.visibleLayers.map((l) => l.toLowerCase()))
      : null;
    const layerShown = (layer: string) =>
      !layerFilter || layerFilter.has(layer.toLowerCase());

    // Board substrate dark green
    const [bx0, by0] = toPx(0, pcb.boardOutline.heightMm);
    const [bx1, by1] = toPx(pcb.boardOutline.widthMm, 0);
    fillRectPx(png, bx0, by0, bx1 - bx0, by1 - by0, [16, 46, 32, 255]);

    // Pours & copper zones
    for (const cz of pcb.lockedCopperZones) {
      if (!layerShown(cz.layer)) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of cz.polygonMm) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const [p0x, p0y] = toPx(minX, maxY);
      const [p1x, p1y] = toPx(maxX, minY);
      fillRectPx(png, p0x, p0y, Math.max(2, p1x - p0x), Math.max(2, p1y - p0y), [158, 52, 42, 255]);
    }

    // Tracks
    const drawTracks = (tracks: Array<{ layer: string; widthMm: number; pointsMm: Array<[number, number]> }>, color: [number, number, number, number]) => {
      for (const tr of tracks) {
        if (!layerShown(tr.layer)) continue;
        const pxW = Math.max(2, tr.widthMm * pixelPerMm);
        for (let i = 0; i < tr.pointsMm.length - 1; i++) {
          const [x0, y0] = toPx(tr.pointsMm[i][0], tr.pointsMm[i][1]);
          const [x1, y1] = toPx(tr.pointsMm[i + 1][0], tr.pointsMm[i + 1][1]);
          drawLinePx(png, x0, y0, x1, y1, pxW, color);
        }
      }
    };
    drawTracks(pcb.tracks, [215, 75, 65, 255]);
    drawTracks(pcb.lockedTracks, [240, 120, 60, 255]);

    // Components & pads
    for (const pl of pcb.placements) {
      const layer = pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer";
      if (!layerShown(layer)) continue;
      const [rw, rh] = getRotatedDims(pl.bboxMm, pl.rotationDeg);
      const [x0, y0] = toPx(pl.xMm - rw / 2, pl.yMm + rh / 2);
      const [x1, y1] = toPx(pl.xMm + rw / 2, pl.yMm - rh / 2);
      fillRectPx(png, x0, y0, Math.max(3, x1 - x0), Math.max(3, y1 - y0), [48, 56, 68, 255]);
      // Silkscreen border
      drawLinePx(png, x0, y0, x1, y0, 1, [235, 235, 235, 255]);
      drawLinePx(png, x1, y0, x1, y1, 1, [235, 235, 235, 255]);
      drawLinePx(png, x1, y1, x0, y1, 1, [235, 235, 235, 255]);
      drawLinePx(png, x0, y1, x0, y0, 1, [235, 235, 235, 255]);

      for (const pad of pl.pads) {
        const [px0, py0] = toPx(pad.xMm - pad.sizeMm[0] / 2, pad.yMm + pad.sizeMm[1] / 2);
        const [px1, py1] = toPx(pad.xMm + pad.sizeMm[0] / 2, pad.yMm - pad.sizeMm[1] / 2);
        fillRectPx(png, px0, py0, Math.max(2, px1 - px0), Math.max(2, py1 - py0), [230, 190, 95, 255]);
      }
    }

    // Vias
    for (const v of [...pcb.lockedVias, ...pcb.vias]) {
      const [vx, vy] = toPx(v.xMm, v.yMm);
      drawCirclePx(png, vx, vy, Math.max(2, (v.outerDiaMm / 2) * pixelPerMm), [220, 185, 90, 255], true);
      drawCirclePx(png, vx, vy, Math.max(1, (v.drillMm / 2) * pixelPerMm), [18, 24, 32, 255], true);
    }

    // Board outline border
    drawLinePx(png, bx0, by0, bx1, by0, 2, [250, 204, 21, 255]);
    drawLinePx(png, bx1, by0, bx1, by1, 2, [250, 204, 21, 255]);
    drawLinePx(png, bx1, by1, bx0, by1, 2, [250, 204, 21, 255]);
    drawLinePx(png, bx0, by1, bx0, by0, 2, [250, 204, 21, 255]);
  } else if (doc.sch) {
    for (const w of doc.sch.wires) {
      const [x0, y0] = toPx(w.startMm[0], w.startMm[1]);
      const [x1, y1] = toPx(w.endMm[0], w.endMm[1]);
      drawLinePx(png, x0, y0, x1, y1, 2, [74, 222, 128, 255]);
    }
    for (const c of doc.sch.components) {
      const [cx, cy] = c.posMm ?? [0, 0];
      const [x0, y0] = toPx(cx - 2.5, cy + 2.5);
      const [x1, y1] = toPx(cx + 2.5, cy - 2.5);
      fillRectPx(png, x0, y0, Math.max(6, x1 - x0), Math.max(6, y1 - y0), [59, 130, 246, 255]);
    }
  }

  // Highlight points
  for (const hp of options.highlightPointsMm ?? []) {
    const [hx, hy] = toPx(hp.posMm[0], hp.posMm[1]);
    drawCirclePx(png, hx, hy, 12, [239, 68, 68, 255], false);
  }

  return {
    pngBuffer: PNG.sync.write(png),
    capturedBboxMm: bbox,
    pixelPerMm: Number(pixelPerMm.toFixed(3)),
  };
}

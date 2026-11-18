import type {
  ReaParameterSpec,
  ReaPhysicalDimension,
  ReaUnitContract,
  UnitMode,
} from "../types/index.js";

export const MM_PER_MIL = 0.0254;
export const MIL_PER_MM = 1 / MM_PER_MIL; // 39.37007874015748
export const MM_PER_SCH_10MIL = 0.254;
export const SCH_10MIL_PER_MM = 1 / MM_PER_SCH_10MIL; // 3.937007874015748
export const MM_PER_INCH = 25.4;
export const INCH_PER_MM = 1 / MM_PER_INCH;
export const DEG_PER_RAD = 180 / Math.PI;
export const RAD_PER_DEG = Math.PI / 180;

export type LengthUnit = "none" | "mm" | "mil" | "10mil" | "inch";
export type AngleUnit = "none" | "deg" | "rad";

export interface EnumToken {
  $enum: string;
}

export interface RefToken {
  $ref: string;
}

export interface TokenResolverOptions {
  resolveEnum?: (enumPath: string) => unknown;
  resolveRef?: (handle: string) => unknown;
  unresolvedEnumMode?: "marker" | "error" | "keep";
  unresolvedRefMode?: "error" | "keep";
}

export interface UnitConversionOptions {
  unitMode?: UnitMode;
  contract?: Partial<ReaUnitContract>;
  parameterSpecs?: ReaParameterSpec[];
  dimensionOverrides?: Record<string, ReaPhysicalDimension | "none">;
  /** Fallback native length unit when contract.nativeLengthUnit is omitted */
  defaultNativeLengthUnit?: LengthUnit;
  /** Fallback native angle unit when contract.nativeAngleUnit is omitted */
  defaultNativeAngleUnit?: AngleUnit;
}

/**
 * Built-in static dictionary for common JLCEDA Pro L1 public enums
 * (exact values aligned with `@jlceda/pro-api-types`).
 */
export const BUILTIN_JLC_ENUMS: Record<string, Record<string, string | number>> = {
  ESYS_Unit: {
    MILLIMETER: "mm",
    CENTIMETER: "cm",
    DECIMETER: "dm",
    METER: "m",
    INCH: "inch",
    IN: "in",
    MIL: "mil",
  },
  EPCB_LayerId: {
    TOP: 1,
    BOTTOM: 2,
    TOP_SILKSCREEN: 3,
    BOTTOM_SILKSCREEN: 4,
    TOP_SOLDER_MASK: 5,
    BOTTOM_SOLDER_MASK: 6,
    TOP_PASTE_MASK: 7,
    BOTTOM_PASTE_MASK: 8,
    TOP_ASSEMBLY: 9,
    BOTTOM_ASSEMBLY: 10,
    BOARD_OUTLINE: 11,
    MULTI: 12,
    DOCUMENT: 13,
    MECHANICAL: 14,
    INNER_1: 15,
    INNER_2: 16,
    INNER_3: 17,
    INNER_4: 18,
    HOLE: 47,
    RATLINE: 57,
    TOP_STIFFENER: 58,
    BOTTOM_STIFFENER: 59,
  },
  EPCB_PrimitiveType: {
    ARC: "Arc",
    COMPONENT: "Component",
    PAD: "Pad",
    COMPONENT_PAD: "ComponentPad",
    POLYLINE: "Polyline",
    POUR: "Pour",
    FILL: "Fill",
    REGION: "Region",
    LINE: "Line",
    VIA: "Via",
    DIMENSION: "Dimension",
    IMAGE: "Image",
    OBJECT: "Object",
    POURED: "Poured",
    STRING: "String",
    ATTRIBUTE: "Attribute",
  },
  EPCB_AutoRoutingCornerStyle: {
    DEGREE_45: 0,
    DEGREE_90: 1,
  },
  EPCB_AutoRoutingExistingPrimitiveMode: {
    KEEP: "keep",
    REMOVE: "remove",
  },
  EPCB_AutoRoutingOptimization: {
    COMPLETION: 1,
    FASTER: 0,
  },
  EPCB_LayerStatus: {
    NOT_USED: 0,
    SHOW: 1,
    HIDDEN: 2,
  },
  EDMT_EditorDocumentType: {
    SCHEMATIC_PAGE: 1,
    PCB: 2,
    SYMBOL: 3,
    FOOTPRINT: 4,
    PANEL: 5,
  },
  ESCH_PrimitiveLineType: {
    SOLID: 0,
    DASHED: 1,
    DOTTED: 2,
  },
};

const DEFAULT_LENGTH_FIELD_NAMES = new Set<string>([
  "x",
  "y",
  "z",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "left",
  "right",
  "top",
  "bottom",
  "width",
  "height",
  "length",
  "size",
  "sizex",
  "sizey",
  "radius",
  "r",
  "diameter",
  "outerdiameter",
  "innerdiameter",
  "drill",
  "drilldiameter",
  "holediameter",
  "holewidth",
  "holeheight",
  "linewidth",
  "trackwidth",
  "tracewidth",
  "strokeWidth".toLowerCase(),
  "clearance",
  "gap",
  "pitch",
  "margin",
  "offsetx",
  "offsety",
  "startx",
  "starty",
  "endx",
  "endy",
  "centerx",
  "centery",
  "minx",
  "miny",
  "maxx",
  "maxy",
  "dx",
  "dy",
  "padwidth",
  "padheight",
  "outlinewidth",
  "expansion",
  "soldermaskexpansion",
  "pastemaskexpansion",
  "minwidth",
  "maxwidth",
  "preferredwidth",
  "viadrill",
  "viadiameter",
  "gridsize",
]);

const DEFAULT_LENGTH_ARRAY_FIELD_NAMES = new Set<string>([
  "points",
  "polygon",
  "coords",
  "bbox",
  "bounds",
  "center",
  "pos",
  "position",
  "relpos",
  "vertices",
  "line",
  "path",
]);

const DEFAULT_ANGLE_FIELD_NAMES = new Set<string>([
  "angle",
  "rotation",
  "rot",
  "startangle",
  "endangle",
  "sweepangle",
]);

const SKIP_UNIT_CONVERSION_SUFFIXES = [
  "mm",
  "mil",
  "deg",
  "rad",
  "id",
  "uuid",
  "count",
  "index",
  "order",
  "port",
  "pid",
  "code",
  "version",
  "percent",
  "ratio",
  "scale",
];

/**
 * Lossless IEEE-754 double-precision conversion: mm -> mil.
 */
export function mmToMil(mm: number): number {
  return mm * MIL_PER_MM;
}

/**
 * Lossless IEEE-754 double-precision conversion: mil -> mm.
 */
export function milToMm(mil: number): number {
  return mil * MM_PER_MIL;
}

/**
 * Lossless conversion: mm -> schematic native `10mil` (`0.01inch` = `0.254mm`).
 */
export function mmToSch10Mil(mm: number): number {
  return mm * SCH_10MIL_PER_MM;
}

/**
 * Lossless conversion: schematic native `10mil` -> mm.
 */
export function sch10MilToMm(sch10Mil: number): number {
  return sch10Mil * MM_PER_SCH_10MIL;
}

/**
 * Lossless conversion: degrees -> radians.
 */
export function degToRad(deg: number): number {
  return deg * RAD_PER_DEG;
}

/**
 * Lossless conversion: radians -> degrees.
 */
export function radToDeg(rad: number): number {
  return rad * DEG_PER_RAD;
}

export function convertLength(
  value: number,
  fromUnit: LengthUnit,
  toUnit: LengthUnit
): number {
  if (!Number.isFinite(value) || fromUnit === toUnit || fromUnit === "none" || toUnit === "none") {
    return value;
  }
  let mm: number;
  switch (fromUnit) {
    case "mm":
      mm = value;
      break;
    case "mil":
      mm = milToMm(value);
      break;
    case "10mil":
      mm = sch10MilToMm(value);
      break;
    case "inch":
      mm = value * MM_PER_INCH;
      break;
  }
  switch (toUnit) {
    case "mm":
      return mm;
    case "mil":
      return mmToMil(mm);
    case "10mil":
      return mmToSch10Mil(mm);
    case "inch":
      return mm * INCH_PER_MM;
  }
}

export function convertAngle(
  value: number,
  fromUnit: AngleUnit,
  toUnit: AngleUnit
): number {
  if (!Number.isFinite(value) || fromUnit === toUnit || fromUnit === "none" || toUnit === "none") {
    return value;
  }
  if (fromUnit === "deg" && toUnit === "rad") {
    return degToRad(value);
  }
  if (fromUnit === "rad" && toUnit === "deg") {
    return radToDeg(value);
  }
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isEnumToken(value: unknown): value is EnumToken {
  return (
    isPlainObject(value) &&
    typeof value.$enum === "string" &&
    Object.keys(value).length === 1
  );
}

export function isRefToken(value: unknown): value is RefToken {
  return (
    isPlainObject(value) &&
    typeof value.$ref === "string" &&
    Object.keys(value).length === 1
  );
}

/**
 * Lookup a dotted enum expression such as `EPCB_LayerId.TOP` or `eda.EPCB_LayerId.TOP`
 * in the built-in L1 enum registry.
 */
export function lookupBuiltinEnum(enumPath: string): string | number | undefined {
  const cleaned = enumPath.trim().replace(/^(?:window\.|globalThis\.|eda\.)/, "");
  const parts = cleaned.split(".");
  if (parts.length !== 2) {
    return undefined;
  }
  const [enumName, memberName] = parts;
  const table = BUILTIN_JLC_ENUMS[enumName];
  if (!table || !Object.prototype.hasOwnProperty.call(table, memberName)) {
    return undefined;
  }
  return table[memberName];
}

/**
 * Recursively resolve `{$enum: "..."}` and `{$ref: "jlc_obj:..."}` tokens
 * inside parameter structures.
 */
export function resolveSpecialTokens(
  value: unknown,
  options: TokenResolverOptions = {}
): unknown {
  if (isEnumToken(value)) {
    const expr = value.$enum.trim();
    const customResolved = options.resolveEnum?.(expr);
    if (customResolved !== undefined) {
      return customResolved;
    }
    const builtinResolved = lookupBuiltinEnum(expr);
    if (builtinResolved !== undefined) {
      return builtinResolved;
    }
    const mode = options.unresolvedEnumMode ?? "marker";
    if (mode === "error") {
      throw new Error(`ERR_ENUM_UNRESOLVED: Cannot resolve enum token '${expr}'`);
    }
    if (mode === "keep") {
      return value;
    }
    return { __jlcEnum: expr };
  }

  if (isRefToken(value)) {
    const refHandle = value.$ref.trim();
    if (options.resolveRef) {
      const resolved = options.resolveRef(refHandle);
      if (resolved !== undefined) {
        return resolved;
      }
      if ((options.unresolvedRefMode ?? "error") === "error") {
        throw new Error(`ERR_HANDLE_NOT_FOUND: Cannot resolve handle reference '${refHandle}'`);
      }
    }
    if ((options.unresolvedRefMode ?? "error") === "error" && !options.resolveRef) {
      throw new Error(`ERR_HANDLE_NOT_FOUND: No handle resolver for '${refHandle}'`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveSpecialTokens(item, options));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = resolveSpecialTokens(val, options);
    }
    return out;
  }

  return value;
}

function buildSpecDimensionMap(
  parameterSpecs?: ReaParameterSpec[],
  overrides?: Record<string, ReaPhysicalDimension | "none">
): Map<string, ReaPhysicalDimension | "none"> {
  const map = new Map<string, ReaPhysicalDimension | "none">();
  if (parameterSpecs) {
    for (const spec of parameterSpecs) {
      if (spec.physicalDimension) {
        map.set(spec.name.toLowerCase(), spec.physicalDimension);
      }
    }
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      map.set(k.toLowerCase(), v);
    }
  }
  return map;
}

function shouldSkipBySuffix(lowerKey: string): boolean {
  for (const suffix of SKIP_UNIT_CONVERSION_SUFFIXES) {
    if (lowerKey.length > suffix.length && lowerKey.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function inferFieldDimension(
  key: string,
  specMap: Map<string, ReaPhysicalDimension | "none">
): "length" | "length_array" | "angle" | "none" {
  const lower = key.toLowerCase();
  const explicit = specMap.get(lower);
  if (explicit) {
    if (explicit === "length") return "length";
    if (explicit === "angle") return "angle";
    return "none";
  }
  if (shouldSkipBySuffix(lower)) {
    return "none";
  }
  if (DEFAULT_LENGTH_FIELD_NAMES.has(lower)) {
    return "length";
  }
  if (DEFAULT_LENGTH_ARRAY_FIELD_NAMES.has(lower)) {
    return "length_array";
  }
  if (DEFAULT_ANGLE_FIELD_NAMES.has(lower)) {
    return "angle";
  }
  return "none";
}

function convertNumericArrayRecursive(
  arr: unknown[],
  fromLen: LengthUnit,
  toLen: LengthUnit
): unknown[] {
  return arr.map((item) => {
    if (typeof item === "number") {
      return convertLength(item, fromLen, toLen);
    }
    if (Array.isArray(item)) {
      return convertNumericArrayRecursive(item, fromLen, toLen);
    }
    return item;
  });
}

function resolveContractUnits(options: UnitConversionOptions): {
  enabled: boolean;
  nativeLength: LengthUnit;
  nativeAngle: AngleUnit;
} {
  if (options.unitMode === "native") {
    return { enabled: false, nativeLength: "none", nativeAngle: "none" };
  }
  const contract = options.contract;
  if (contract && contract.autoConvertFromMmDeg === false) {
    return { enabled: false, nativeLength: "none", nativeAngle: "none" };
  }
  const rawLen = contract?.nativeLengthUnit ?? options.defaultNativeLengthUnit ?? "mil";
  const nativeLength: LengthUnit =
    rawLen === "explicit_unit_param" ? "none" : rawLen;
  const nativeAngle: AngleUnit =
    contract?.nativeAngleUnit ?? options.defaultNativeAngleUnit ?? "deg";
  return { enabled: true, nativeLength, nativeAngle };
}

function convertRecursive(
  value: unknown,
  direction: "to_native" | "from_native",
  nativeLength: LengthUnit,
  nativeAngle: AngleUnit,
  specMap: Map<string, ReaPhysicalDimension | "none">,
  inheritedDimension: "length" | "length_array" | "angle" | "none"
): unknown {
  if (isEnumToken(value) || isRefToken(value)) {
    return value;
  }
  if (
    isPlainObject(value) &&
    (typeof value.__jlcEnum === "string" || typeof value.__jlcObjectId === "string")
  ) {
    return value;
  }

  const fromLen: LengthUnit = direction === "to_native" ? "mm" : nativeLength;
  const toLen: LengthUnit = direction === "to_native" ? nativeLength : "mm";
  const fromAng: AngleUnit = direction === "to_native" ? "deg" : nativeAngle;
  const toAng: AngleUnit = direction === "to_native" ? nativeAngle : "deg";

  if (typeof value === "number") {
    if (inheritedDimension === "length" || inheritedDimension === "length_array") {
      return convertLength(value, fromLen, toLen);
    }
    if (inheritedDimension === "angle") {
      return convertAngle(value, fromAng, toAng);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (inheritedDimension === "length" || inheritedDimension === "length_array") {
      return convertNumericArrayRecursive(value, fromLen, toLen);
    }
    return value.map((item) =>
      convertRecursive(item, direction, nativeLength, nativeAngle, specMap, "none")
    );
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, fieldVal] of Object.entries(value)) {
      const fieldDim = inferFieldDimension(key, specMap);
      out[key] = convertRecursive(
        fieldVal,
        direction,
        nativeLength,
        nativeAngle,
        specMap,
        fieldDim
      );
    }
    return out;
  }

  return value;
}

/**
 * Convert MCP high-level parameters (`mm` / `deg`) into JLCEDA native units
 * (`mil`, `10mil`, `rad`, etc.) recursively, preserving special tokens.
 */
export function convertParamsToNative(
  params: unknown,
  options: UnitConversionOptions = {}
): unknown {
  const { enabled, nativeLength, nativeAngle } = resolveContractUnits(options);
  if (!enabled) {
    return params;
  }
  const specMap = buildSpecDimensionMap(
    options.parameterSpecs,
    options.dimensionOverrides
  );

  // If params is an ordered positional args array and parameterSpecs are provided,
  // align each positional argument with its corresponding parameterSpec.
  if (Array.isArray(params) && options.parameterSpecs && options.parameterSpecs.length > 0) {
    return params.map((arg, idx) => {
      const spec = options.parameterSpecs![idx];
      const dim =
        spec?.physicalDimension === "length"
          ? "length"
          : spec?.physicalDimension === "angle"
            ? "angle"
            : "none";
      return convertRecursive(arg, "to_native", nativeLength, nativeAngle, specMap, dim);
    });
  }

  return convertRecursive(params, "to_native", nativeLength, nativeAngle, specMap, "none");
}

/**
 * Convert JLCEDA native return values (`mil`, `10mil`, `rad`, etc.) back into
 * MCP high-level metric units (`mm` / `deg`) recursively.
 */
export function convertResultFromNative(
  result: unknown,
  options: UnitConversionOptions = {}
): unknown {
  const { enabled, nativeLength, nativeAngle } = resolveContractUnits(options);
  if (!enabled) {
    return result;
  }
  const specMap = buildSpecDimensionMap(
    options.parameterSpecs,
    options.dimensionOverrides
  );
  return convertRecursive(result, "from_native", nativeLength, nativeAngle, specMap, "none");
}

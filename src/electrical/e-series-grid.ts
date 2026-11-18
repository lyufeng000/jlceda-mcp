/**
 * Standard E24 / E96 resistor & capacitor grids, package derating limits,
 * and LCSC (立创商城) Basic/Preferred component C-code mapping.
 */

export type ESeriesType = "E24" | "E96";

export interface ResistorPackageSpec {
  package: string;
  ratedPowerW: number;
  safePower50PctW: number;
  maxWorkingVoltageV: number;
  safeWorkingVoltage80PctV: number;
  antiTombstoneRequired: boolean;
}

export interface LcscBasicPartRef {
  lcscId: string;
  mpn: string;
  category: "RES" | "CAP" | "IND" | "DIODE" | "MOSFET" | "IC";
  package: string;
  numericValue: number; // Ohm, pF, or uH
  unit: "Ohm" | "pF" | "uH" | "V";
  dielectric?: "C0G_NP0" | "X7R" | "X5R" | "MNO2_TANT" | "AL_LIQUID";
  ratedVoltageV?: number;
  ratedCurrentA?: number;
  libraryClass: "basic" | "extended";
  description: string;
}

export interface MatchedStandardValue {
  nominalValue: number;
  formatted: string;
  unit: string;
  series: ESeriesType;
  relativeErrorPct: number;
  lcscCandidate?: LcscBasicPartRef;
}

/** Standard E24 base multipliers (1.0 .. 9.1). */
export const E24_MULTIPLIERS: readonly number[] = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
  3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1,
];

/** Complete IEC 60063 E96 (1%) base multipliers (1.00 .. 9.76). */
export const E96_MULTIPLIERS: readonly number[] = [
  1.00, 1.02, 1.05, 1.07, 1.10, 1.13, 1.15, 1.18,
  1.21, 1.24, 1.27, 1.30, 1.33, 1.37, 1.40, 1.43,
  1.47, 1.50, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74,
  1.78, 1.82, 1.87, 1.91, 1.96, 2.00, 2.05, 2.10,
  2.15, 2.21, 2.26, 2.32, 2.37, 2.43, 2.49, 2.55,
  2.61, 2.67, 2.74, 2.80, 2.87, 2.94, 3.01, 3.09,
  3.16, 3.24, 3.32, 3.40, 3.48, 3.57, 3.65, 3.74,
  3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53,
  4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49,
  5.62, 5.76, 5.90, 6.04, 6.19, 6.34, 6.49, 6.65,
  6.81, 6.98, 7.15, 7.32, 7.50, 7.68, 7.87, 8.06,
  8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

/** Standard E12/E24 capacitor base multipliers (pF .. uF). */
export const E24_CAP_MULTIPLIERS: readonly number[] = [
  1.0, 1.2, 1.5, 1.8, 2.0, 2.2, 2.7, 3.0, 3.3, 3.9, 4.7, 5.1, 5.6, 6.8, 7.5, 8.2, 9.1,
];

/** Standard power inductor values in uH. */
export const STANDARD_INDUCTOR_UH: readonly number[] = [
  0.47, 0.68, 1.0, 1.2, 1.5, 2.2, 3.3, 4.7, 6.8, 10, 15, 22, 33, 47, 68, 100, 150, 220, 330, 470,
];

/** Table 6-4 resistor package power & voltage specifications. */
export const RESISTOR_PACKAGE_SPECS: Record<string, ResistorPackageSpec> = {
  "0201": {
    package: "0201",
    ratedPowerW: 0.05,
    safePower50PctW: 0.025,
    maxWorkingVoltageV: 25,
    safeWorkingVoltage80PctV: 20,
    antiTombstoneRequired: true,
  },
  "0402": {
    package: "0402",
    ratedPowerW: 0.0625,
    safePower50PctW: 0.03125,
    maxWorkingVoltageV: 50,
    safeWorkingVoltage80PctV: 40,
    antiTombstoneRequired: true,
  },
  "0603": {
    package: "0603",
    ratedPowerW: 0.1,
    safePower50PctW: 0.05,
    maxWorkingVoltageV: 75, // 50~75V typical; warn above 50V, hard fail above 75V
    safeWorkingVoltage80PctV: 60,
    antiTombstoneRequired: true,
  },
  "0805": {
    package: "0805",
    ratedPowerW: 0.125,
    safePower50PctW: 0.0625,
    maxWorkingVoltageV: 150,
    safeWorkingVoltage80PctV: 120,
    antiTombstoneRequired: false,
  },
  "1206": {
    package: "1206",
    ratedPowerW: 0.25,
    safePower50PctW: 0.125,
    maxWorkingVoltageV: 200,
    safeWorkingVoltage80PctV: 160,
    antiTombstoneRequired: false,
  },
  "2512": {
    package: "2512",
    ratedPowerW: 1.0,
    safePower50PctW: 0.5,
    maxWorkingVoltageV: 200,
    safeWorkingVoltage80PctV: 160,
    antiTombstoneRequired: false,
  },
};

export const ORDERED_RESISTOR_PACKAGES = ["0402", "0603", "0805", "1206", "2512"] as const;

/** LCSC common SMT Basic & Preferred component C-code mapping table. */
export const LCSC_BASIC_CATALOG: readonly LcscBasicPartRef[] = [
  // Resistors - 0402 1%
  { lcscId: "C17168", mpn: "0402WGF0000TCE", category: "RES", package: "0402", numericValue: 0, unit: "Ohm", libraryClass: "basic", description: "0Ω ±1% 1/16W 0402" },
  { lcscId: "C25076", mpn: "0402WGF1000TCE", category: "RES", package: "0402", numericValue: 100, unit: "Ohm", libraryClass: "basic", description: "100Ω ±1% 1/16W 0402" },
  { lcscId: "C25092", mpn: "0402WGF220JTCE", category: "RES", package: "0402", numericValue: 22, unit: "Ohm", libraryClass: "basic", description: "22Ω ±1% 1/16W 0402" },
  { lcscId: "C25105", mpn: "0402WGF330JTCE", category: "RES", package: "0402", numericValue: 33, unit: "Ohm", libraryClass: "basic", description: "33Ω ±1% 1/16W 0402" },
  { lcscId: "C25118", mpn: "0402WGF470JTCE", category: "RES", package: "0402", numericValue: 47, unit: "Ohm", libraryClass: "basic", description: "47Ω ±1% 1/16W 0402" },
  { lcscId: "C25122", mpn: "0402WGF510JTCE", category: "RES", package: "0402", numericValue: 51, unit: "Ohm", libraryClass: "basic", description: "51Ω ±1% 1/16W 0402" },
  { lcscId: "C25087", mpn: "0402WGF1500TCE", category: "RES", package: "0402", numericValue: 150, unit: "Ohm", libraryClass: "basic", description: "150Ω ±1% 1/16W 0402" },
  { lcscId: "C25091", mpn: "0402WGF2200TCE", category: "RES", package: "0402", numericValue: 220, unit: "Ohm", libraryClass: "basic", description: "220Ω ±1% 1/16W 0402" },
  { lcscId: "C25104", mpn: "0402WGF3300TCE", category: "RES", package: "0402", numericValue: 330, unit: "Ohm", libraryClass: "basic", description: "330Ω ±1% 1/16W 0402" },
  { lcscId: "C25117", mpn: "0402WGF4700TCE", category: "RES", package: "0402", numericValue: 470, unit: "Ohm", libraryClass: "basic", description: "470Ω ±1% 1/16W 0402" },
  { lcscId: "C11702", mpn: "0402WGF1001TCE", category: "RES", package: "0402", numericValue: 1000, unit: "Ohm", libraryClass: "basic", description: "1kΩ ±1% 1/16W 0402" },
  { lcscId: "C25867", mpn: "0402WGF1501TCE", category: "RES", package: "0402", numericValue: 1500, unit: "Ohm", libraryClass: "basic", description: "1.5kΩ ±1% 1/16W 0402" },
  { lcscId: "C4109", mpn: "0402WGF2001TCE", category: "RES", package: "0402", numericValue: 2000, unit: "Ohm", libraryClass: "basic", description: "2kΩ ±1% 1/16W 0402" },
  { lcscId: "C25879", mpn: "0402WGF2201TCE", category: "RES", package: "0402", numericValue: 2200, unit: "Ohm", libraryClass: "basic", description: "2.2kΩ ±1% 1/16W 0402" },
  { lcscId: "C25890", mpn: "0402WGF3301TCE", category: "RES", package: "0402", numericValue: 3300, unit: "Ohm", libraryClass: "basic", description: "3.3kΩ ±1% 1/16W 0402" },
  { lcscId: "C25900", mpn: "0402WGF4701TCE", category: "RES", package: "0402", numericValue: 4700, unit: "Ohm", libraryClass: "basic", description: "4.7kΩ ±1% 1/16W 0402" },
  { lcscId: "C25905", mpn: "0402WGF5101TCE", category: "RES", package: "0402", numericValue: 5100, unit: "Ohm", libraryClass: "basic", description: "5.1kΩ ±1% 1/16W 0402" },
  { lcscId: "C25744", mpn: "0402WGF1002TCE", category: "RES", package: "0402", numericValue: 10000, unit: "Ohm", libraryClass: "basic", description: "10kΩ ±1% 1/16W 0402" },
  { lcscId: "C25756", mpn: "0402WGF1502TCE", category: "RES", package: "0402", numericValue: 15000, unit: "Ohm", libraryClass: "basic", description: "15kΩ ±1% 1/16W 0402" },
  { lcscId: "C25765", mpn: "0402WGF2002TCE", category: "RES", package: "0402", numericValue: 20000, unit: "Ohm", libraryClass: "basic", description: "20kΩ ±1% 1/16W 0402" },
  { lcscId: "C25768", mpn: "0402WGF2202TCE", category: "RES", package: "0402", numericValue: 22000, unit: "Ohm", libraryClass: "basic", description: "22kΩ ±1% 1/16W 0402" },
  { lcscId: "C25779", mpn: "0402WGF3302TCE", category: "RES", package: "0402", numericValue: 33000, unit: "Ohm", libraryClass: "basic", description: "33kΩ ±1% 1/16W 0402" },
  { lcscId: "C25792", mpn: "0402WGF4702TCE", category: "RES", package: "0402", numericValue: 47000, unit: "Ohm", libraryClass: "basic", description: "47kΩ ±1% 1/16W 0402" },
  { lcscId: "C25741", mpn: "0402WGF1003TCE", category: "RES", package: "0402", numericValue: 100000, unit: "Ohm", libraryClass: "basic", description: "100kΩ ±1% 1/16W 0402" },
  { lcscId: "C25767", mpn: "0402WGF2203TCE", category: "RES", package: "0402", numericValue: 220000, unit: "Ohm", libraryClass: "basic", description: "220kΩ ±1% 1/16W 0402" },
  { lcscId: "C25791", mpn: "0402WGF4703TCE", category: "RES", package: "0402", numericValue: 470000, unit: "Ohm", libraryClass: "basic", description: "470kΩ ±1% 1/16W 0402" },
  { lcscId: "C26083", mpn: "0402WGF1004TCE", category: "RES", package: "0402", numericValue: 1000000, unit: "Ohm", libraryClass: "basic", description: "1MΩ ±1% 1/16W 0402" },

  // Resistors - 0603 / 0805 / 1206
  { lcscId: "C23244", mpn: "0603WAF750KT5E", category: "RES", package: "0603", numericValue: 75, unit: "Ohm", libraryClass: "basic", description: "75Ω ±1% 1/10W 0603" },
  { lcscId: "C23162", mpn: "0603WAF4700T5E", category: "RES", package: "0603", numericValue: 470, unit: "Ohm", libraryClass: "basic", description: "470Ω ±1% 1/10W 0603" },
  { lcscId: "C21190", mpn: "0603WAF1001T5E", category: "RES", package: "0603", numericValue: 1000, unit: "Ohm", libraryClass: "basic", description: "1kΩ ±1% 1/10W 0603" },
  { lcscId: "C22807", mpn: "0603WAF100JT5E", category: "RES", package: "0603", numericValue: 10, unit: "Ohm", libraryClass: "basic", description: "10Ω ±1% 1/10W 0603" },
  { lcscId: "C25190", mpn: "0603WAF051JT5E", category: "RES", package: "0603", numericValue: 0.51, unit: "Ohm", libraryClass: "extended", description: "0.51Ω ±1% 1/10W 0603" },
  { lcscId: "C25224", mpn: "0603WAF100KT5E", category: "RES", package: "0603", numericValue: 1.0, unit: "Ohm", libraryClass: "basic", description: "1.0Ω ±1% 1/10W 0603" },
  { lcscId: "C25365", mpn: "0603WAF330MT5E", category: "RES", package: "0603", numericValue: 0.33, unit: "Ohm", libraryClass: "extended", description: "0.33Ω ±1% 1/10W 0603" },
  { lcscId: "C17437", mpn: "0805W8F1200T5E", category: "RES", package: "0805", numericValue: 120, unit: "Ohm", libraryClass: "basic", description: "120Ω ±1% 1/8W 0805" },
  { lcscId: "C17414", mpn: "0805W8F1002T5E", category: "RES", package: "0805", numericValue: 10000, unit: "Ohm", libraryClass: "basic", description: "10kΩ ±1% 1/8W 0805" },
  { lcscId: "C17902", mpn: "1206W4F1001T5E", category: "RES", package: "1206", numericValue: 1000, unit: "Ohm", libraryClass: "basic", description: "1kΩ ±1% 1/4W 1206" },
  { lcscId: "C17936", mpn: "1206W4F1003T5E", category: "RES", package: "1206", numericValue: 100000, unit: "Ohm", libraryClass: "basic", description: "100kΩ ±1% 1/4W 1206" },
  { lcscId: "C17965", mpn: "1206W4F3303T5E", category: "RES", package: "1206", numericValue: 330000, unit: "Ohm", libraryClass: "basic", description: "330kΩ ±1% 1/4W 1206" },
  { lcscId: "C17998", mpn: "1206W4F1004T5E", category: "RES", package: "1206", numericValue: 1000000, unit: "Ohm", libraryClass: "basic", description: "1MΩ ±1% 1/4W 1206" },

  // Capacitors - C0G/NP0 (pF)
  { lcscId: "C32949", mpn: "CL05C100JB5NNNC", category: "CAP", package: "0402", numericValue: 10, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "10pF C0G 50V 0402" },
  { lcscId: "C1546", mpn: "CL05C082DB5NNNC", category: "CAP", package: "0402", numericValue: 8.2, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "8.2pF C0G 50V 0402" },
  { lcscId: "C1548", mpn: "CL05C120JB5NNNC", category: "CAP", package: "0402", numericValue: 12, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "12pF C0G 50V 0402" },
  { lcscId: "C1549", mpn: "CL05C150JB5NNNC", category: "CAP", package: "0402", numericValue: 15, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "15pF C0G 50V 0402" },
  { lcscId: "C1550", mpn: "CL05C180JB5NNNC", category: "CAP", package: "0402", numericValue: 18, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "18pF C0G 50V 0402" },
  { lcscId: "C1555", mpn: "CL05C220JB5NNNC", category: "CAP", package: "0402", numericValue: 22, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "22pF C0G 50V 0402" },
  { lcscId: "C1561", mpn: "CL05C330JB5NNNC", category: "CAP", package: "0402", numericValue: 33, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "33pF C0G 50V 0402" },
  { lcscId: "C1530", mpn: "CL05C101JB5NNNC", category: "CAP", package: "0402", numericValue: 100, unit: "pF", dielectric: "C0G_NP0", ratedVoltageV: 50, libraryClass: "basic", description: "100pF C0G 50V 0402" },

  // Capacitors - X7R / X5R / High-Voltage
  { lcscId: "C1538", mpn: "CL05B102KB5NNNC", category: "CAP", package: "0402", numericValue: 1000, unit: "pF", dielectric: "X7R", ratedVoltageV: 50, libraryClass: "basic", description: "1nF X7R 50V 0402" },
  { lcscId: "C15195", mpn: "CL05B103KB5NNNC", category: "CAP", package: "0402", numericValue: 10000, unit: "pF", dielectric: "X7R", ratedVoltageV: 50, libraryClass: "basic", description: "10nF X7R 50V 0402" },
  { lcscId: "C1525", mpn: "CL05B104KO5NNNC", category: "CAP", package: "0402", numericValue: 100000, unit: "pF", dielectric: "X7R", ratedVoltageV: 16, libraryClass: "basic", description: "100nF X7R 16V 0402" },
  { lcscId: "C307331", mpn: "CL05B104KB54PNC", category: "CAP", package: "0402", numericValue: 100000, unit: "pF", dielectric: "X7R", ratedVoltageV: 50, libraryClass: "basic", description: "100nF X7R 50V 0402" },
  { lcscId: "C52923", mpn: "CL05A105KA5NQNC", category: "CAP", package: "0402", numericValue: 1000000, unit: "pF", dielectric: "X5R", ratedVoltageV: 25, libraryClass: "basic", description: "1uF X5R 25V 0402" },
  { lcscId: "C19702", mpn: "CL10A106KP8NNNC", category: "CAP", package: "0603", numericValue: 10000000, unit: "pF", dielectric: "X5R", ratedVoltageV: 10, libraryClass: "basic", description: "10uF X5R 10V 0603" },
  { lcscId: "C15850", mpn: "CL21B106KOQNNNE", category: "CAP", package: "0805", numericValue: 10000000, unit: "pF", dielectric: "X7R", ratedVoltageV: 16, libraryClass: "basic", description: "10uF X7R 16V 0805" },
  { lcscId: "C45783", mpn: "CL21A226MAQNNNE", category: "CAP", package: "0805", numericValue: 22000000, unit: "pF", dielectric: "X5R", ratedVoltageV: 25, libraryClass: "basic", description: "22uF X5R 25V 0805" },
  { lcscId: "C12891", mpn: "CL31B106KBHNNNE", category: "CAP", package: "1206", numericValue: 10000000, unit: "pF", dielectric: "X7R", ratedVoltageV: 50, libraryClass: "basic", description: "10uF X7R 50V 1206" },
  { lcscId: "C9196", mpn: "CC1206KKX7RDBB102", category: "CAP", package: "1206", numericValue: 1000, unit: "pF", dielectric: "X7R", ratedVoltageV: 2000, libraryClass: "basic", description: "1nF/2kV X7R 1206 (Bob-Smith HV)" },

  // Inductors
  { lcscId: "C169395", mpn: "SWPA4030S4R7MT", category: "IND", package: "SMD-4030", numericValue: 4.7, unit: "uH", ratedCurrentA: 2.9, libraryClass: "basic", description: "4.7uH 2.9A Shielded Power Inductor" },
  { lcscId: "C167220", mpn: "SWPA5040S100MT", category: "IND", package: "SMD-5040", numericValue: 10, unit: "uH", ratedCurrentA: 2.3, libraryClass: "basic", description: "10uH 2.3A Shielded Power Inductor" },
  { lcscId: "C167223", mpn: "SWPA5040S220MT", category: "IND", package: "SMD-5040", numericValue: 22, unit: "uH", ratedCurrentA: 1.6, libraryClass: "basic", description: "22uH 1.6A Shielded Power Inductor" },

  // Discrete Diodes & MOSFETs
  { lcscId: "C2128", mpn: "1N4148WS", category: "DIODE", package: "SOD-323", numericValue: 75, unit: "V", ratedVoltageV: 75, ratedCurrentA: 0.15, libraryClass: "basic", description: "1N4148WS Fast Switching Diode" },
  { lcscId: "C14998", mpn: "1N4007", category: "DIODE", package: "SMA", numericValue: 1000, unit: "V", ratedVoltageV: 1000, ratedCurrentA: 1.0, libraryClass: "basic", description: "1N4007 1000V 1A Rectifier Diode" },
  { lcscId: "C8678", mpn: "SS34", category: "DIODE", package: "SMA", numericValue: 40, unit: "V", ratedVoltageV: 40, ratedCurrentA: 3.0, libraryClass: "basic", description: "SS34 40V 3A Schottky Diode" },
  { lcscId: "C173413", mpn: "BZT52C12", category: "DIODE", package: "SOD-123", numericValue: 12, unit: "V", ratedVoltageV: 12, libraryClass: "basic", description: "BZT52C12 12V Zener Diode" },
  { lcscId: "C81598", mpn: "SMF5.0A", category: "DIODE", package: "SOD-123FL", numericValue: 5.0, unit: "V", ratedVoltageV: 5.0, libraryClass: "basic", description: "SMF5.0A 5.0V Uni-directional TVS" },
  { lcscId: "C20917", mpn: "AO3400A", category: "MOSFET", package: "SOT-23-3", numericValue: 30, unit: "V", ratedVoltageV: 30, ratedCurrentA: 5.7, libraryClass: "basic", description: "AO3400A 30V 5.7A N-MOS (Logic Level 2.5V)" },
  { lcscId: "C15127", mpn: "AO3401A", category: "MOSFET", package: "SOT-23-3", numericValue: 30, unit: "V", ratedVoltageV: 30, ratedCurrentA: 4.0, libraryClass: "basic", description: "AO3401A -30V -4A P-MOS" },
  { lcscId: "C8545", mpn: "2N7002", category: "MOSFET", package: "SOT-23-3", numericValue: 60, unit: "V", ratedVoltageV: 60, ratedCurrentA: 0.115, libraryClass: "basic", description: "2N7002 60V N-MOS" },
];

/**
 * Generate sorted standard resistance grid across decades (0.1 Ohm .. 10 MOhm).
 */
export function generateResistorGrid(
  series: ESeriesType = "E24",
  minOhm = 0.1,
  maxOhm = 10_000_000
): number[] {
  const mults = series === "E96" ? E96_MULTIPLIERS : E24_MULTIPLIERS;
  const values: number[] = [];
  for (let exp = -1; exp <= 7; exp++) {
    const scale = Math.pow(10, exp);
    for (const m of mults) {
      const val = Number((m * scale).toPrecision(6));
      if (val >= minOhm - 1e-12 && val <= maxOhm + 1e-6) {
        values.push(val);
      }
    }
  }
  return values;
}

/**
 * Generate sorted standard capacitance grid in pF (1 pF .. 470 uF).
 */
export function generateCapacitorGridPf(
  minPf = 1,
  maxPf = 470_000_000
): number[] {
  const values: number[] = [];
  for (let exp = 0; exp <= 8; exp++) {
    const scale = Math.pow(10, exp);
    for (const m of E24_CAP_MULTIPLIERS) {
      const val = Number((m * scale).toPrecision(4));
      if (val >= minPf - 1e-9 && val <= maxPf + 1e-6) {
        values.push(val);
      }
    }
  }
  return values;
}

export function formatResistance(ohm: number): string {
  if (ohm === 0) return "0Ω";
  if (ohm >= 1_000_000) {
    const m = ohm / 1_000_000;
    return `${Number(m.toPrecision(4))}MΩ`;
  }
  if (ohm >= 1_000) {
    const k = ohm / 1_000;
    return `${Number(k.toPrecision(4))}kΩ`;
  }
  return `${Number(ohm.toPrecision(4))}Ω`;
}

export function formatCapacitanceFromPf(pf: number): string {
  if (pf >= 1_000_000) {
    return `${Number((pf / 1_000_000).toPrecision(4))}uF`;
  }
  if (pf >= 1_000) {
    return `${Number((pf / 1_000).toPrecision(4))}nF`;
  }
  return `${Number(pf.toPrecision(4))}pF`;
}

export function findLcscResistorCandidate(
  ohm: number,
  preferredPkg?: string
): LcscBasicPartRef | undefined {
  const candidates = LCSC_BASIC_CATALOG.filter(
    (p) =>
      p.category === "RES" &&
      Math.abs(p.numericValue - ohm) <= Math.max(1e-6, ohm * 0.005)
  );
  if (candidates.length === 0) return undefined;
  if (preferredPkg) {
    const exactPkg = candidates.find((c) => c.package === preferredPkg);
    if (exactPkg) return exactPkg;
  }
  return candidates.find((c) => c.libraryClass === "basic") ?? candidates[0];
}

export function findLcscCapacitorCandidate(
  pf: number,
  dielectric?: string,
  minVoltageV = 0,
  preferredPkg?: string
): LcscBasicPartRef | undefined {
  const candidates = LCSC_BASIC_CATALOG.filter(
    (p) =>
      p.category === "CAP" &&
      Math.abs(p.numericValue - pf) <= Math.max(0.05, pf * 0.01) &&
      (!dielectric || p.dielectric === dielectric) &&
      (p.ratedVoltageV ?? 0) >= minVoltageV
  );
  if (candidates.length === 0) return undefined;
  if (preferredPkg) {
    const exactPkg = candidates.find((c) => c.package === preferredPkg);
    if (exactPkg) return exactPkg;
  }
  return candidates.find((c) => c.libraryClass === "basic") ?? candidates[0];
}

/**
 * Match a target resistance (Ohm) to the closest E24/E96 value.
 */
export function matchStandardResistor(
  targetOhm: number,
  series: ESeriesType = "E24",
  options?: { minOhm?: number; maxOhm?: number; preferredPkg?: string; preferCeil?: boolean }
): MatchedStandardValue {
  if (targetOhm <= 0) {
    return {
      nominalValue: 0,
      formatted: "0Ω",
      unit: "Ohm",
      series,
      relativeErrorPct: 0,
      lcscCandidate: findLcscResistorCandidate(0, options?.preferredPkg),
    };
  }
  const grid = generateResistorGrid(
    series,
    options?.minOhm ?? 0.1,
    options?.maxOhm ?? 10_000_000
  );
  let best = grid[0];
  let bestErr = Infinity;

  for (const val of grid) {
    if (options?.preferCeil && val < targetOhm) continue;
    const relErr = Math.abs(val - targetOhm) / targetOhm;
    if (relErr < bestErr) {
      bestErr = relErr;
      best = val;
    }
  }
  if (bestErr === Infinity) {
    best = grid[grid.length - 1];
    bestErr = Math.abs(best - targetOhm) / targetOhm;
  }

  return {
    nominalValue: best,
    formatted: formatResistance(best),
    unit: "Ohm",
    series,
    relativeErrorPct: Number((bestErr * 100).toFixed(4)),
    lcscCandidate: findLcscResistorCandidate(best, options?.preferredPkg),
  };
}

/**
 * Match a target capacitance to closest standard capacitor value.
 */
export function matchStandardCapacitor(
  targetValue: number,
  inputUnit: "pF" | "nF" | "uF",
  options?: {
    dielectric?: "C0G_NP0" | "X7R" | "X5R";
    minVoltageV?: number;
    preferredPkg?: string;
    preferCeil?: boolean;
  }
): MatchedStandardValue {
  const scale = inputUnit === "pF" ? 1 : inputUnit === "nF" ? 1000 : 1_000_000;
  const targetPf = targetValue * scale;
  const grid = generateCapacitorGridPf();

  let bestPf = grid[0];
  let bestErr = Infinity;
  for (const val of grid) {
    if (options?.preferCeil && val < targetPf) continue;
    const relErr = Math.abs(val - targetPf) / Math.max(targetPf, 1e-9);
    if (relErr < bestErr) {
      bestErr = relErr;
      bestPf = val;
    }
  }
  if (bestErr === Infinity) {
    bestPf = grid[grid.length - 1];
    bestErr = Math.abs(bestPf - targetPf) / Math.max(targetPf, 1e-9);
  }

  const outValue = bestPf / scale;
  return {
    nominalValue: Number(outValue.toPrecision(4)),
    formatted: formatCapacitanceFromPf(bestPf),
    unit: inputUnit,
    series: "E24",
    relativeErrorPct: Number((bestErr * 100).toFixed(4)),
    lcscCandidate: findLcscCapacitorCandidate(
      bestPf,
      options?.dielectric,
      options?.minVoltageV ?? 0,
      options?.preferredPkg
    ),
  };
}

/**
 * Match a target inductance (uH) to standard power inductor values.
 */
export function matchStandardInductor(targetUh: number): MatchedStandardValue {
  let best = STANDARD_INDUCTOR_UH[0];
  let bestErr = Infinity;
  for (const val of STANDARD_INDUCTOR_UH) {
    const relErr = Math.abs(val - targetUh) / Math.max(targetUh, 1e-9);
    if (relErr < bestErr) {
      bestErr = relErr;
      best = val;
    }
  }
  const lcscCandidate = LCSC_BASIC_CATALOG.find(
    (p) => p.category === "IND" && Math.abs(p.numericValue - best) <= 0.05
  );
  return {
    nominalValue: best,
    formatted: `${best}uH`,
    unit: "uH",
    series: "E24",
    relativeErrorPct: Number((bestErr * 100).toFixed(4)),
    lcscCandidate,
  };
}

/**
 * Optimize N resistors in series to achieve targetOhm with minimal error.
 * Useful for high-voltage (>150V) resistor divider string splitting (N x 1206).
 */
export function optimizeSeriesResistorCombination(
  targetOhm: number,
  count: number,
  series: ESeriesType = "E96"
): {
  valuesOhm: number[];
  totalOhm: number;
  relativeErrorPct: number;
} {
  if (count <= 1) {
    const single = matchStandardResistor(targetOhm, series);
    return {
      valuesOhm: [single.nominalValue],
      totalOhm: single.nominalValue,
      relativeErrorPct: single.relativeErrorPct,
    };
  }

  // Try equal-value array first for voltage symmetry
  const equalTarget = targetOhm / count;
  const equalMatch = matchStandardResistor(equalTarget, series);
  const equalTotal = equalMatch.nominalValue * count;
  const equalErr = Math.abs(equalTotal - targetOhm) / targetOhm;

  if (equalErr <= 0.001) {
    return {
      valuesOhm: Array<number>(count).fill(equalMatch.nominalValue),
      totalOhm: equalTotal,
      relativeErrorPct: Number((equalErr * 100).toFixed(4)),
    };
  }

  // Hybrid balanced array: (count - 1) identical main resistors + 1 trim resistor from E-series
  // keeping voltage drop balanced within <= 25% of equal share.
  const grid = generateResistorGrid(series, Math.max(1, equalTarget * 0.5), equalTarget * 1.5);
  let bestValues = Array<number>(count).fill(equalMatch.nominalValue);
  let bestTotal = equalTotal;
  let bestErr = equalErr;

  for (const baseVal of grid) {
    const rem = targetOhm - baseVal * (count - 1);
    if (rem <= 0) continue;
    // Keep voltage sharing balanced (trim resistor within 0.6x..1.25x of baseVal)
    if (rem < baseVal * 0.6 || rem > baseVal * 1.25) continue;
    const trimMatch = matchStandardResistor(rem, series);
    const total = baseVal * (count - 1) + trimMatch.nominalValue;
    const err = Math.abs(total - targetOhm) / targetOhm;
    if (err < bestErr) {
      bestErr = err;
      bestTotal = total;
      bestValues = [...Array<number>(count - 1).fill(baseVal), trimMatch.nominalValue];
    }
  }

  return {
    valuesOhm: bestValues,
    totalOhm: Number(bestTotal.toPrecision(8)),
    relativeErrorPct: Number((bestErr * 100).toFixed(4)),
  };
}

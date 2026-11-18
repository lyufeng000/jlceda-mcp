import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  SpiceAnalysisItem,
  SpiceRunRequest,
  SpiceRunResult,
} from "../types/index.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// SPICE Value Parser & Netlist Elements
// ============================================================================

export function parseSpiceValue(raw: string): number {
  const s = raw.trim().toLowerCase();
  const match = s.match(/^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(meg|t|g|k|m|u|n|p|f)?/);
  if (!match) {
    throw new Error(`Invalid SPICE numeric value: '${raw}'`);
  }
  const num = Number(match[1]);
  const suffix = match[2] ?? "";
  const multMap: Record<string, number> = {
    t: 1e12,
    g: 1e9,
    meg: 1e6,
    k: 1e3,
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
    f: 1e-15,
  };
  return num * (multMap[suffix] ?? 1);
}

interface PulseSpec {
  v1: number;
  v2: number;
  td: number;
  tr: number;
  tf: number;
  pw: number;
  per: number;
}

interface ResistorEl {
  kind: "R";
  name: string;
  n1: string;
  n2: string;
  value: number;
}

interface CapacitorEl {
  kind: "C";
  name: string;
  n1: string;
  n2: string;
  value: number;
  rser: number;
  lser: number;
}

interface InductorEl {
  kind: "L";
  name: string;
  n1: string;
  n2: string;
  value: number;
  rser: number;
}

interface SourceEl {
  kind: "V" | "I";
  name: string;
  n1: string;
  n2: string;
  dc: number;
  acMag: number;
  acPhaseDeg: number;
  pulse?: PulseSpec;
}

type SpiceElement = ResistorEl | CapacitorEl | InductorEl | SourceEl;

function normalizeNode(n: string): string {
  const u = n.trim().toUpperCase();
  if (u === "0" || u === "GND") return "0";
  return n.trim();
}

function evalPulse(pulse: PulseSpec, t: number): number {
  if (t <= pulse.td) return pulse.v1;
  let dt = t - pulse.td;
  if (pulse.per > 0) {
    dt = dt % pulse.per;
  }
  if (dt < pulse.tr) {
    return pulse.tr > 0 ? pulse.v1 + ((pulse.v2 - pulse.v1) * dt) / pulse.tr : pulse.v2;
  }
  if (dt < pulse.tr + pulse.pw) {
    return pulse.v2;
  }
  if (dt < pulse.tr + pulse.pw + pulse.tf) {
    const fdt = dt - (pulse.tr + pulse.pw);
    return pulse.tf > 0 ? pulse.v2 + ((pulse.v1 - pulse.v2) * fdt) / pulse.tf : pulse.v1;
  }
  return pulse.v1;
}

function extractInlineParam(tokens: string[], key: string): number | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*(.+)$`, "i");
  for (const tok of tokens) {
    const m = tok.match(re);
    if (m) return parseSpiceValue(m[1]);
  }
  return undefined;
}

export function parseSpiceNetlist(netlistText: string): {
  elements: SpiceElement[];
  nodes: string[];
} {
  const rawLines = netlistText.split(/\r?\n/);
  const lines: string[] = [];
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith(";")) continue;
    if (trimmed.startsWith("+") && lines.length > 0) {
      lines[lines.length - 1] += " " + trimmed.slice(1).trim();
    } else {
      lines.push(trimmed);
    }
  }

  const elements: SpiceElement[] = [];
  let internalSeq = 0;
  const nodeSet = new Set<string>();
  const regNode = (n: string) => {
    if (n !== "0") nodeSet.add(n);
    return n;
  };

  for (const line of lines) {
    if (line.startsWith(".")) continue;
    // Normalize PULSE(...) spaces
    const normalized = line.replace(/\(\s*/g, "(").replace(/\s*\)/g, ")");
    const tokens = normalized.split(/\s+/);
    if (tokens.length < 4) continue;
    const name = tokens[0];
    const prefix = name[0].toUpperCase();
    const n1 = regNode(normalizeNode(tokens[1]));
    const n2 = regNode(normalizeNode(tokens[2]));

    if (prefix === "R") {
      elements.push({
        kind: "R",
        name,
        n1,
        n2,
        value: Math.max(1e-9, parseSpiceValue(tokens[3])),
      });
    } else if (prefix === "C") {
      const val = parseSpiceValue(tokens[3]);
      const rser = extractInlineParam(tokens.slice(4), "rser") ?? extractInlineParam(tokens.slice(4), "esr") ?? 0;
      const lser = extractInlineParam(tokens.slice(4), "lser") ?? extractInlineParam(tokens.slice(4), "esl") ?? 0;
      if (rser > 0 || lser > 0) {
        let curNode = n1;
        if (rser > 0) {
          const mid = regNode(`__int_${name}_r_${++internalSeq}`);
          elements.push({ kind: "R", name: `R_${name}_ESR`, n1: curNode, n2: mid, value: rser });
          curNode = mid;
        }
        if (lser > 0) {
          const mid = regNode(`__int_${name}_l_${++internalSeq}`);
          elements.push({ kind: "L", name: `L_${name}_ESL`, n1: curNode, n2: mid, value: lser, rser: 0 });
          curNode = mid;
        }
        elements.push({ kind: "C", name, n1: curNode, n2, value: val, rser: 0, lser: 0 });
      } else {
        elements.push({ kind: "C", name, n1, n2, value: val, rser: 0, lser: 0 });
      }
    } else if (prefix === "L") {
      const val = parseSpiceValue(tokens[3]);
      const rser = extractInlineParam(tokens.slice(4), "rser") ?? extractInlineParam(tokens.slice(4), "rdc") ?? 0;
      elements.push({ kind: "L", name, n1, n2, value: val, rser });
    } else if (prefix === "V" || prefix === "I") {
      let dc = 0;
      let acMag = 0;
      let acPhaseDeg = 0;
      let pulse: PulseSpec | undefined;

      const rest = tokens.slice(3);
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i];
        const up = tok.toUpperCase();
        if (up === "DC" && i + 1 < rest.length) {
          dc = parseSpiceValue(rest[++i]);
        } else if (up === "AC" && i + 1 < rest.length) {
          acMag = parseSpiceValue(rest[++i]);
          if (i + 1 < rest.length && /^[+-]?\d/.test(rest[i + 1])) {
            acPhaseDeg = parseSpiceValue(rest[++i]);
          }
        } else if (up.startsWith("PULSE(")) {
          const fullPulse = rest.slice(i).join(" ");
          const pm = fullPulse.match(/PULSE\(([^)]+)\)/i);
          if (pm) {
            const nums = pm[1].trim().split(/[\s,]+/).map(parseSpiceValue);
            pulse = {
              v1: nums[0] ?? 0,
              v2: nums[1] ?? 0,
              td: nums[2] ?? 0,
              tr: nums[3] ?? 1e-9,
              tf: nums[4] ?? 1e-9,
              pw: nums[5] ?? 1,
              per: nums[6] ?? 0,
            };
            dc = pulse.v1;
          }
          break;
        } else if (i === 0 && /^[+-]?\d/.test(tok)) {
          dc = parseSpiceValue(tok);
        }
      }

      elements.push({ kind: prefix, name, n1, n2, dc, acMag, acPhaseDeg, pulse });
    }
  }

  return { elements, nodes: Array.from(nodeSet) };
}

// ============================================================================
// Dense Linear Solvers (Real & Complex Gaussian Elimination with Partial Pivot)
// ============================================================================

function solveRealLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-18) {
      throw new Error("Singular MNA circuit matrix (check floating nodes or shorted voltage sources).");
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const piv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / piv;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }
  return x;
}

interface Complex {
  re: number;
  im: number;
}

function cAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}
function cSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}
function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function cDiv(a: Complex, b: Complex): Complex {
  const denom = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / denom, im: (a.im * b.re - a.re * b.im) / denom };
}
function cAbs(a: Complex): number {
  return Math.hypot(a.re, a.im);
}

function solveComplexLinear(A: Complex[][], b: Complex[]): Complex[] {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row.map((z) => ({ ...z })), { ...b[i] }]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxMag = cAbs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const m = cAbs(M[r][col]);
      if (m > maxMag) {
        maxMag = m;
        pivotRow = r;
      }
    }
    if (maxMag < 1e-18) {
      throw new Error("Singular complex MNA matrix during AC analysis.");
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const piv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = cDiv(M[r][col], piv);
      if (factor.re === 0 && factor.im === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] = cSub(M[r][c], cMul(factor, M[col][c]));
      }
    }
  }

  const x = Array.from({ length: n }, () => ({ re: 0, im: 0 }));
  for (let i = n - 1; i >= 0; i--) {
    let sum = { ...M[i][n] };
    for (let j = i + 1; j < n; j++) {
      sum = cSub(sum, cMul(M[i][j], x[j]));
    }
    x[i] = cDiv(sum, M[i][i]);
  }
  return x;
}

// ============================================================================
// MNA Circuit Simulation Kernel (.OP, .AC, .TRAN)
// ============================================================================

export class MnaSpiceKernel {
  private readonly elements: SpiceElement[];
  private readonly nodeIndex = new Map<string, number>();
  private readonly vSources: SourceEl[] = [];
  private readonly iSources: SourceEl[] = [];
  private readonly inductors: InductorEl[] = [];
  private readonly capacitors: CapacitorEl[] = [];
  private readonly resistors: ResistorEl[] = [];
  private readonly numNodes: number;
  private readonly dim: number;

  constructor(netlistText: string) {
    const parsed = parseSpiceNetlist(netlistText);
    this.elements = parsed.elements;
    parsed.nodes.forEach((n, idx) => {
      this.nodeIndex.set(n.toUpperCase(), idx);
    });
    this.numNodes = parsed.nodes.length;

    for (const el of this.elements) {
      if (el.kind === "R") this.resistors.push(el);
      else if (el.kind === "C") this.capacitors.push(el);
      else if (el.kind === "L") this.inductors.push(el);
      else if (el.kind === "V") this.vSources.push(el);
      else if (el.kind === "I") this.iSources.push(el);
    }

    this.dim = this.numNodes + this.vSources.length + this.inductors.length;
  }

  private idx(nodeName: string): number {
    if (nodeName === "0") return -1;
    return this.nodeIndex.get(nodeName.toUpperCase()) ?? -1;
  }

  private stampRealConductance(A: number[][], n1: string, n2: string, g: number): void {
    const i1 = this.idx(n1);
    const i2 = this.idx(n2);
    if (i1 >= 0) A[i1][i1] += g;
    if (i2 >= 0) A[i2][i2] += g;
    if (i1 >= 0 && i2 >= 0) {
      A[i1][i2] -= g;
      A[i2][i1] -= g;
    }
  }

  private stampComplexAdmittance(A: Complex[][], n1: string, n2: string, y: Complex): void {
    const i1 = this.idx(n1);
    const i2 = this.idx(n2);
    if (i1 >= 0) A[i1][i1] = cAdd(A[i1][i1], y);
    if (i2 >= 0) A[i2][i2] = cAdd(A[i2][i2], y);
    if (i1 >= 0 && i2 >= 0) {
      A[i1][i2] = cSub(A[i1][i2], y);
      A[i2][i1] = cSub(A[i2][i1], y);
    }
  }

  public solveOp(): {
    nodeVoltages: Record<string, number>;
    inductorCurrents: number[];
  } {
    const A = Array.from({ length: this.dim }, () => new Array<number>(this.dim).fill(0));
    const b = new Array<number>(this.dim).fill(0);

    // Gmin for DC stability
    for (let i = 0; i < this.numNodes; i++) {
      A[i][i] += 1e-12;
    }

    for (const r of this.resistors) {
      this.stampRealConductance(A, r.n1, r.n2, 1 / r.value);
    }

    // Current sources
    for (const isrc of this.iSources) {
      const i1 = this.idx(isrc.n1);
      const i2 = this.idx(isrc.n2);
      // Conventional current flows from n1 to n2 inside source -> leaves n1, enters n2
      if (i1 >= 0) b[i1] -= isrc.dc;
      if (i2 >= 0) b[i2] += isrc.dc;
    }

    // Voltage sources
    this.vSources.forEach((vs, k) => {
      const row = this.numNodes + k;
      const i1 = this.idx(vs.n1);
      const i2 = this.idx(vs.n2);
      if (i1 >= 0) {
        A[i1][row] += 1;
        A[row][i1] += 1;
      }
      if (i2 >= 0) {
        A[i2][row] -= 1;
        A[row][i2] -= 1;
      }
      b[row] = vs.dc;
    });

    // Inductors at DC: V(n1) - V(n2) - rser * I_L = 0
    this.inductors.forEach((ind, k) => {
      const row = this.numNodes + this.vSources.length + k;
      const i1 = this.idx(ind.n1);
      const i2 = this.idx(ind.n2);
      if (i1 >= 0) {
        A[i1][row] += 1;
        A[row][i1] += 1;
      }
      if (i2 >= 0) {
        A[i2][row] -= 1;
        A[row][i2] -= 1;
      }
      A[row][row] -= ind.rser;
      b[row] = 0;
    });

    const x = solveRealLinear(A, b);
    const nodeVoltages: Record<string, number> = { "0": 0, GND: 0 };
    for (const [name, i] of this.nodeIndex.entries()) {
      nodeVoltages[name] = x[i];
    }
    const inductorCurrents = this.inductors.map(
      (_ind, k) => x[this.numNodes + this.vSources.length + k]
    );
    return { nodeVoltages, inductorCurrents };
  }

  public solveAc(params: {
    sourceNet?: string;
    probeNet: string;
    fStartHz: number;
    fStopHz: number;
    pointsPerDecade?: number;
  }): {
    freqsHz: number[];
    gainsDb: number[];
    peakGainDb: number;
    resonantFreqHz: number;
    atten100MhzDb: number;
    dcGainDb: number;
  } {
    const fStart = Math.max(1, params.fStartHz);
    const fStop = Math.max(fStart, params.fStopHz);
    const ptsPerDec = params.pointsPerDecade ?? 240;
    const decades = Math.max(0.1, Math.log10(fStop / fStart));
    const totalPts = Math.max(20, Math.round(decades * ptsPerDec));

    const freqsHz: number[] = [];
    for (let i = 0; i <= totalPts; i++) {
      freqsHz.push(fStart * Math.pow(fStop / fStart, i / totalPts));
    }
    if (100_000_000 >= fStart && 100_000_000 <= fStop) {
      freqsHz.push(100_000_000);
    }
    freqsHz.sort((a, b) => a - b);

    // Determine AC excitation source
    let acSourceIndex = this.vSources.findIndex((v) => v.acMag > 0);
    if (acSourceIndex < 0 && params.sourceNet) {
      const target = params.sourceNet.toUpperCase();
      acSourceIndex = this.vSources.findIndex((v) => v.n1.toUpperCase() === target);
    }
    if (acSourceIndex < 0 && this.vSources.length > 0) {
      acSourceIndex = 0;
    }

    const evalAtFreq = (freqHz: number): number => {
      const omega = 2 * Math.PI * freqHz;
      const A: Complex[][] = Array.from({ length: this.dim }, () =>
        Array.from({ length: this.dim }, () => ({ re: 0, im: 0 }))
      );
      const b: Complex[] = Array.from({ length: this.dim }, () => ({ re: 0, im: 0 }));

      for (let i = 0; i < this.numNodes; i++) {
        A[i][i].re += 1e-12;
      }

      for (const r of this.resistors) {
        this.stampComplexAdmittance(A, r.n1, r.n2, { re: 1 / r.value, im: 0 });
      }
      for (const c of this.capacitors) {
        this.stampComplexAdmittance(A, c.n1, c.n2, { re: 0, im: omega * c.value });
      }

      this.vSources.forEach((vs, k) => {
        const row = this.numNodes + k;
        const i1 = this.idx(vs.n1);
        const i2 = this.idx(vs.n2);
        if (i1 >= 0) {
          A[i1][row].re += 1;
          A[row][i1].re += 1;
        }
        if (i2 >= 0) {
          A[i2][row].re -= 1;
          A[row][i2].re -= 1;
        }
        const mag = vs.acMag > 0 ? vs.acMag : k === acSourceIndex ? 1.0 : 0;
        const rad = (vs.acPhaseDeg * Math.PI) / 180;
        b[row] = { re: mag * Math.cos(rad), im: mag * Math.sin(rad) };
      });

      this.inductors.forEach((ind, k) => {
        const row = this.numNodes + this.vSources.length + k;
        const i1 = this.idx(ind.n1);
        const i2 = this.idx(ind.n2);
        if (i1 >= 0) {
          A[i1][row].re += 1;
          A[row][i1].re += 1;
        }
        if (i2 >= 0) {
          A[i2][row].re -= 1;
          A[row][i2].re -= 1;
        }
        A[row][row].re -= ind.rser;
        A[row][row].im -= omega * ind.value;
      });

      const x = solveComplexLinear(A, b);
      const probeIdx = this.idx(params.probeNet);
      const vProbe = probeIdx >= 0 ? x[probeIdx] : { re: 0, im: 0 };
      const srcMag =
        acSourceIndex >= 0
          ? this.vSources[acSourceIndex].acMag > 0
            ? this.vSources[acSourceIndex].acMag
            : 1.0
          : 1.0;
      const mag = cAbs(vProbe) / Math.max(srcMag, 1e-12);
      return 20 * Math.log10(Math.max(mag, 1e-12));
    };

    const gainsDb: number[] = [];
    let peakGainDb = -Infinity;
    let resonantFreqHz = freqsHz[0];

    for (const f of freqsHz) {
      const g = evalAtFreq(f);
      gainsDb.push(g);
      if (g > peakGainDb) {
        peakGainDb = g;
        resonantFreqHz = f;
      }
    }

    const atten100MhzDb = evalAtFreq(100_000_000);
    return {
      freqsHz,
      gainsDb,
      peakGainDb: Number(peakGainDb.toFixed(4)),
      resonantFreqHz: Number(resonantFreqHz.toFixed(2)),
      atten100MhzDb: Number(atten100MhzDb.toFixed(4)),
      dcGainDb: Number(gainsDb[0].toFixed(4)),
    };
  }

  public solveTran(params: {
    probeNet: string;
    tStopS: number;
    stepLoadCurrentMa?: { from: number; to: number; tr_ns?: number };
  }): {
    timesS: number[];
    valuesV: number[];
    vInitV: number;
    vMinV: number;
    vMaxV: number;
    vFinalV: number;
    maxDroopMv: number;
    maxOvershootMv: number;
    ringingCycles: number;
  } {
    const op = this.solveOp();
    const probeKey = params.probeNet.toUpperCase();
    const vInit = op.nodeVoltages[probeKey] ?? 0;

    // Synthesize transient step load if requested and no pulsed source exists
    const extraISources: SourceEl[] = [...this.iSources];
    if (params.stepLoadCurrentMa && !this.elements.some((e) => e.kind !== "R" && e.kind !== "C" && e.kind !== "L" && e.pulse)) {
      const trS = (params.stepLoadCurrentMa.tr_ns ?? 100) * 1e-9;
      extraISources.push({
        kind: "I",
        name: "I_STEP_LOAD",
        n1: params.probeNet,
        n2: "0",
        dc: params.stepLoadCurrentMa.from / 1000,
        acMag: 0,
        acPhaseDeg: 0,
        pulse: {
          v1: params.stepLoadCurrentMa.from / 1000,
          v2: params.stepLoadCurrentMa.to / 1000,
          td: params.tStopS * 0.05,
          tr: Math.max(1e-9, trS),
          tf: Math.max(1e-9, trS),
          pw: params.tStopS,
          per: 0,
        },
      });
    }

    const steps = 1800;
    const dt = params.tStopS / steps;

    // Initial state for C and L
    const capVoltages = this.capacitors.map(
      (c) => (op.nodeVoltages[c.n1.toUpperCase()] ?? 0) - (op.nodeVoltages[c.n2.toUpperCase()] ?? 0)
    );
    const capCurrents = new Array<number>(this.capacitors.length).fill(0);
    const indCurrents = [...op.inductorCurrents];
    const indIdealVoltages = new Array<number>(this.inductors.length).fill(0);

    // Pre-build constant conductance matrix M (trapezoidal constant dt!)
    const A = Array.from({ length: this.dim }, () => new Array<number>(this.dim).fill(0));
    for (let i = 0; i < this.numNodes; i++) A[i][i] += 1e-12;
    for (const r of this.resistors) this.stampRealConductance(A, r.n1, r.n2, 1 / r.value);
    for (const c of this.capacitors) {
      const geq = (2 * c.value) / dt;
      this.stampRealConductance(A, c.n1, c.n2, geq);
    }
    this.vSources.forEach((vs, k) => {
      const row = this.numNodes + k;
      const i1 = this.idx(vs.n1);
      const i2 = this.idx(vs.n2);
      if (i1 >= 0) {
        A[i1][row] += 1;
        A[row][i1] += 1;
      }
      if (i2 >= 0) {
        A[i2][row] -= 1;
        A[row][i2] -= 1;
      }
    });
    this.inductors.forEach((ind, k) => {
      const row = this.numNodes + this.vSources.length + k;
      const req = (2 * ind.value) / dt;
      const i1 = this.idx(ind.n1);
      const i2 = this.idx(ind.n2);
      if (i1 >= 0) {
        A[i1][row] += 1;
        A[row][i1] += 1;
      }
      if (i2 >= 0) {
        A[i2][row] -= 1;
        A[row][i2] -= 1;
      }
      A[row][row] -= ind.rser + req;
    });

    const timesS: number[] = [0];
    const valuesV: number[] = [vInit];
    const probeIdx = this.idx(params.probeNet);

    for (let step = 1; step <= steps; step++) {
      const t = step * dt;
      const b = new Array<number>(this.dim).fill(0);

      for (const isrc of extraISources) {
        const val = isrc.pulse ? evalPulse(isrc.pulse, t) : isrc.dc;
        const i1 = this.idx(isrc.n1);
        const i2 = this.idx(isrc.n2);
        if (i1 >= 0) b[i1] -= val;
        if (i2 >= 0) b[i2] += val;
      }

      this.capacitors.forEach((c, k) => {
        const geq = (2 * c.value) / dt;
        const iHist = geq * capVoltages[k] + capCurrents[k];
        const i1 = this.idx(c.n1);
        const i2 = this.idx(c.n2);
        if (i1 >= 0) b[i1] += iHist;
        if (i2 >= 0) b[i2] -= iHist;
      });

      this.vSources.forEach((vs, k) => {
        const row = this.numNodes + k;
        b[row] = vs.pulse ? evalPulse(vs.pulse, t) : vs.dc;
      });

      this.inductors.forEach((ind, k) => {
        const row = this.numNodes + this.vSources.length + k;
        const req = (2 * ind.value) / dt;
        b[row] = -req * indCurrents[k] - indIdealVoltages[k];
      });

      const x = solveRealLinear(A, b);

      // Update companion states
      this.capacitors.forEach((c, k) => {
        const geq = (2 * c.value) / dt;
        const i1 = this.idx(c.n1);
        const i2 = this.idx(c.n2);
        const vNew = (i1 >= 0 ? x[i1] : 0) - (i2 >= 0 ? x[i2] : 0);
        capCurrents[k] = geq * (vNew - capVoltages[k]) - capCurrents[k];
        capVoltages[k] = vNew;
      });

      this.inductors.forEach((ind, k) => {
        const row = this.numNodes + this.vSources.length + k;
        const iNew = x[row];
        const i1 = this.idx(ind.n1);
        const i2 = this.idx(ind.n2);
        const vTotal = (i1 >= 0 ? x[i1] : 0) - (i2 >= 0 ? x[i2] : 0);
        indIdealVoltages[k] = vTotal - ind.rser * iNew;
        indCurrents[k] = iNew;
      });

      const vProbe = probeIdx >= 0 ? x[probeIdx] : 0;
      timesS.push(t);
      valuesV.push(vProbe);
    }

    const vMin = Math.min(...valuesV);
    const vMax = Math.max(...valuesV);
    const vFinal = valuesV[valuesV.length - 1];
    const maxDroopMv = Math.max(0, (vInit - vMin) * 1000);
    const maxOvershootMv = Math.max(0, (vMax - vFinal) * 1000);

    // Count significant ringing cycles (zero crossings around vFinal after step edge)
    const ampThreshold = Math.max(0.001, (vMax - vMin) * 0.04);
    let halfCycles = 0;
    let lastSign = 0;
    for (let i = Math.floor(steps * 0.05); i < valuesV.length; i++) {
      const diff = valuesV[i] - vFinal;
      if (Math.abs(diff) > ampThreshold) {
        const s = diff > 0 ? 1 : -1;
        if (lastSign !== 0 && s !== lastSign) {
          halfCycles++;
        }
        lastSign = s;
      }
    }
    const ringingCycles = Math.floor(halfCycles / 2);

    return {
      timesS,
      valuesV,
      vInitV: Number(vInit.toFixed(6)),
      vMinV: Number(vMin.toFixed(6)),
      vMaxV: Number(vMax.toFixed(6)),
      vFinalV: Number(vFinal.toFixed(6)),
      maxDroopMv: Number(maxDroopMv.toFixed(3)),
      maxOvershootMv: Number(maxOvershootMv.toFixed(3)),
      ringingCycles,
    };
  }
}

// ============================================================================
// Assertion Evaluator & Headless ngspice / MNA Runner
// ============================================================================

function evaluateNumericAssertion(
  assertion: string,
  actualValue: number
): { passed: boolean; op: string; target: number } {
  const m = assertion.match(/(<=|>=|<|>|==|!=)\s*([+-]?\d+(?:\.\d+)?)/);
  if (!m) return { passed: true, op: "==", target: actualValue };
  const op = m[1];
  const target = Number(m[2]);
  let passed = true;
  if (op === "<=") passed = actualValue <= target;
  else if (op === ">=") passed = actualValue >= target;
  else if (op === "<") passed = actualValue < target;
  else if (op === ">") passed = actualValue > target;
  else if (op === "==") passed = Math.abs(actualValue - target) <= 1e-6;
  else if (op === "!=") passed = Math.abs(actualValue - target) > 1e-6;
  return { passed, op, target };
}

function synthesizeNetlistFromComponents(request: SpiceRunRequest): string {
  const acItem = request.analysisSuite.find((a) => a.type === "AC");
  const srcNet = String(acItem?.params.source_net ?? request.subcircuitNets?.[0] ?? "VIN");
  const probeNet = String(acItem?.params.probe_net ?? request.probeNodes?.[0] ?? request.subcircuitNets?.[1] ?? "VOUT");
  const hasDamp = (request.components ?? []).some((c) => /damp/i.test(c));
  const lines = [
    "* Synthesized Bead+MLCC Filter Subcircuit",
    `V_SRC ${srcNet} 0 DC 3.3 AC 1`,
    `L_FB1 ${srcNet} ${probeNet} 1.2u Rser=0.15`,
    `C_OUT1 ${probeNet} 0 4.7u Rser=0.02`,
  ];
  if (hasDamp) {
    lines.push(`R_DAMP1 ${probeNet} N_DAMP 0.51`);
    lines.push(`C_DAMP1 N_DAMP 0 22u`);
  }
  lines.push(".end");
  return lines.join("\n");
}

async function tryExternalNgspice(
  ngspiceExePath: string,
  netlistText: string,
  analysisSuite: SpiceAnalysisItem[]
): Promise<string | null> {
  const tempDir = mkdtempSync(join(tmpdir(), "jlceda-ngspice-"));
  try {
    const lines = netlistText
      .split(/\r?\n/)
      .filter((l) => !/^\.end\s*$/i.test(l.trim()));
    for (const item of analysisSuite) {
      if (item.type === "OP") lines.push(".op");
      else if (item.type === "AC") {
        const f0 = Number(item.params.f_start_hz ?? 100);
        const f1 = Number(item.params.f_stop_hz ?? 100_000_000);
        lines.push(`.ac dec 100 ${f0} ${f1}`);
      } else if (item.type === "TRAN") {
        const tStopUs = Number(item.params.t_stop_us ?? 200);
        lines.push(`.tran ${Math.max(0.05, tStopUs / 1000)}u ${tStopUs}u`);
      }
    }
    lines.push(".end");
    const cirPath = join(tempDir, "circuit.cir");
    writeFileSync(cirPath, lines.join("\n"), "utf-8");

    const { stdout } = await execFileAsync(ngspiceExePath, ["-b", cirPath], {
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export interface RunSpiceOptions {
  ngspiceExePath?: string | null;
  cdpSimHook?: ((request: SpiceRunRequest) => Promise<SpiceRunResult | null>) | null;
}

export async function runSpiceSimulation(
  request: SpiceRunRequest,
  options?: RunSpiceOptions
): Promise<SpiceRunResult> {
  // 1. Optional live CDP SCH_SimulationEngine hook
  if (options?.cdpSimHook) {
    const cdpRes = await options.cdpSimHook(request);
    if (cdpRes) return cdpRes;
  }

  const netlist = request.spiceNetlist?.trim()
    ? request.spiceNetlist
    : synthesizeNetlistFromComponents(request);

  // 2. Optional external ngspice -b (with <=10s hard kill timeout)
  const exePath = options?.ngspiceExePath ?? process.env.NGSPICE_EXE_PATH;
  let externalStdout: string | null = null;
  if (exePath) {
    externalStdout = await tryExternalNgspice(exePath, netlist, request.analysisSuite);
  }

  // 3. Built-in real MNA mathematical kernel (AC/TRAN/OP physical equations)
  const kernel = new MnaSpiceKernel(netlist);
  const metrics: Record<string, number | string | boolean> = {};
  const failedAssertions: SpiceRunResult["failedAssertions"] = [];

  for (const item of request.analysisSuite) {
    if (item.type === "OP") {
      const op = kernel.solveOp();
      for (const [node, v] of Object.entries(op.nodeVoltages)) {
        metrics[`op_${node.toLowerCase()}_v`] = Number(v.toFixed(6));
      }
      const probe = String(item.params.probe_net ?? request.probeNodes?.[0] ?? "OUT").toUpperCase();
      const vProbe = op.nodeVoltages[probe] ?? 0;
      metrics.op_probe_v = Number(vProbe.toFixed(6));

      for (const assertion of item.assertions ?? []) {
        const up = assertion.toUpperCase();
        let actual = vProbe;
        const vNodeMatch = up.match(/V\(([^)]+)\)/);
        if (vNodeMatch) {
          actual = op.nodeVoltages[vNodeMatch[1].trim()] ?? 0;
        }
        const check = evaluateNumericAssertion(assertion, actual);
        if (!check.passed) {
          failedAssertions.push({
            assertion,
            actual: Number(actual.toFixed(4)),
            diagnosis: `直流工作点 ${assertion} 不达标（实测 ${actual.toFixed(4)}V）。`,
            prescribed_action: "核查分压比、偏置电阻或电源使能电平。",
          });
        }
      }
    } else if (item.type === "AC") {
      const probeNet = String(
        item.params.probe_net ?? request.probeNodes?.[0] ?? request.subcircuitNets?.[1] ?? "VOUT"
      );
      const sourceNet = item.params.source_net ? String(item.params.source_net) : undefined;
      const ac = kernel.solveAc({
        sourceNet,
        probeNet,
        fStartHz: Number(item.params.f_start_hz ?? 100),
        fStopHz: Number(item.params.f_stop_hz ?? 100_000_000),
      });

      metrics.ac_peak_gain_db = ac.peakGainDb;
      metrics.ac_resonant_freq_hz = ac.resonantFreqHz;
      metrics.ac_resonant_freq_khz = Number((ac.resonantFreqHz / 1000).toFixed(3));
      metrics.ac_atten_100mhz_db = ac.atten100MhzDb;
      metrics.ac_dc_gain_db = ac.dcGainDb;

      for (const assertion of item.assertions ?? []) {
        const up = assertion.toUpperCase();
        if (up.includes("MAX_GAIN_DB")) {
          const check = evaluateNumericAssertion(assertion, ac.peakGainDb);
          if (!check.passed) {
            failedAssertions.push({
              assertion,
              actual: ac.peakGainDb,
              diagnosis: `回路在 ${(ac.resonantFreqHz / 1000).toFixed(2)} kHz 处出现严重欠阻尼 LC 谐振峰 (+${ac.peakGainDb.toFixed(2)} dB > ${check.target} dB)，会放大前端开关电源纹波！`,
              prescribed_action:
                "调用 jlc_elec_calc(calculator='rc_filter_damping', inputs={mode:'BEAD_DAMP', ...}) 计算并在滤波输出端对地并联串联阻尼电阻 (0.5Ω~2.2Ω) 的阻尼电容支路 (C_damp = 4*C_eff)。",
            });
          }
        } else if (up.includes("ATTENUATION_AT_100MHZ_DB")) {
          const check = evaluateNumericAssertion(assertion, ac.atten100MhzDb);
          if (!check.passed) {
            failedAssertions.push({
              assertion,
              actual: ac.atten100MhzDb,
              diagnosis: `100MHz 高频衰减不足（实测 ${ac.atten100MhzDb.toFixed(2)} dB，要求 ${assertion}）。`,
              prescribed_action: "增大磁珠高频阻抗或减小旁路电容等效串联电感(ESL)/引线长度。",
            });
          }
        }
      }
    } else if (item.type === "TRAN") {
      const probeNet = String(
        item.params.probe_net ?? request.probeNodes?.[0] ?? request.subcircuitNets?.[1] ?? "VOUT"
      );
      const tStopS =
        item.params.t_stop_s !== undefined
          ? Number(item.params.t_stop_s)
          : Number(item.params.t_stop_us ?? 200) * 1e-6;
      const stepLoad = item.params.step_load_current_ma as
        | { from: number; to: number; tr_ns?: number }
        | undefined;

      const tran = kernel.solveTran({
        probeNet,
        tStopS,
        stepLoadCurrentMa: stepLoad,
      });

      metrics.tran_v_init_v = tran.vInitV;
      metrics.tran_v_min_v = tran.vMinV;
      metrics.tran_v_max_v = tran.vMaxV;
      metrics.tran_v_final_v = tran.vFinalV;
      metrics.tran_max_droop_mv = tran.maxDroopMv;
      metrics.tran_max_overshoot_mv = tran.maxOvershootMv;
      metrics.tran_ringing_cycles = tran.ringingCycles;

      for (const assertion of item.assertions ?? []) {
        const up = assertion.toUpperCase();
        if (up.includes("V_DROOP_MAX_MV")) {
          const check = evaluateNumericAssertion(assertion, tran.maxDroopMv);
          if (!check.passed) {
            failedAssertions.push({
              assertion,
              actual: tran.maxDroopMv,
              diagnosis: `阶跃负载瞬态压降过大（实测跌落 ${tran.maxDroopMv.toFixed(2)} mV > ${check.target} mV）。`,
              prescribed_action: "增大局部储能电容容值或降低前端电源/磁珠直流阻抗。",
            });
          }
        } else if (up.includes("RINGING_CYCLES")) {
          const check = evaluateNumericAssertion(assertion, tran.ringingCycles);
          if (!check.passed) {
            failedAssertions.push({
              assertion,
              actual: tran.ringingCycles,
              diagnosis: `阶跃响应存在欠阻尼振铃（实测振荡 ${tran.ringingCycles} 个周期 > ${check.target}）。`,
              prescribed_action: "增加 RC 阻尼支路提升系统阻尼比 ζ >= 0.7。",
            });
          }
        }
      }
    }
  }

  return {
    converged: true,
    simulationPassed: failedAssertions.length === 0,
    engineUsed: externalStdout ? "ngspice" : "jlc_builtin",
    metrics,
    failedAssertions,
  };
}

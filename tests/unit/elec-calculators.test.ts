import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import {
  CesmBinder,
  E24_MULTIPLIERS,
  E96_MULTIPLIERS,
  MnaSpiceKernel,
  bindCesm,
  calculateCrystalLoadCap,
  calculateDcdcInductorCap,
  calculateI2cPullup,
  calculateLdoThermal,
  calculateLedOptocoupler,
  calculateMosfetLossGate,
  calculateRcFilterDamping,
  calculateTraceCurrentIrdrop,
  calculateVoltageDivider,
  clearSessionBindings,
  getBoundCesm,
  instantiateBlock,
  isCesmBound,
  matchStandardCapacitor,
  matchStandardInductor,
  matchStandardResistor,
  optimizeSeriesResistorCombination,
  parseDatasheetPdfBuffer,
  runElecCalculator,
  runSpiceSimulation,
  validateCesmSchema,
  verifyNoFourWayJunctions,
} from "../../src/electrical/index.js";
import { BLOCK_TEMPLATE_IDS, ELEC_CALCULATOR_NAMES } from "../../src/types/index.js";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** Build a valid minimal single-page PDF buffer containing arbitrary ASCII text lines. */
function buildMinimalPdfBuffer(lines: string[]): Buffer {
  const escapedLines = lines
    .map((l) => l.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"))
    .map((l, idx) => (idx === 0 ? `(${l}) Tj` : `0 -14 Td (${l}) Tj`))
    .join("\n");
  const streamContent = `BT\n/F1 10 Tf\n50 750 Td\n${escapedLines}\nET\n`;

  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

// ============================================================================
// 1. E-Series Grid & LCSC Basic Mapping
// ============================================================================

describe("e-series-grid", () => {
  it("contains exact 24 E24 multipliers and 96 E96 multipliers", () => {
    expect(E24_MULTIPLIERS).toHaveLength(24);
    expect(E96_MULTIPLIERS).toHaveLength(96);
    expect(E96_MULTIPLIERS[0]).toBe(1.0);
    expect(E96_MULTIPLIERS[E96_MULTIPLIERS.length - 1]).toBe(9.76);
  });

  it("matches E24/E96 resistors, capacitors, inductors, and LCSC C-codes", () => {
    const r5k1 = matchStandardResistor(5090, "E24", { preferredPkg: "0402" });
    expect(r5k1.nominalValue).toBe(5100);
    expect(r5k1.lcscCandidate?.lcscId).toBe("C25905");

    const rE96 = matchStandardResistor(49850, "E96");
    expect(rE96.nominalValue).toBe(49900);
    expect(rE96.relativeErrorPct).toBeLessThan(0.15);

    const c100n = matchStandardCapacitor(100, "nF", { dielectric: "X7R", preferredPkg: "0402" });
    expect(c100n.nominalValue).toBe(100);
    expect(c100n.lcscCandidate?.lcscId).toBe("C1525");

    const l4u7 = matchStandardInductor(4.5);
    expect(l4u7.nominalValue).toBe(4.7);
    expect(l4u7.lcscCandidate?.lcscId).toBe("C169395");
  });

  it("optimizes multi-resistor series combinations within < 0.1% error", () => {
    const opt = optimizeSeriesResistorCombination(990_000, 3, "E96");
    expect(opt.valuesOhm).toHaveLength(3);
    expect(opt.relativeErrorPct).toBeLessThan(0.1);
    expect(Math.abs(opt.totalOhm - 990_000) / 990_000).toBeLessThan(0.001);
  });
});

// ============================================================================
// 2. All 9 Deterministic Calculators (50+ Calibrated Test Cases, Error < 0.1%)
// ============================================================================

describe("9 Deterministic Electrical Calculators (50+ Calibrated Cases)", () => {
  it("supports dispatching all 9 calculators by name", () => {
    expect(ELEC_CALCULATOR_NAMES).toHaveLength(9);
    const res = runElecCalculator("crystal_load_cap", { cl_datasheet_pf: 12, freq_mhz: 8 });
    expect(res.calculator).toBe("crystal_load_cap");
    expect(res.deratingPass).toBe(true);
  });

  // --- Calculator 1: voltage_divider (8 cases) ---
  describe("1. voltage_divider", () => {
    it("Case 1-3: FB mode computes 3.3V, 5.0V, 12.0V within <0.1% formula precision", () => {
      const cases = [
        { vout: 3.3, vref: 0.8, ifbUa: 0.1 },
        { vout: 5.0, vref: 0.596, ifbUa: 0.2 },
        { vout: 12.0, vref: 0.8, ifbUa: 1.0 },
      ];
      for (const c of cases) {
        const res = calculateVoltageDivider({
          mode: "FB",
          v_in_max: c.vout,
          v_target_or_vref: c.vref,
          i_fb_ua: c.ifbUa,
          r_series: "E96",
        });
        const expectedV =
          c.vref * (1 + res.results.r_top_ohm / res.results.r_bot_ohm) +
          (c.ifbUa * 1e-6) * res.results.r_top_ohm;
        expect(Math.abs(res.results.v_actual - expectedV) / expectedV).toBeLessThan(0.0001);
        expect(res.results.error_pct).toBeLessThan(0.5);
        expect(res.deratingPass).toBe(true);
      }
    });

    it("Case 4-5: ADC mode checks Thevenin impedance and recommends C_charge_nf when R_th > adc_z_max_kohm", () => {
      const highZ = calculateVoltageDivider({
        mode: "ADC",
        v_in_max: 24.0,
        v_target_or_vref: 3.0,
        adc_z_max_kohm: 2.0,
        r_series: "E96",
      });
      const rTop = highZ.results.r_top_ohm;
      const rBot = highZ.results.r_bot_ohm;
      const expectedRth = (rTop * rBot) / (rTop + rBot);
      expect(Math.abs(highZ.results.r_th_ohm - expectedRth) / expectedRth).toBeLessThan(0.001);
      if (expectedRth > 2000) {
        expect(highZ.results.c_charge_nf).toBeGreaterThanOrEqual(10);
      }

      const lowZ = calculateVoltageDivider({
        mode: "ADC",
        v_in_max: 12.0,
        v_target_or_vref: 3.0,
        adc_z_max_kohm: 50.0,
        r_series: "E96",
      });
      expect(lowZ.results.c_charge_nf).toBeNull();
    });

    it("Case 6-8: HV 310V DC auto-splits R_top into N series 1206 resistors & rejects undersized 0402", () => {
      const hv310 = calculateVoltageDivider({
        mode: "ADC",
        v_in_max: 310.0,
        v_target_or_vref: 2.5,
        r_series: "E96",
      });
      expect(hv310.results.hv_series_split).toBe(true);
      expect(hv310.results.r_top_series_count).toBeGreaterThanOrEqual(3);
      expect(hv310.results.r_top_series_array_ohm.length).toBe(hv310.results.r_top_series_count);
      expect(hv310.results.r_top_package).toBe("1206");
      expect(hv310.results.v_top_each_v).toBeLessThanOrEqual(160);
      expect(hv310.deratingPass).toBe(true);

      const hv400 = calculateVoltageDivider({
        mode: "ADC",
        v_in_max: 450.0,
        v_target_or_vref: 2.5,
        r_series: "E96",
      });
      expect(hv400.results.r_top_series_count).toBeGreaterThanOrEqual(3);
      expect(hv400.results.v_top_each_v).toBeLessThanOrEqual(160);

      const fail0402 = calculateVoltageDivider({
        mode: "ADC",
        v_in_max: 80.0,
        v_target_or_vref: 3.0,
        package: "0402",
      });
      expect(fail0402.deratingPass).toBe(false);
    });
  });

  // --- Calculator 2: ldo_thermal (6 cases) ---
  describe("2. ldo_thermal", () => {
    it("Case 9-11: Fails 12V->3.3V@0.3A and 5V->3.3V@0.5A with FAIL_SWITCH_TO_DCDC", () => {
      const ams1117 = calculateLdoThermal({
        v_in_min: 11.4,
        v_in_max: 12.6,
        v_out: 3.3,
        i_load_avg: 0.35,
        v_dropout: 1.2,
        r_theta_ja: 65,
        t_ambient_c: 45,
        mlcc_stable: false,
      });
      expect(Math.abs(ams1117.results.pd_watts - 3.255) / 3.255).toBeLessThan(0.001);
      expect(Math.abs(ams1117.results.tj_celsius - 256.575) / 256.575).toBeLessThan(0.001);
      expect(ams1117.status).toBe("FAIL_SWITCH_TO_DCDC");
      expect(ams1117.deratingPass).toBe(false);
      expect(ams1117.results.series_esr_required_ohm).toBeCloseTo(0.33, 2);

      const overPower = calculateLdoThermal({
        v_in_min: 4.8,
        v_in_max: 5.2,
        v_out: 3.3,
        i_load_avg: 0.4, // (5.2 - 3.3) * 0.4 = 0.76W > 0.6W
        v_dropout: 0.3,
        r_theta_ja: 60,
        t_ambient_c: 25,
        mlcc_stable: true,
      });
      expect(overPower.results.pd_watts).toBeCloseTo(0.76, 4);
      expect(overPower.status).toBe("FAIL_SWITCH_TO_DCDC");
      expect(overPower.deratingPass).toBe(false);

      const overTj = calculateLdoThermal({
        v_in_min: 4.8,
        v_in_max: 5.0,
        v_out: 3.3,
        i_load_avg: 0.2, // PD = 0.34W <= 0.6W, TJ = 45 + 0.34*200 = 113C > 105C
        v_dropout: 0.25,
        r_theta_ja: 200,
        t_ambient_c: 45,
        mlcc_stable: true,
      });
      expect(overTj.results.tj_celsius).toBeCloseTo(113.0, 3);
      expect(overTj.status).toBe("FAIL_SWITCH_TO_DCDC");
      expect(overTj.deratingPass).toBe(false);
    });

    it("Case 12-14: Passes safe low-noise LDO, detects dropout shortage, and warns on mlcc_stable=false", () => {
      const passLdo = calculateLdoThermal({
        v_in_min: 4.5,
        v_in_max: 5.2,
        v_out: 3.3,
        i_load_avg: 0.1,
        i_q_ma: 0.05,
        v_dropout: 0.25,
        r_theta_ja: 200,
        t_ambient_c: 45,
        mlcc_stable: true,
      });
      const expectedPd = (5.2 - 3.3) * 0.1 + 5.2 * 0.00005;
      expect(Math.abs(passLdo.results.pd_watts - expectedPd) / expectedPd).toBeLessThan(0.001);
      expect(passLdo.deratingPass).toBe(true);
      expect(passLdo.status).toBe("PASS");

      const dropoutFail = calculateLdoThermal({
        v_in_min: 3.6,
        v_in_max: 4.2,
        v_out: 3.3,
        i_load_avg: 0.05,
        v_dropout: 0.5,
        r_theta_ja: 100,
        t_ambient_c: 45,
      });
      expect(dropoutFail.deratingPass).toBe(false);
      expect(dropoutFail.status).toBe("FAIL_DROPOUT_INSUFFICIENT");

      const legacy1117LowLoad = calculateLdoThermal({
        v_in_min: 4.8,
        v_in_max: 5.0,
        v_out: 3.3,
        i_load_avg: 0.1,
        v_dropout: 1.1,
        r_theta_ja: 65,
        t_ambient_c: 45,
        mlcc_stable: false,
      });
      expect(legacy1117LowLoad.deratingPass).toBe(true);
      expect(legacy1117LowLoad.results.series_esr_required_ohm).toBe(0.33);
      expect(legacy1117LowLoad.warnings.some((w) => /ESR/i.test(w))).toBe(true);
    });
  });

  // --- Calculator 3: dcdc_inductor_cap (6 cases) ---
  describe("3. dcdc_inductor_cap", () => {
    it("Case 15-17: Buck 24V->5V@2A, 12V->3.3V@3A with OCP floor, and 20V->3.3V@3A", () => {
      const buck1 = calculateDcdcInductorCap({
        topology: "BUCK",
        v_in_range: [9, 24],
        v_out: 5.0,
        i_out_max: 2.0,
        f_sw_khz: 400,
        ic_ocp_limit_a: 3.5,
      });
      const expectedL1Ideal = (5.0 * (24 - 5.0)) / (24 * 400e3 * (0.3 * 2.0));
      expect(Math.abs(buck1.results.l_ideal_uh - expectedL1Ideal * 1e6) / (expectedL1Ideal * 1e6)).toBeLessThan(0.001);
      expect(buck1.results.i_sat_min).toBeGreaterThanOrEqual(
        Math.max(1.3 * buck1.results.i_peak, 1.1 * 3.5) - 1e-4
      );
      expect(buck1.results.i_cin_rms).toBeGreaterThan(0);

      const buck2 = calculateDcdcInductorCap({
        topology: "BUCK",
        v_in_range: [10, 14],
        v_out: 3.3,
        i_out_max: 3.0,
        f_sw_khz: 500,
        ic_ocp_limit_a: 5.0, // 1.1 * 5.0 = 5.5A dominates 1.3 * Ipeak
      });
      expect(buck2.results.i_sat_min).toBeCloseTo(5.5, 3);
      expect(buck2.deratingPass).toBe(true);

      const buck3 = calculateDcdcInductorCap({
        topology: "BUCK",
        v_in_range: [12, 20],
        v_out: 3.3,
        i_out_max: 3.0,
        f_sw_khz: 500,
      });
      expect(buck3.results.i_cin_rms).toBeGreaterThan(0.9);
      expect(buck3.results.c_out_parallel_count).toBeGreaterThanOrEqual(1);
    });

    it("Case 18-20: Boost 3.7V->12V, X5R 0402 DC-bias retention loss, and under-voltage cap failure", () => {
      const boost = calculateDcdcInductorCap({
        topology: "BOOST",
        v_in_range: [3.2, 4.2],
        v_out: 12.0,
        i_out_max: 0.5,
        f_sw_khz: 600,
        efficiency: 0.88,
      });
      const dMax = 1 - (3.2 * 0.88) / 12.0;
      const iIn = (12.0 * 0.5) / (3.2 * 0.88);
      expect(Math.abs(boost.results.duty_cycle_max - dMax) / dMax).toBeLessThan(0.001);
      expect(Math.abs(boost.results.i_l_avg_a - iIn) / iIn).toBeLessThan(0.001);

      const tinyCap = calculateDcdcInductorCap({
        topology: "BUCK",
        v_in_range: [8, 12],
        v_out: 5.0,
        i_out_max: 2.0,
        f_sw_khz: 400,
        c_out_eff_req_uf: 22,
        cap_dielectric: "X5R",
        cap_package: "0402",
        cap_voltage_rating_v: 6.3,
      });
      expect(tinyCap.deratingPass).toBe(false);
      expect(tinyCap.results.dc_bias_retention_factor).toBeLessThan(0.35);
      expect(tinyCap.results.c_out_nom_req_uf).toBeGreaterThan(60);
    });
  });

  // --- Calculator 4: crystal_load_cap (5 cases) ---
  describe("4. crystal_load_cap", () => {
    it("Case 21-25: Solves C1=C2=2*(CL-Cstray) across 8pF/12pF/20pF/32.768kHz and detects stray>CL", () => {
      const c8 = calculateCrystalLoadCap({ cl_datasheet_pf: 8, freq_mhz: 16, c_pin_pf: 2.0, c_trace_pf: 1.5 });
      expect(c8.results.c_stray_pf).toBeCloseTo(3.5, 4);
      expect(c8.results.c1_c2_ideal_pf).toBeCloseTo(9.0, 4);
      expect(c8.results.c1_c2_standard_pf).toBe(9.1);
      expect(c8.deratingPass).toBe(true);

      const c12 = calculateCrystalLoadCap({ cl_datasheet_pf: 12, freq_mhz: 8, c_pin_pf: 2.0, c_trace_pf: 2.0 });
      expect(c12.results.c1_c2_ideal_pf).toBeCloseTo(16.0, 4);
      expect(c12.results.c1_c2_standard_pf).toBe(15);
      const expectedRext = 1 / (2 * Math.PI * 8e6 * 15e-12);
      expect(Math.abs(c12.results.r_ext_ideal_ohm - expectedRext) / expectedRext).toBeLessThan(0.001);

      const c20 = calculateCrystalLoadCap({ cl_datasheet_pf: 20, freq_mhz: 12, c_pin_pf: 2.0, c_trace_pf: 2.0 });
      expect(c20.results.c1_c2_ideal_pf).toBeCloseTo(32.0, 4);
      expect(c20.results.c1_c2_standard_pf).toBe(33);

      const cRtc = calculateCrystalLoadCap({ cl_datasheet_pf: 12.5, freq_mhz: 0.032768, max_dl_uw: 1.0 });
      expect(cRtc.results.recommend_reserve_r_ext).toBe(true);
      expect(cRtc.results.r_ext_ideal_ohm).toBeGreaterThan(200_000);

      const cFail = calculateCrystalLoadCap({ cl_datasheet_pf: 4, freq_mhz: 24, c_pin_pf: 2.5, c_trace_pf: 2.5 });
      expect(cFail.deratingPass).toBe(false);
    });
  });

  // --- Calculator 5: i2c_pullup (6 cases) ---
  describe("5. i2c_pullup", () => {
    it("Case 26-31: Enforces NXP UM10204 bounds, deducts existing pullups, and flags overcurrent", () => {
      const m100 = calculateI2cPullup({ vdd_v: 3.3, speed_mode: "100k", c_bus_pf: 100 });
      expect(Math.abs(m100.results.rp_min_ohm - 2.9 / 0.003) / (2.9 / 0.003)).toBeLessThan(0.001);
      const expectedRpMax100 = 1000e-9 / (0.8473 * 100e-12);
      expect(Math.abs(m100.results.rp_max_ohm - expectedRpMax100) / expectedRpMax100).toBeLessThan(0.001);
      expect(m100.deratingPass).toBe(true);
      expect(m100.results.recommended_add_ohm!).toBeGreaterThanOrEqual(m100.results.rp_min_ohm);
      expect(m100.results.recommended_add_ohm!).toBeLessThanOrEqual(m100.results.rp_max_ohm);

      const m400 = calculateI2cPullup({ vdd_v: 3.3, speed_mode: "400k", c_bus_pf: 100 });
      expect(m400.deratingPass).toBe(true);
      expect(m400.results.resulting_total_rp_ohm).toBeLessThanOrEqual(m400.results.rp_max_ohm);

      const m1M = calculateI2cPullup({ vdd_v: 3.3, speed_mode: "1M", c_bus_pf: 150 });
      expect(m1M.deratingPass).toBe(true);

      const deduct = calculateI2cPullup({
        vdd_v: 3.3,
        speed_mode: "400k",
        c_bus_pf: 100,
        existing_pullups_kohm: [10],
      });
      expect(deduct.deratingPass).toBe(true);
      expect(deduct.results.resulting_total_rp_ohm).toBeLessThanOrEqual(deduct.results.rp_max_ohm);

      const alreadyOk = calculateI2cPullup({
        vdd_v: 3.3,
        speed_mode: "400k",
        c_bus_pf: 100,
        existing_pullups_kohm: [4.7, 4.7],
      });
      expect(alreadyOk.deratingPass).toBe(true);
      expect(alreadyOk.status).toBe("PASS_EXISTING_SUFFICIENT");

      const overCurrent = calculateI2cPullup({
        vdd_v: 3.3,
        speed_mode: "400k",
        c_bus_pf: 100,
        existing_pullups_kohm: [2.2, 2.2, 4.7], // ~758 Ohm < 967 Ohm
      });
      expect(overCurrent.deratingPass).toBe(false);
      expect(overCurrent.status).toBe("FAIL_OVERCURRENT_VOL_VIOLATION");
    });
  });

  // --- Calculator 6: rc_filter_damping (6 cases) ---
  describe("6. rc_filter_damping", () => {
    it("Case 32-37: Solves LPF, DEBOUNCE, and BEAD_DAMP Q-factor & RC damping patch", () => {
      const lpf1 = calculateRcFilterDamping({ mode: "LPF", r_ohm: 1000, c_nf: 100 });
      const expFc = 1 / (2 * Math.PI * 1000 * 100e-9);
      expect(Math.abs(lpf1.results.fc_hz! - expFc) / expFc).toBeLessThan(0.001);

      const lpf2 = calculateRcFilterDamping({ mode: "LPF", fc_hz: 10_000, c_nf: 10 });
      expect(lpf2.results.r_ohm).toBe(1600);

      const deb = calculateRcFilterDamping({ mode: "DEBOUNCE", debounce_ms: 10 });
      expect(deb.results.tau_ms).toBeCloseTo(10, 1);

      // Bead 1.2uH + 4.7uF with 0.17 Ohm -> Q = 2.97 -> Peak = +9.46 dB
      const beadFail = calculateRcFilterDamping({
        mode: "BEAD_DAMP",
        l_bead_uh: 1.2,
        c_mlcc_uf: 4.7,
        r_dc_bead: 0.15,
        r_esr_cap: 0.02,
      });
      const expectedQ = (1 / 0.17) * Math.sqrt(1.2e-6 / 4.7e-6);
      const expectedPeak = 20 * Math.log10(expectedQ);
      expect(Math.abs(beadFail.results.q_factor! - expectedQ) / expectedQ).toBeLessThan(0.001);
      expect(Math.abs(beadFail.results.peak_gain_db! - expectedPeak) / expectedPeak).toBeLessThan(0.001);
      expect(beadFail.results.needs_damping).toBe(true);
      expect(beadFail.results.c_damp_ideal_uf).toBeCloseTo(18.8, 2);
      expect(beadFail.results.r_damp_ideal_ohm!).toBeCloseTo(Math.sqrt(1.2 / 4.7), 3);
      expect(beadFail.deratingPass).toBe(false);

      const beadPass = calculateRcFilterDamping({
        mode: "BEAD_DAMP",
        l_bead_uh: 1.0,
        c_mlcc_uf: 10.0,
        r_dc_bead: 0.5,
        r_esr_cap: 0.05,
      });
      expect(beadPass.results.q_factor!).toBeLessThan(1.0);
      expect(beadPass.deratingPass).toBe(true);
    });
  });

  // --- Calculator 7: led_optocoupler (5 cases) ---
  describe("7. led_optocoupler", () => {
    it("Case 38-42: Calculates soft LED current, opto 2x CTR margin, and 50% resistor power derating", () => {
      const led33 = calculateLedOptocoupler({
        device_type: "STATUS_LED",
        v_supply: 3.3,
        vf_typ: 2.0,
      });
      expect(led33.results.i_f_target_ma).toBe(2.0);
      expect([620, 680]).toContain(led33.results.r_std_ohm);
      expect(led33.deratingPass).toBe(true);

      const led24 = calculateLedOptocoupler({
        device_type: "STATUS_LED",
        v_supply: 24.0,
        vf_typ: 2.0,
        i_target_ma: 2.0,
      });
      expect(led24.results.r_std_ohm).toBe(11000);
      expect(led24.results.resistor_power_mw).toBeCloseTo((22 * 22) / 11, 2); // 44mW -> exceeds 0402 31.25mW!
      expect(["0603", "0805", "1206"]).toContain(led24.results.recommended_min_package);

      const opto24 = calculateLedOptocoupler({
        device_type: "OPTO",
        v_supply: 24.0,
        vf_typ: 1.2,
        opto_ic_ma: 5.0,
        ctr_min_pct: 50,
      });
      // IF = 2.0 * 5mA / 0.5 = 20mA -> R ~ 1.14k -> ~456mW -> needs 2512
      expect(opto24.results.i_f_target_ma).toBeCloseTo(20, 3);
      expect(opto24.results.recommended_min_package).toBe("2512");

      const optoFail0402 = calculateLedOptocoupler({
        device_type: "OPTO",
        v_supply: 24.0,
        vf_typ: 1.2,
        opto_ic_ma: 2.0,
        ctr_min_pct: 50,
        r_package: "0402",
      });
      expect(optoFail0402.deratingPass).toBe(false);

      const opto5v = calculateLedOptocoupler({
        device_type: "OPTO",
        v_supply: 5.0,
        vf_typ: 1.2,
        opto_ic_ma: 1.0,
        ctr_min_pct: 50,
      });
      expect(opto5v.deratingPass).toBe(true);
    });
  });

  // --- Calculator 8: mosfet_loss_gate (5 cases) ---
  describe("8. mosfet_loss_gate", () => {
    it("Case 43-47: Blocks 3.3V driving 10V MOSFET, computes 1.5x hot Rdson + switching losses, outputs Rg/Rgs", () => {
      const blocked = calculateMosfetLossGate({
        v_bus: 24,
        i_rms: 3,
        i_peak: 4,
        v_drive: 3.3,
        rdson_25c_mohm: 15,
        vgs_spec_min: 10.0,
        qg_nc: 25,
        f_sw_khz: 100,
      });
      expect(blocked.results.gate_drive_ok).toBe(false);
      expect(blocked.deratingPass).toBe(false);
      expect(blocked.status).toBe("FAIL_GATE_DRIVE_INSUFFICIENT");

      const ao3400 = calculateMosfetLossGate({
        v_bus: 12,
        i_rms: 2.0,
        i_peak: 2.5,
        v_drive: 3.3,
        rdson_25c_mohm: 32,
        vgs_spec_min: 2.5,
        qg_nc: 6,
        f_sw_khz: 50,
        t_rise_ns: 20,
        t_fall_ns: 20,
      });
      expect(ao3400.results.gate_drive_ok).toBe(true);
      const expCond = 2.0 * 2.0 * (0.032 * 1.5);
      const expSw = 0.5 * 12 * 2.5 * 40e-9 * 50e3;
      expect(Math.abs(ao3400.results.p_conduction_w - expCond) / expCond).toBeLessThan(0.0001);
      expect(Math.abs(ao3400.results.p_switching_w - expSw) / expSw).toBeLessThan(0.0001);
      expect(ao3400.results.rg_recommended_ohm).toBeGreaterThanOrEqual(2.2);
      expect(ao3400.results.rg_recommended_ohm).toBeLessThanOrEqual(22);
      expect(ao3400.results.rgs_bleeder_kohm).toBeGreaterThanOrEqual(10);
      expect(ao3400.results.rgs_bleeder_kohm).toBeLessThanOrEqual(47);
      expect(ao3400.deratingPass).toBe(true);

      const thermalOver = calculateMosfetLossGate({
        v_bus: 48,
        i_rms: 10,
        i_peak: 15,
        v_drive: 10,
        rdson_25c_mohm: 40,
        vgs_spec_min: 10,
        qg_nc: 30,
        f_sw_khz: 100,
        r_theta_ja: 60,
        t_ambient_c: 45,
      });
      expect(thermalOver.deratingPass).toBe(false);
    });
  });

  // --- Calculator 9: trace_current_irdrop (7 cases) ---
  describe("9. trace_current_irdrop", () => {
    it("Case 48-54: Exact IPC-2221, Sheet Resistance IR Drop, Table 9-4 Vias, and Table 9-1 Clearances", () => {
      // Exact doc benchmark: 5V / 3A / 80mm / 1oz / EXT / dT=10C / 2% drop
      const docCase = calculateTraceCurrentIrdrop({
        voltage_v: 5.0,
        current_a: 3.0,
        length_mm: 80.0,
        copper_oz: 1,
        layer: "EXT",
        max_dt_c: 10,
        max_drop_pct: 2.0,
        return_path: "SOLID_GND_PLANE",
      });
      expect(docCase.results.w_thermal_ipc2221_mm).toBeCloseTo(1.3673, 2);
      expect(docCase.results.w_irdrop_limit_mm).toBeCloseTo(1.20, 3);
      expect(docCase.results.recommended_trace_width_mm).toBeGreaterThanOrEqual(1.4);
      expect(docCase.results.via_stitching_for_layer_change.min_parallel_vias).toBe(5);
      expect(docCase.results.min_clearance_surface_mm).toBe(0.15);

      // IR-drop governed case: 3.3V / 1.5A / 150mm / 1oz / 2% (66mV limit)
      const irCase = calculateTraceCurrentIrdrop({
        voltage_v: 3.3,
        current_a: 1.5,
        length_mm: 150.0,
        copper_oz: 1,
        layer: "EXT",
        max_dt_c: 10,
        max_drop_pct: 2.0,
      });
      expect(irCase.results.governing_constraint).toContain("IR_DROP");
      expect(irCase.results.w_irdrop_limit_mm).toBeCloseTo((1.5 * 0.0005 * 150) / 0.066, 3);

      // 2oz copper cuts width ~in half
      const twoOz = calculateTraceCurrentIrdrop({
        voltage_v: 5.0,
        current_a: 3.0,
        length_mm: 80.0,
        copper_oz: 2,
      });
      expect(twoOz.results.w_irdrop_limit_mm).toBeCloseTo(0.60, 3);
      expect(twoOz.results.w_thermal_ipc2221_mm).toBeCloseTo(docCase.results.w_thermal_ipc2221_mm / 2, 2);

      // Internal layer k=0.024
      const intLayer = calculateTraceCurrentIrdrop({
        voltage_v: 12.0,
        current_a: 2.0,
        length_mm: 40.0,
        layer: "INT",
      });
      expect(intLayer.results.w_thermal_ipc2221_mm).toBeCloseTo(2.03, 1);

      // TRACE_RETURN doubles IR drop
      const traceRet = calculateTraceCurrentIrdrop({
        voltage_v: 5.0,
        current_a: 3.0,
        length_mm: 80.0,
        return_path: "TRACE_RETURN",
      });
      expect(traceRet.results.w_irdrop_limit_mm).toBeCloseTo(2.40, 3);

      // 220V AC (311V peak) safety clearance & creepage
      const hvAc = calculateTraceCurrentIrdrop({
        voltage_v: 310.0,
        power_w: 100.0,
        length_mm: 30.0,
      });
      expect(hvAc.results.min_clearance_surface_mm).toBe(3.0);
      expect(hvAc.results.reinforced_pri_sec_clearance_mm).toBe(5.0);
      expect(hvAc.results.reinforced_pri_sec_creepage_mm).toBe(6.4);

      // 0.4mm via drill for 5A
      const via04 = calculateTraceCurrentIrdrop({
        voltage_v: 24.0,
        current_a: 5.0,
        length_mm: 20.0,
        via_drill_mm: 0.4,
      });
      expect(via04.results.via_stitching_for_layer_change.min_parallel_vias).toBe(5);
      expect(via04.results.via_stitching_for_layer_change.min_parallel_vias_with_redundancy).toBe(6);
    });
  });
});

// ============================================================================
// 3. LCSC Datasheet Binder, Ajv Schema, PNG Layout Example & PDF Extraction
// ============================================================================

describe("lcsc-datasheet-binder", () => {
  it("validates all golden CESMs against cesm-v1.schema.json and persists in node:sqlite", () => {
    const tmpDir = makeTempDir("cesm-sqlite-");
    const dbPath = join(tmpDir, "cesm_test.sqlite");
    const imgDir = join(tmpDir, "imgs");
    const binder = new CesmBinder({ sqlitePath: dbPath, layoutImageDir: imgDir });

    const parts = binder.searchParts("", 100);
    expect(parts.length).toBeGreaterThanOrEqual(25);
    for (const part of parts) {
      const check = validateCesmSchema(part);
      expect(check.valid, `Schema error for ${part.lcsc_id}: ${check.errors.join(", ")}`).toBe(true);
    }

    // Verify TPS54302 C96581 rich layoutExample & generated PNG
    const buck = binder.lookupCachedCesm("C96581")!;
    expect(buck).toBeDefined();
    expect(buck.layoutExample?.copperZones?.length).toBeGreaterThanOrEqual(4);
    expect(buck.layoutExample?.thermalViaArray?.gridRows).toBe(3);
    expect(buck.layoutExample?.thermalViaArray?.gridCols).toBe(3);
    expect(buck.layoutExample?.sensitiveRouteConstraints?.[0].tapPointRule).toBe("AFTER_LAST_COUT_PAD");
    expect(buck.layoutExample?.referenceImageUri).toBeDefined();
    expect(existsSync(buck.layoutExample!.referenceImageUri!)).toBe(true);

    const pngBuf = readFileSync(buck.layoutExample!.referenceImageUri!);
    const decoded = PNG.sync.read(pngBuf);
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(480);

    // Reject invalid CESM
    const badCheck = validateCesmSchema({ lcsc_id: "BAD_CODE", mpn: "X" });
    expect(badCheck.valid).toBe(false);
    expect(() => binder.bindCesm({ lcsc_id: "BAD" } as any)).toThrow(/schema/i);

    binder.close();
  });

  it("manages in-memory session binding pool (bindCesm / isCesmBound / getBoundCesm)", () => {
    clearSessionBindings();
    expect(isCesmBound("C2040")).toBe(false);
    const binder = new CesmBinder({ sqlitePath: ":memory:", layoutImageDir: makeTempDir("img-") });
    const stm32 = binder.lookupCachedCesm("C2040")!;
    bindCesm(stm32, false);
    expect(isCesmBound("C2040")).toBe(true);
    expect(getBoundCesm("C2040")?.mpn).toBe("STM32F103C8T6");
    clearSessionBindings();
    binder.close();
  });

  it("parses real PDF Buffer via unpdf and extracts AbsMax, Thermal, Layout Guidelines & Example", async () => {
    const pdfBuf = buildMinimalPdfBuffer([
      "TPS54302DDCR 28V 3A Synchronous Buck Converter",
      "Absolute Maximum Ratings",
      "Input Voltage VIN -0.3 to 30 V",
      "TJ(max) = 150 C",
      "Thermal Information: RthetaJA = 45 C/W",
      "10.1 Layout Guidelines",
      "- Place high frequency CIN capacitor directly between VIN and GND pins",
      "- Keep SW copper compact and forbid blind vias in hot loop",
      "10.2 Layout Example (Figure 67)",
      "Use 3x3 thermal via array under EPAD connected to Topside Ground Area",
      "Route FB trace away from SW island and power inductor",
    ]);

    const parsed = await parseDatasheetPdfBuffer(pdfBuf, "C96581");
    expect(parsed.vAbsMaxV).toBe(30);
    expect(parsed.tjMaxC).toBe(150);
    expect(parsed.rThetaJaCPerW).toBe(45);
    expect(parsed.layoutGuidelines.length).toBeGreaterThanOrEqual(2);
    expect(parsed.layoutExample?.sourceSectionTitle).toContain("Layout Example");
    expect(parsed.layoutExample?.thermalViaArray?.gridRows).toBe(3);
    expect(parsed.layoutExample?.thermalViaArray?.gridCols).toBe(3);

    const tmpDir = makeTempDir("cesm-pdf-");
    const binder = new CesmBinder({
      sqlitePath: join(tmpDir, "cesm.sqlite"),
      layoutImageDir: join(tmpDir, "imgs"),
      preloadGolden: false,
    });
    const extracted = await binder.extractAndBind({
      lcscCode: "C999999",
      pdfBuffer: pdfBuf,
      bindCesmToSession: true,
      overrides: { mpn: "CUSTOM_BUCK_IC", category: "PMIC_DCDC", package: "HSOP-8-EP" },
    });
    expect(extracted.verified).toBe(true);
    expect(extracted.cesm.ratings.v_working_max).toBe(30);
    expect(extracted.cesm.ratings.tj_max_c).toBe(150);
    expect(binder.isCesmBound("C999999")).toBe(true);
    binder.close();
  });
});

// ============================================================================
// 4. All 9 Standard Reference Blocks & Anti-4-Way-Junction Instantiator
// ============================================================================

describe("9 standard reference blocks & block-instantiator", () => {
  it("instantiates all 9 blocks with 0 four-way cross junctions and >=2.54mm T-stagger", () => {
    expect(BLOCK_TEMPLATE_IDS).toHaveLength(9);
    for (const templateId of BLOCK_TEMPLATE_IDS) {
      const result = instantiateBlock({
        blockTemplateId: templateId,
        originMm: [100, 100],
      });
      expect(result.placedComponents.length).toBeGreaterThanOrEqual(2);
      expect(result.wires.length).toBeGreaterThanOrEqual(2);
      expect(result.fourWayJunctionCount).toBe(0);
      if (result.minJunctionSpacingMm !== null) {
        expect(result.minJunctionSpacingMm).toBeGreaterThanOrEqual(2.54 - 1e-4);
      }
      const check = verifyNoFourWayJunctions(result.wires, result.junctions);
      expect(check.fourWayJunctionCount).toBe(0);
    }
  });

  it("enforces anti-pitfall rules on Type-C, Reverse PMOS, LDO thermal, XTAL, and Bob-Smith", () => {
    // 1. Type-C dual independent 5.1k resistors
    const typeC = instantiateBlock({
      blockTemplateId: "BLK_USB_TYPEC_UFP_5V",
      originMm: [50, 50],
    });
    const rcc1 = typeC.placedComponents.find((c) => c.refRole === "R_CC1");
    const rcc2 = typeC.placedComponents.find((c) => c.refRole === "R_CC2");
    expect(rcc1?.value).toBe("5.1kΩ");
    expect(rcc2?.value).toBe("5.1kΩ");
    expect(typeC.wires.some((w) => w.netName.includes("USB_CC1"))).toBe(true);
    expect(typeC.wires.some((w) => w.netName.includes("USB_CC2"))).toBe(true);

    // 2. Reverse PMOS >12V automatically adds 12V Zener, <=12V omits it
    const pmos24 = instantiateBlock({
      blockTemplateId: "BLK_PWR_REVERSE_PMOS",
      originMm: [50, 50],
      parameters: { v_in_max: 24 },
    });
    expect(pmos24.placedComponents.some((c) => c.refRole === "D_ZENER_GS")).toBe(true);

    const pmos5 = instantiateBlock({
      blockTemplateId: "BLK_PWR_REVERSE_PMOS",
      originMm: [50, 50],
      parameters: { v_in_max: 5 },
    });
    expect(pmos5.placedComponents.some((c) => c.refRole === "D_ZENER_GS")).toBe(false);

    // 3. LDO Thermal overload detection
    const ldoHot = instantiateBlock({
      blockTemplateId: "BLK_LDO_LOWNOISE",
      originMm: [50, 50],
      parameters: { v_in_min: 11.5, v_in_max: 12.5, v_out: 3.3, i_load_avg: 0.4 },
    });
    expect(ldoHot.calcReport.ldo_thermal.status).toBe("FAIL_SWITCH_TO_DCDC");
    expect(ldoHot.calcReport.ldo_thermal.deratingPass).toBe(false);

    // 4. XTAL dynamic C0G capacitance
    const xtal = instantiateBlock({
      blockTemplateId: "BLK_XTAL_PASSIVE",
      originMm: [50, 50],
      parameters: { cl_datasheet_pf: 8, freq_mhz: 16, c_pin_pf: 2, c_trace_pf: 1.5 },
    });
    expect(xtal.calcReport.crystal_load_cap.results.c1_c2_standard_pf).toBe(9.1);
    expect(xtal.placedComponents.find((c) => c.refRole === "C_LOAD_1")?.value).toContain("9.1pF");

    // 5. Bob-Smith 75 Ohm x 4 + 1nF/2kV -> PGND
    const eth = instantiateBlock({
      blockTemplateId: "BLK_ETH_RJ45_BOBSMITH",
      originMm: [50, 50],
    });
    const bsRes = eth.placedComponents.filter((c) => c.refRole.startsWith("R_BS_"));
    expect(bsRes).toHaveLength(4);
    expect(eth.placedComponents.find((c) => c.refRole === "C_BS_HV")?.value).toBe("1nF/2kV");

    // 6. Buck Sync dynamic inductor + FB divider + bias-compensated COUT
    const buck = instantiateBlock({
      blockTemplateId: "BLK_DCDC_BUCK_SYNC",
      originMm: [20, 20],
      parameters: { v_in_range: [12, 24], v_out: 3.3, i_out_max: 2.0, f_sw_khz: 500, v_ref: 0.596 },
    });
    expect(buck.calcReport.dcdc_inductor_cap.deratingPass).toBe(true);
    expect(buck.calcReport.voltage_divider.results.v_actual).toBeCloseTo(3.3, 1);
    expect(buck.fourWayJunctionCount).toBe(0);

    // 7. RS485 isolated vs non-isolated & Relay DC/AC conditional components
    const rs485NonIso = instantiateBlock({
      blockTemplateId: "BLK_BUS_RS485_CAN",
      originMm: [10, 10],
      parameters: { isolated: false, is_end_node: false },
    });
    expect(rs485NonIso.placedComponents.some((c) => c.refRole === "U_ISO")).toBe(false);
    expect(rs485NonIso.placedComponents.some((c) => c.refRole === "R_TERM")).toBe(false);
    expect(rs485NonIso.fourWayJunctionCount).toBe(0);

    const relayDc = instantiateBlock({
      blockTemplateId: "BLK_IND_RELAY_DRIVE",
      originMm: [10, 10],
      parameters: { coil_voltage_v: 12, v_drive: 3.3, load_type: "DC" },
    });
    expect(relayDc.calcReport.mosfet_loss_gate.results.gate_drive_ok).toBe(true);
    expect(relayDc.placedComponents.some((c) => c.refRole === "D_FLYBACK")).toBe(true);
    expect(relayDc.placedComponents.some((c) => c.refRole === "RV_MOV")).toBe(false);
  });

  it("explicitly detects synthetic 4-way cross junctions in verifyNoFourWayJunctions", () => {
    const check = verifyNoFourWayJunctions(
      [
        { id: "w1", netName: "GND", startMm: [0, 10], endMm: [20, 10] },
        { id: "w2", netName: "GND", startMm: [10, 0], endMm: [10, 20] },
      ],
      []
    );
    expect(check.fourWayJunctionCount).toBe(1);
    expect(check.invalidJunctions[0].degree).toBe(4);
  });
});

// ============================================================================
// 5. Headless SPICE MNA Engine (.OP / .AC / .TRAN & Bead+MLCC Resonance)
// ============================================================================

describe("ngspice-runner MNA physical kernel", () => {
  it("solves .OP DC voltage divider operating point to <0.01% error", async () => {
    const netlist = [
      "* DC Divider",
      "V1 IN 0 DC 10",
      "R1 IN OUT 3k",
      "R2 OUT 0 2k",
      ".end",
    ].join("\n");

    const res = await runSpiceSimulation({
      spiceNetlist: netlist,
      analysisSuite: [
        { type: "OP", params: { probe_net: "OUT" }, assertions: ["V(OUT) >= 3.99", "V(OUT) <= 4.01"] },
      ],
    });
    expect(res.converged).toBe(true);
    expect(res.simulationPassed).toBe(true);
    expect(res.metrics.op_out_v).toBeCloseTo(4.0, 5);
  });

  it("detects +9.4dB underdamped Bead+MLCC LC resonance peak in .AC and passes after adding RC damping", async () => {
    // 1.2uH bead (Rdc=0.15) + 4.7uF MLCC (ESR=0.02) => Z0=sqrt(1.2/4.7)=0.5053 Ohm, R=0.17 => Q=2.97 => +9.46 dB
    const underdampedNetlist = [
      "* Underdamped Ferrite Bead + MLCC Filter",
      "V_SRC 3V3_DIG 0 DC 3.3 AC 1",
      "L_FB1 3V3_DIG VDDA_3V3 1.2u Rser=0.15",
      "C_MLCC VDDA_3V3 0 4.7u Rser=0.02",
      ".end",
    ].join("\n");

    const failRes = await runSpiceSimulation({
      spiceNetlist: underdampedNetlist,
      analysisSuite: [
        {
          type: "AC",
          params: { source_net: "3V3_DIG", probe_net: "VDDA_3V3", f_start_hz: 100, f_stop_hz: 100_000_000 },
          assertions: ["MAX_GAIN_DB <= 1.0", "ATTENUATION_AT_100MHZ_DB <= -35.0"],
        },
        {
          type: "TRAN",
          params: { probe_net: "VDDA_3V3", step_load_current_ma: { from: 5, to: 80, tr_ns: 100 }, t_stop_us: 200 },
          assertions: ["V_DROOP_MAX_MV <= 60.0", "RINGING_CYCLES <= 2"],
        },
      ],
    });

    expect(failRes.converged).toBe(true);
    expect(failRes.simulationPassed).toBe(false);
    expect(Number(failRes.metrics.ac_peak_gain_db)).toBeGreaterThan(9.0);
    expect(Number(failRes.metrics.ac_peak_gain_db)).toBeLessThan(10.0);
    expect(failRes.failedAssertions.some((f) => f.assertion.includes("MAX_GAIN_DB"))).toBe(true);
    expect(failRes.failedAssertions[0].prescribed_action).toContain("rc_filter_damping");

    // Apply damping patch from rc_filter_damping: Cdamp = 22uF, Rdamp = 0.51 Ohm
    const dampedNetlist = [
      "* Damped Ferrite Bead + MLCC Filter",
      "V_SRC 3V3_DIG 0 DC 3.3 AC 1",
      "L_FB1 3V3_DIG VDDA_3V3 1.2u Rser=0.15",
      "C_MLCC VDDA_3V3 0 4.7u Rser=0.02",
      "R_DAMP1 VDDA_3V3 N_DAMP 0.51",
      "C_DAMP1 N_DAMP 0 22u Rser=0.01",
      ".end",
    ].join("\n");

    const passRes = await runSpiceSimulation({
      spiceNetlist: dampedNetlist,
      analysisSuite: [
        {
          type: "AC",
          params: { source_net: "3V3_DIG", probe_net: "VDDA_3V3", f_start_hz: 100, f_stop_hz: 100_000_000 },
          assertions: ["MAX_GAIN_DB <= 1.0", "ATTENUATION_AT_100MHZ_DB <= -35.0"],
        },
        {
          type: "TRAN",
          params: { probe_net: "VDDA_3V3", step_load_current_ma: { from: 5, to: 80, tr_ns: 100 }, t_stop_us: 200 },
          assertions: ["V_DROOP_MAX_MV <= 60.0", "RINGING_CYCLES <= 2"],
        },
      ],
    });

    expect(passRes.converged).toBe(true);
    expect(Number(passRes.metrics.ac_peak_gain_db)).toBeLessThanOrEqual(1.0);
    expect(Number(passRes.metrics.ac_atten_100mhz_db)).toBeLessThanOrEqual(-35.0);
    expect(Number(passRes.metrics.tran_max_droop_mv)).toBeLessThanOrEqual(60.0);
    expect(Number(passRes.metrics.tran_ringing_cycles)).toBeLessThanOrEqual(2);
    expect(passRes.simulationPassed).toBe(true);
    expect(passRes.failedAssertions).toHaveLength(0);
  });

  it("synthesizes subcircuit netlist from component list when raw spiceNetlist is omitted", async () => {
    const res = await runSpiceSimulation({
      subcircuitNets: ["3V3_DIG", "VDDA_3V3", "GND"],
      components: ["FB1", "C12"],
      analysisSuite: [
        {
          type: "AC",
          params: { source_net: "3V3_DIG", probe_net: "VDDA_3V3", f_start_hz: 100, f_stop_hz: 100_000_000 },
          assertions: ["MAX_GAIN_DB <= 1.0"],
        },
      ],
    });
    expect(res.converged).toBe(true);
    expect(res.simulationPassed).toBe(false);
    expect(Number(res.metrics.ac_peak_gain_db)).toBeGreaterThan(9.0);

    const fixed = await runSpiceSimulation({
      subcircuitNets: ["3V3_DIG", "VDDA_3V3", "GND"],
      components: ["FB1", "C12", "R_DAMP1", "C_DAMP1"],
      analysisSuite: [
        {
          type: "AC",
          params: { source_net: "3V3_DIG", probe_net: "VDDA_3V3", f_start_hz: 100, f_stop_hz: 100_000_000 },
          assertions: ["MAX_GAIN_DB <= 1.0"],
        },
      ],
    });
    expect(fixed.simulationPassed).toBe(true);
  });
});

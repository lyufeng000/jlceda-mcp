import type { ElecCalcResult, ElecCalculatorName } from "../../types/index.js";
import {
  type CrystalLoadCapInputs,
  calculateCrystalLoadCap,
} from "./crystal-load-cap.js";
import {
  type DcdcInductorCapInputs,
  calculateDcdcInductorCap,
} from "./dcdc-inductor-cap.js";
import { type I2cPullupInputs, calculateI2cPullup } from "./i2c-pullup.js";
import { type LdoThermalInputs, calculateLdoThermal } from "./ldo-thermal.js";
import {
  type LedOptocouplerInputs,
  calculateLedOptocoupler,
} from "./led-optocoupler.js";
import {
  type MosfetLossGateInputs,
  calculateMosfetLossGate,
} from "./mosfet-loss-gate.js";
import {
  type RcFilterDampingInputs,
  calculateRcFilterDamping,
} from "./rc-filter-damping.js";
import {
  type TraceCurrentIrdropInputs,
  calculateTraceCurrentIrdrop,
} from "./trace-current-irdrop.js";
import {
  type VoltageDividerInputs,
  calculateVoltageDivider,
} from "./voltage-divider.js";

export * from "./voltage-divider.js";
export * from "./ldo-thermal.js";
export * from "./dcdc-inductor-cap.js";
export * from "./crystal-load-cap.js";
export * from "./i2c-pullup.js";
export * from "./rc-filter-damping.js";
export * from "./led-optocoupler.js";
export * from "./mosfet-loss-gate.js";
export * from "./trace-current-irdrop.js";

/**
 * Unified dispatcher for `jlc_elec_calc`.
 */
export function runElecCalculator(
  calculator: ElecCalculatorName,
  inputs: Record<string, unknown>
): ElecCalcResult<any> {
  switch (calculator) {
    case "voltage_divider":
      return calculateVoltageDivider(inputs as unknown as VoltageDividerInputs);
    case "ldo_thermal":
      return calculateLdoThermal(inputs as unknown as LdoThermalInputs);
    case "dcdc_inductor_cap":
      return calculateDcdcInductorCap(inputs as unknown as DcdcInductorCapInputs);
    case "crystal_load_cap":
      return calculateCrystalLoadCap(inputs as unknown as CrystalLoadCapInputs);
    case "i2c_pullup":
      return calculateI2cPullup(inputs as unknown as I2cPullupInputs);
    case "rc_filter_damping":
      return calculateRcFilterDamping(inputs as unknown as RcFilterDampingInputs);
    case "led_optocoupler":
      return calculateLedOptocoupler(inputs as unknown as LedOptocouplerInputs);
    case "mosfet_loss_gate":
      return calculateMosfetLossGate(inputs as unknown as MosfetLossGateInputs);
    case "trace_current_irdrop":
      return calculateTraceCurrentIrdrop(inputs as unknown as TraceCurrentIrdropInputs);
    default: {
      const exhaustive: never = calculator;
      throw new Error(`Unsupported electrical calculator: ${String(exhaustive)}`);
    }
  }
}

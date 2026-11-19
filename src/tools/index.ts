import {
  JLC_TOOL_NAMES,
  type JlcToolName,
  type McpToolHandler,
} from "../types/index.js";
import { LAYER1_TOOLS } from "./layer1-session-doc.js";
import { LAYER2_TOOLS } from "./layer2-reflection.js";
import { LAYER3_TOOLS } from "./layer3-lib-calc.js";
import { LAYER4_TOOLS } from "./layer4-schematic-spice.js";
import { LAYER5_TOOLS } from "./layer5-pcb-layout-route.js";
import { LAYER6_TOOLS } from "./layer6-audit-vision.js";

export * from "./state.js";
export * from "./layer1-session-doc.js";
export * from "./layer2-reflection.js";
export * from "./layer3-lib-calc.js";
export * from "./layer4-schematic-spice.js";
export * from "./layer5-pcb-layout-route.js";
export * from "./layer6-audit-vision.js";

export const ALL_JLC_TOOLS: readonly McpToolHandler[] = [
  ...LAYER1_TOOLS,
  ...LAYER2_TOOLS,
  ...LAYER3_TOOLS,
  ...LAYER4_TOOLS,
  ...LAYER5_TOOLS,
  ...LAYER6_TOOLS,
];

export const TOOL_HANDLER_MAP: ReadonlyMap<JlcToolName, McpToolHandler> = new Map(
  ALL_JLC_TOOLS.map((t) => [t.name, t])
);

// Strict compile-time & startup invariant assertion: all registered tools must match JLC_TOOL_NAMES.all
(function assertToolRegistryAlignment(): void {
  const registeredNames = ALL_JLC_TOOLS.map((t) => t.name);
  const expectedNames = [...JLC_TOOL_NAMES.all];
  if (registeredNames.length !== expectedNames.length) {
    throw new Error(
      `Tool count mismatch: registered ${registeredNames.length}, expected ${expectedNames.length}`
    );
  }
  const missing = expectedNames.filter((n) => !TOOL_HANDLER_MAP.has(n));
  const extra = registeredNames.filter((n) => !(expectedNames as string[]).includes(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Tool registry mismatch! Missing=[${missing.join(", ")}] Extra=[${extra.join(", ")}]`
    );
  }
})();

export function getToolHandler(name: string): McpToolHandler | undefined {
  return TOOL_HANDLER_MAP.get(name as JlcToolName);
}

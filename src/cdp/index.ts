import type { ICdpSessionManager } from "../types/index.js";
import {
  CdpTargetRouter,
  type CdpSessionManagerOptions,
} from "./target-router.js";

export * from "./win32-window-scanner.js";
export * from "./unit-converter.js";
export * from "./handle-pool.js";
export * from "./transaction-guard.js";
export * from "./rpc-executor.js";
export * from "./target-router.js";
export * from "./view-capture-hud.js";

/**
 * Create a zero-bridge CDP session manager implementing `ICdpSessionManager`
 * (backed by `CdpTargetRouter` and `CdpRpcExecutor` implementing `ICdpRpcExecutor`).
 */
export function createCdpSessionManager(
  options: CdpSessionManagerOptions = {}
): ICdpSessionManager {
  return new CdpTargetRouter(options);
}

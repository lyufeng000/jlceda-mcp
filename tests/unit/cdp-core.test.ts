import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { WebSocketServer, type WebSocket } from "ws";
import type { CdpProcessInfo } from "../../src/types/index.js";
import {
  ARRAY_PAGINATION_THRESHOLD,
  CdpRpcExecutor,
  CdpTransactionError,
  FORBIDDEN_LCEDA_FLAGS,
  HandlePool,
  MIL_PER_MM,
  buildHudSvgMarkup,
  buildLcedaLaunchArgs,
  captureViewWithHud,
  composeSideBySideComparisonPng,
  convertParamsToNative,
  convertResultFromNative,
  decodeAndVerifyPersistentReference,
  degToRad,
  extractCdpPortFromCommandLine,
  extractUserDataDirFromCommandLine,
  milToMm,
  mmToMil,
  mmToSch10Mil,
  radToDeg,
  resolveSpecialTokens,
  scanLcedaWin32State,
  sch10MilToMm,
  CdpTargetRouter,
  type LayerVisibilityEntry,
  type RawCdpTarget,
  type Win32ScanSnapshot,
} from "../../src/cdp/index.js";

// ============================================================================
// Local Mock CDP HTTP + WebSocket Server Harness
// ============================================================================

interface MockTargetState {
  id: string;
  type: string;
  title: string;
  url: string;
  docType: "SCH" | "PCB" | "SYMBOL" | "FOOTPRINT" | "PANEL" | "HOME" | "UNKNOWN";
  docUuid: string | null;
  projectUuid: string | null;
  projectName: string | null;
  primitiveCount: number;
  isActive: boolean;
  isUnactivated?: boolean;
  activeInteractiveTool: string | null;
  domModals?: Array<{
    source: "dom";
    title: string;
    textSummary: string;
    buttons?: string[];
  }>;
  progressBar?: { visible: boolean; percent: number | null; label: string } | null;
  primitives: Array<{ id: string; xMil: number; yMil: number; layer: number }>;
  checkpoints: Map<string, Array<{ id: string; xMil: number; yMil: number; layer: number }>>;
  layers: LayerVisibilityEntry[];
  hudInjected: boolean;
  hangMode?: "none" | "async_hang" | "sync_freeze";
  screenshotPngBase64?: string;
}

class MockCdpInstanceServer {
  public port = 0;
  public readonly pid: number;
  public readonly browserId = "mock-browser-001";
  public readonly targets = new Map<string, MockTargetState>();
  public readonly receivedCommands: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  public browserClosed = false;
  public terminateExecutionCount = 0;

  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private readonly openSockets = new Set<WebSocket>();
  private frozenSockets = new Map<string, () => void>();
  private sessionSeq = 0;

  constructor(pid: number, initialTargets: MockTargetState[] = []) {
    this.pid = pid;
    for (const t of initialTargets) {
      this.targets.set(t.id, t);
    }
  }

  public async start(): Promise<number> {
    this.httpServer = http.createServer((req, res) => {
      const urlPath = req.url ?? "/";
      res.setHeader("Content-Type", "application/json");
      if (urlPath === "/json/version") {
        res.end(
          JSON.stringify({
            Browser: "Chrome/128.0.0.0 Electron/32.0.0 JLCEDA/4.1.105",
            "Protocol-Version": "1.3",
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/${this.browserId}`,
          })
        );
        return;
      }
      if (urlPath === "/json/list" || urlPath === "/json") {
        const list: RawCdpTarget[] = Array.from(this.targets.values()).map((t) => ({
          id: t.id,
          type: t.type,
          title: t.title,
          url: t.url,
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/${t.id}`,
        }));
        res.end(JSON.stringify(list));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => {
      this.openSockets.add(ws);
      ws.on("close", () => this.openSockets.delete(ws));

      const reqUrl = req.url ?? "";
      const pageMatch = reqUrl.match(/\/devtools\/page\/([^/?]+)/);
      const defaultTargetId = pageMatch?.[1];
      const sessionToTarget = new Map<string, string>();

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };

        this.receivedCommands.push({
          method: msg.method,
          params: msg.params ?? {},
          sessionId: msg.sessionId,
        });

        const resolveTarget = (): MockTargetState | undefined => {
          if (msg.sessionId && sessionToTarget.has(msg.sessionId)) {
            return this.targets.get(sessionToTarget.get(msg.sessionId)!);
          }
          if (defaultTargetId) {
            return this.targets.get(defaultTargetId);
          }
          return Array.from(this.targets.values())[0];
        };

        const sendReply = (result: unknown, sessionId = msg.sessionId): void => {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                ...(sessionId ? { sessionId } : {}),
                result,
              })
            );
          }
        };

        const sendEvent = (
          method: string,
          params: Record<string, unknown>,
          sessionId = msg.sessionId
        ): void => {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
              })
            );
          }
        };

        // Handle Browser / Target / Runtime / Page commands
        if (msg.method === "Browser.close") {
          this.browserClosed = true;
          sendReply({});
          setTimeout(() => {
            void this.stop();
          }, 20);
          return;
        }

        if (msg.method === "Target.attachToTarget") {
          const targetId = String(msg.params?.targetId ?? "");
          if (!this.targets.has(targetId)) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                error: { code: -32000, message: `Target '${targetId}' not found` },
              })
            );
            return;
          }
          const newSessionId = `sess_${++this.sessionSeq}_${targetId}`;
          sessionToTarget.set(newSessionId, targetId);
          sendReply({ sessionId: newSessionId });
          return;
        }

        if (msg.method === "Target.activateTarget") {
          sendReply({});
          return;
        }

        if (msg.method === "Runtime.enable") {
          sendReply({});
          sendEvent("Runtime.executionContextCreated", {
            context: {
              id: 1,
              origin: "https://pro.lceda.cn",
              name: "",
              auxData: { isDefault: true, type: "default" },
            },
          });
          return;
        }

        if (msg.method === "Page.enable" || msg.method === "Runtime.releaseObjectGroup") {
          sendReply({});
          return;
        }

        if (msg.method === "Runtime.terminateExecution") {
          this.terminateExecutionCount++;
          const target = resolveTarget();
          if (target) {
            target.hangMode = "none";
          }
          const key = msg.sessionId ?? defaultTargetId ?? "__root__";
          const unblock = this.frozenSockets.get(key);
          if (unblock) {
            this.frozenSockets.delete(key);
            unblock();
          }
          sendReply({});
          return;
        }

        if (msg.method === "Runtime.evaluate") {
          const expr = String(msg.params?.expression ?? "");
          if (expr === "globalThis") {
            sendReply({
              result: {
                type: "object",
                className: "Window",
                objectId: "obj_global_1",
              },
            });
            return;
          }
          sendReply({ result: { type: "undefined" } });
          return;
        }

        if (msg.method === "Page.captureScreenshot") {
          const target = resolveTarget();
          const b64 =
            target?.screenshotPngBase64 ??
            createSolidPatternPng(64, 48, [10, 20, 30, 255]).toString("base64");
          sendReply({ data: b64 });
          return;
        }

        if (msg.method === "Runtime.callFunctionOn") {
          const target = resolveTarget();
          if (!target) {
            sendReply({
              result: { type: "undefined" },
              exceptionDetails: { text: "Target missing" },
            });
            return;
          }
          void this.handleCallFunctionOn(
            target,
            msg,
            sendReply,
            defaultTargetId
          );
          return;
        }

        sendReply({});
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer!.address() as AddressInfo;
        this.port = addr.port;
        resolve();
      });
    });
    return this.port;
  }

  private async handleCallFunctionOn(
    target: MockTargetState,
    msg: {
      id: number;
      params?: Record<string, unknown>;
      sessionId?: string;
    },
    sendReply: (result: unknown) => void,
    defaultTargetId?: string
  ): Promise<void> {
    const fnDecl = String(msg.params?.functionDeclaration ?? "");
    const rawArgs = Array.isArray(msg.params?.arguments)
      ? (msg.params!.arguments as Array<{ value?: unknown; objectId?: string }>)
      : [];
    const arg0 = (rawArgs[0]?.value ?? {}) as Record<string, unknown>;

    // 1. Target context probe
    if (fnDecl.includes("entry=regist|activated=not")) {
      sendReply({
        result: {
          type: "object",
          value: {
            isUnactivated:
              Boolean(target.isUnactivated) ||
              /entry=regist|activated=not/i.test(target.url),
            hasEda: !target.isUnactivated && !/entry=regist|activated=not/i.test(target.url),
            docType: target.docType,
            docUuid: target.docUuid,
            projectUuid: target.projectUuid,
            projectName: target.projectName,
            primitiveCount: target.primitiveCount,
            isActive: target.isActive,
            isDirty: false,
            readOnly: false,
            selectionCount: 0,
            activeInteractiveTool: target.activeInteractiveTool,
            domModals: target.domModals ?? [],
          },
        },
      });
      return;
    }

    // 2. Bypass status probe
    if (fnDecl.includes(".ant-modal-wrap")) {
      sendReply({
        result: {
          type: "object",
          value: {
            activeModalDialogs: target.domModals ?? [],
            activeProgressBar: target.progressBar ?? null,
          },
        },
      });
      return;
    }

    // 3. Interactive tool check
    if (fnDecl.includes("__jlcMcpActiveInteractiveTool")) {
      sendReply({
        result: {
          type: "object",
          value: { activeInteractiveTool: target.activeInteractiveTool },
        },
      });
      return;
    }

    // 4. Transaction begin / commit / rollback
    if (fnDecl.includes("beginCompositeStep")) {
      const ckptId = String(arg0.checkpointId ?? "ckpt_mock");
      target.checkpoints.set(
        ckptId,
        target.primitives.map((p) => ({ ...p }))
      );
      sendReply({
        result: {
          type: "object",
          value: { checkpointId: ckptId, historyDepth: 1, mechanism: "l3_adapter" },
        },
      });
      return;
    }

    if (fnDecl.includes("commitTransaction")) {
      const ckptId = String(arg0.checkpointId ?? "");
      target.checkpoints.delete(ckptId);
      sendReply({
        result: {
          type: "object",
          value: { checkpointId: ckptId, historyDepth: 2, status: "committed" },
        },
      });
      return;
    }

    if (fnDecl.includes("rollbackTo")) {
      const ckptId = String(arg0.checkpointId ?? "");
      const saved = target.checkpoints.get(ckptId);
      if (saved) {
        target.primitives = saved.map((p) => ({ ...p }));
        target.checkpoints.delete(ckptId);
      }
      sendReply({
        result: {
          type: "object",
          value: { checkpointId: ckptId, historyDepth: 1, status: "rolled_back" },
        },
      });
      return;
    }

    // 5. HUD & Layer visibility operations
    if (fnDecl.includes("getAllLayers")) {
      sendReply({
        result: {
          type: "object",
          value: target.layers.map((l) => ({ ...l })),
        },
      });
      return;
    }

    if (fnDecl.includes("setLayerVisible") && !fnDecl.includes("snapshot")) {
      const visibleIds = new Set((arg0.visibleLayers as Array<number | string>) ?? []);
      for (const layer of target.layers) {
        if (layer.layerStatus === 0) continue;
        layer.visible = visibleIds.has(layer.id);
        layer.layerStatus = layer.visible ? 1 : 2;
      }
      sendReply({ result: { type: "boolean", value: true } });
      return;
    }

    if (fnDecl.includes("snapshot")) {
      const snap = (arg0.snapshot as LayerVisibilityEntry[]) ?? [];
      target.layers = snap.map((s) => ({ ...s }));
      sendReply({ result: { type: "boolean", value: true } });
      return;
    }

    if (fnDecl.includes("svgMarkup")) {
      target.hudInjected = true;
      sendReply({ result: { type: "object", value: { injected: true } } });
      return;
    }

    if (fnDecl.includes("removeChild") && fnDecl.includes("domId")) {
      target.hudInjected = false;
      sendReply({ result: { type: "object", value: { removed: true } } });
      return;
    }

    // 6. Close document
    if (fnDecl.includes("remainingOpenCount")) {
      sendReply({
        result: {
          type: "object",
          value: { closed: true, remainingOpenCount: 0 },
        },
      });
      return;
    }

    // 7. Generic EDA API dispatch (`invokeEdaApi`)
    if (fnDecl.includes("__jlcRefSlot")) {
      const apiPath = String(arg0.apiPath ?? "");
      const args = Array.isArray(arg0.args) ? arg0.args : [];

      if (apiPath === "eda.pcb_Test.slowAsyncHang" || target.hangMode === "async_hang") {
        const timeoutMs = Number(arg0.timeoutMs ?? 80);
        setTimeout(() => {
          sendReply({
            result: {
              type: "object",
              value: { __jlcAsyncTimeout: true, timeoutMs },
            },
          });
        }, timeoutMs);
        return;
      }

      if (apiPath === "eda.pcb_Test.syncInfiniteLoop" || target.hangMode === "sync_freeze") {
        const key = msg.sessionId ?? defaultTargetId ?? "__root__";
        this.frozenSockets.set(key, () => {
          sendReply({
            result: { type: "undefined" },
            exceptionDetails: { text: "Execution terminated" },
          });
        });
        return;
      }

      if (apiPath === "eda.pcb_Test.slowInFlight") {
        await new Promise((r) => setTimeout(r, 150));
        sendReply({ result: { type: "object", value: { ok: true } } });
        return;
      }

      if (apiPath === "eda.pcb_PrimitiveLine.create") {
        const payload = (args[0] ?? {}) as {
          id?: string;
          x?: number;
          y?: number;
          layer?: number;
        };
        const prim = {
          id: payload.id ?? `line_${target.primitives.length + 1}`,
          xMil: Number(payload.x ?? 0),
          yMil: Number(payload.y ?? 0),
          layer: Number(payload.layer ?? 1),
        };
        target.primitives.push(prim);
        sendReply({ result: { type: "object", value: prim } });
        return;
      }

      if (apiPath === "eda.pcb_PrimitiveLine.createAndFail") {
        const payload = (args[0] ?? {}) as { id?: string; x?: number; y?: number };
        target.primitives.push({
          id: payload.id ?? "partial_line",
          xMil: Number(payload.x ?? 0),
          yMil: Number(payload.y ?? 0),
          layer: 1,
        });
        sendReply({
          result: {
            type: "object",
            value: {
              __jlcDispatchError: {
                errorCode: "ERR_SIMULATED_MIDWAY_FAIL",
                message: "Simulated failure midway through batch write",
              },
            },
          },
        });
        return;
      }

      if (apiPath === "eda.pcb_PrimitivePad.getAll") {
        const count = Number((args[0] as { count?: number } | undefined)?.count ?? 250);
        const list = Array.from({ length: count }, (_, idx) => ({
          primitiveId: `pad_${idx + 1}`,
          x: idx * 100, // native mil -> converts to mm
          y: 200,
        }));
        sendReply({ result: { type: "object", value: list } });
        return;
      }

      if (apiPath === "eda.pcb_PrimitiveComponent.inspectRef") {
        const slotArg = (args[0] ?? {}) as {
          __jlcRefSlot?: number;
          target?: { __jlcRefSlot?: number };
          layer?: number;
        };
        const slotIndex =
          typeof slotArg.__jlcRefSlot === "number"
            ? slotArg.__jlcRefSlot
            : typeof slotArg.target?.__jlcRefSlot === "number"
              ? slotArg.target.__jlcRefSlot
              : undefined;
        const hydratedObjectId =
          slotIndex !== undefined ? rawArgs[1 + slotIndex]?.objectId : undefined;
        sendReply({
          result: {
            type: "object",
            value: {
              hydratedObjectId: hydratedObjectId ?? null,
              layer: slotArg.layer ?? null,
            },
          },
        });
        return;
      }

      sendReply({ result: { type: "object", value: { apiPath, args } } });
      return;
    }

    // Direct custom callFunction tests
    if (fnDecl.includes("SYNC_FREEZE_TEST") || target.hangMode === "sync_freeze") {
      const key = msg.sessionId ?? defaultTargetId ?? "__root__";
      this.frozenSockets.set(key, () => {
        sendReply({
          result: { type: "undefined" },
          exceptionDetails: { text: "Execution terminated" },
        });
      });
      return;
    }

    if (fnDecl.includes("DELAY_RESPONSE_TEST")) {
      await new Promise((r) => setTimeout(r, 150));
      sendReply({ result: { type: "object", value: { finished: true } } });
      return;
    }

    sendReply({ result: { type: "object", value: { ok: true } } });
  }

  public async stop(): Promise<void> {
    for (const sock of this.openSockets) {
      try {
        sock.terminate();
      } catch {
        // Ignore
      }
    }
    this.openSockets.clear();
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
  }
}

function createSolidPatternPng(
  width: number,
  height: number,
  rgbaA: [number, number, number, number],
  rgbaB?: [number, number, number, number]
): Buffer {
  const png = new PNG({ width, height, fill: true });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const useB = rgbaB && x >= Math.floor(width / 2);
      const [r, g, b, a] = useB ? rgbaB : rgbaA;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

function makeDefaultLayers(): LayerVisibilityEntry[] {
  return [
    { id: 1, name: "TopLayer", layerStatus: 1, visible: true },
    { id: 2, name: "BottomLayer", layerStatus: 1, visible: true },
    { id: 3, name: "TopSilkLayer", layerStatus: 2, visible: false },
  ];
}

// ============================================================================
// Test Suites
// ============================================================================

const activeServers: MockCdpInstanceServer[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await srv.stop();
  }
});

describe("cdp-core: Launch Flags & Win32 Window Scanner", () => {
  it("enforces strict lceda-pro.exe launch argument whitelist and rejects forbidden UNKNOWN_FLAG switches", () => {
    const args = buildLcedaLaunchArgs({
      cdpPort: 19222,
      userDataDir: "D:\\Data\\.temp\\jlceda-headless",
      inspectPort: 19229,
    });

    expect(args).toContain("--remote-debugging-port=19222");
    expect(args).toContain(
      "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling"
    );
    expect(args).toContain("--user-data-dir=D:\\Data\\.temp\\jlceda-headless");
    expect(args).toContain("--inspect=19229");

    for (const arg of args) {
      for (const forbidden of FORBIDDEN_LCEDA_FLAGS) {
        expect(arg.startsWith(forbidden)).toBe(false);
      }
    }

    expect(
      extractCdpPortFromCommandLine(
        '"D:\\lceda-pro\\lceda-pro.exe" --remote-debugging-port=19225 --disable-features=CalculateNativeWinOcclusion'
      )
    ).toBe(19225);
    expect(
      extractUserDataDirFromCommandLine(
        '"lceda-pro.exe" --user-data-dir="D:\\Data\\.temp\\profile" --remote-debugging-port=19222'
      )
    ).toBe("D:\\Data\\.temp\\profile");
  });

  it("scans Win32 Z-Order, foreground status, and #32770 blocking modal dialogs and handles non-Windows / timeouts safely", async () => {
    const nonWin = await scanLcedaWin32State({ platform: "linux" });
    expect(nonWin.platformSupported).toBe(false);
    expect(nonWin.processes).toEqual([]);
    expect(nonWin.modalDialogs).toEqual([]);

    const mockWin = await scanLcedaWin32State({
      platform: "win32",
      execPowerShell: async () => ({
        stdout: JSON.stringify({
          mainProcesses: [
            {
              pid: 4100,
              exePath: "D:\\lceda-pro\\lceda-pro.exe",
              commandLine:
                '"D:\\lceda-pro\\lceda-pro.exe" --remote-debugging-port=19222',
            },
            {
              pid: 4200,
              exePath: "D:\\lceda-pro\\lceda-pro.exe",
              commandLine: '"D:\\lceda-pro\\lceda-pro.exe"',
            },
          ],
          windows: [
            {
              hwnd: "0x100A",
              pid: 4100,
              title: "PowerBoard_PCB - JLCEDA Pro",
              className: "Chrome_WidgetWin_1",
              isVisible: true,
              isForeground: true,
              zOrder: 0,
              isDialog32770: false,
            },
            {
              hwnd: "0x200B",
              pid: 4100,
              title: "打开工程文件",
              className: "#32770",
              isVisible: true,
              isForeground: false,
              zOrder: 1,
              isDialog32770: true,
              dialogButtons: ["打开(&O)", "取消"],
              dialogTexts: ["请选择 .epro 文件"],
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    });

    expect(mockWin.platformSupported).toBe(true);
    expect(mockWin.timedOut).toBe(false);
    expect(mockWin.processes).toHaveLength(2);
    expect(mockWin.processes[0]).toMatchObject({
      pid: 4100,
      hasCdp: true,
      cdpPort: 19222,
      isForeground: true,
      zOrder: 0,
    });
    expect(mockWin.processes[1]).toMatchObject({
      pid: 4200,
      hasCdp: false,
      cdpPort: null,
    });
    expect(mockWin.modalDialogs).toEqual([
      {
        source: "win32",
        title: "打开工程文件",
        textSummary: "请选择 .epro 文件",
        buttons: ["打开(&O)", "取消"],
        hwnd: "0x200B",
      },
    ]);

    const timedOutSnap = await scanLcedaWin32State({
      platform: "win32",
      timeoutMs: 250,
      execPowerShell: async (_script, timeoutMs) => ({
        stdout: "",
        stderr: `Timed out after ${timeoutMs}ms`,
        exitCode: null,
        timedOut: true,
      }),
    });
    expect(timedOutSnap.timedOut).toBe(true);
    expect(timedOutSnap.processes).toEqual([]);
  });
});

describe("cdp-core: Target Router, Scoring, Activation Gate & Bypass Status", () => {
  it("① scores multi-instance / multi-target graphs, skips HOME/devtools/service_worker, attaches active PCB, closes empty HOME instances, and hot-switches tabs via Flat Session", async () => {
    const emptyInstance = new MockCdpInstanceServer(5001, [
      {
        id: "t_sw_a",
        type: "service_worker",
        title: "Service Worker",
        url: "https://pro.lceda.cn/sw.js",
        docType: "UNKNOWN",
        docUuid: null,
        projectUuid: null,
        projectName: null,
        primitiveCount: 0,
        isActive: false,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: [],
        hudInjected: false,
      },
      {
        id: "t_home_a",
        type: "page",
        title: "欢迎使用嘉立创EDA专业版",
        url: "https://pro.lceda.cn/start",
        docType: "HOME",
        docUuid: null,
        projectUuid: null,
        projectName: null,
        primitiveCount: 0,
        isActive: true,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: [],
        hudInjected: false,
      },
    ]);

    const activeInstance = new MockCdpInstanceServer(5002, [
      {
        id: "t_devtools_b",
        type: "page",
        title: "DevTools",
        url: "devtools://devtools/bundled/inspector.html",
        docType: "UNKNOWN",
        docUuid: null,
        projectUuid: null,
        projectName: null,
        primitiveCount: 0,
        isActive: false,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: [],
        hudInjected: false,
      },
      {
        id: "t_home_b",
        type: "page",
        title: "Start Page",
        url: "https://pro.lceda.cn/home",
        docType: "HOME",
        docUuid: null,
        projectUuid: null,
        projectName: null,
        primitiveCount: 0,
        isActive: false,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: [],
        hudInjected: false,
      },
      {
        id: "t_sch_b",
        type: "page",
        title: "Main_SCH",
        url: "https://pro.lceda.cn/editor?doc=sch1",
        docType: "SCH",
        docUuid: "doc-sch-1",
        projectUuid: "proj-iot-1",
        projectName: "IoT_Controller",
        primitiveCount: 25,
        isActive: false,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: [],
        hudInjected: false,
      },
      {
        id: "t_pcb_b",
        type: "page",
        title: "PowerBoard_PCB",
        url: "https://pro.lceda.cn/editor?doc=pcb1",
        docType: "PCB",
        docUuid: "doc-pcb-1",
        projectUuid: "proj-iot-1",
        projectName: "IoT_Controller",
        primitiveCount: 64,
        isActive: true,
        activeInteractiveTool: null,
        domModals: [
          {
            source: "dom",
            title: "DRC 运行中",
            textSummary: "正在检查间距规则",
            buttons: ["取消"],
          },
        ],
        progressBar: { visible: true, percent: 68, label: "DRC 68%" },
        primitives: [],
        checkpoints: new Map(),
        layers: makeDefaultLayers(),
        hudInjected: false,
      },
    ]);

    activeServers.push(emptyInstance, activeInstance);
    const portA = await emptyInstance.start();
    const portB = await activeInstance.start();

    const win32Processes: CdpProcessInfo[] = [
      {
        pid: 5001,
        hasCdp: true,
        cdpPort: portA,
        windowTitle: "欢迎页",
        zOrder: 1,
        isForeground: false,
      },
      {
        pid: 5002,
        hasCdp: true,
        cdpPort: portB,
        windowTitle: "IoT_Controller - PowerBoard_PCB",
        zOrder: 0,
        isForeground: true,
      },
    ];

    const router = new CdpTargetRouter({
      portRange: [portA, portA], // prove multi-port via win32 + port scanning
      win32Scanner: async (): Promise<Win32ScanSnapshot> => ({
        platformSupported: true,
        processes: win32Processes,
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });

    const conn = await router.connect({
      editorType: "pcb",
      closeEmptyInstances: true,
    });

    expect(conn.connected).toBe(true);
    expect(conn.collaborationMode).toBe("interactive_copilot");
    expect(conn.boundInstance).toMatchObject({
      pid: 5002,
      cdpPort: portB,
      projectUuid: "proj-iot-1",
      activeDocHandle: "PowerBoard_PCB",
      activeDocType: "PCB",
    });
    expect(conn.closedEmptyPids).toContain(5001);
    expect(emptyInstance.browserClosed).toBe(true);
    expect(activeInstance.browserClosed).toBe(false);

    // Hot-switch to SCH tab via Flat Session
    const switched = await router.activateDocument("Main_SCH");
    expect(switched.type).toBe("SCH");
    expect(switched.activeDocumentHandle).toBe("Main_SCH");
    const resolvedSch = await router.resolveTargetSession("Main_SCH");
    expect(resolvedSch.docType).toBe("SCH");
    expect(resolvedSch.targetId).toBe("t_sch_b");
    expect(resolvedSch.sessionId).toBeTruthy();

    // Switch back to PCB and check bypass getSessionStatus while an RPC is in flight
    await router.activateDocument("PowerBoard_PCB");
    const exec = router.getExecutor() as CdpRpcExecutor;
    const inFlight = exec.invokeEdaApi("eda.pcb_Test.slowInFlight");
    const status = await router.getSessionStatus();
    expect(status.connectedPid).toBe(5002);
    expect(status.rpcQueueDepth).toBeGreaterThanOrEqual(1);
    expect(status.activeModalDialogs[0]?.title).toBe("DRC 运行中");
    expect(status.activeProgressBar).toEqual({
      visible: true,
      percent: 68,
      label: "DRC 68%",
    });
    await inFlight;
    await router.disconnect();
  });

  it("② compliantly intercepts first-install unactivated state (entry=regist / activated=not) with ERR_CLIENT_NOT_ACTIVATED", async () => {
    const unactivatedServer = new MockCdpInstanceServer(6001, [
      {
        id: "t_regist",
        type: "page",
        title: "嘉立创EDA 登录激活",
        url: "https://pro.lceda.cn/editor?entry=regist&activated=not",
        docType: "UNKNOWN",
        docUuid: null,
        projectUuid: null,
        projectName: null,
        primitiveCount: 0,
        isActive: true,
        isUnactivated: true,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: [],
        hudInjected: false,
      },
    ]);
    activeServers.push(unactivatedServer);
    const port = await unactivatedServer.start();

    const router = new CdpTargetRouter({
      portRange: [port, port],
      win32Scanner: async () => ({
        platformSupported: true,
        processes: [
          {
            pid: 6001,
            hasCdp: true,
            cdpPort: port,
            windowTitle: "JLCEDA Login",
            zOrder: 0,
            isForeground: true,
          },
        ],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });

    const result = await router.connect({ launch: false });
    expect(result.connected).toBe(false);
    expect(result.errorCode).toBe("ERR_CLIENT_NOT_ACTIVATED");
    expect(result.boundInstance).toBeNull();
    expect(result.remediation).toContain("登录");
    expect(router.isConnected()).toBe(false);
  });

  it("refuses to kill user running instance without CDP (ERR_INSTANCE_WITHOUT_CDP) and supports isolatedHeadless parallel launch + releaseProcess exit", async () => {
    let spawnedWhenDisabled = false;
    const routerNoCdp = new CdpTargetRouter({
      portRange: [19229, 19229],
      processSpawner: () => {
        spawnedWhenDisabled = true;
        return { pid: 9999 };
      },
      httpFetcher: async () => {
        throw new Error("Connection refused");
      },
      win32Scanner: async () => ({
        platformSupported: true,
        processes: [
          {
            pid: 7001,
            hasCdp: false,
            cdpPort: null,
            windowTitle: "UserDesign_PCB - 未保存",
            zOrder: 0,
            isForeground: true,
          },
        ],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });

    const noCdpRes = await routerNoCdp.connect({ launch: false });
    expect(noCdpRes.connected).toBe(false);
    expect(noCdpRes.errorCode).toBe("ERR_INSTANCE_WITHOUT_CDP");
    expect(noCdpRes.remediation).toContain("isolatedHeadless=true");
    expect(spawnedWhenDisabled).toBe(false);

    // Parallel isolated headless instance launch + clean releaseProcess close
    const headlessSrv = new MockCdpInstanceServer(7002, [
      {
        id: "t_headless_pcb",
        type: "page",
        title: "Batch_PCB",
        url: "https://pro.lceda.cn/editor?doc=batch1",
        docType: "PCB",
        docUuid: "batch-doc-1",
        projectUuid: "batch-proj-1",
        projectName: "BatchProject",
        primitiveCount: 12,
        isActive: true,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: makeDefaultLayers(),
        hudInjected: false,
      },
    ]);
    activeServers.push(headlessSrv);
    const headlessPort = await headlessSrv.start();

    let capturedSpawnArgs: string[] = [];
    let spawnCalled = false;

    const routerIsolated = new CdpTargetRouter({
      exePath: "D:\\Program Files\\Development Tools\\lceda-pro\\lceda-pro.exe",
      headlessProfileDir: "D:\\Data\\.temp\\jlceda-mcp-headless",
      portRange: [headlessPort, headlessPort],
      win32Scanner: async () => ({
        platformSupported: true,
        processes: spawnCalled
          ? [
              {
                pid: 7001,
                hasCdp: false,
                cdpPort: null,
                windowTitle: "UserDesign_PCB",
                zOrder: 1,
                isForeground: false,
              },
              {
                pid: 7002,
                hasCdp: true,
                cdpPort: headlessPort,
                userDataDir: "D:\\Data\\.temp\\jlceda-mcp-headless",
                windowTitle: "Batch_PCB",
                zOrder: 0,
                isForeground: true,
              },
            ]
          : [
              {
                pid: 7001,
                hasCdp: false,
                cdpPort: null,
                windowTitle: "UserDesign_PCB",
                zOrder: 0,
                isForeground: true,
              },
            ],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
      processSpawner: (_exe, args) => {
        spawnCalled = true;
        capturedSpawnArgs = args;
        return { pid: 7002 };
      },
      httpFetcher: async (port, endpoint) => {
        if (!spawnCalled || port !== headlessPort) {
          throw new Error("Not spawned yet");
        }
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        return await res.json();
      },
    });

    const isoConn = await routerIsolated.connect({
      launch: true,
      isolatedHeadless: true,
      cdpPort: headlessPort,
    });
    expect(isoConn.connected).toBe(true);
    expect(isoConn.collaborationMode).toBe("offline_delivery");
    expect(capturedSpawnArgs).toContain(
      `--remote-debugging-port=${headlessPort}`
    );
    expect(capturedSpawnArgs).toContain(
      "--user-data-dir=D:\\Data\\.temp\\jlceda-mcp-headless"
    );
    for (const arg of capturedSpawnArgs) {
      for (const bad of FORBIDDEN_LCEDA_FLAGS) {
        expect(arg.startsWith(bad)).toBe(false);
      }
    }

    const closeRes = await routerIsolated.closeDocument({
      document: "Batch_PCB",
      releaseProcess: true,
    });
    expect(closeRes).toEqual({
      closed: true,
      lockReleased: true,
      processExited: true,
    });
    expect(headlessSrv.browserClosed).toBe(true);
  });
});

describe("cdp-core: ③ Runtime.callFunctionOn, Watchdog Timeouts & Atomic Rollback", () => {
  it("executes all API calls via Runtime.callFunctionOn with structured args, enforces interactive yield lock, and rolls back atomically on soft timeout, midway error, and hard Runtime.terminateExecution", async () => {
    const pcbTarget: MockTargetState = {
      id: "t_tx_pcb",
      type: "page",
      title: "TxBoard_PCB",
      url: "https://pro.lceda.cn/editor?doc=tx1",
      docType: "PCB",
      docUuid: "doc-tx-1",
      projectUuid: "proj-tx-1",
      projectName: "TxBoard",
      primitiveCount: 1,
      isActive: true,
      activeInteractiveTool: null,
      primitives: [{ id: "seed_line", xMil: 100, yMil: 100, layer: 1 }],
      checkpoints: new Map(),
      layers: makeDefaultLayers(),
      hudInjected: false,
    };

    const srv = new MockCdpInstanceServer(8001, [pcbTarget]);
    activeServers.push(srv);
    const port = await srv.start();

    const router = new CdpTargetRouter({
      portRange: [port, port],
      softTimeoutMs: 80,
      hardTerminateGraceMs: 60,
      win32Scanner: async () => ({
        platformSupported: true,
        processes: [
          {
            pid: 8001,
            hasCdp: true,
            cdpPort: port,
            windowTitle: "TxBoard_PCB",
            zOrder: 0,
            isForeground: true,
          },
        ],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });

    await router.connect();
    const exec = router.getExecutor() as CdpRpcExecutor;

    // Verify Runtime.callFunctionOn is used (no concatenated Runtime.evaluate JS)
    const evalApiCalls = srv.receivedCommands.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        c.params.expression !== "globalThis"
    );
    expect(evalApiCalls).toHaveLength(0);

    // 1. Successful transactional write with mm -> mil unit conversion
    const okTx = await exec.invokeEdaApi(
      "eda.pcb_PrimitiveLine.create",
      [{ id: "good_line", x: 25.4, y: 2.54, layer: { $enum: "EPCB_LayerId.TOP" } }],
      { transactional: true }
    );
    expect(okTx.rolledBack).toBe(false);
    expect(pcbTarget.primitives).toHaveLength(2);
    expect(pcbTarget.primitives[1].xMil).toBeCloseTo(1000, 9);
    expect(pcbTarget.primitives[1].yMil).toBeCloseTo(100, 9);

    // 2. Interactive drawing yield lock rejects when user holds active tool
    pcbTarget.activeInteractiveTool = "PCB_ROUTE_TRACK";
    await expect(
      exec.runInTransaction("TxBoard_PCB", "BlockedByUser", async () => {
        return "should_not_run";
      })
    ).rejects.toMatchObject({
      errorCode: "ERR_USER_INTERACTIVE_BUSY",
      rolledBack: false,
    });
    pcbTarget.activeInteractiveTool = null;

    // 3. Soft timeout (ERR_RPC_ASYNC_TIMEOUT) inside transaction -> atomic rollback without terminateExecution
    const prevTermCount = srv.terminateExecutionCount;
    let softCaught: unknown;
    try {
      await exec.invokeEdaApi("eda.pcb_Test.slowAsyncHang", [], {
        transactional: true,
        timeoutMs: 50,
      });
    } catch (err) {
      softCaught = err;
    }
    expect(softCaught).toBeInstanceOf(CdpTransactionError);
    expect((softCaught as CdpTransactionError).errorCode).toBe("ERR_RPC_ASYNC_TIMEOUT");
    expect((softCaught as CdpTransactionError).rolledBack).toBe(true);
    expect(srv.terminateExecutionCount).toBe(prevTermCount);

    // 4. Midway mutation error inside multi-step transaction -> atomic rollback
    let midwayCaught: unknown;
    try {
      await exec.runInTransaction("TxBoard_PCB", "MidwayBatch", async () => {
        await exec.invokeEdaApi("eda.pcb_PrimitiveLine.create", [
          { id: "temp_1", x: 10, y: 10 },
        ]);
        expect(pcbTarget.primitives).toHaveLength(3);
        await exec.invokeEdaApi("eda.pcb_PrimitiveLine.createAndFail", [
          { id: "temp_2", x: 20, y: 20 },
        ]);
      });
    } catch (err) {
      midwayCaught = err;
    }
    expect(midwayCaught).toBeInstanceOf(CdpTransactionError);
    expect((midwayCaught as CdpTransactionError).errorCode).toBe(
      "ERR_SIMULATED_MIDWAY_FAIL"
    );
    expect((midwayCaught as CdpTransactionError).rolledBack).toBe(true);
    expect(pcbTarget.primitives).toHaveLength(2); // 100% restored to before failed tx!

    // 5. Synchronous V8 infinite loop -> hard timeout triggers Runtime.terminateExecution + atomic rollback
    let hardCaught: unknown;
    try {
      await exec.runInTransaction("TxBoard_PCB", "SyncLoopTx", async () => {
        await exec.invokeEdaApi("eda.pcb_PrimitiveLine.create", [
          { id: "temp_before_loop", x: 5, y: 5 },
        ]);
        expect(pcbTarget.primitives).toHaveLength(3);
        await exec.invokeEdaApi("eda.pcb_Test.syncInfiniteLoop", [], {
          timeoutMs: 40,
        });
      });
    } catch (err) {
      hardCaught = err;
    }
    expect(hardCaught).toBeInstanceOf(CdpTransactionError);
    expect((hardCaught as CdpTransactionError).errorCode).toBe(
      "ERR_RPC_EXECUTION_TERMINATED"
    );
    expect((hardCaught as CdpTransactionError).rolledBack).toBe(true);
    expect(srv.terminateExecutionCount).toBe(prevTermCount + 1);
    expect(pcbTarget.primitives).toHaveLength(2); // temp_before_loop rolled back cleanly!

    // 6. Verify {$ref: "jlc_obj:..."} objectId slot hydration + {$enum}
    exec.handlePool.registerHandle({
      handle: "jlc_obj:900",
      objectId: "v8_remote_comp_u1",
      primitiveId: "e1",
      type: "Component",
    });
    const hydratedRes = await exec.invokeEdaApi<{
      hydratedObjectId: string | null;
      layer: number | null;
    }>("eda.pcb_PrimitiveComponent.inspectRef", [
      { $ref: "jlc_obj:900" },
    ]);
    // Verify wrapped object ref slot also works
    const wrappedHydrated = await exec.invokeEdaApi<{
      hydratedObjectId: string | null;
      layer: number | null;
    }>("eda.pcb_PrimitiveComponent.inspectRef", [
      { target: { $ref: "jlc_obj:900" }, layer: { $enum: "EPCB_LayerId.BOTTOM" } },
    ]);
    expect(hydratedRes.result.hydratedObjectId).toBe("v8_remote_comp_u1");
    expect(wrappedHydrated.result.hydratedObjectId).toBe("v8_remote_comp_u1");
    expect(wrappedHydrated.result.layer).toBe(2);

    await router.disconnect();
  });
});

describe("cdp-core: ④ Array Pagination (>200), LRU Handle Pool & CRC32 Persistent References", () => {
  it("paginates arrays > 200 items via jlc_arr cursor and manages LRU handle pool eviction & objectGroup release", async () => {
    const pool = new HandlePool({ maxHandles: 3 });

    const h1 = pool.registerHandle({ objectId: "obj_1", type: "Pad", primitiveId: "p1" });
    const h2 = pool.registerHandle({ objectId: "obj_2", type: "Pad", primitiveId: "p2" });
    const h3 = pool.registerHandle({ objectId: "obj_3", type: "Pad", primitiveId: "p3" });

    // Touch h1 so h2 becomes LRU
    expect(pool.getHandle(h1.handle)?.objectId).toBe("obj_1");
    const h4 = pool.registerHandle({ objectId: "obj_4", type: "Pad", primitiveId: "p4" });

    expect(pool.hasHandle(h2.handle)).toBe(false);
    expect(pool.hasHandle(h1.handle)).toBe(true);
    expect(pool.hasHandle(h3.handle)).toBe(true);
    expect(pool.hasHandle(h4.handle)).toBe(true);

    let releasedGroup: string | null = null;
    const removedCount = await pool.releaseObjectGroup(undefined, async (grp) => {
      releasedGroup = grp;
    });
    expect(releasedGroup).toBe("jlc-mcp-ephemeral");
    expect(removedCount).toBe(3);
    expect(pool.stats().handleCount).toBe(0);

    // Threshold 200 test: exactly 200 not paginated, 250 paginated to 50 preview
    const exact200 = pool.paginateArray(Array.from({ length: 200 }, (_, i) => i));
    expect(exact200.paginated).toBe(false);
    expect(exact200.items).toHaveLength(ARRAY_PAGINATION_THRESHOLD);

    const over250 = pool.paginateArray(Array.from({ length: 250 }, (_, i) => ({ id: i })));
    expect(over250.paginated).toBe(true);
    expect(over250.items).toHaveLength(50);
    expect(over250.arrayCursor?.totalCount).toBe(250);
    expect(over250.arrayCursor?.hasMore).toBe(true);

    const cursorId = over250.arrayCursor!.handle;
    const page2 = pool.readArrayCursor<{ id: number }>(cursorId, 50, 100);
    expect(page2.items).toHaveLength(100);
    expect(page2.items[0].id).toBe(50);
    expect(page2.hasMore).toBe(true);

    const page3 = pool.readArrayCursor<{ id: number }>(cursorId, 150, 150);
    expect(page3.items).toHaveLength(100);
    expect(page3.items[99].id).toBe(249);
    expect(page3.hasMore).toBe(false);

    // Also test end-to-end array pagination through invokeEdaApi
    const srv = new MockCdpInstanceServer(8501, [
      {
        id: "t_arr_pcb",
        type: "page",
        title: "DenseBoard_PCB",
        url: "https://pro.lceda.cn/editor?doc=dense1",
        docType: "PCB",
        docUuid: "doc-dense-1",
        projectUuid: "proj-dense-1",
        projectName: "DenseBoard",
        primitiveCount: 250,
        isActive: true,
        activeInteractiveTool: null,
        primitives: [],
        checkpoints: new Map(),
        layers: makeDefaultLayers(),
        hudInjected: false,
      },
    ]);
    activeServers.push(srv);
    const port = await srv.start();
    const router = new CdpTargetRouter({
      portRange: [port, port],
      win32Scanner: async () => ({
        platformSupported: true,
        processes: [
          {
            pid: 8501,
            hasCdp: true,
            cdpPort: port,
            windowTitle: "DenseBoard_PCB",
            zOrder: 0,
            isForeground: true,
          },
        ],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });
    await router.connect();
    const exec = router.getExecutor() as CdpRpcExecutor;
    const padRes = await exec.invokeEdaApi<Array<{ primitiveId: string; x: number }>>(
      "eda.pcb_PrimitivePad.getAll",
      [{ count: 250 }]
    );
    expect(padRes.result).toHaveLength(50);
    expect(padRes.arrayCursor?.totalCount).toBe(250);
    expect(padRes.result[1].x).toBeCloseTo(2.54, 9); // 100 mil -> 2.54 mm converted!
    await router.disconnect();
  });

  it("creates CRC32-signed Base64 persistent references, validates docUuid/primId/naturalKey rebinding, and strictly returns ERR_REF_STALE on deletion or ambiguity", () => {
    const pool = new HandlePool();
    const created = pool.createPersistentReference({
      projUuid: "proj-1",
      docUuid: "doc-pcb-1",
      docType: "PCB",
      primType: "Component",
      primId: "e1024",
      naturalKey: {
        designator: "U3",
        lcsc: "C2040",
      },
      geomAnchorMm: [42.5, 31.2],
    });

    expect(created.payload.crc).toMatch(/^[0-9a-f]{8}$/);
    const verified = decodeAndVerifyPersistentReference(created.base64);
    expect(verified.valid).toBe(true);
    expect(verified.payload?.primId).toBe("e1024");

    // Tamper payload -> CRC mismatch
    const tamperedObj = { ...created.payload, primId: "e9999" };
    const tamperedB64 = Buffer.from(JSON.stringify(tamperedObj), "utf8").toString(
      "base64"
    );
    const badCrc = decodeAndVerifyPersistentReference(tamperedB64);
    expect(badCrc.valid).toBe(false);
    expect(badCrc.errorCode).toBe("ERR_REF_CORRUPT");

    // Document UUID mismatch -> ERR_REF_STALE
    const wrongDoc = pool.resolvePersistentReference({
      base64: created.base64,
      targetDocUuid: "doc-pcb-OTHER",
      candidates: [
        {
          primId: "e1024",
          primType: "Component",
          naturalKey: { designator: "U3", lcsc: "C2040" },
        },
      ],
    });
    expect(wrongDoc.resolved).toBe(false);
    expect(wrongDoc.errorCode).toBe("ERR_REF_STALE");

    // Direct match on primId + primType
    const direct = pool.resolvePersistentReference({
      base64: created.base64,
      targetDocUuid: "doc-pcb-1",
      candidates: [
        {
          primId: "e1024",
          primType: "Component",
          naturalKey: { designator: "U3", lcsc: "C2040" },
          objectId: "v8_u3",
        },
      ],
    });
    expect(direct.resolved).toBe(true);
    expect(direct.reboundByNaturalKey).toBe(false);
    expect(direct.handle).toMatch(/^jlc_obj:/);

    // Safe rebind when primId reassigned after sync, naturalKey uniquely matches
    const rebound = pool.resolvePersistentReference({
      base64: created.base64,
      targetDocUuid: "doc-pcb-1",
      candidates: [
        {
          primId: "e1024", // recycled to a resistor!
          primType: "Component",
          naturalKey: { designator: "R9", lcsc: "C25804" },
        },
        {
          primId: "e5555",
          primType: "Component",
          naturalKey: { designator: "U3", lcsc: "C2040" },
        },
      ],
    });
    expect(rebound.resolved).toBe(true);
    expect(rebound.reboundByNaturalKey).toBe(true);
    expect(rebound.primitiveId).toBe("e5555");

    // Deleted entity -> strict ERR_REF_STALE (never guess neighbor)
    const deleted = pool.resolvePersistentReference({
      base64: created.base64,
      targetDocUuid: "doc-pcb-1",
      candidates: [
        {
          primId: "e1025",
          primType: "Component",
          naturalKey: { designator: "U4", lcsc: "C2040" },
        },
      ],
    });
    expect(deleted.resolved).toBe(false);
    expect(deleted.errorCode).toBe("ERR_REF_STALE");

    // Ambiguous multiple naturalKey matches -> strict ERR_REF_STALE (never guess)
    const ambiguous = pool.resolvePersistentReference({
      base64: created.base64,
      targetDocUuid: "doc-pcb-1",
      candidates: [
        {
          primId: "e7001",
          primType: "Component",
          naturalKey: { designator: "U3", lcsc: "C2040" },
        },
        {
          primId: "e7002",
          primType: "Component",
          naturalKey: { designator: "U3", lcsc: "C2040" },
        },
      ],
    });
    expect(ambiguous.resolved).toBe(false);
    expect(ambiguous.errorCode).toBe("ERR_REF_STALE");
  });
});

describe("cdp-core: ⑤ Double-Precision Unit Conversion & pngjs Side-by-Side HUD Capture", () => {
  it("performs lossless double-precision conversions across mm/mil/10mil/deg/rad and recursive objects", () => {
    expect(mmToMil(1)).toBe(MIL_PER_MM);
    expect(mmToMil(1)).toBeCloseTo(39.37007874015748, 12);
    expect(milToMm(100)).toBeCloseTo(2.54, 12);
    expect(milToMm(mmToMil(12.3456789))).toBeCloseTo(12.3456789, 12);

    expect(mmToSch10Mil(2.54)).toBeCloseTo(10, 12);
    expect(sch10MilToMm(10)).toBeCloseTo(2.54, 12);

    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 12);

    const resolvedTokens = resolveSpecialTokens({
      layer: { $enum: "EPCB_LayerId.TOP" },
      unit: { $enum: "ESYS_Unit.MILLIMETER" },
    });
    expect(resolvedTokens).toEqual({ layer: 1, unit: "mm" });

    const nativeParams = convertParamsToNative(
      {
        x: 2.54,
        y: 5.08,
        trackWidth: 0.254,
        angle: 90,
        primitiveId: "e1",
        pinCount: 16,
        points: [
          [0, 0],
          [2.54, 2.54],
        ],
      },
      {
        contract: {
          nativeLengthUnit: "mil",
          nativeAngleUnit: "rad",
          autoConvertFromMmDeg: true,
        },
      }
    ) as Record<string, unknown>;

    expect(nativeParams.x).toBeCloseTo(100, 12);
    expect(nativeParams.y).toBeCloseTo(200, 12);
    expect(nativeParams.trackWidth).toBeCloseTo(10, 12);
    expect(nativeParams.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(nativeParams.primitiveId).toBe("e1");
    expect(nativeParams.pinCount).toBe(16);
    expect((nativeParams.points as number[][])[1][0]).toBeCloseTo(100, 12);

    const backToMm = convertResultFromNative(nativeParams, {
      contract: {
        nativeLengthUnit: "mil",
        nativeAngleUnit: "rad",
        autoConvertFromMmDeg: true,
      },
    }) as Record<string, unknown>;
    expect(backToMm.x).toBeCloseTo(2.54, 12);
    expect(backToMm.y).toBeCloseTo(5.08, 12);
    expect(backToMm.angle).toBeCloseTo(90, 12);

    // Native mode skips conversion
    const untouched = convertParamsToNative({ x: 100 }, { unitMode: "native" }) as {
      x: number;
    };
    expect(untouched.x).toBe(100);
  });

  it("renders metric SVG HUD, snapshots/restores PCB layers, and stitches actual PCB + OEM Datasheet Layout Example PNG side-by-side via pngjs", async () => {
    const svg = buildHudSvgMarkup({
      viewportWidthPx: 800,
      viewportHeightPx: 600,
      regionMm: [0, 0, 80, 60],
      gridSpacingMm: 10,
      violations: [{ id: "#V1", xMm: 20, yMm: 30, label: "CLEARANCE", severity: "BLOCKER" }],
    });
    expect(svg).toContain("pointer-events:none");
    expect(svg).toContain("#V1 CLEARANCE");
    expect(svg).toContain("10.0mm");

    const actualPcbPng = createSolidPatternPng(
      160,
      120,
      [220, 40, 40, 255],
      [40, 90, 220, 255]
    );
    const datasheetRefPng = createSolidPatternPng(
      200,
      150,
      [30, 180, 80, 255],
      [230, 200, 40, 255]
    );

    // Direct pngjs compositing check
    const directComposite = composeSideBySideComparisonPng(
      actualPcbPng,
      datasheetRefPng,
      {
        leftTitle: "ACTUAL PCB",
        rightTitle: "TI LAYOUT EXAMPLE",
      }
    );
    const parsedDirect = PNG.sync.read(directComposite.pngBuffer);
    expect(directComposite.pngBuffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(parsedDirect.width).toBe(directComposite.width);
    expect(parsedDirect.height).toBe(directComposite.height);
    expect(parsedDirect.width).toBeGreaterThan(160 + 200);
    expect(parsedDirect.height).toBeGreaterThan(150);

    // Verify left panel pixel color (scaled to 150px tall -> width = 200)
    const lx = directComposite.leftRect.x + 10;
    const ly = directComposite.leftRect.y + 10;
    const lIdx = (parsedDirect.width * ly + lx) << 2;
    expect(parsedDirect.data[lIdx]).toBe(220);
    expect(parsedDirect.data[lIdx + 1]).toBe(40);
    expect(parsedDirect.data[lIdx + 2]).toBe(40);

    // Verify right panel pixel color (far right half)
    const rx = directComposite.rightRect.x + directComposite.rightRect.width - 10;
    const ry = directComposite.rightRect.y + 10;
    const rIdx = (parsedDirect.width * ry + rx) << 2;
    expect(parsedDirect.data[rIdx]).toBe(230);
    expect(parsedDirect.data[rIdx + 1]).toBe(200);
    expect(parsedDirect.data[rIdx + 2]).toBe(40);

    // Full end-to-end captureViewWithHud over Mock CDP WebSocket server
    const hudTarget: MockTargetState = {
      id: "t_hud_pcb",
      type: "page",
      title: "HudBoard_PCB",
      url: "https://pro.lceda.cn/editor?doc=hud1",
      docType: "PCB",
      docUuid: "doc-hud-1",
      projectUuid: "proj-hud-1",
      projectName: "HudBoard",
      primitiveCount: 20,
      isActive: true,
      activeInteractiveTool: null,
      primitives: [],
      checkpoints: new Map(),
      layers: makeDefaultLayers(),
      hudInjected: false,
      screenshotPngBase64: actualPcbPng.toString("base64"),
    };

    const srv = new MockCdpInstanceServer(9001, [hudTarget]);
    activeServers.push(srv);
    const port = await srv.start();
    const router = new CdpTargetRouter({
      portRange: [port, port],
      win32Scanner: async () => ({
        platformSupported: true,
        processes: [
          {
            pid: 9001,
            hasCdp: true,
            cdpPort: port,
            windowTitle: "HudBoard_PCB",
            zOrder: 0,
            isForeground: true,
          },
        ],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });
    await router.connect();
    const exec = router.getExecutor();

    const captureRes = await captureViewWithHud(exec, {
      document: "HudBoard_PCB",
      overlayGridMm: 5,
      regionMm: [0, 0, 50, 40],
      violations: [{ id: "#V1", xMm: 12, yMm: 18, severity: "BLOCKER" }],
      visibleLayers: [1], // temporarily hide BottomLayer (id=2)
      compareWithDatasheetPng: datasheetRefPng,
      datasheetLabel: "C96581",
    });

    expect(captureRes.hudCleanedUp).toBe(true);
    expect(captureRes.layerSnapshotRestored).toBe(true);
    expect(hudTarget.hudInjected).toBe(false);
    // Original BottomLayer (id=2) visibility must be restored to true!
    expect(hudTarget.layers.find((l) => l.id === 2)?.visible).toBe(true);
    expect(captureRes.sideBySide).toBeDefined();
    const parsedOut = PNG.sync.read(captureRes.pngBuffer);
    expect(parsedOut.width).toBe(captureRes.sideBySide!.width);
    expect(parsedOut.height).toBe(captureRes.sideBySide!.height);

    await router.disconnect();
  });
});

describe("cdp-core: ⑥ jlc_configure hot-update & jlc_launch client launcher", () => {
  it("returns ERR_CLIENT_PATH_REQUIRED when exePath is missing, hot-updates via updateRuntimeOptions, and launches with strictly whitelisted flags", async () => {
    const router = new CdpTargetRouter({
      exePath: null,
      win32Scanner: async () => ({
        processes: [],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
    });

    const missingRes = await router.launchClient();
    expect(missingRes.launched).toBe(false);
    expect(missingRes.errorCode).toBe("ERR_CLIENT_PATH_REQUIRED");

    const spawned: Array<{ exe: string; args: string[] }> = [];
    const customRouter = new CdpTargetRouter({
      exePath: null,
      portRange: [19260, 19265],
      win32Scanner: async () => ({
        processes: [],
        windows: [],
        modalDialogs: [],
        timedOut: false,
      }),
      processSpawner: (exe, args) => {
        spawned.push({ exe, args });
        return { pid: 42424 };
      },
      httpFetcher: async (_port, endpoint) => {
        if (spawned.length === 0) {
          throw new Error("not listening yet");
        }
        if (endpoint === "/json/list") {
          return [
            {
              id: "t-reg",
              type: "page",
              title: "Regist",
              url: "https://client/editor?entry=regist",
            },
          ];
        }
        return {};
      },
    });

    customRouter.updateRuntimeOptions({
      exePath: "D:\\Program Files\\Development Tools\\lceda-pro\\lceda-pro.exe",
    });

    const launchRes = await customRouter.launchClient({ waitForCdpMs: 1500 });
    expect(launchRes.launched).toBe(true);
    expect(launchRes.alreadyRunning).toBe(false);
    expect(launchRes.pid).toBe(42424);
    expect(launchRes.cdpPort).toBe(19260);
    expect(launchRes.cdpReady).toBe(true);
    expect(launchRes.activationRequired).toBe(true);
    expect(spawned).toHaveLength(1);
    for (const flag of FORBIDDEN_LCEDA_FLAGS) {
      expect(spawned[0].args.some((a) => a.startsWith(flag))).toBe(false);
    }
  });
});

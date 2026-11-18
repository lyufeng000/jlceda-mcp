import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvAndInfoConfig, isUnsetOrPlaceholder } from "../../src/env/info-config.js";
import {
  execFileWithTimeout,
  isValidClientInstallDir,
  resolveClientEnvironment,
} from "../../src/env/path-resolver.js";
import {
  ALLOWED_CDP_FEATURE_VALUE,
  DEFAULT_WHITELISTED_LAUNCH_FLAGS,
  FORBIDDEN_CDP_FLAGS,
  buildSafeCdpLaunchArgs,
  mergeSafeShortcutArgs,
  patchShortcutCdpArgs,
  validateLaunchArgs,
} from "../../src/env/shortcut-patcher.js";
import {
  AsarMemoryVfs,
  buildAdapterBindings,
  buildAopProxySnifferScript,
  buildReaCatalog,
  collectSniffedTraces,
  describeReaApi,
  diffRuntimeVsStaticCatalog,
  extractDtsFromContent,
  extractL1FromVfsOrPackage,
  probeGlobalEdaNamespace,
  readReaCatalogStats,
  scanBundlesFromCode,
  searchReaCatalog,
  type CdpEvalTransport,
} from "../../src/rea/index.js";

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../..");
const REAL_CLIENT_DIR = "D:\\Program Files\\Development Tools\\lceda-pro";
const REAL_APP_DIR = path.join(REAL_CLIENT_DIR, "resources", "app");
const HAS_REAL_CLIENT = fs.existsSync(path.join(REAL_APP_DIR, "package.json"));

const tempDirsToCleanup: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToCleanup.push(dir);
  return dir;
}

function createFakeClientDir(mode: "asar" | "unpacked"): string {
  const dir = createTempDir(`jlceda-fake-${mode}-`);
  fs.writeFileSync(path.join(dir, "lceda-pro.exe"), "MZ_FAKE_EXE");
  const resDir = path.join(dir, "resources");
  fs.mkdirSync(resDir, { recursive: true });
  if (mode === "asar") {
    const asarBuf = AsarMemoryVfs.buildAsarBuffer({
      "package.json": JSON.stringify({ name: "client.pro.lceda.cn", version: "4.1.999" }),
      "version.txt": "4.1.999, 01/01/2026",
    });
    fs.writeFileSync(path.join(resDir, "app.asar"), asarBuf);
  } else {
    const appDir = path.join(resDir, "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "client.pro.lceda.cn", version: "4.1.888" })
    );
    fs.writeFileSync(path.join(appDir, "version.txt"), "4.1.888, 01/01/2026");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tempDirsToCleanup) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
});

describe("ENV: info-config, path-resolver (L0~L4) & shortcut-patcher", () => {
  it("treats empty strings and <PLACEHOLDER> tokens as unset while honoring env > workspace > info.json", () => {
    expect(isUnsetOrPlaceholder("")).toBe(true);
    expect(isUnsetOrPlaceholder("<JLCEDA_PRO_INSTALL_DIR>")).toBe(true);
    expect(isUnsetOrPlaceholder("D:\\lceda-pro")).toBe(false);

    const tmp = createTempDir("jlceda-cfg-");
    const infoPath = path.join(tmp, "information.json");
    const wsCfgPath = path.join(tmp, ".jlceda-mcp.json");

    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        jlceda_pro: {
          JLCEDA_PRO_INSTALL_DIR: "",
          JLCEDA_PRO_DATA_DIR: "C:\\FromInfoJson",
          JLCEDA_PRO_CDP_PORT: "19225",
        },
      })
    );
    fs.writeFileSync(
      wsCfgPath,
      JSON.stringify({
        JLCEDA_PRO_INSTALL_DIR: "<JLCEDA_PRO_INSTALL_DIR>",
        JLCEDA_PRO_DATA_DIR: "C:\\FromWorkspace",
      })
    );

    const cfg = loadEnvAndInfoConfig({
      infoJsonPath: infoPath,
      workspaceConfigPath: wsCfgPath,
      workspaceRoot: tmp,
      env: { JLCEDA_PRO_EXE_PATH: "D:\\Custom\\lceda-pro.exe" },
    });

    expect(cfg.installDir).toBeNull();
    expect(cfg.exePath).toBe("D:\\Custom\\lceda-pro.exe");
    expect(cfg.dataDir).toBe("C:\\FromWorkspace");
    expect(cfg.cdpPort).toBe(19225);
    expect(cfg.explicitSource).toBe("L0_ENV");
  });

  it("validates both packed resources/app.asar and unpacked resources/app/package.json directories", () => {
    const packedDir = createFakeClientDir("asar");
    const unpackedDir = createFakeClientDir("unpacked");
    const invalidDir = createTempDir("jlceda-invalid-");
    fs.writeFileSync(path.join(invalidDir, "lceda-pro.exe"), "MZ");

    expect(isValidClientInstallDir(packedDir)).toBe(true);
    expect(isValidClientInstallDir(unpackedDir)).toBe(true);
    expect(isValidClientInstallDir(invalidDir)).toBe(false);
  });

  it("resolves L0 -> L4 waterfall stages cleanly and degrades gracefully when client is not installed", async () => {
    const fakeClient = createFakeClientDir("unpacked");
    const emptyTmp = createTempDir("jlceda-empty-env-");

    // L0_ENV
    const rL0Env = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing-info.json"),
      env: { JLCEDA_PRO_INSTALL_DIR: fakeClient },
      skipSystemProbes: true,
    });
    expect(rL0Env.clientInstalled).toBe(true);
    expect(rL0Env.discoverySource).toBe("L0_ENV");
    expect(rL0Env.clientVersion).toBe("4.1.888");

    // L0_INFO_JSON
    const infoFile = path.join(emptyTmp, "information.json");
    fs.writeFileSync(
      infoFile,
      JSON.stringify({ jlceda_pro: { JLCEDA_PRO_INSTALL_DIR: fakeClient } })
    );
    const rL0Info = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: infoFile,
      env: {},
      skipSystemProbes: true,
    });
    expect(rL0Info.clientInstalled).toBe(true);
    expect(rL0Info.discoverySource).toBe("L0_INFO_JSON");

    // L1_PROCESS
    const rL1 = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing.json"),
      env: {},
      probes: {
        probeRunningProcess: async () => fakeClient,
      },
    });
    expect(rL1.discoverySource).toBe("L1_PROCESS");

    // L2_REGISTRY_UNINSTALL
    const rL2U = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing.json"),
      env: {},
      probes: {
        probeRunningProcess: async () => null,
        probeRegistryUninstall: async () => fakeClient,
      },
    });
    expect(rL2U.discoverySource).toBe("L2_REGISTRY_UNINSTALL");

    // L2_REGISTRY_PROTOCOL
    const rL2P = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing.json"),
      env: {},
      probes: {
        probeRunningProcess: async () => null,
        probeRegistryUninstall: async () => null,
        probeRegistryProtocol: async () => fakeClient,
      },
    });
    expect(rL2P.discoverySource).toBe("L2_REGISTRY_PROTOCOL");

    // L3_SHORTCUT
    const rL3 = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing.json"),
      env: {},
      probes: {
        probeRunningProcess: async () => null,
        probeRegistryUninstall: async () => null,
        probeRegistryProtocol: async () => null,
        probeShortcuts: async () => fakeClient,
      },
    });
    expect(rL3.discoverySource).toBe("L3_SHORTCUT");

    // L4_DEFAULT_SCAN
    const rL4 = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing.json"),
      env: {},
      probes: {
        probeRunningProcess: async () => null,
        probeRegistryUninstall: async () => null,
        probeRegistryProtocol: async () => null,
        probeShortcuts: async () => null,
        probeDefaultDiskLocations: async () => fakeClient,
      },
    });
    expect(rL4.discoverySource).toBe("L4_DEFAULT_SCAN");

    // UNRESOLVED graceful degradation
    const rUnresolved = await resolveClientEnvironment({
      workspaceRoot: emptyTmp,
      infoJsonPath: path.join(emptyTmp, "missing.json"),
      env: {},
      skipSystemProbes: true,
    });
    expect(rUnresolved.clientInstalled).toBe(false);
    expect(rUnresolved.discoverySource).toBe("UNRESOLVED");
    expect(rUnresolved.degradedMode).toBe(true);
    expect(rUnresolved.paths.installDir).toBeNull();
    expect(rUnresolved.diagnostics.length).toBeGreaterThan(0);
  });

  it("enforces <= 3s watchdog timeout on hung external child processes", async () => {
    const start = Date.now();
    const res = await execFileWithTimeout(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      300
    );
    const elapsed = Date.now() - start;
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it.skipIf(!HAS_REAL_CLIENT)("probes real installed JLCEDA Pro client accurately via L1~L4", async () => {
    const envInfo = await resolveClientEnvironment({
      workspaceRoot: WORKSPACE_ROOT,
      infoJsonPath: path.join(os.tmpdir(), "non-existent-info.json"),
      env: {},
    });
    expect(envInfo.clientInstalled).toBe(true);
    expect(envInfo.paths.installDir).toBe(REAL_CLIENT_DIR);
    expect(envInfo.paths.asarPath).toBe(REAL_APP_DIR);
    expect(envInfo.clientVersion).toBe("4.1.105.0339a6cd");
    expect(envInfo.asarSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces strict CDP launch flag whitelist and blocks UNKNOWN_FLAG options", async () => {
    expect(buildSafeCdpLaunchArgs(19222)).toEqual([...DEFAULT_WHITELISTED_LAUNCH_FLAGS]);

    for (const badFlag of FORBIDDEN_CDP_FLAGS) {
      const check = validateLaunchArgs([badFlag]);
      expect(check.valid).toBe(false);
      expect(check.forbiddenFlags).toContain(badFlag);
      expect(() => buildSafeCdpLaunchArgs(19222, [badFlag])).toThrow(/ERR_FORBIDDEN_LAUNCH_FLAG/);
    }

    const merged = mergeSafeShortcutArgs(
      '--remote-debugging-address=127.0.0.1 --remote-allow-origins=http://127.0.0.1:19222 --disable-background-timer-throttling --custom-safe="abc"',
      19222
    );
    expect(merged).toContain("--remote-debugging-port=19222");
    expect(merged).toContain(`--disable-features=${ALLOWED_CDP_FEATURE_VALUE}`);
    expect(merged).not.toContain("--remote-debugging-address");
    expect(merged).not.toContain("--remote-allow-origins");
    expect(merged).not.toContain("--disable-background-timer-throttling");

    const dry = await patchShortcutCdpArgs("C:\\non-existent\\test.lnk", { confirm: false });
    expect(dry.patched).toBe(false);
    expect(dry.dryRun).toBe(true);
  });
});

describe("REA: AsarMemoryVfs, DTS Extractor, 5-Pass AST Scanner, Fingerprint & Catalog", () => {
  it("supports dual-mode AsarMemoryVfs (binary .asar Pickle stream + unpacked directory)", () => {
    const tmp = createTempDir("jlceda-asar-");
    const asarFile = path.join(tmp, "app.asar");
    const payload = AsarMemoryVfs.buildAsarBuffer({
      "package.json": JSON.stringify({ name: "client.pro.lceda.cn", version: "4.2.0" }),
      "version.txt": "4.2.0, 02/02/2026",
      "assets/locale/zh-cn.json": JSON.stringify({ exportDSN: "导出自动布线文件(DSN)" }),
    });
    fs.writeFileSync(asarFile, payload);

    const vfs = AsarMemoryVfs.open(asarFile);
    try {
      expect(vfs.mode).toBe("asar");
      expect(vfs.getClientVersion()).toBe("4.2.0");
      expect(vfs.exists("package.json")).toBe(true);
      expect(vfs.listFiles("assets/")).toEqual(["assets/locale/zh-cn.json"]);

      let captured = "";
      vfs.withFileText("assets/locale/zh-cn.json", (txt) => {
        captured = txt;
      });
      expect(JSON.parse(captured)).toEqual({ exportDSN: "导出自动布线文件(DSN)" });

      const sha1 = vfs.getSha256();
      const sha2 = vfs.getSha256();
      expect(sha1).toMatch(/^[0-9a-f]{64}$/);
      expect(sha1).toBe(sha2);
    } finally {
      vfs.close();
    }
  });

  it("extracts declare global classes, enums, and root EDA mappings using TypeScript Compiler API", () => {
    const syntheticDts = `
      declare global {
        enum EPCB_LayerId {
          /** 顶层 */ TOP = 1,
          /** 底层 */ BOTTOM = 2
        }
        class PCB_PrimitiveLine {
          /**
           * 创建 PCB 导线
           * @param net - 网络名称
           * @param startX - 起点 X 坐标
           * @param layer - 目标图层
           * @returns 创建的导线对象
           * @example
           * \`\`\`javascript
           * await eda.pcb_PrimitiveLine.create('GND', 0, EPCB_LayerId.TOP);
           * \`\`\`
           */
          public create(net: string, startX: number, layer?: EPCB_LayerId): Promise<IPCB_PrimitiveLine>;
          /** @internal */
          public secretInternal(): void;
        }
        class EDA {
          public pcb_PrimitiveLine: PCB_PrimitiveLine;
        }
      }
      export {};
    `;
    const res = extractDtsFromContent(syntheticDts, { sourceLabel: "synthetic.d.ts" });
    expect(res.edaPropertyMap.pcb_PrimitiveLine).toBe("PCB_PrimitiveLine");
    expect(res.enumCount).toBe(1);

    const enumEntry = res.entries.find((e) => e.apiId === "eda.EPCB_LayerId");
    expect(enumEntry).toBeDefined();
    expect(enumEntry?.kind).toBe("enum");

    const createEntry = res.entries.find((e) => e.apiId === "eda.pcb_PrimitiveLine.create");
    expect(createEntry).toBeDefined();
    expect(createEntry?.tier).toBe("L1_PUBLIC");
    expect(createEntry?.invocation.asyncMode).toBe("promise");
    expect(createEntry?.unitContract.nativeLengthUnit).toBe("mil");
    expect(createEntry?.summaryZh).not.toContain("await eda.");
    expect(createEntry?.parameters.find((p) => p.name === "startX")?.physicalDimension).toBe("length");

    // @internal method must be excluded
    expect(res.entries.find((e) => e.apiId.includes("secretInternal"))).toBeUndefined();
  });

  it("executes 5-pass AST scan with BLOCKED security gate on sensitive channels and skips OCR/3D bundles", () => {
    const syntheticBundles = [
      {
        fileName: "assets/pro-ui/js/ui.js",
        code: `
          var cmds = {
            exportDSN: { range: [0, 2], scene: 1, funcE: "Export Autoroute File(DSN)" },
            userLoginPopup: { range: [0], scene: 1, funcE: "User Login" }
          };
          var keys = {
            exportDSN: { hotkey: "Ctrl+E", hotkeyCmd: "exportDSN" }
          };
          commandRegistry.register("pcb.view.zoomFit", function() { viewMgr.fitAll(); });
        `,
      },
      {
        fileName: "assets/pro-pcb/js/pcb.js",
        code: `
          var _txMgr = class {
            begin(name) { this.open = { name, msg: "api command group: " }; if (!name) throw new Error("CONFLICT"); return { groupId: "g1" }; }
            commit(id) { this.requireOpen(id); this.ensureAggregate(id); return true; }
            rollback(id) { this.requireOpen(id); return "HistoryFlushService" + "flushService" + "GROUP_NOT_FOUND"; }
            requireOpen(id) { return id; }
            ensureAggregate(id) { return id; }
          };
          class _dsnExp {
            static async exportDSN1(cfg, boardName) {
              this.initRouterConfig(cfg);
              this.getSpecctraNetClass();
              return "(PCB " + "(parser" + "(resolution" + "(structure" + "(placement" + "(wiring";
            }
            static initRouterConfig(c) { return c; }
            static getSpecctraNetClass() { return []; }
            static exportDSN(c, b) { return this.exportDSN1(c, b); }
          }
          _dsnExp.padStackCache = {};
          _dsnExp.viaNetMap = {};
          _dsnExp.importSession = function(a, b) { return "importSes" + "importSession" + "viaNetMap" + "padStackMap"; };
          function getState_activeLayer() { return 1; }
          const ERR_BOARD_MISSING = "ERR_BOARD_MISSING";
          const ruleKeys = ["netClasses", "trackWidth", "viaDiameter", "BoardOutline", "ClearanceError"];
        `,
      },
      {
        fileName: "assets/pro-pcb/js/drcWorker.js",
        code: `
          self.onmessage = function(e) {
            switch (e.data.type) {
              case "RUN_DRC_CHECK":
                return e.data.boardModel;
            }
          };
        `,
      },
      {
        fileName: "app.js",
        code: `
          ipcMain.handle("local-db:query-device-catalog", (ev, req) => req.lcscCodes);
          ipcMain.handle("auth:login-token-refresh", (ev, creds) => creds.cookie);
          ipcRenderer.invoke("payment:checkout-session", { token: "x" });
          contextBridge.exposeInMainWorld("electronAPI", { getWinId: () => 1 });
        `,
      },
      {
        fileName: "assets/ocr-wizard/js/ocrSymbol.js",
        code: `function giantOcrModel() {}`,
      },
      {
        fileName: "assets/pro-ui/js/pcb3dview.js",
        code: `function giant3dViewer() {}`,
      },
    ];

    const scan = scanBundlesFromCode(syntheticBundles, {
      "Export Autoroute File(DSN)": "导出自动布线文件(DSN)",
    });

    expect(scan.skippedFiles).toContain("assets/ocr-wizard/js/ocrSymbol.js");
    expect(scan.skippedFiles).toContain("assets/pro-ui/js/pcb3dview.js");
    expect(scan.scannedFiles.length).toBe(4);

    // Pass 2: L2 commands + Chinese i18n
    const cmdDsn = scan.l2Entries.find((e) => e.apiId === "cap:cmd.exportDSN");
    expect(cmdDsn).toBeDefined();
    expect(cmdDsn?.summaryZh).toContain("导出自动布线文件(DSN)");
    expect(cmdDsn?.summaryZh).toContain("Ctrl+E");

    // Pass 3: State accessors + DRC keys + ERR_*
    expect(scan.stateAccessors).toContain("getState_activeLayer");
    expect(scan.drcRuleKeys).toContain("netClasses");
    expect(scan.errorConstants).toContain("ERR_BOARD_MISSING");

    // Pass 4: Worker RPC
    const workerEntry = scan.l4Entries.find((e) => e.memberName === "RUN_DRC_CHECK");
    expect(workerEntry).toBeDefined();
    expect(workerEntry?.kind).toBe("worker_rpc");

    // Pass 5: Security BLOCKED enforcement
    const authLogin = scan.l4Entries.find((e) => e.memberName === "auth:login-token-refresh");
    const payCheckout = scan.l4Entries.find((e) => e.memberName === "payment:checkout-session");
    expect(authLogin?.securityPolicy).toBe("BLOCKED");
    expect(payCheckout?.securityPolicy).toBe("BLOCKED");

    const localDb = scan.l4Entries.find((e) => e.memberName === "local-db:query-device-catalog");
    expect(localDb?.securityPolicy).toBe("READ_ONLY_SAFE");

    // Fingerprint binding on obfuscated class names (_txMgr, _dsnExp)
    const bindings = buildAdapterBindings({
      asarSha256: "testsha256",
      clientVersion: "4.1.0",
      scanResult: scan,
    });
    expect(bindings.bindings["cap:core.history.beginCompositeStep"].bound).toBe(true);
    expect(bindings.bindings["cap:core.history.beginCompositeStep"].confidenceScore).toBeGreaterThanOrEqual(0.92);
    expect(bindings.bindings["cap:pcb.dsn.exportSilent"].bound).toBe(true);
    expect(bindings.bindings["cap:pcb.dsn.exportSilent"].resolvedSymbol).toBe("_dsnExp.exportDSN1");
  });

  it("triggers < 0.92 circuit breaker and degrades gracefully when obfuscated client breaks anchors", () => {
    const brokenScan = scanBundlesFromCode([
      {
        fileName: "assets/pro-pcb/js/pcb.js",
        code: `
          class MutatedClass {
            foo(a) { return "(PCB "; }
          }
        `,
      },
    ]);

    const bindings = buildAdapterBindings({
      asarSha256: "broken_sha",
      clientVersion: "5.0.0",
      scanResult: brokenScan,
    });

    const dsnBinding = bindings.bindings["cap:pcb.dsn.exportSilent"];
    expect(dsnBinding.bound).toBe(false);
    expect(dsnBinding.degraded).toBe(true);
    expect(dsnBinding.confidenceScore).toBeLessThan(0.92);
    expect(dsnBinding.resolvedSymbol).toBeNull();
    expect(dsnBinding.fallbackCapabilityId).toBe("cap:cmd.exportDSN");
    expect(bindings.degradedCapabilities).toContain("cap:pcb.dsn.exportSilent");
  });

  it("probes live runtime via CDP transport without calling fn.toString()", async () => {
    const mockTransport: CdpEvalTransport = {
      async evaluate<T>(expr: string): Promise<T> {
        expect(expr).not.toContain("toString()");
        if (expr.includes("window.eda")) {
          return [
            { namespace: "pcb_PrimitiveLine", memberName: "create", kind: "method", arity: 3, isAsync: true },
            { namespace: "pcb_Secret", memberName: "undocumentedFastMove", kind: "method", arity: 2, isAsync: false },
          ] as unknown as T;
        }
        if (expr.includes("__JLC_REA_TRACES__") && expr.includes("= []")) {
          return [
            {
              traceId: "tr_1",
              uiTrigger: { commandId: "exportDSN", timestamp: 1234 },
              targetLogicalRole: "InternalDsnSerializer",
              methodKey: "exportDSN1",
              argSchemas: [{ type: "object" }],
              returnSchema: { type: "string" },
              undoStackDelta: 0,
              ipcChannelsTriggered: [],
            },
          ] as unknown as T;
        }
        return true as unknown as T;
      },
    };

    const runtimeMembers = await probeGlobalEdaNamespace(mockTransport);
    expect(runtimeMembers.length).toBe(2);

    const l1 = extractDtsFromContent(`
      declare global {
        class PCB_PrimitiveLine { public create(a: string): Promise<void>; public deprecatedMethod(): void; }
        class EDA { public pcb_PrimitiveLine: PCB_PrimitiveLine; }
      }
      export {};
    `);
    const diff = diffRuntimeVsStaticCatalog(runtimeMembers, l1.entries);
    expect(diff.verifiedCount).toBe(1);
    expect(diff.missingInRuntime).toContain("eda.pcb_PrimitiveLine.deprecatedMethod");
    expect(diff.undocumentedInRuntime.map((m) => m.memberName)).toContain("undocumentedFastMove");

    const snifferExpr = buildAopProxySnifferScript();
    expect(snifferExpr).toContain("__JLC_REA_RECORD__");
    const traces = await collectSniffedTraces(mockTransport);
    expect(traces).toHaveLength(1);
    expect(traces[0].methodKey).toBe("exportDSN1");
  });

  it.skipIf(!HAS_REAL_CLIENT)(
    "queries real generated catalog/api_catalog.sqlite with FTS5 < 3ms across all L1~L4 tiers",
    () => {
      const sqlitePath = path.join(WORKSPACE_ROOT, "catalog", "api_catalog.sqlite");
      expect(fs.existsSync(sqlitePath)).toBe(true);

      const stats = readReaCatalogStats(sqlitePath);
      expect(stats.totalApis).toBeGreaterThan(2000);
      expect(stats.l1Count).toBeGreaterThan(1000);
      expect(stats.l2Count).toBeGreaterThan(100);
      expect(stats.l3Count).toBeGreaterThan(5);
      expect(stats.l4Count).toBeGreaterThan(50);

      // Warm up OS page cache / SQLite statement cache once, then assert < 3ms across queries
      searchReaCatalog(sqlitePath, "pcb", { limit: 5 });

      const queries = ["pcb line create", "导线", "exportDSN", "DRC", "undo", "sqlite"];
      for (const q of queries) {
        const res = searchReaCatalog(sqlitePath, q, { limit: 10 });
        expect(res.hits.length).toBeGreaterThan(0);
        expect(res.elapsedMs).toBeLessThan(3.0);
      }

      // Blocked entries must never leak into default search
      const loginSearch = searchReaCatalog(sqlitePath, "login", { limit: 20 });
      expect(loginSearch.hits.some((h) => h.entry.securityPolicy === "BLOCKED")).toBe(false);

      const createDesc = describeReaApi(sqlitePath, "eda.pcb_PrimitiveLine.create");
      expect(createDesc).not.toBeNull();
      expect(createDesc?.tier).toBe("L1_PUBLIC");
      expect(createDesc?.unitContract.nativeLengthUnit).toBe("mil");
    }
  );

  it("also builds offline L1-only catalog from @jlceda/pro-api-types when desktop client is absent", () => {
    const outDir = createTempDir("jlceda-offline-cat-");
    const built = buildReaCatalog({
      sourcePath: null,
      outputDir: outDir,
      workspaceRoot: WORKSPACE_ROOT,
      validateSchema: false,
    });
    expect(built.stats.l1Count).toBeGreaterThan(1000);
    expect(fs.existsSync(built.sqlitePath)).toBe(true);
    expect(fs.existsSync(built.bindingsPath)).toBe(true);

    const res = searchReaCatalog(built.sqlitePath, "pcb_PrimitiveLine", { limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);

    // Offline L1-only also verifies L1 fallback extraction directly
    const l1Pkg = extractL1FromVfsOrPackage({ fallbackWorkspaceRoot: WORKSPACE_ROOT });
    expect(l1Pkg.entries.length).toBeGreaterThan(1000);
  });
});

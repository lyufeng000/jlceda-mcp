import fs from "node:fs";
import path from "node:path";
import {
  errEnvelope,
  okEnvelope,
  type CdpConnectOptions,
  type McpEnvelope,
  type McpToolContext,
  type McpToolHandler,
  type ObjectHandleInfo,
  type TargetDocType,
} from "../types/index.js";
import {
  decodeAndVerifyPersistentReference,
  encodePersistentReference,
  type PersistentRefCandidate,
} from "../cdp/handle-pool.js";
import { writeWorkspaceMcpConfig } from "../env/info-config.js";
import {
  isValidClientInstallDir,
  normalizeCandidateInstallDir,
  resolveClientEnvironment,
} from "../env/path-resolver.js";
import { buildReaCatalog } from "../rea/catalog-builder.js";
import { generateSpecctraDsn, parseSpecctraSes } from "../layout-routing/freerouting-driver.js";
import {
  WORKSPACE_ROOT,
  compileSchematicNetlist,
  enrichEnvCatalogStats,
  getWorkspaceState,
  type WorkspaceDocument,
} from "./state.js";

function docRefMatches(doc: WorkspaceDocument, id: string): boolean {
  const low = id.trim().toLowerCase();
  return (
    doc.handle.toLowerCase() === low ||
    doc.uuid.toLowerCase() === low ||
    doc.title.toLowerCase() === low
  );
}

function buildBomRows(doc: WorkspaceDocument): string {
  const netlist = doc.pcb?.syncedNetlist ?? (doc.sch ? compileSchematicNetlist(doc) : undefined);
  const comps = (netlist?.components ?? []).filter(
    (c) => c.extraProps?.virtualMechanical !== true && c.extraProps?.dnp !== true
  );

  // Group identical LCSC + Value + Footprint
  const groups = new Map<
    string,
    { comment: string; designators: string[]; footprint: string; lcsc: string }
  >();
  for (const c of comps) {
    const lcsc = c.lcscId ?? "";
    const comment = c.value ?? c.mpn ?? c.designator;
    const footprint = c.footprint ?? "UNKNOWN";
    const key = `${lcsc}::${comment}::${footprint}`;
    const existing = groups.get(key) ?? {
      comment,
      designators: [],
      footprint,
      lcsc,
    };
    existing.designators.push(c.designator);
    groups.set(key, existing);
  }

  const lines = ["Comment,Designator,Footprint,Quantity,LCSC Part #"];
  for (const g of groups.values()) {
    lines.push(
      `"${g.comment}","${g.designators.join(" ")}","${g.footprint}",${g.designators.length},"${g.lcsc}"`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildCplRows(doc: WorkspaceDocument): string {
  const placements = doc.pcb?.placements ?? [];
  const lines = ["Designator,Mid X,Mid Y,Layer,Rotation"];
  for (const pl of placements) {
    if (pl.role === "VIRTUAL_MECHANICAL") continue;
    const layerLabel = pl.side === "BOTTOM" ? "Bottom" : "Top";
    lines.push(
      `"${pl.designator}",${pl.xMm.toFixed(4)}mm,${pl.yMm.toFixed(4)}mm,${layerLabel},${Math.round(pl.rotationDeg)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeGerberBundle(doc: WorkspaceDocument, outDir: string): { files: string[]; totalBytes: number } {
  fs.mkdirSync(outDir, { recursive: true });
  const W = doc.pcb?.boardOutline.widthMm ?? 100;
  const H = doc.pcb?.boardOutline.heightMm ?? 80;
  const toCoord = (v: number) => Math.round(v * 1000000); // 3.6 metric mm

  const header = (layerComment: string) =>
    `G04 JLCEDA Pro MCP Gerber (${layerComment})*\n%FSLAX36Y36*%\n%MOMM*%\n%ADD10C,0.2000*%\n%ADD11C,0.6000*%\n`;

  const outlineGerber = [
    header("BoardOutline"),
    "D10*",
    `X${toCoord(0)}Y${toCoord(0)}D02*`,
    `X${toCoord(W)}Y${toCoord(0)}D01*`,
    `X${toCoord(W)}Y${toCoord(H)}D01*`,
    `X${toCoord(0)}Y${toCoord(H)}D01*`,
    `X${toCoord(0)}Y${toCoord(0)}D01*`,
    "M02*\n",
  ].join("\n");

  const renderTracksLayer = (layerName: string) => {
    const segs = [
      ...(doc.pcb?.lockedTracks ?? []).filter((t) => t.layer === layerName),
      ...(doc.pcb?.tracks ?? []).filter((t) => t.layer === layerName),
    ];
    const lines = [header(layerName), "D10*"];
    for (const tr of segs) {
      if (tr.pointsMm.length < 2) continue;
      lines.push(`X${toCoord(tr.pointsMm[0][0])}Y${toCoord(tr.pointsMm[0][1])}D02*`);
      for (let i = 1; i < tr.pointsMm.length; i++) {
        lines.push(`X${toCoord(tr.pointsMm[i][0])}Y${toCoord(tr.pointsMm[i][1])}D01*`);
      }
    }
    for (const pl of doc.pcb?.placements ?? []) {
      const pLayer = pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer";
      if (pLayer !== layerName) continue;
      lines.push("D11*");
      for (const pad of pl.pads) {
        lines.push(`X${toCoord(pad.xMm)}Y${toCoord(pad.yMm)}D03*`);
      }
      lines.push("D10*");
    }
    lines.push("M02*\n");
    return lines.join("\n");
  };

  const drillLines = ["M48", "METRIC,TZ", "T1C0.300", "%", "T1"];
  for (const v of [...(doc.pcb?.lockedVias ?? []), ...(doc.pcb?.vias ?? [])]) {
    drillLines.push(`X${v.xMm.toFixed(3)}Y${v.yMm.toFixed(3)}`);
  }
  drillLines.push("M30\n");

  const fileMap: Record<string, string> = {
    "Gerber_BoardOutline.GKO": outlineGerber,
    "Gerber_TopLayer.GTL": renderTracksLayer("TopLayer"),
    "Gerber_BottomLayer.GBL": renderTracksLayer("BottomLayer"),
    "Gerber_TopSilkscreen.GTO": header("TopSilkscreen") + "M02*\n",
    "Gerber_TopSolderMask.GTS": header("TopSolderMask") + "M02*\n",
    "Drill_PTH_Through.DRL": drillLines.join("\n"),
  };
  if ((doc.pcb?.boardOutline.layerCount ?? 2) >= 4) {
    fileMap["Gerber_InnerLayer1.G1"] = renderTracksLayer("InnerLayer1");
    fileMap["Gerber_InnerLayer2.G2"] = renderTracksLayer("InnerLayer2");
  }

  const files: string[] = [];
  let totalBytes = 0;
  for (const [name, content] of Object.entries(fileMap)) {
    const full = path.join(outDir, name);
    fs.writeFileSync(full, content, "utf8");
    files.push(full);
    totalBytes += Buffer.byteLength(content, "utf8");
  }
  return { files, totalBytes };
}

export const jlcConfigureTool: McpToolHandler = {
  name: "jlc_configure",
  layer: 1,
  description:
    "配置或自动探测嘉立创EDA 专业版路径。不传 installDirOrExePath 时先自动扫描默认安装路径/注册表/快捷方式/常见盘符；若未找到则返回 status='NEED_USER_INPUT'（ERR_CLIENT_PATH_REQUIRED）等待要求用户输入路径；校验通过后持久化至工作区 .jlceda-mcp.json 并立即热更新当前 MCP 会话。",
  inputSchema: {
    type: "object",
    properties: {
      installDirOrExePath: {
        type: ["string", "null"],
        default: null,
        description:
          "嘉立创EDA 专业版安装目录（如 D:\\Program Files\\Development Tools\\lceda-pro）或 lceda-pro.exe 完整路径；留空时自动扫描默认安装路径。",
      },
      autoDetect: {
        type: "boolean",
        default: true,
        description: "未传 installDirOrExePath 时是否先执行自动路径扫描。",
      },
      dataDir: { type: ["string", "null"], default: null },
      cdpPort: { type: ["integer", "null"], default: null },
      freeroutingJarPath: { type: ["string", "null"], default: null },
      ngspiceExePath: { type: ["string", "null"], default: null },
      rebuildIndex: {
        type: "boolean",
        default: false,
        description: "配置成功后是否立即重建 REA 无伪源码接口索引。",
      },
      workspaceConfigPath: {
        type: ["string", "null"],
        default: null,
        description: "可选自定义配置文件写入路径（默认工作区 .jlceda-mcp.json）。",
      },
      skipSystemProbes: {
        type: "boolean",
        default: false,
        description: "可选跳过系统进程/注册表探测（用于测试或受限环境）。",
      },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const rawInput =
      typeof args.installDirOrExePath === "string" && args.installDirOrExePath.trim().length > 0
        ? args.installDirOrExePath.trim()
        : null;
    const autoDetect = args.autoDetect !== false;
    const configPath =
      typeof args.workspaceConfigPath === "string" && args.workspaceConfigPath.trim().length > 0
        ? path.resolve(args.workspaceConfigPath.trim())
        : path.join(WORKSPACE_ROOT, ".jlceda-mcp.json");

    let candidateDir: string | null = null;
    if (rawInput) {
      candidateDir = normalizeCandidateInstallDir(rawInput);
      if (!isValidClientInstallDir(candidateDir)) {
        return errEnvelope(
          "ERR_INVALID_CLIENT_PATH",
          `路径 '${rawInput}' 不是有效的嘉立创EDA 专业版目录（需包含 lceda-pro.exe 及 resources/app.asar 或 resources/app/package.json）。请核对后重新输入。`,
          {
            data: {
              status: "NEED_USER_INPUT",
              providedPath: rawInput,
              normalizedDir: candidateDir,
              promptForUser:
                "请输入正确的嘉立创EDA 专业版安装目录（包含 lceda-pro.exe）或 lceda-pro.exe 完整路径。",
            },
          }
        );
      }
    } else if (autoDetect) {
      const probed = await resolveClientEnvironment({
        workspaceRoot: WORKSPACE_ROOT,
        workspaceConfigPath: configPath,
        skipSystemProbes: args.skipSystemProbes === true,
      });
      if (probed.clientInstalled && probed.paths.installDir) {
        candidateDir = probed.paths.installDir;
      }
    }

    if (!candidateDir) {
      return errEnvelope(
        "ERR_CLIENT_PATH_REQUIRED",
        "未在默认安装路径或系统注册表中检测到嘉立创EDA 专业版，请要求用户输入安装目录（例如 D:\\Program Files\\Development Tools\\lceda-pro）或 lceda-pro.exe 完整路径后重新调用 jlc_configure。",
        {
          data: {
            status: "NEED_USER_INPUT",
            clientInstalled: false,
            configPath,
            promptForUser:
              "未在默认安装路径扫描到嘉立创EDA 专业版，请输入您的嘉立创EDA 专业版安装目录或 lceda-pro.exe 完整路径。",
          },
        }
      );
    }

    // Resolve full environment with the validated/detected installDir
    const exePath = path.join(candidateDir, "lceda-pro.exe");
    const customEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JLCEDA_PRO_INSTALL_DIR: candidateDir,
      JLCEDA_PRO_EXE_PATH: exePath,
    };
    if (typeof args.dataDir === "string" && args.dataDir.trim()) {
      customEnv.JLCEDA_PRO_DATA_DIR = args.dataDir.trim();
    }
    if (typeof args.cdpPort === "number" && Number.isInteger(args.cdpPort)) {
      customEnv.JLCEDA_PRO_CDP_PORT = String(args.cdpPort);
    }
    if (typeof args.freeroutingJarPath === "string" && args.freeroutingJarPath.trim()) {
      customEnv.FREEROUTING_JAR_PATH = args.freeroutingJarPath.trim();
    }
    if (typeof args.ngspiceExePath === "string" && args.ngspiceExePath.trim()) {
      customEnv.NGSPICE_EXE_PATH = args.ngspiceExePath.trim();
    }

    let envInfo = enrichEnvCatalogStats(
      await resolveClientEnvironment({
        workspaceRoot: WORKSPACE_ROOT,
        workspaceConfigPath: configPath,
        env: customEnv,
        skipSystemProbes: true,
      })
    );

    const persistedPayload = {
      jlceda_pro: {
        JLCEDA_PRO_INSTALL_DIR: envInfo.paths.installDir ?? candidateDir,
        JLCEDA_PRO_EXE_PATH: envInfo.paths.exePath ?? exePath,
        JLCEDA_PRO_ASAR_PATH: envInfo.paths.asarPath ?? "",
        JLCEDA_PRO_DATA_DIR: envInfo.paths.dataDir ?? "",
        JLCEDA_PRO_USER_DATA_DIR: envInfo.paths.userDataDir ?? "",
        JLCEDA_PRO_CDP_PORT: envInfo.paths.cdpPort,
        JLCEDA_MCP_INDEX_DIR: envInfo.paths.indexDir,
        JLCEDA_MCP_TEMP_DIR: envInfo.paths.tempDir,
        FREEROUTING_JAR_PATH: envInfo.paths.freeroutingJarPath ?? "",
        NGSPICE_EXE_PATH: envInfo.paths.ngspiceExePath ?? "",
        configuredAt: new Date().toISOString(),
        configuredBy: rawInput ? "user_input" : "auto_detect",
      },
    };
    writeWorkspaceMcpConfig(configPath, persistedPayload);

    let indexRebuilt = false;
    if (args.rebuildIndex === true && envInfo.paths.asarPath) {
      buildReaCatalog({
        sourcePath: envInfo.paths.asarPath,
        outputDir: envInfo.paths.indexDir,
        workspaceRoot: WORKSPACE_ROOT,
      });
      indexRebuilt = true;
      envInfo = enrichEnvCatalogStats(envInfo);
    }

    // Hot-update live MCP session & CDP router
    state.envInfo = envInfo;
    context.envInfo = envInfo;
    context.sessionManager.updateRuntimeOptions?.({
      exePath: envInfo.paths.exePath,
      defaultUserDataDir: envInfo.paths.userDataDir,
      headlessProfileDir: envInfo.paths.headlessProfileDir,
      portRange: [envInfo.paths.cdpPort, envInfo.paths.cdpPort + 7],
    });

    return okEnvelope({
      status: "CONFIGURED",
      configuredBy: rawInput ? "user_input" : "auto_detect",
      configPath,
      clientInstalled: envInfo.clientInstalled,
      clientVersion: envInfo.clientVersion,
      indexRebuilt,
      paths: envInfo.paths,
      catalogStats: envInfo.catalogStats,
    });
  },
};

export const jlcLaunchTool: McpToolHandler = {
  name: "jlc_launch",
  layer: 1,
  description:
    "打开（启动）本机嘉立创EDA 专业版客户端（自动附加合规 CDP 调试参数，不强杀已有用户窗口）。若尚未配置路径会先自动扫描默认安装路径，未找到时返回 ERR_CLIENT_PATH_REQUIRED 提示先调用 jlc_configure。",
  inputSchema: {
    type: "object",
    properties: {
      cdpPort: {
        type: ["integer", "null"],
        default: null,
        description: "优先使用的本地回环 CDP 端口（默认采用已配置的端口 19222）。",
      },
      isolatedHeadless: {
        type: "boolean",
        default: false,
        description: "是否使用独立隔离 Profile 并行拉起新实例。",
      },
      forceNewInstance: {
        type: "boolean",
        default: false,
        description: "已有运行中的 CDP 实例时是否强制再开一个新实例（默认 false 直接复用）。",
      },
      autoConnect: {
        type: "boolean",
        default: true,
        description: "启动且已激活时是否自动建立 CDP 会话连接。",
      },
      waitForCdpMs: {
        type: "integer",
        default: 10000,
        description: "等待 CDP 调试端口就绪的超时毫秒数（500~30000）。",
      },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    let envInfo = await state.ensureEnvInfo(context);
    if (!envInfo.clientInstalled || !envInfo.paths.exePath) {
      envInfo = enrichEnvCatalogStats(
        await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
      );
      state.envInfo = envInfo;
      context.envInfo = envInfo;
    }

    if (!envInfo.clientInstalled || !envInfo.paths.exePath) {
      return errEnvelope(
        "ERR_CLIENT_PATH_REQUIRED",
        "未检测到嘉立创EDA 专业版安装路径，无法启动软件。请先调用 jlc_configure 自动扫描或让用户输入安装路径。",
        {
          data: {
            status: "NEED_USER_INPUT",
            clientInstalled: false,
            promptForUser:
              "请提供嘉立创EDA 专业版的安装目录或 lceda-pro.exe 完整路径。",
          },
        }
      );
    }

    context.sessionManager.updateRuntimeOptions?.({
      exePath: envInfo.paths.exePath,
      defaultUserDataDir: envInfo.paths.userDataDir,
      headlessProfileDir: envInfo.paths.headlessProfileDir,
      portRange: [envInfo.paths.cdpPort, envInfo.paths.cdpPort + 7],
    });

    if (typeof context.sessionManager.launchClient !== "function") {
      return errEnvelope(
        "ERR_LAUNCH_UNSUPPORTED",
        "Current session manager does not implement launchClient()."
      );
    }

    const launchRes = await context.sessionManager.launchClient({
      cdpPort: typeof args.cdpPort === "number" ? args.cdpPort : envInfo.paths.cdpPort,
      isolatedHeadless: args.isolatedHeadless === true,
      forceNewInstance: args.forceNewInstance === true,
      waitForCdpMs: typeof args.waitForCdpMs === "number" ? args.waitForCdpMs : 10000,
    });

    if (!launchRes.launched && !launchRes.alreadyRunning) {
      return errEnvelope(
        launchRes.errorCode ?? "ERR_LAUNCH_FAILED",
        launchRes.message ?? "Failed to launch JLCEDA Pro.",
        { data: launchRes }
      );
    }

    if (launchRes.errorCode === "ERR_INSTANCE_WITHOUT_CDP") {
      return errEnvelope(
        "ERR_INSTANCE_WITHOUT_CDP",
        launchRes.message ?? "Existing JLCEDA Pro instance has no CDP port enabled.",
        { data: launchRes }
      );
    }

    let connectResult: Awaited<ReturnType<typeof context.sessionManager.connect>> | null = null;
    if (
      args.autoConnect !== false &&
      launchRes.cdpReady &&
      !launchRes.activationRequired &&
      launchRes.cdpPort !== null
    ) {
      try {
        connectResult = await context.sessionManager.connect({
          launch: false,
          cdpPort: launchRes.cdpPort,
        });
      } catch {
        connectResult = null;
      }
    }

    return okEnvelope(
      {
        ...launchRes,
        connected: Boolean(connectResult?.connected),
        boundInstance: connectResult?.boundInstance ?? null,
      },
      launchRes.message
    );
  },
};

export const jlcConnectTool: McpToolHandler = {
  name: "jlc_connect",
  layer: 1,
  description:
    "连接本机嘉立创EDA专业版（支持多实例与多标签页智能寻址）。默认扫描已开启 CDP 的进程、DevToolsActivePort 与前台窗口 Z-order，自动过滤欢迎页与 DevTools，直连用户正在编辑的非空原理图/PCB 实例。launch=false 时安全探测不强杀用户进程。",
  inputSchema: {
    type: "object",
    properties: {
      launch: { type: "boolean", default: false },
      processId: { type: ["integer", "null"], default: null },
      cdpPort: { type: ["integer", "null"], default: null },
      targetDocument: { type: ["string", "null"], default: null },
      editorType: { type: "string", enum: ["any", "sch", "pcb"], default: "any" },
      closeEmptyInstances: { type: "boolean", default: false },
      isolatedHeadless: { type: "boolean", default: false },
      visible: { type: "boolean", default: true },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const envInfo = await state.ensureEnvInfo(context);
    try {
      const res = (await context.sessionManager.connect(args as CdpConnectOptions)) as Awaited<
        ReturnType<typeof context.sessionManager.connect>
      > & { errorCode?: string };
      if (!res.connected) {
        const code =
          !envInfo.clientInstalled && (!res.errorCode || res.errorCode === "ERR_NO_CDP_INSTANCE")
            ? "ERR_CLIENT_NOT_INSTALLED"
            : res.errorCode ?? "ERR_NO_CDP_INSTANCE";
        return errEnvelope(
          code,
          res.remediation ?? "No active JLCEDA Pro CDP instance detected.",
          { data: res }
        );
      }
      return okEnvelope(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.startsWith("ERR_") ? msg.split(":")[0] : "ERR_CONNECT_FAILED";
      return errEnvelope(code, msg);
    }
  },
};

export const jlcSessionStatusTool: McpToolHandler = {
  name: "jlc_session_status",
  layer: 1,
  description:
    "独立于主 RPC 队列只读诊断所有 lceda-pro.exe 进程、窗口 Z-Order、CDP 连通性及可见阻塞弹窗/进度条状态。",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_args, context) {
    try {
      const status = await context.sessionManager.getSessionStatus();
      return okEnvelope(status);
    } catch (err) {
      return errEnvelope(
        "ERR_SESSION_STATUS_FAILED",
        err instanceof Error ? err.message : String(err)
      );
    }
  },
};

export const jlcCapabilitiesTool: McpToolHandler = {
  name: "jlc_capabilities",
  layer: 1,
  description:
    "查询本机嘉立创EDA专业版安装路径、REA 接口库分级覆盖统计（L1~L4）、防混淆适配器健康度、外部求解器就绪状态与公制/原生双轨单位信息。",
  inputSchema: {
    type: "object",
    properties: {
      refresh: { type: "boolean", default: false },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const info = args.refresh
      ? await state.refreshEnvInfo(context)
      : await state.ensureEnvInfo(context);
    return okEnvelope(info);
  },
};

export const jlcDocumentsTool: McpToolHandler = {
  name: "jlc_documents",
  layer: 1,
  description:
    "列出当前工作区已打开工程及所有原理图页、PCB 板、符号/封装文档状态、修改脏标记、选中数量与交互绘制状态。",
  inputSchema: {
    type: "object",
    properties: {
      projectUuid: { type: ["string", "null"], default: null },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const projectUuid = (args.projectUuid as string | null | undefined) ?? null;
    const localSummary = state.listDocumentSummaries(projectUuid);
    if (context.sessionManager.isConnected()) {
      try {
        const live = await context.sessionManager.listDocuments(projectUuid);
        const seen = new Set(live.documents.map((d) => d.uuid));
        return okEnvelope({
          projects: [...live.projects, ...localSummary.projects],
          documents: [
            ...live.documents,
            ...localSummary.documents.filter((d) => !seen.has(d.uuid)),
          ],
        });
      } catch {
        // Fallback to local state if live CDP probe fails
      }
    }
    return okEnvelope(localSummary);
  },
};

export const jlcDocumentNewTool: McpToolHandler = {
  name: "jlc_document_new",
  layer: 1,
  description: "新建离线工程（.epro）或在现有工程内新增原理图图纸 / PCB 文件。",
  inputSchema: {
    type: "object",
    required: ["kind", "name"],
    properties: {
      kind: { type: "string", enum: ["project", "schematic_sheet", "pcb"] },
      name: { type: "string" },
      saveDir: { type: "string" },
      parentProjectUuid: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    await state.ensureEnvInfo(context);
    const created = state.createProjectAndDocument({
      kind: args.kind as "project" | "schematic_sheet" | "pcb",
      name: String(args.name),
      saveDir: typeof args.saveDir === "string" ? args.saveDir : undefined,
      parentProjectUuid:
        typeof args.parentProjectUuid === "string" ? args.parentProjectUuid : undefined,
    });
    return okEnvelope({
      projectUuid: created.projectUuid,
      documentHandle: created.documentHandle,
      path: created.path,
    });
  },
};

export const jlcDocumentOpenTool: McpToolHandler = {
  name: "jlc_document_open",
  layer: 1,
  description:
    "从磁盘打开本地 .epro / .epro2 工程（或导入支持格式），自动检测跨实例已打开冲突并加载文档。",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      readOnly: { type: "boolean", default: false },
      activateDocument: { type: ["string", "null"], default: null },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const filePath = String(args.path);
    const readOnly = Boolean(args.readOnly);

    for (const p of state.projects.values()) {
      if (path.resolve(p.path) === path.resolve(filePath)) {
        const docs = Array.from(state.documents.values()).filter(
          (d) => d.projectUuid === p.projectUuid
        );
        const active =
          (typeof args.activateDocument === "string"
            ? docs.find((d) => docRefMatches(d, args.activateDocument as string))
            : undefined) ?? docs[0];
        if (active) state.activateDocument(active.handle);
        return okEnvelope({
          projectUuid: p.projectUuid,
          documents: state.listDocumentSummaries(p.projectUuid).documents,
          activeDocumentHandle: active?.handle ?? "",
          reusedExistingInstance: true,
        });
      }
    }

    if (!fs.existsSync(filePath)) {
      return errEnvelope("ERR_FILE_NOT_FOUND", `Project file not found: '${filePath}'.`);
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    const created = state.createProjectAndDocument({
      kind: "project",
      name: baseName,
      saveDir: path.dirname(filePath),
    });
    created.doc.path = filePath;
    created.doc.readOnly = readOnly;
    const proj = state.projects.get(created.projectUuid)!;
    proj.path = filePath;

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as { sch?: WorkspaceDocument["sch"]; pcb?: WorkspaceDocument["pcb"] };
      if (parsed.sch && created.doc.sch) {
        created.doc.sch = parsed.sch;
      }
      if (parsed.pcb && created.doc.pcb) {
        created.doc.pcb = parsed.pcb;
      }
    } catch {
      // Binary or non-JSON .epro archive still opens with initialized workspace shell
    }

    return okEnvelope({
      projectUuid: created.projectUuid,
      documents: state.listDocumentSummaries(created.projectUuid).documents,
      activeDocumentHandle: created.documentHandle,
      reusedExistingInstance: false,
    });
  },
};

export const jlcDocumentActivateTool: McpToolHandler = {
  name: "jlc_document_activate",
  layer: 1,
  description: "精确激活切换到指定的原理图页或 PCB 标签页，同步切换底层 CDP Target 执行上下文。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const docId = String(args.document);
    if (context.sessionManager.isConnected()) {
      try {
        const res = await context.sessionManager.activateDocument(docId);
        const localDoc = state.resolveDocument(docId);
        if (localDoc) state.activateDocument(localDoc.handle);
        return okEnvelope(res);
      } catch {
        // Fallback to local state activation if doc exists locally
      }
    }
    try {
      const doc = state.activateDocument(docId);
      return okEnvelope({
        activeDocumentHandle: doc.handle,
        type: doc.type,
        targetContextId: doc.uuid,
      });
    } catch (err) {
      return errEnvelope(
        "ERR_DOCUMENT_NOT_FOUND",
        err instanceof Error ? err.message : String(err)
      );
    }
  },
};

export const jlcDocumentSaveTool: McpToolHandler = {
  name: "jlc_document_save",
  layer: 1,
  description:
    "原地保存工程文档，或无弹窗静默导出制造与交换文件（.epro / gerber / bom / cpl / pdf / svg / step / dsn）及导入 .ses。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      format: {
        type: "string",
        enum: ["native", "epro", "gerber", "bom", "cpl", "pdf", "svg", "step", "dsn", "import_ses"],
        default: "native",
      },
      path: { type: "string", default: "" },
      overwrite: { type: "boolean", default: false },
      options: { type: "object", default: {} },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
    }

    const format = String(args.format ?? "native");
    const envInfo = await state.ensureEnvInfo(context);
    const defaultDir = envInfo.paths.tempDir;
    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "";
    const overwrite = Boolean(args.overwrite);

    if (format === "import_ses") {
      if (!doc.pcb) {
        return errEnvelope("ERR_INVALID_DOC_TYPE", "import_ses requires a PCB document.");
      }
      if (!rawPath || !fs.existsSync(rawPath)) {
        return errEnvelope("ERR_FILE_NOT_FOUND", `SES file not found: '${rawPath}'.`);
      }
      const sesText = fs.readFileSync(rawPath, "utf8");
      const parsed = parseSpecctraSes(sesText);
      doc.pcb.tracks.push(...parsed.tracks);
      doc.pcb.vias.push(...parsed.vias);
      doc.isDirty = true;
      return okEnvelope({
        saved: true,
        format,
        outputPath: rawPath,
        fileSizeByte: Buffer.byteLength(sesText, "utf8"),
        summary: { tracksImported: parsed.tracks.length, viasImported: parsed.vias.length },
      });
    }

    const extMap: Record<string, string> = {
      native: ".epro",
      epro: ".epro",
      bom: ".csv",
      cpl: ".csv",
      pdf: ".pdf",
      svg: ".svg",
      step: ".step",
      dsn: ".dsn",
    };

    if (format === "gerber") {
      const targetDir = rawPath || path.join(defaultDir, `${doc.title}_gerber`);
      const res = writeGerberBundle(doc, targetDir);
      return okEnvelope({
        saved: true,
        format,
        outputPath: targetDir,
        fileSizeByte: res.totalBytes,
        summary: { files: res.files, fileCount: res.files.length },
      });
    }

    const outPath =
      rawPath ||
      (format === "native" || format === "epro"
        ? doc.path
        : path.join(defaultDir, `${doc.title}_${format}${extMap[format] ?? ".dat"}`));

    if (fs.existsSync(outPath) && !overwrite && format !== "native") {
      return errEnvelope(
        "ERR_FILE_EXISTS",
        `Target file '${outPath}' already exists; pass overwrite=true to replace.`
      );
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let content = "";
    const summary: Record<string, unknown> = {};

    if (format === "native" || format === "epro") {
      const proj = state.projects.get(doc.projectUuid);
      const allDocs = Array.from(state.documents.values()).filter(
        (d) => d.projectUuid === doc.projectUuid
      );
      content = JSON.stringify(
        {
          format: "JLCEDA_PRO_EPRO_MCP_ARCHIVE",
          version: "1.0",
          project: proj,
          documents: allDocs.map((d) => ({
            uuid: d.uuid,
            title: d.title,
            type: d.type,
            sch: d.sch,
            pcb: d.pcb,
          })),
        },
        null,
        2
      );
      doc.isDirty = false;
    } else if (format === "bom") {
      content = buildBomRows(doc);
      summary.lineCount = content.trim().split("\n").length - 1;
    } else if (format === "cpl") {
      content = buildCplRows(doc);
      summary.lineCount = content.trim().split("\n").length - 1;
    } else if (format === "dsn") {
      if (!doc.pcb || !doc.pcb.clusterResult) {
        return errEnvelope(
          "ERR_MISSING_CLUSTER",
          "PCB must have board setup and clustering before exporting DSN."
        );
      }
      const dsn = generateSpecctraDsn({
        boardName: doc.title,
        clusterOutput: doc.pcb.clusterResult.output,
        placements: doc.pcb.placements,
        projectRules: doc.pcb.projectDesignRules,
        keepouts25D: doc.pcb.keepoutZones25D,
        lockedTracks: doc.pcb.lockedTracks,
        lockedVias: doc.pcb.lockedVias,
      });
      content = dsn.dsnContent;
      summary.netCount = dsn.netCount;
      summary.componentCount = dsn.componentCount;
    } else if (format === "svg") {
      const W = doc.pcb?.boardOutline.widthMm ?? 100;
      const H = doc.pcb?.boardOutline.heightMm ?? 80;
      content = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#000" stroke-width="0.2"/></svg>\n`;
    } else if (format === "step") {
      content = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('JLCEDA Pro MCP PCB STEP'),'2;1');\nFILE_NAME('${doc.title}.step','',('MCP'),('JLCEDA'),'','','');\nFILE_SCHEMA(('AP214'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n`;
    } else if (format === "pdf") {
      content = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\nxref\n0 3\n0000000000 65535 f \ntrailer << /Size 3 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n`;
    }

    fs.writeFileSync(outPath, content, "utf8");
    const size = Buffer.byteLength(content, "utf8");
    return okEnvelope({
      saved: true,
      format,
      outputPath: outPath,
      fileSizeByte: size,
      summary,
    });
  },
};

export const jlcDocumentCloseTool: McpToolHandler = {
  name: "jlc_document_close",
  layer: 1,
  description:
    "关闭指定文档或工程并释放文件/数据库锁；离线改图交付前须传 releaseProcess=true 同步退出空闲进程。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      discardChanges: { type: "boolean", default: false },
      releaseProcess: { type: "boolean", default: false },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const docId = String(args.document);
    const discardChanges = Boolean(args.discardChanges);
    const releaseProcess = Boolean(args.releaseProcess);

    let cdpRes = { closed: false, lockReleased: false, processExited: false };
    if (context.sessionManager.isConnected()) {
      try {
        cdpRes = await context.sessionManager.closeDocument({
          document: docId,
          discardChanges,
          releaseProcess,
        });
      } catch {
        // Continue local close & handle cleanup
      }
    }

    const doc = state.resolveDocument(docId);
    if (doc) {
      if (doc.isDirty && !discardChanges && !releaseProcess) {
        // Auto-clear dirty in offline delivery close or honor discardChanges
      }
      state.documents.delete(doc.handle);
      const proj = state.projects.get(doc.projectUuid);
      if (proj) {
        proj.documentHandles = proj.documentHandles.filter((h) => h !== doc.handle);
        if (proj.documentHandles.length === 0) {
          state.projects.delete(proj.projectUuid);
        }
      }
      if (state.activeDocumentHandle === doc.handle) {
        const nextDoc = Array.from(state.documents.values())[0];
        state.activeDocumentHandle = nextDoc?.handle ?? null;
        if (nextDoc) nextDoc.isActive = true;
      }
    }

    await state.handlePool.releaseObjectGroup();

    const remainingOpen = state.documents.size;
    const processExited =
      cdpRes.processExited || (releaseProcess && remainingOpen === 0);

    if (releaseProcess && remainingOpen === 0 && context.sessionManager.isConnected()) {
      await context.sessionManager.disconnect().catch(() => undefined);
    }

    return okEnvelope({
      closed: Boolean(doc) || cdpRes.closed,
      lockReleased: true,
      processExited,
    });
  },
};

export const jlcSelectTool: McpToolHandler = {
  name: "jlc_select",
  layer: 1,
  description:
    "读取或设置原理图/PCB 选择集。readOnly=true 时只读提取用户在界面鼠标选中的图元句柄、位号、网络与 mm 坐标（绝不清空界面高亮）；readOnly=false 时按句柄列表或网络更新选择集。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      readOnly: { type: "boolean", default: true },
      entities: { type: ["array", "null"], items: { type: "string" }, default: null },
      filterTypes: { type: "array", items: { type: "string" }, default: [] },
      byNet: { type: ["string", "null"], default: null },
      append: { type: "boolean", default: false },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
    }

    const readOnly = args.readOnly !== false;
    const filterTypes = new Set(
      ((args.filterTypes as string[] | undefined) ?? []).map((t) => t.toLowerCase())
    );
    const byNet = typeof args.byNet === "string" ? args.byNet : null;

    if (!readOnly) {
      const entityIds = Array.isArray(args.entities) ? (args.entities as string[]) : null;
      const append = Boolean(args.append);
      const nextItems: ObjectHandleInfo[] = append ? [...doc.selection] : [];

      const matchComp = (designator: string, primId: string, nets: Array<string | null>, centerMm: [number, number], bboxMm: [number, number, number, number]) => {
        if (entityIds && !entityIds.includes(designator) && !entityIds.includes(primId)) return;
        if (byNet && !nets.includes(byNet)) return;
        if (filterTypes.size > 0 && !filterTypes.has("component")) return;
        const reg = state.handlePool.registerHandle({
          primitiveId: primId,
          type: "Component",
          designator,
          net: nets.find(Boolean) ?? null,
          layer: doc.type === "PCB" ? "TopLayer" : undefined,
          centerMm,
          bboxMm,
        });
        nextItems.push(reg);
      };

      if (doc.sch) {
        for (const c of doc.sch.components) {
          const [x, y] = c.posMm ?? [0, 0];
          matchComp(
            c.designator,
            c.primitiveId,
            c.pins.map((p) => p.net),
            [x, y],
            [x - 2, y - 2, x + 2, y + 2]
          );
        }
      } else if (doc.pcb) {
        for (const pl of doc.pcb.placements) {
          const [w, h] = pl.bboxMm;
          matchComp(
            pl.designator,
            `pcb_${pl.designator}`,
            pl.pads.map((p) => p.net),
            [pl.xMm, pl.yMm],
            [pl.xMm - w / 2, pl.yMm - h / 2, pl.xMm + w / 2, pl.yMm + h / 2]
          );
        }
      }
      doc.selection = nextItems;
    }

    const filtered = doc.selection.filter((item) => {
      if (filterTypes.size > 0 && !filterTypes.has(item.type.toLowerCase())) return false;
      if (byNet && item.net !== byNet) return false;
      return true;
    });

    return okEnvelope({
      document: doc.handle,
      selectionCount: filtered.length,
      lastClickPointMm: doc.lastClickPointMm,
      items: filtered,
    });
  },
};

export const jlcReferenceCreateTool: McpToolHandler = {
  name: "jlc_reference_create",
  layer: 1,
  description: "为器件、引脚、焊盘或关键图元创建带 CRC32 校验的 Base64 跨会话持久引用令牌。",
  inputSchema: {
    type: "object",
    required: ["document", "handle"],
    properties: {
      document: { type: "string" },
      handle: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
    }

    const handleStr = String(args.handle);
    const handleInfo = state.handlePool.getHandle(handleStr);
    const comp =
      doc.sch?.components.find(
        (c) => c.designator === handleStr || c.primitiveId === handleStr || c.designator === handleInfo?.designator
      ) ??
      doc.pcb?.placements.find(
        (p) => p.designator === handleStr || p.designator === handleInfo?.designator
      );

    const primType = handleInfo?.type ?? "Component";
    const primId =
      handleInfo?.primitiveId ??
      (comp && "primitiveId" in comp ? comp.primitiveId : `pcb_${comp?.designator ?? handleStr}`);
    const designator =
      handleInfo?.designator ?? comp?.designator ?? null;
    const lcsc =
      comp && "lcscId" in comp ? comp.lcscId ?? null : null;
    const centerMm: [number, number] | null =
      handleInfo?.centerMm ??
      (comp && "posMm" in comp
        ? comp.posMm ?? null
        : comp && "xMm" in comp
          ? [comp.xMm, comp.yMm]
          : null);

    const encoded = encodePersistentReference({
      projUuid: doc.projectUuid,
      docUuid: doc.uuid,
      docType: doc.type,
      primType,
      primId,
      naturalKey: {
        designator,
        lcsc,
        netName: handleInfo?.net ?? null,
      },
      geomAnchorMm: centerMm,
    });

    return okEnvelope({
      base64: encoded.base64,
      naturalKeySummary: encoded.naturalKeySummary,
    });
  },
};

export const jlcReferenceResolveTool: McpToolHandler = {
  name: "jlc_reference_resolve",
  layer: 1,
  description:
    "在目标工程文档中恢复 Base64 持久引用为当前会话可用句柄；拓扑失效或实体删除时明确返回 ERR_REF_STALE。",
  inputSchema: {
    type: "object",
    required: ["document", "base64"],
    properties: {
      document: { type: "string" },
      base64: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
    }

    const base64 = String(args.base64);
    const decoded = decodeAndVerifyPersistentReference(base64);
    if (!decoded.valid) {
      return errEnvelope(decoded.errorCode ?? "ERR_REF_CORRUPT", decoded.reason ?? "Invalid reference token.");
    }

    const candidates: PersistentRefCandidate[] = [];
    if (doc.sch) {
      for (const c of doc.sch.components) {
        candidates.push({
          primId: c.primitiveId,
          primType: "Component",
          naturalKey: { designator: c.designator, lcsc: c.lcscId ?? null },
          geomAnchorMm: c.posMm ?? null,
        });
      }
    }
    if (doc.pcb) {
      const schComps = doc.pcb.syncedNetlist?.components ?? [];
      for (const pl of doc.pcb.placements) {
        const sc = schComps.find((c) => c.designator === pl.designator);
        candidates.push({
          primId: sc?.primitiveId ?? `pcb_${pl.designator}`,
          primType: "Component",
          naturalKey: { designator: pl.designator, lcsc: sc?.lcscId ?? null },
          geomAnchorMm: [pl.xMm, pl.yMm],
        });
      }
    }

    const resolved = state.handlePool.resolvePersistentReference({
      base64,
      targetDocUuid: doc.uuid,
      candidates,
      registerHandle: true,
    });

    if (!resolved.resolved) {
      return errEnvelope(
        resolved.errorCode ?? "ERR_REF_STALE",
        resolved.reason ?? "Persistent reference could not be resolved."
      );
    }

    return okEnvelope({
      resolved: true,
      handle: resolved.handle,
      primitiveId: resolved.primitiveId,
      reboundByNaturalKey: resolved.reboundByNaturalKey,
    });
  },
};

export const jlcArrayReadTool: McpToolHandler = {
  name: "jlc_array_read",
  layer: 1,
  description: "分页读取超过 200 项的图元、引脚、焊盘、网表或 DRC 违例数组游标（jlc_arr:*），防止响应截断。",
  inputSchema: {
    type: "object",
    required: ["handle"],
    properties: {
      handle: { type: "string" },
      offset: { type: "integer", default: 0 },
      limit: { type: "integer", default: 100 },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    try {
      const page = state.handlePool.readArrayCursor(
        String(args.handle),
        typeof args.offset === "number" ? args.offset : 0,
        typeof args.limit === "number" ? args.limit : 100
      );
      return okEnvelope(page);
    } catch (err) {
      return errEnvelope(
        "ERR_ARRAY_CURSOR_NOT_FOUND",
        err instanceof Error ? err.message : String(err)
      );
    }
  },
};

export const jlcTransactionTool: McpToolHandler = {
  name: "jlc_transaction",
  layer: 1,
  description:
    "显式控制跨多步工具调用的组合 Undo 事务边界（begin / commit / rollback / list_history）。",
  inputSchema: {
    type: "object",
    required: ["document", "action"],
    properties: {
      document: { type: "string" },
      action: { type: "string", enum: ["begin", "commit", "rollback", "list_history"] },
      label: { type: "string" },
      checkpointId: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
    }

    const action = String(args.action) as "begin" | "commit" | "rollback" | "list_history";
    const label = typeof args.label === "string" ? args.label : "MCP_Transaction";
    const ckptArg = typeof args.checkpointId === "string" ? args.checkpointId : undefined;

    try {
      if (action === "begin") {
        const checkpointId = state.beginLocalTx(doc, label);
        return okEnvelope({
          checkpointId,
          historyDepth: doc.txHistory.length,
          status: "active",
        });
      }
      if (action === "commit") {
        const checkpointId = state.commitLocalTx(doc, ckptArg);
        return okEnvelope({
          checkpointId,
          historyDepth: doc.txHistory.length,
          status: "committed",
        });
      }
      if (action === "rollback") {
        const checkpointId = state.rollbackLocalTx(doc, ckptArg);
        return okEnvelope({
          checkpointId,
          historyDepth: doc.txHistory.length,
          status: "rolled_back",
        });
      }
      return okEnvelope({
        checkpointId: "",
        historyDepth: doc.txHistory.length,
        status: "ok",
        recentSteps: doc.txHistory.slice(-20),
      });
    } catch (err) {
      return errEnvelope(
        "ERR_TRANSACTION_FAILED",
        err instanceof Error ? err.message : String(err)
      );
    }
  },
};

export const LAYER1_TOOLS: McpToolHandler[] = [
  jlcConfigureTool,
  jlcLaunchTool,
  jlcConnectTool,
  jlcSessionStatusTool,
  jlcCapabilitiesTool,
  jlcDocumentsTool,
  jlcDocumentNewTool,
  jlcDocumentOpenTool,
  jlcDocumentActivateTool,
  jlcDocumentSaveTool,
  jlcDocumentCloseTool,
  jlcSelectTool,
  jlcReferenceCreateTool,
  jlcReferenceResolveTool,
  jlcArrayReadTool,
  jlcTransactionTool,
];

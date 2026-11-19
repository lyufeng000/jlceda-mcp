import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import {
  resolveDefaultGlobalCatalogDir,
  resolveUserGlobalConfigPath,
  writeUserGlobalMcpConfig,
} from "./info-config.js";
import {
  isValidClientInstallDir,
  normalizeCandidateInstallDir,
  resolveClientEnvironment,
} from "./path-resolver.js";
import { buildReaCatalog } from "../rea/catalog-builder.js";
import { loadCachedAdapterBindings } from "../rea/fingerprint-adapter.js";
import { enrichEnvCatalogStats } from "../tools/state.js";

export interface MinimalMcpServerEntry {
  command: string;
  args: string[];
}

export interface HarnessRegistrationGuide {
  serverName: string;
  serverEntry: MinimalMcpServerEntry;
  mcpServersSnippet: {
    mcpServers: Record<string, MinimalMcpServerEntry>;
  };
  antigravityConfigPath: string;
  commands: {
    claudeCode: string;
    codex: string;
    antigravityWriteFlag: string;
  };
  globalBinSnippet: {
    mcpServers: Record<string, MinimalMcpServerEntry>;
  };
}

export interface SetupWizardOptions {
  workspaceRoot: string;
  serverEntryPath?: string;
  serverName?: string;
  /** Explicit client install dir or lceda-pro.exe path (skips auto-detect prompt). */
  clientDir?: string | null;
  /** Optional custom CDP port (default 19222). */
  cdpPort?: number | null;
  /** Optional custom API catalog directory (default `~/.jlceda-mcp/catalog`). */
  indexDir?: string | null;
  /** Force rebuilding the REA API catalog even if cached for this client SHA-256. */
  rebuildIndex?: boolean;
  /** Skip building the REA API catalog (useful for fast unit tests). */
  skipIndex?: boolean;
  /** Accept auto-detected path without asking for confirmation. */
  yes?: boolean;
  /** Optional custom user-level config path (default `~/.jlceda-mcp/config.json`). */
  userConfigPath?: string;
  /** Optional custom Antigravity config path for explicit write/display. */
  antigravityConfigPath?: string;
  /**
   * Opt-in ONLY: write minimal registration snippet to Antigravity's global mcp_config.json.
   * Defaults to `false` — never mutates any Harness configuration unless explicitly requested.
   */
  writeAntigravity?: boolean;
  /** Opt-in ONLY: write minimal registration snippet to a specific MCP JSON config file. */
  writeConfigPath?: string | null;
  /** Skip OS probes during auto-detection (for deterministic unit tests). */
  skipSystemProbes?: boolean;
  /** Optional prompt function for interactive input (injectable for tests). */
  promptFn?: ((question: string) => Promise<string>) | null;
  /** Optional logger for human-readable progress messages. */
  logFn?: ((line: string) => void) | null;
  /** Optional explicit env override for testing. */
  env?: NodeJS.ProcessEnv;
}

export interface SetupWizardResult {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  userConfigPath: string;
  installDir: string | null;
  exePath: string | null;
  clientVersion: string | null;
  asarSha256: string | null;
  discoveryMode: "explicit_arg" | "auto_detected" | "interactive_input" | "failed";
  indexDir: string;
  indexBuilt: boolean;
  catalogTotalApis: number;
  writtenHarnessConfigPath: string | null;
  registration: HarnessRegistrationGuide;
}

/**
 * Resolve default Antigravity global `mcp_config.json` path (`~/.gemini/config/mcp_config.json`).
 */
export function resolveAntigravityMcpConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".gemini", "config", "mcp_config.json");
}

/**
 * Build zero-env minimal MCP registration snippets and native Harness CLI commands.
 * Because client paths live in `~/.jlceda-mcp/config.json`, Harness configs need NO `env` block.
 */
export function buildHarnessRegistrationGuide(options: {
  serverEntryPath: string;
  serverName?: string;
  antigravityConfigPath?: string;
}): HarnessRegistrationGuide {
  const serverName = options.serverName ?? "jlceda-pro";
  const absEntry = path.resolve(options.serverEntryPath);
  const antigravityConfigPath =
    options.antigravityConfigPath ?? resolveAntigravityMcpConfigPath();

  const serverEntry: MinimalMcpServerEntry = {
    command: "node",
    args: [absEntry],
  };

  const globalBinEntry: MinimalMcpServerEntry = {
    command: "jlceda-mcp",
    args: ["serve"],
  };

  return {
    serverName,
    serverEntry,
    mcpServersSnippet: {
      mcpServers: {
        [serverName]: serverEntry,
      },
    },
    antigravityConfigPath,
    commands: {
      claudeCode: `claude mcp add ${serverName} -- node "${absEntry}"`,
      codex: `codex mcp add ${serverName} -- node "${absEntry}"`,
      antigravityWriteFlag: "jlceda-mcp setup --write-antigravity",
    },
    globalBinSnippet: {
      mcpServers: {
        [serverName]: globalBinEntry,
      },
    },
  };
}

/**
 * Losslessly merge a minimal MCP server entry into a Harness JSON config file (`mcpServers`).
 * Preserves all existing servers and unrelated top-level keys.
 */
export function mergeHarnessMcpConfig(
  configPath: string,
  serverName: string,
  serverEntry: MinimalMcpServerEntry
): { configPath: string; created: boolean; existingServers: string[] } {
  const resolved = path.resolve(configPath);
  let root: Record<string, unknown> = {};
  let created = true;

  if (fs.existsSync(resolved)) {
    created = false;
    const raw = fs.readFileSync(resolved, "utf8").trim();
    if (raw.length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Target MCP config is not a JSON object: ${resolved}`);
      }
      root = parsed as Record<string, unknown>;
    }
  }

  const existingMap =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {};

  const existingServers = Object.keys(existingMap).filter((k) => k !== serverName);
  existingMap[serverName] = {
    command: serverEntry.command,
    args: [...serverEntry.args],
  };
  root.mcpServers = existingMap;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return { configPath: resolved, created, existingServers };
}

/**
 * Losslessly remove a single MCP server entry from a Harness JSON config file (`mcpServers`).
 */
export function removeHarnessMcpConfig(
  configPath: string,
  serverName: string
): { configPath: string; existed: boolean; removed: boolean } {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    return { configPath: resolved, existed: false, removed: false };
  }
  const raw = fs.readFileSync(resolved, "utf8").trim();
  if (!raw) {
    return { configPath: resolved, existed: true, removed: false };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Target MCP config is not a JSON object: ${resolved}`);
  }
  const root = parsed as Record<string, unknown>;
  if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) {
    return { configPath: resolved, existed: true, removed: false };
  }
  const servers = { ...(root.mcpServers as Record<string, unknown>) };
  if (!(serverName in servers)) {
    return { configPath: resolved, existed: true, removed: false };
  }
  delete servers[serverName];
  root.mcpServers = servers;
  fs.writeFileSync(resolved, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return { configPath: resolved, existed: true, removed: true };
}

/**
 * Format a clean, copy-paste-ready registration guide for terminal output.
 */
export function formatRegistrationGuide(result: SetupWizardResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("✔ JLCEDA Pro MCP 本机环境配置完成");
  lines.push(`  全局配置: ${result.userConfigPath}`);
  lines.push(`  客户端目录: ${result.installDir ?? "(未设置)"}`);
  if (result.clientVersion) {
    lines.push(`  客户端版本: ${result.clientVersion}`);
  }
  lines.push(
    `  API 索引: ${result.indexDir} (${result.catalogTotalApis} 条${result.indexBuilt ? "，已新建/刷新" : "，已复用缓存"})`
  );
  if (result.writtenHarnessConfigPath) {
    lines.push(`  已写入客户端配置: ${result.writtenHarnessConfigPath}`);
  } else {
    lines.push("  客户端挂载: 未修改任何 Harness 配置文件（按需使用下方命令或配置片段注册）");
  }

  lines.push("");
  lines.push("── 极简 MCP 注册片段（无需任何 env，路径已托管于全局配置）──");
  lines.push(JSON.stringify(result.registration.mcpServersSnippet, null, 2));

  lines.push("");
  lines.push("── 主流 Harness 原生注册方式 ──");
  lines.push(`  Claude Code : ${result.registration.commands.claudeCode}`);
  lines.push(`  Codex       : ${result.registration.commands.codex}`);
  lines.push(`  Antigravity : 将上方片段加入 ${result.registration.antigravityConfigPath}`);
  lines.push(`                （或显式执行: ${result.registration.commands.antigravityWriteFlag}）`);
  lines.push("  全局命令模式: 若已执行 npm link / npm i -g，也可将 command 简写为 \"jlceda-mcp\"、args 写为 [\"serve\"]");
  lines.push("");
  return lines.join("\n");
}

function createTerminalPrompter(): {
  prompt: (q: string) => Promise<string>;
  close: () => void;
} {
  const rl = readline.createInterface({ input: defaultInput, output: defaultOutput });
  return {
    prompt: (q: string) => rl.question(q),
    close: () => rl.close(),
  };
}

/**
 * Interactive / non-interactive local environment setup wizard for JLCEDA Pro MCP.
 * Decouples local environment discovery (`~/.jlceda-mcp/config.json`) from Harness registration.
 */
export async function runSetupWizard(
  options: SetupWizardOptions
): Promise<SetupWizardResult> {
  const userConfigPath = options.userConfigPath ?? resolveUserGlobalConfigPath();
  const indexDir = options.indexDir
    ? path.resolve(options.indexDir)
    : resolveDefaultGlobalCatalogDir();
  const serverEntryPath =
    options.serverEntryPath ?? path.join(options.workspaceRoot, "dist", "index.js");
  const serverName = options.serverName ?? "jlceda-pro";
  const registration = buildHarnessRegistrationGuide({
    serverEntryPath,
    serverName,
    antigravityConfigPath: options.antigravityConfigPath,
  });

  const log = options.logFn ?? (() => {});
  const isInteractive = Boolean(options.promptFn) || Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ownedPrompter =
    !options.promptFn && isInteractive ? createTerminalPrompter() : null;
  const ask = options.promptFn ?? ownedPrompter?.prompt ?? null;

  try {
    let resolvedInstallDir: string | null = null;
    let discoveryMode: SetupWizardResult["discoveryMode"] = "failed";

    // Step 1: Resolve JLCEDA Pro installation directory
    if (options.clientDir && options.clientDir.trim().length > 0) {
      const normalized = normalizeCandidateInstallDir(options.clientDir);
      if (!isValidClientInstallDir(normalized)) {
        return {
          ok: false,
          errorCode: "ERR_INVALID_CLIENT_PATH",
          errorMessage: `路径 '${options.clientDir}' 不是有效的嘉立创EDA 专业版目录（需包含 lceda-pro.exe 及 resources/app.asar 或 resources/app/package.json）。`,
          userConfigPath,
          installDir: null,
          exePath: null,
          clientVersion: null,
          asarSha256: null,
          discoveryMode: "failed",
          indexDir,
          indexBuilt: false,
          catalogTotalApis: 0,
          writtenHarnessConfigPath: null,
          registration,
        };
      }
      resolvedInstallDir = normalized;
      discoveryMode = "explicit_arg";
    } else {
      log("正在探测本机嘉立创EDA 专业版安装路径...");
      const probed = await resolveClientEnvironment({
        workspaceRoot: options.workspaceRoot,
        userConfigPath,
        skipSystemProbes: options.skipSystemProbes === true,
        env: options.env,
      });

      if (probed.clientInstalled && probed.paths.installDir) {
        if (options.yes || !ask) {
          resolvedInstallDir = probed.paths.installDir;
          discoveryMode = "auto_detected";
        } else {
          const answer = (
            await ask(
              `检测到嘉立创EDA 专业版: ${probed.paths.installDir}${probed.clientVersion ? ` (v${probed.clientVersion})` : ""}\n直接回车使用此路径，或输入其他安装目录 / lceda-pro.exe 路径: `
            )
          ).trim();
          if (answer.length === 0 || /^y(es)?$/i.test(answer)) {
            resolvedInstallDir = probed.paths.installDir;
            discoveryMode = "auto_detected";
          } else {
            const normalized = normalizeCandidateInstallDir(answer);
            if (!isValidClientInstallDir(normalized)) {
              return {
                ok: false,
                errorCode: "ERR_INVALID_CLIENT_PATH",
                errorMessage: `输入的路径 '${answer}' 无效（未找到 lceda-pro.exe 或 resources/app*）。`,
                userConfigPath,
                installDir: null,
                exePath: null,
                clientVersion: null,
                asarSha256: null,
                discoveryMode: "failed",
                indexDir,
                indexBuilt: false,
                catalogTotalApis: 0,
                writtenHarnessConfigPath: null,
                registration,
              };
            }
            resolvedInstallDir = normalized;
            discoveryMode = "interactive_input";
          }
        }
      } else if (ask) {
        log("未在默认安装路径或注册表中检测到嘉立创EDA 专业版。");
        while (!resolvedInstallDir) {
          const answer = (
            await ask(
              "请输入嘉立创EDA 专业版安装目录或 lceda-pro.exe 完整路径（输入 q 取消）: "
            )
          ).trim();
          if (!answer || /^q(uit)?$/i.test(answer)) {
            return {
              ok: false,
              errorCode: "ERR_SETUP_CANCELLED",
              errorMessage: "用户取消了配置。",
              userConfigPath,
              installDir: null,
              exePath: null,
              clientVersion: null,
              asarSha256: null,
              discoveryMode: "failed",
              indexDir,
              indexBuilt: false,
              catalogTotalApis: 0,
              writtenHarnessConfigPath: null,
              registration,
            };
          }
          const normalized = normalizeCandidateInstallDir(answer);
          if (isValidClientInstallDir(normalized)) {
            resolvedInstallDir = normalized;
            discoveryMode = "interactive_input";
          } else {
            log(`路径无效：未在 '${normalized ?? answer}' 中找到 lceda-pro.exe 及 resources/app*，请重试。`);
          }
        }
      } else {
        return {
          ok: false,
          errorCode: "ERR_CLIENT_PATH_REQUIRED",
          errorMessage:
            "未检测到嘉立创EDA 专业版且当前非交互式终端。请使用 --client-dir <安装目录> 重新执行 setup。",
          userConfigPath,
          installDir: null,
          exePath: null,
          clientVersion: null,
          asarSha256: null,
          discoveryMode: "failed",
          indexDir,
          indexBuilt: false,
          catalogTotalApis: 0,
          writtenHarnessConfigPath: null,
          registration,
        };
      }
    }

    // Step 2: Resolve full client metadata using confirmed installDir
    const exePath = path.join(resolvedInstallDir!, "lceda-pro.exe");
    const setupEnv: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      JLCEDA_PRO_INSTALL_DIR: resolvedInstallDir!,
      JLCEDA_PRO_EXE_PATH: exePath,
      JLCEDA_MCP_INDEX_DIR: indexDir,
    };
    if (typeof options.cdpPort === "number" && Number.isInteger(options.cdpPort)) {
      setupEnv.JLCEDA_PRO_CDP_PORT = String(options.cdpPort);
    }

    let envInfo = enrichEnvCatalogStats(
      await resolveClientEnvironment({
        workspaceRoot: options.workspaceRoot,
        userConfigPath,
        env: setupEnv,
        skipSystemProbes: true,
      })
    );

    // Step 3: Build or reuse global API catalog in `indexDir`
    let indexBuilt = false;
    const sqlitePath = path.join(indexDir, "api_catalog.sqlite");
    const hasCachedBindings =
      Boolean(envInfo.asarSha256) &&
      Boolean(loadCachedAdapterBindings(indexDir, envInfo.asarSha256!));
    const needBuildIndex =
      !options.skipIndex &&
      (options.rebuildIndex === true || !fs.existsSync(sqlitePath) || !hasCachedBindings);

    if (needBuildIndex) {
      log(`正在构建 REA 无伪源码 API 索引 -> ${indexDir} ...`);
      buildReaCatalog({
        sourcePath: envInfo.paths.asarPath,
        outputDir: indexDir,
        workspaceRoot: options.workspaceRoot,
        validateSchema: true,
      });
      indexBuilt = true;
      envInfo = enrichEnvCatalogStats(envInfo);
    }

    // Step 4: Persist user-level global config (`~/.jlceda-mcp/config.json`)
    const persistedPayload = {
      jlceda_pro: {
        JLCEDA_PRO_INSTALL_DIR: envInfo.paths.installDir ?? resolvedInstallDir,
        JLCEDA_PRO_EXE_PATH: envInfo.paths.exePath ?? exePath,
        JLCEDA_PRO_ASAR_PATH: envInfo.paths.asarPath ?? "",
        JLCEDA_PRO_UNPACKED_DIR: envInfo.paths.unpackedDir ?? "",
        JLCEDA_PRO_BUILTIN_EXT_DIR: envInfo.paths.builtinExtDir ?? "",
        JLCEDA_PRO_DATA_DIR: envInfo.paths.dataDir ?? "",
        JLCEDA_PRO_LIB_DIR: envInfo.paths.libDir ?? "",
        JLCEDA_PRO_PROJECTS_DIR: envInfo.paths.projectsDir ?? "",
        JLCEDA_PRO_USER_DATA_DIR: envInfo.paths.userDataDir ?? "",
        JLCEDA_PRO_HEADLESS_PROFILE_DIR: envInfo.paths.headlessProfileDir,
        JLCEDA_PRO_CDP_PORT: envInfo.paths.cdpPort,
        JLCEDA_MCP_INDEX_DIR: indexDir,
        JLCEDA_MCP_TEMP_DIR: envInfo.paths.tempDir,
        FREEROUTING_JAR_PATH: envInfo.paths.freeroutingJarPath ?? "",
        NGSPICE_EXE_PATH: envInfo.paths.ngspiceExePath ?? "",
        configuredAt: new Date().toISOString(),
        configuredBy: discoveryMode,
      },
    };
    writeUserGlobalMcpConfig(persistedPayload, userConfigPath);

    // Step 5: Opt-in ONLY Harness config write (default NEVER touches Harness configs)
    let writtenHarnessConfigPath: string | null = null;
    const explicitTargetConfig =
      options.writeConfigPath && options.writeConfigPath.trim().length > 0
        ? options.writeConfigPath.trim()
        : options.writeAntigravity
          ? registration.antigravityConfigPath
          : null;

    if (explicitTargetConfig) {
      const merged = mergeHarnessMcpConfig(
        explicitTargetConfig,
        registration.serverName,
        registration.serverEntry
      );
      writtenHarnessConfigPath = merged.configPath;
    }

    return {
      ok: true,
      userConfigPath,
      installDir: envInfo.paths.installDir ?? resolvedInstallDir,
      exePath: envInfo.paths.exePath ?? exePath,
      clientVersion: envInfo.clientVersion,
      asarSha256: envInfo.asarSha256,
      discoveryMode,
      indexDir,
      indexBuilt,
      catalogTotalApis: envInfo.catalogStats.totalApis,
      writtenHarnessConfigPath,
      registration,
    };
  } finally {
    ownedPrompter?.close();
  }
}

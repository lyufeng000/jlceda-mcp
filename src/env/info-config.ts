import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Normalized configuration values resolved from process env, `~/information.json`,
 * and workspace `.jlceda-mcp.json`.
 */
export interface EnvAndInfoConfig {
  installDir: string | null;
  exePath: string | null;
  asarPath: string | null;
  unpackedDir: string | null;
  builtinExtDir: string | null;
  dataDir: string | null;
  libDir: string | null;
  projectsDir: string | null;
  userDataDir: string | null;
  headlessProfileDir: string;
  cdpPort: number;
  indexDir: string;
  tempDir: string;
  freeroutingJarPath: string | null;
  ngspiceExePath: string | null;
  /** Source tag indicating whether any L0 explicit client path was supplied. */
  explicitSource: "L0_ENV" | "L0_INFO_JSON" | null;
  diagnostics: string[];
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  infoJsonPath?: string;
  workspaceRoot?: string;
  workspaceConfigPath?: string;
}

const DEFAULT_CDP_PORT = 19222;
const PLACEHOLDER_RE = /^<[A-Z0-9_]+>$/;

/**
 * Return true when a config string is unset, whitespace-only, or an unexpanded `<PLACEHOLDER>`.
 */
export function isUnsetOrPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return PLACEHOLDER_RE.test(trimmed);
}

/**
 * Normalize a configured string value, collapsing empty strings and `<...>` placeholders to `null`.
 */
export function normalizeConfigString(value: unknown): string | null {
  if (isUnsetOrPlaceholder(value)) {
    return null;
  }
  return String(value).trim();
}

function parsePort(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535) {
    return value;
  }
  if (typeof value === "string" && !isUnsetOrPlaceholder(value)) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) {
      return parsed;
    }
  }
  return fallback;
}

function readJsonRecordSafe(
  filePath: string,
  diagnostics: string[],
  label: string
): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    diagnostics.push(`${label} is not a JSON object; ignoring.`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push(`Failed to parse ${label}: ${msg}`);
    return null;
  }
}

function pickSection(
  root: Record<string, unknown> | null
): Record<string, unknown> {
  if (!root) {
    return {};
  }
  for (const key of ["jlceda_pro", "jlcedaPro", "jlceda", "lceda_pro", "lcedaPro"]) {
    const sub = root[key];
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      return sub as Record<string, unknown>;
    }
  }
  return root;
}

function pickString(
  section: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const normalized = normalizeConfigString(section[key]);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

/**
 * Determine default process temporary directory (`D:\Data\.temp\jlceda-mcp` if `D:\Data` exists,
 * otherwise system tmpdir).
 */
export function resolveDefaultTempDir(): string {
  const preferredBase = "D:\\Data";
  try {
    if (fs.existsSync(preferredBase)) {
      return path.join(preferredBase, ".temp", "jlceda-mcp");
    }
  } catch {
    // Fall back to system tmpdir on inaccessible drive.
  }
  return path.join(os.tmpdir(), "jlceda-mcp");
}

/**
 * Determine default isolated headless Chromium profile directory.
 */
export function resolveDefaultHeadlessProfileDir(): string {
  const preferredBase = "D:\\Data";
  try {
    if (fs.existsSync(preferredBase)) {
      return path.join(preferredBase, ".temp", "jlceda-mcp-headless-profile");
    }
  } catch {
    // Fall back to system tmpdir.
  }
  return path.join(os.tmpdir(), "jlceda-mcp-headless-profile");
}

/**
 * Load L0 environment variables, `%USERPROFILE%\information.json`, and workspace `.jlceda-mcp.json`.
 * Precedence: process env > workspace `.jlceda-mcp.json` > `~/information.json` > safe defaults.
 */
export function loadEnvAndInfoConfig(options: LoadConfigOptions = {}): EnvAndInfoConfig {
  const env = options.env ?? process.env;
  const homeDir = os.homedir();
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const infoJsonPath = options.infoJsonPath ?? path.join(homeDir, "information.json");
  const workspaceConfigPath =
    options.workspaceConfigPath ?? path.join(workspaceRoot, ".jlceda-mcp.json");

  const diagnostics: string[] = [];
  const infoRaw = readJsonRecordSafe(infoJsonPath, diagnostics, "information.json");
  const wsRaw = readJsonRecordSafe(workspaceConfigPath, diagnostics, ".jlceda-mcp.json");

  const infoSection = pickSection(infoRaw);
  const wsSection = pickSection(wsRaw);

  const pickWithPriority = (
    envKeys: string[],
    jsonKeys: string[]
  ): { value: string | null; source: "L0_ENV" | "L0_INFO_JSON" | null } => {
    for (const ek of envKeys) {
      const v = normalizeConfigString(env[ek]);
      if (v !== null) {
        return { value: v, source: "L0_ENV" };
      }
    }
    const wsVal = pickString(wsSection, jsonKeys);
    if (wsVal !== null) {
      return { value: wsVal, source: "L0_INFO_JSON" };
    }
    const infoVal = pickString(infoSection, jsonKeys);
    if (infoVal !== null) {
      return { value: infoVal, source: "L0_INFO_JSON" };
    }
    return { value: null, source: null };
  };

  const installDirPick = pickWithPriority(
    ["JLCEDA_PRO_INSTALL_DIR"],
    ["JLCEDA_PRO_INSTALL_DIR", "installDir", "install_dir"]
  );
  const exePathPick = pickWithPriority(
    ["JLCEDA_PRO_EXE_PATH"],
    ["JLCEDA_PRO_EXE_PATH", "exePath", "exe_path"]
  );
  const asarPathPick = pickWithPriority(
    ["JLCEDA_PRO_ASAR_PATH"],
    ["JLCEDA_PRO_ASAR_PATH", "asarPath", "asar_path"]
  );
  const unpackedDirPick = pickWithPriority(
    ["JLCEDA_PRO_UNPACKED_DIR"],
    ["JLCEDA_PRO_UNPACKED_DIR", "unpackedDir", "unpacked_dir"]
  );
  const builtinExtDirPick = pickWithPriority(
    ["JLCEDA_PRO_BUILTIN_EXT_DIR"],
    ["JLCEDA_PRO_BUILTIN_EXT_DIR", "builtinExtDir", "builtin_ext_dir"]
  );
  const dataDirPick = pickWithPriority(
    ["JLCEDA_PRO_DATA_DIR"],
    ["JLCEDA_PRO_DATA_DIR", "dataDir", "data_dir"]
  );
  const libDirPick = pickWithPriority(
    ["JLCEDA_PRO_LIB_DIR"],
    ["JLCEDA_PRO_LIB_DIR", "libDir", "lib_dir"]
  );
  const projectsDirPick = pickWithPriority(
    ["JLCEDA_PRO_PROJECTS_DIR"],
    ["JLCEDA_PRO_PROJECTS_DIR", "projectsDir", "projects_dir"]
  );
  const userDataDirPick = pickWithPriority(
    ["JLCEDA_PRO_USER_DATA_DIR"],
    ["JLCEDA_PRO_USER_DATA_DIR", "userDataDir", "user_data_dir"]
  );
  const headlessProfilePick = pickWithPriority(
    ["JLCEDA_PRO_HEADLESS_PROFILE_DIR"],
    ["JLCEDA_PRO_HEADLESS_PROFILE_DIR", "headlessProfileDir", "headless_profile_dir"]
  );
  const indexDirPick = pickWithPriority(
    ["JLCEDA_MCP_INDEX_DIR"],
    ["JLCEDA_MCP_INDEX_DIR", "indexDir", "index_dir"]
  );
  const tempDirPick = pickWithPriority(
    ["JLCEDA_MCP_TEMP_DIR"],
    ["JLCEDA_MCP_TEMP_DIR", "tempDir", "temp_dir"]
  );
  const freeroutingPick = pickWithPriority(
    ["FREEROUTING_JAR_PATH"],
    ["FREEROUTING_JAR_PATH", "freeroutingJarPath", "freerouting_jar_path"]
  );
  const ngspicePick = pickWithPriority(
    ["NGSPICE_EXE_PATH"],
    ["NGSPICE_EXE_PATH", "ngspiceExePath", "ngspice_exe_path"]
  );

  const cdpPortRaw =
    env.JLCEDA_PRO_CDP_PORT ??
    wsSection.JLCEDA_PRO_CDP_PORT ??
    wsSection.cdpPort ??
    infoSection.JLCEDA_PRO_CDP_PORT ??
    infoSection.cdpPort;
  const cdpPort = parsePort(cdpPortRaw, DEFAULT_CDP_PORT);

  const explicitSource =
    exePathPick.source ??
    installDirPick.source ??
    asarPathPick.source ??
    null;

  return {
    installDir: installDirPick.value,
    exePath: exePathPick.value,
    asarPath: asarPathPick.value,
    unpackedDir: unpackedDirPick.value,
    builtinExtDir: builtinExtDirPick.value,
    dataDir: dataDirPick.value,
    libDir: libDirPick.value,
    projectsDir: projectsDirPick.value,
    userDataDir: userDataDirPick.value,
    headlessProfileDir: headlessProfilePick.value ?? resolveDefaultHeadlessProfileDir(),
    cdpPort,
    indexDir: indexDirPick.value ?? path.resolve(workspaceRoot, "catalog"),
    tempDir: tempDirPick.value ?? resolveDefaultTempDir(),
    freeroutingJarPath: freeroutingPick.value,
    ngspiceExePath: ngspicePick.value,
    explicitSource,
    diagnostics,
  };
}

/**
 * Persist resolved JLCEDA paths into workspace `.jlceda-mcp.json` when explicitly requested
 * (e.g. `doctor --auto-configure`). Never touches `~/information.json`.
 */
export function writeWorkspaceMcpConfig(
  workspaceConfigPath: string,
  payload: Record<string, unknown>
): void {
  fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true });
  fs.writeFileSync(workspaceConfigPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

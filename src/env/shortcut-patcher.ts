import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileWithTimeout } from "./path-resolver.js";

/**
 * Strictly whitelisted JLCEDA Pro Chromium/Electron launch flags.
 * Flags outside this whitelist (specifically `--remote-debugging-address`,
 * `--remote-allow-origins`, `--disable-background-timer-throttling`,
 * `--disable-renderer-backgrounding`) cause real JLCEDA Pro v4.1.105+
 * to abort on startup with `UNKNOWN_FLAG`.
 */
export const ALLOWED_CDP_FEATURE_VALUE =
  "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";

export const DEFAULT_WHITELISTED_LAUNCH_FLAGS = [
  "--remote-debugging-port=19222",
  `--disable-features=${ALLOWED_CDP_FEATURE_VALUE}`,
] as const;

export const FORBIDDEN_CDP_FLAGS = [
  "--remote-debugging-address",
  "--remote-allow-origins",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
] as const;

export interface LaunchArgsValidationResult {
  valid: boolean;
  forbiddenFlags: string[];
  unknownFlags: string[];
}

export interface ShortcutInspectionResult {
  shortcutPath: string;
  exists: boolean;
  targetPath: string | null;
  arguments: string;
  hasWhitelistedCdpArgs: boolean;
  hasForbiddenFlags: boolean;
  forbiddenFlagsFound: string[];
}

export interface PatchShortcutOptions {
  port?: number;
  /** Must be explicitly `true` to mutate a `.lnk` file on disk. Default: false (dry-run). */
  confirm?: boolean;
  timeoutMs?: number;
}

export interface PatchShortcutResult {
  shortcutPath: string;
  patched: boolean;
  dryRun: boolean;
  previousArgs: string;
  nextArgs: string;
  reason?: string;
}

function splitArgString(raw: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    tokens.push(match[1] !== undefined ? `"${match[1]}"` : match[2]);
  }
  return tokens;
}

function getFlagName(arg: string): string {
  const eqIdx = arg.indexOf("=");
  return (eqIdx >= 0 ? arg.slice(0, eqIdx) : arg).toLowerCase();
}

/**
 * Validate a candidate list of Electron/JLCEDA launch arguments against the strict whitelist.
 */
export function validateLaunchArgs(args: string[]): LaunchArgsValidationResult {
  const forbiddenFlags: string[] = [];
  const unknownFlags: string[] = [];

  for (const arg of args) {
    const flagName = getFlagName(arg.trim());
    if ((FORBIDDEN_CDP_FLAGS as readonly string[]).includes(flagName)) {
      forbiddenFlags.push(arg);
      continue;
    }
    if (flagName === "--remote-debugging-port") {
      const portStr = arg.split("=")[1] ?? "";
      const portNum = Number.parseInt(portStr, 10);
      if (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
        unknownFlags.push(arg);
      }
      continue;
    }
    if (flagName === "--disable-features") {
      const val = arg.split("=")[1] ?? "";
      if (val !== ALLOWED_CDP_FEATURE_VALUE) {
        unknownFlags.push(arg);
      }
      continue;
    }
    unknownFlags.push(arg);
  }

  return {
    valid: forbiddenFlags.length === 0 && unknownFlags.length === 0,
    forbiddenFlags,
    unknownFlags,
  };
}

/**
 * Build strictly whitelisted JLCEDA Pro CDP launch arguments.
 * Throws if any forbidden or non-whitelisted extra flags are supplied.
 */
export function buildSafeCdpLaunchArgs(
  port: number = 19222,
  extraArgs: string[] = []
): string[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid CDP port: ${port}. Must be an integer in 1024..65535.`);
  }
  const baseArgs = [
    `--remote-debugging-port=${port}`,
    `--disable-features=${ALLOWED_CDP_FEATURE_VALUE}`,
  ];
  if (extraArgs.length > 0) {
    const check = validateLaunchArgs(extraArgs);
    if (!check.valid) {
      const rejected = [...check.forbiddenFlags, ...check.unknownFlags].join(", ");
      throw new Error(
        `ERR_FORBIDDEN_LAUNCH_FLAG: Refusing non-whitelisted flags (${rejected}) that trigger UNKNOWN_FLAG exit in JLCEDA Pro.`
      );
    }
  }
  return baseArgs;
}

/**
 * Merge whitelisted CDP arguments into an existing shortcut `Arguments` string,
 * stripping any legacy forbidden flags (`--remote-debugging-address`, etc.).
 */
export function mergeSafeShortcutArgs(existingArgs: string, port: number = 19222): string {
  const safeLaunch = buildSafeCdpLaunchArgs(port);
  const tokens = splitArgString(existingArgs);
  const preserved: string[] = [];

  for (const token of tokens) {
    const flagName = getFlagName(token);
    if (
      (FORBIDDEN_CDP_FLAGS as readonly string[]).includes(flagName) ||
      flagName === "--remote-debugging-port" ||
      flagName === "--disable-features"
    ) {
      continue;
    }
    preserved.push(token);
  }

  return [...preserved, ...safeLaunch].join(" ").trim();
}

/**
 * Discover JLCEDA Pro desktop & Start Menu `.lnk` shortcuts (read-only).
 */
export function findJlcShortcuts(customDirs?: string[]): string[] {
  const env = process.env;
  const dirs =
    customDirs ??
    [
      env.APPDATA ? path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs") : "",
      env.ProgramData
        ? path.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")
        : "",
      path.join(os.homedir(), "Desktop"),
      env.PUBLIC ? path.join(env.PUBLIC, "Desktop") : "",
    ].filter(Boolean);

  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 2 || !fs.existsSync(dir)) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (
        ent.isFile() &&
        ent.name.toLowerCase().endsWith(".lnk") &&
        /(?:嘉立创EDA|LCEDA|EasyEDA)/i.test(ent.name) &&
        !/(?:卸载|uninstall)/i.test(ent.name)
      ) {
        found.push(fullPath);
      }
    }
  };

  for (const d of dirs) {
    visit(d, 0);
  }
  return found;
}

/**
 * Read-only inspection of a Windows `.lnk` shortcut's `TargetPath` and `Arguments`.
 */
export async function inspectShortcutArgs(
  shortcutPath: string,
  timeoutMs: number = 3000
): Promise<ShortcutInspectionResult> {
  if (!fs.existsSync(shortcutPath) || process.platform !== "win32") {
    return {
      shortcutPath,
      exists: fs.existsSync(shortcutPath),
      targetPath: null,
      arguments: "",
      hasWhitelistedCdpArgs: false,
      hasForbiddenFlags: false,
      forbiddenFlagsFound: [],
    };
  }

  const escaped = shortcutPath.replace(/'/g, "''");
  const psScript = [
    "$sh = New-Object -ComObject WScript.Shell",
    `$sc = $sh.CreateShortcut('${escaped}')`,
    "Write-Output ($sc.TargetPath + '|' + $sc.Arguments)",
  ].join("; ");

  const res = await execFileWithTimeout(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    timeoutMs
  );

  const rawLine = res.stdout.trim().split(/\r?\n/)[0] ?? "";
  const sep = rawLine.indexOf("|");
  const targetPath = sep >= 0 ? rawLine.slice(0, sep).trim() || null : null;
  const args = sep >= 0 ? rawLine.slice(sep + 1).trim() : "";

  const tokens = splitArgString(args);
  const forbiddenFlagsFound = tokens.filter((t) =>
    (FORBIDDEN_CDP_FLAGS as readonly string[]).includes(getFlagName(t))
  );
  const hasPort = tokens.some((t) => getFlagName(t) === "--remote-debugging-port");
  const hasFeatures = tokens.some(
    (t) =>
      getFlagName(t) === "--disable-features" &&
      (t.split("=")[1] ?? "") === ALLOWED_CDP_FEATURE_VALUE
  );

  return {
    shortcutPath,
    exists: true,
    targetPath,
    arguments: args,
    hasWhitelistedCdpArgs: hasPort && hasFeatures && forbiddenFlagsFound.length === 0,
    hasForbiddenFlags: forbiddenFlagsFound.length > 0,
    forbiddenFlagsFound,
  };
}

/**
 * Patch a `.lnk` shortcut to include whitelisted CDP launch flags.
 * By default runs in dry-run mode (`confirm !== true`) and NEVER modifies system shortcuts
 * unless explicitly confirmed by caller (`confirm: true`).
 */
export async function patchShortcutCdpArgs(
  shortcutPath: string,
  options: PatchShortcutOptions = {}
): Promise<PatchShortcutResult> {
  const port = options.port ?? 19222;
  const timeoutMs = options.timeoutMs ?? 3000;
  const inspection = await inspectShortcutArgs(shortcutPath, timeoutMs);

  if (!inspection.exists) {
    return {
      shortcutPath,
      patched: false,
      dryRun: !options.confirm,
      previousArgs: "",
      nextArgs: "",
      reason: "Shortcut file does not exist.",
    };
  }

  const nextArgs = mergeSafeShortcutArgs(inspection.arguments, port);
  if (!options.confirm) {
    return {
      shortcutPath,
      patched: false,
      dryRun: true,
      previousArgs: inspection.arguments,
      nextArgs,
      reason: "Dry-run mode: pass confirm=true to write shortcut arguments.",
    };
  }

  if (process.platform !== "win32") {
    return {
      shortcutPath,
      patched: false,
      dryRun: false,
      previousArgs: inspection.arguments,
      nextArgs,
      reason: "Windows WScript.Shell shortcut patching is only supported on win32.",
    };
  }

  const escapedPath = shortcutPath.replace(/'/g, "''");
  const escapedArgs = nextArgs.replace(/'/g, "''");
  const psScript = [
    "$sh = New-Object -ComObject WScript.Shell",
    `$sc = $sh.CreateShortcut('${escapedPath}')`,
    `$sc.Arguments = '${escapedArgs}'`,
    "$sc.Save()",
  ].join("; ");

  const res = await execFileWithTimeout(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    timeoutMs
  );

  if (res.timedOut || res.stderr.trim().length > 0) {
    return {
      shortcutPath,
      patched: false,
      dryRun: false,
      previousArgs: inspection.arguments,
      nextArgs,
      reason: res.timedOut ? "Shortcut save timed out." : res.stderr.trim(),
    };
  }

  return {
    shortcutPath,
    patched: true,
    dryRun: false,
    previousArgs: inspection.arguments,
    nextArgs,
  };
}

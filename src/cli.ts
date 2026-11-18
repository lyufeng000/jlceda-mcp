#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledNetlist } from "./types/index.js";
import { writeWorkspaceMcpConfig } from "./env/info-config.js";
import { resolveClientEnvironment } from "./env/path-resolver.js";
import {
  findJlcShortcuts,
  patchShortcutCdpArgs,
} from "./env/shortcut-patcher.js";
import { buildReaCatalog } from "./rea/catalog-builder.js";
import { loadCachedAdapterBindings } from "./rea/fingerprint-adapter.js";
import { verifyZeroSourceCatalog } from "./rea/zero-source-verifier.js";
import { createBuiltInCesmResolver, runElectricalLinter } from "./linters/index.js";
import { enrichEnvCatalogStats } from "./tools/state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

function parseFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  const eqPrefix = `${flag}=`;
  const found = argv.find((a) => a.startsWith(eqPrefix));
  return found ? found.slice(eqPrefix.length) : undefined;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const autoConfigure = argv.includes("--auto-configure");
  const patchShortcut = argv.includes("--patch-shortcut-cdp");

  const envInfo = enrichEnvCatalogStats(
    await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
  );
  const wsConfigPath = path.join(WORKSPACE_ROOT, ".jlceda-mcp.json");
  let configuredPath: string | null = null;

  if (autoConfigure) {
    const payload = {
      jlceda_pro: {
        JLCEDA_PRO_INSTALL_DIR: envInfo.paths.installDir ?? "",
        JLCEDA_PRO_EXE_PATH: envInfo.paths.exePath ?? "",
        JLCEDA_PRO_ASAR_PATH: envInfo.paths.asarPath ?? "",
        JLCEDA_PRO_UNPACKED_DIR: envInfo.paths.unpackedDir ?? "",
        JLCEDA_PRO_BUILTIN_EXT_DIR: envInfo.paths.builtinExtDir ?? "",
        JLCEDA_PRO_DATA_DIR: envInfo.paths.dataDir ?? "",
        JLCEDA_PRO_LIB_DIR: envInfo.paths.libDir ?? "",
        JLCEDA_PRO_PROJECTS_DIR: envInfo.paths.projectsDir ?? "",
        JLCEDA_PRO_USER_DATA_DIR: envInfo.paths.userDataDir ?? "",
        JLCEDA_PRO_HEADLESS_PROFILE_DIR: envInfo.paths.headlessProfileDir,
        JLCEDA_PRO_CDP_PORT: String(envInfo.paths.cdpPort),
        JLCEDA_MCP_INDEX_DIR: envInfo.paths.indexDir,
        JLCEDA_MCP_TEMP_DIR: envInfo.paths.tempDir,
        FREEROUTING_JAR_PATH: envInfo.paths.freeroutingJarPath ?? "",
        NGSPICE_EXE_PATH: envInfo.paths.ngspiceExePath ?? "",
      },
    };
    writeWorkspaceMcpConfig(wsConfigPath, payload);
    configuredPath = wsConfigPath;
  }

  const shortcutResults = [];
  if (patchShortcut) {
    const shortcuts = findJlcShortcuts();
    for (const sc of shortcuts) {
      const patchRes = await patchShortcutCdpArgs(sc, {
        port: envInfo.paths.cdpPort,
        confirm: true,
      });
      shortcutResults.push(patchRes);
    }
  }

  console.log(
    JSON.stringify(
      {
        command: "doctor",
        clientInstalled: envInfo.clientInstalled,
        discoverySource: envInfo.discoverySource,
        clientVersion: envInfo.clientVersion,
        asarSha256: envInfo.asarSha256,
        degradedMode: envInfo.degradedMode,
        paths: envInfo.paths,
        catalogStats: envInfo.catalogStats,
        solvers: envInfo.solvers,
        autoConfiguredFile: configuredPath,
        shortcutPatchCount: shortcutResults.length,
        shortcutResults,
        diagnostics: envInfo.diagnostics,
      },
      null,
      2
    )
  );
  return 0;
}

async function cmdIndex(argv: string[]): Promise<number> {
  const sourceArg = parseFlagValue(argv, "--source");
  const verifyZero = argv.includes("--verify-zero-source");
  const envInfo = enrichEnvCatalogStats(
    await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
  );
  const sourcePath = sourceArg ?? envInfo.paths.asarPath;
  const outputDir = envInfo.paths.indexDir;

  const buildRes = buildReaCatalog({
    sourcePath,
    outputDir,
    workspaceRoot: WORKSPACE_ROOT,
    validateSchema: true,
  });

  let zeroSourceAudit = null;
  if (verifyZero) {
    zeroSourceAudit = verifyZeroSourceCatalog({
      sqlitePath: buildRes.sqlitePath,
      bindingsPath: buildRes.bindingsPath,
      catalogDir: outputDir,
    });
  }

  console.log(
    JSON.stringify(
      {
        command: "index",
        sourcePath: sourcePath ?? "offline-l1-only",
        sqlitePath: buildRes.sqlitePath,
        bindingsPath: buildRes.bindingsPath,
        stats: buildRes.stats,
        scannedBundlesCount: buildRes.scannedBundlesCount,
        skippedBundlesCount: buildRes.skippedBundlesCount,
        zeroSourceAudit,
      },
      null,
      2
    )
  );

  if (zeroSourceAudit && !zeroSourceAudit.passed) {
    return 1;
  }
  return 0;
}

async function cmdCalibrateL3(): Promise<number> {
  const envInfo = enrichEnvCatalogStats(
    await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
  );
  const sha = envInfo.asarSha256 ?? envInfo.catalogStats.asarSha256;
  if (!sha) {
    console.error("No client SHA-256 found. Run 'index' first.");
    return 1;
  }
  const cached = loadCachedAdapterBindings(envInfo.paths.indexDir, sha);
  if (!cached) {
    console.error(`No cached adapter_bindings.${sha}.json in ${envInfo.paths.indexDir}. Run 'index' first.`);
    return 1;
  }

  console.log(
    JSON.stringify(
      {
        command: "calibrate-l3",
        asarSha256: cached.asarSha256,
        clientVersion: cached.clientVersion,
        totalCapabilities: Object.keys(cached.bindings).length,
        degradedCapabilities: cached.degradedCapabilities,
        bindings: cached.bindings,
      },
      null,
      2
    )
  );
  return cached.degradedCapabilities.length === 0 ? 0 : 1;
}

async function cmdLint(argv: string[]): Promise<number> {
  const netlistArg = argv[0];
  if (!netlistArg) {
    console.error("Usage: jlceda-mcp lint <netlist.json>");
    return 1;
  }
  const fullPath = path.resolve(netlistArg);
  if (!fs.existsSync(fullPath)) {
    console.error(`Netlist file not found: ${fullPath}`);
    return 1;
  }
  const netlist = JSON.parse(fs.readFileSync(fullPath, "utf8")) as CompiledNetlist;
  const report = runElectricalLinter(netlist, {
    cesmResolver: createBuiltInCesmResolver(),
    strictness: "production",
  });
  console.log(JSON.stringify(report, null, 2));
  return report.blockerCount === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  let code = 0;
  if (subcommand === "doctor") {
    code = await cmdDoctor(args.slice(1));
  } else if (subcommand === "index") {
    code = await cmdIndex(args.slice(1));
  } else if (subcommand === "calibrate-l3") {
    code = await cmdCalibrateL3();
  } else if (subcommand === "lint") {
    code = await cmdLint(args.slice(1));
  } else {
    console.log(
      [
        "JLCEDA Pro MCP CLI",
        "Commands:",
        "  doctor [--auto-configure] [--patch-shortcut-cdp]",
        "  index [--source <path>] [--verify-zero-source]",
        "  calibrate-l3",
        "  lint <netlist.json>",
      ].join("\n")
    );
    code = subcommand ? 1 : 0;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error("CLI Error:", err);
  process.exit(1);
});

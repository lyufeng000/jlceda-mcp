import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvAndInfoConfig } from "../../src/env/info-config.js";
import {
  mergeHarnessMcpConfig,
  removeHarnessMcpConfig,
  runSetupWizard,
} from "../../src/env/setup-wizard.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeClientDir(root: string): string {
  const clientDir = path.join(root, "fake-lceda-pro");
  fs.mkdirSync(path.join(clientDir, "resources", "app"), { recursive: true });
  fs.writeFileSync(path.join(clientDir, "lceda-pro.exe"), "fake-exe");
  fs.writeFileSync(
    path.join(clientDir, "resources", "app", "package.json"),
    JSON.stringify({ name: "lceda-pro", version: "4.1.999" }),
    "utf8"
  );
  return clientDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("user-level global config & setup wizard", () => {
  it("resolves config priority: env > workspace .jlceda-mcp.json > ~/.jlceda-mcp/config.json > information.json", () => {
    const tmp = makeTempDir("jlceda-prio-");
    const infoPath = path.join(tmp, "information.json");
    const userCfgPath = path.join(tmp, "user-config.json");
    const wsCfgPath = path.join(tmp, ".jlceda-mcp.json");

    fs.writeFileSync(
      infoPath,
      JSON.stringify({ jlceda_pro: { JLCEDA_PRO_INSTALL_DIR: "C:\\info-dir", JLCEDA_PRO_CDP_PORT: 19225 } }),
      "utf8"
    );
    fs.writeFileSync(
      userCfgPath,
      JSON.stringify({ jlceda_pro: { JLCEDA_PRO_INSTALL_DIR: "D:\\user-global-dir", JLCEDA_PRO_CDP_PORT: 19224 } }),
      "utf8"
    );

    // User global overrides information.json
    const fromUser = loadEnvAndInfoConfig({
      env: {},
      infoJsonPath: infoPath,
      userConfigPath: userCfgPath,
      workspaceConfigPath: wsCfgPath,
    });
    expect(fromUser.installDir).toBe("D:\\user-global-dir");
    expect(fromUser.cdpPort).toBe(19224);

    // Workspace overrides user global
    fs.writeFileSync(
      wsCfgPath,
      JSON.stringify({ jlceda_pro: { JLCEDA_PRO_INSTALL_DIR: "E:\\ws-dir", JLCEDA_PRO_CDP_PORT: 19223 } }),
      "utf8"
    );
    const fromWs = loadEnvAndInfoConfig({
      env: {},
      infoJsonPath: infoPath,
      userConfigPath: userCfgPath,
      workspaceConfigPath: wsCfgPath,
    });
    expect(fromWs.installDir).toBe("E:\\ws-dir");
    expect(fromWs.cdpPort).toBe(19223);

    // Process env overrides workspace
    const fromEnv = loadEnvAndInfoConfig({
      env: { JLCEDA_PRO_INSTALL_DIR: "F:\\env-dir", JLCEDA_PRO_CDP_PORT: "19226" },
      infoJsonPath: infoPath,
      userConfigPath: userCfgPath,
      workspaceConfigPath: wsCfgPath,
    });
    expect(fromEnv.installDir).toBe("F:\\env-dir");
    expect(fromEnv.cdpPort).toBe(19226);
  });

  it("persists ~/.jlceda-mcp/config.json, emits zero-env snippet, and never mutates Harness config by default", async () => {
    const tmp = makeTempDir("jlceda-setup-");
    const fakeClient = createFakeClientDir(tmp);
    const userConfigPath = path.join(tmp, ".jlceda-mcp", "config.json");
    const fakeAntigravityConfig = path.join(tmp, ".gemini", "config", "mcp_config.json");

    const res = await runSetupWizard({
      workspaceRoot: tmp,
      serverEntryPath: path.join(tmp, "dist", "index.js"),
      clientDir: fakeClient,
      userConfigPath,
      antigravityConfigPath: fakeAntigravityConfig,
      indexDir: path.join(tmp, ".jlceda-mcp", "catalog"),
      skipIndex: true,
      skipSystemProbes: true,
      env: {},
    });

    expect(res.ok).toBe(true);
    expect(res.discoveryMode).toBe("explicit_arg");
    expect(res.installDir).toBe(fakeClient);
    expect(res.writtenHarnessConfigPath).toBeNull();
    expect(fs.existsSync(fakeAntigravityConfig)).toBe(false);
    expect(fs.existsSync(userConfigPath)).toBe(true);

    // Zero-env snippet check
    const entry = res.registration.mcpServersSnippet.mcpServers["jlceda-pro"] as unknown as Record<string, unknown>;
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual([path.resolve(tmp, "dist", "index.js")]);
    expect(entry.env).toBeUndefined();

    // Persisted config is readable by loadEnvAndInfoConfig
    const loaded = loadEnvAndInfoConfig({
      env: {},
      userConfigPath,
      workspaceConfigPath: path.join(tmp, "nonexistent.json"),
      infoJsonPath: path.join(tmp, "nonexistent-info.json"),
    });
    expect(loaded.installDir).toBe(fakeClient);
    expect(loaded.indexDir).toBe(path.join(tmp, ".jlceda-mcp", "catalog"));
  });

  it("prompts interactively when auto-detect misses, retrying invalid path until valid", async () => {
    const tmp = makeTempDir("jlceda-interactive-");
    const fakeClient = createFakeClientDir(tmp);
    const userConfigPath = path.join(tmp, ".jlceda-mcp", "config.json");
    const answers = [path.join(tmp, "wrong-dir"), path.join(fakeClient, "lceda-pro.exe")];
    let idx = 0;

    const res = await runSetupWizard({
      workspaceRoot: tmp,
      userConfigPath,
      indexDir: path.join(tmp, ".jlceda-mcp", "catalog"),
      skipIndex: true,
      skipSystemProbes: true,
      env: {},
      promptFn: async () => answers[idx++] ?? "q",
    });

    expect(res.ok).toBe(true);
    expect(res.discoveryMode).toBe("interactive_input");
    expect(res.installDir).toBe(fakeClient);
    expect(idx).toBe(2);
  });

  it("merges and removes Harness config losslessly only when explicitly opted in", async () => {
    const tmp = makeTempDir("jlceda-harness-");
    const harnessPath = path.join(tmp, "mcp_config.json");
    fs.writeFileSync(
      harnessPath,
      JSON.stringify({
        mcpServers: {
          solidworks: { command: "dotnet", args: ["sw.dll"] },
        },
      }),
      "utf8"
    );

    const merged = mergeHarnessMcpConfig(harnessPath, "jlceda-pro", {
      command: "node",
      args: ["F:\\mcp\\dist\\index.js"],
    });
    expect(merged.existingServers).toEqual(["solidworks"]);

    const afterWrite = JSON.parse(fs.readFileSync(harnessPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(afterWrite.mcpServers.solidworks).toBeDefined();
    expect(afterWrite.mcpServers["jlceda-pro"]).toEqual({
      command: "node",
      args: ["F:\\mcp\\dist\\index.js"],
    });
    expect(afterWrite.mcpServers["jlceda-pro"].env).toBeUndefined();

    const removed = removeHarnessMcpConfig(harnessPath, "jlceda-pro");
    expect(removed.removed).toBe(true);
    const afterRemove = JSON.parse(fs.readFileSync(harnessPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(afterRemove.mcpServers.solidworks).toBeDefined();
    expect(afterRemove.mcpServers["jlceda-pro"]).toBeUndefined();
  });
});

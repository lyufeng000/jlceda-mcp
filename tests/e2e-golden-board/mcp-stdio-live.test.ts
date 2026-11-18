import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JLC_TOOL_NAMES, type McpEnvelope } from "../../src/types/index.js";

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST_INDEX = path.join(WORKSPACE_ROOT, "dist", "index.js");

function parseToolEnvelope<T = Record<string, unknown>>(
  res: Awaited<ReturnType<Client["callTool"]>>
): McpEnvelope<T> {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const textItem = content.find((c) => c.type === "text" && typeof c.text === "string");
  if (!textItem?.text) {
    throw new Error(`Expected text content in MCP callTool response, got: ${JSON.stringify(res)}`);
  }
  return JSON.parse(textItem.text) as McpEnvelope<T>;
}

describe("E2E: @modelcontextprotocol/sdk Stdio MCP Server Live Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tempStateDir = "";
  const stderrChunks: string[] = [];

  beforeAll(async () => {
    if (!fs.existsSync(DIST_INDEX)) {
      const tscBin = path.join(WORKSPACE_ROOT, "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tscBin, "-p", path.join(WORKSPACE_ROOT, "tsconfig.json")], {
        cwd: WORKSPACE_ROOT,
        stdio: "pipe",
      });
    }
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlceda-stdio-e2e-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX],
      cwd: WORKSPACE_ROOT,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((kv): kv is [string, string] => typeof kv[1] === "string")
        ),
        JLC_CESM_SQLITE_PATH: path.join(tempStateDir, "cesm_cache.sqlite"),
        JLC_LAYOUT_IMG_DIR: path.join(tempStateDir, "layout_examples"),
      },
      stderr: "pipe",
    });

    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    client = new Client({
      name: "jlceda-mcp-stdio-e2e",
      version: "1.0.0",
    });

    await client.connect(transport);
  }, 25000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // ignore close errors
    }
    try {
      await transport?.close();
    } catch {
      // ignore close errors
    }
    if (tempStateDir) {
      fs.rmSync(tempStateDir, { recursive: true, force: true });
    }
    // Guarantee no lceda-pro.exe was left behind by this test
    if (process.platform === "win32") {
      try {
        const tasklistOut = execFileSync("tasklist", ["/FI", "IMAGENAME eq lceda-pro.exe"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        expect(tasklistOut.toLowerCase()).not.toContain("lceda-pro.exe");
      } catch {
        // tasklist failure shouldn't mask earlier assertion if unavailable
      }
    }
  });

  it("exposes server capabilities and loads instructions.md core rules", () => {
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.tools).toBeDefined();

    const instructions = client.getInstructions() ?? "";
    expect(instructions.length).toBeGreaterThan(50);
    expect(instructions).toContain("jlc_datasheet_extract");
    expect(instructions).toContain("eda.sch_Netlist");
    expect(instructions).toContain("jlc_pcb_cluster_netlist");
    expect(instructions).toContain("jlc_validate");
    expect(instructions).toContain("jlc_document_close");
  });

  it("registers all 41 tools matching JLC_TOOL_NAMES.all with complete JSON schemas", async () => {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(41);
    const listedNames = listed.tools.map((t) => t.name);
    expect(listedNames).toEqual([...JLC_TOOL_NAMES.all]);

    for (const tool of listed.tools) {
      expect(tool.description?.trim().length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("detects local JLCEDA Pro installation and full L1~L4 non-degraded REA catalog via jlc_capabilities", async () => {
    const raw = await client.callTool({
      name: "jlc_capabilities",
      arguments: { refresh: false },
    });
    const env = parseToolEnvelope<{
      clientInstalled: boolean;
      clientVersion: string | null;
      degradedMode: boolean;
      paths: { installDir: string | null; exePath: string | null; catalogDir: string };
      catalogStats: {
        totalApis: number;
        l1Count: number;
        l2Count: number;
        l3Count: number;
        l4Count: number;
      };
    }>(raw);

    expect(env.ok).toBe(true);
    expect(env.data?.clientInstalled).toBe(true);
    expect(env.data?.paths.installDir?.toLowerCase()).toContain("lceda-pro");
    expect(env.data?.degradedMode).toBe(false);
    expect(env.data?.catalogStats.totalApis).toBeGreaterThan(2000);
    expect(env.data?.catalogStats.l1Count).toBeGreaterThan(0);
    expect(env.data?.catalogStats.l2Count).toBeGreaterThan(0);
    expect(env.data?.catalogStats.l3Count).toBeGreaterThan(0);
    expect(env.data?.catalogStats.l4Count).toBeGreaterThan(0);
  });

  it("queries real catalog/api_catalog.sqlite under 3ms, enforces describe-first, and blocks BLOCKED APIs", async () => {
    const searchDsnRaw = await client.callTool({
      name: "jlc_api_search",
      arguments: { query: "dsn", limit: 10 },
    });
    const searchDsn = parseToolEnvelope<{
      totalMatches: number;
      elapsedMs: number;
      items: Array<{ apiId: string; tier: string; securityPolicy: string }>;
    }>(searchDsnRaw);
    expect(searchDsn.ok).toBe(true);
    expect(searchDsn.data?.totalMatches).toBeGreaterThan(0);
    expect(searchDsn.data?.elapsedMs ?? 999).toBeLessThan(3);

    const searchCreateRaw = await client.callTool({
      name: "jlc_api_search",
      arguments: { query: "create", limit: 15 },
    });
    const searchCreate = parseToolEnvelope<{
      totalMatches: number;
      elapsedMs: number;
      items: Array<{ apiId: string; tier: string; securityPolicy: string }>;
    }>(searchCreateRaw);
    expect(searchCreate.ok).toBe(true);
    expect(searchCreate.data?.totalMatches).toBeGreaterThan(0);
    expect(searchCreate.data?.elapsedMs ?? 999).toBeLessThan(3);

    const firstSafeApi =
      searchCreate.data?.items.find((i) => i.securityPolicy !== "BLOCKED")?.apiId ??
      searchDsn.data?.items.find((i) => i.securityPolicy !== "BLOCKED")?.apiId;
    expect(firstSafeApi).toBeTruthy();

    // Invoking before describe must fail cleanly with ERR_API_NOT_DESCRIBED
    const invokeBeforeDescribe = parseToolEnvelope(
      await client.callTool({
        name: "jlc_api_invoke",
        arguments: { apiId: firstSafeApi, arguments: {} },
      })
    );
    expect(invokeBeforeDescribe.ok).toBe(false);
    expect(invokeBeforeDescribe.errorCode).toBe("ERR_API_NOT_DESCRIBED");

    // Describe must succeed and record contract metadata
    const described = parseToolEnvelope<{
      apiId: string;
      tier: string;
      adapterBindingStatus: { bound: boolean; confidence: number; degraded: boolean };
    }>(
      await client.callTool({
        name: "jlc_api_describe",
        arguments: { apiId: firstSafeApi },
      })
    );
    expect(described.ok).toBe(true);
    expect(described.data?.apiId).toBe(firstSafeApi);
    expect(described.data?.adapterBindingStatus).toBeDefined();

    // Locate a BLOCKED API in catalog and verify jlc_api_invoke refuses it
    const blockedSearch = parseToolEnvelope<{
      items: Array<{ apiId: string; securityPolicy: string }>;
    }>(
      await client.callTool({
        name: "jlc_api_search",
        arguments: {
          query: "login",
          domain: "IPC",
          tiers: ["L4_IPC"],
          includeBlocked: true,
          limit: 25,
        },
      })
    );
    const blockedItem = blockedSearch.data?.items.find((i) => i.securityPolicy === "BLOCKED");
    expect(blockedItem).toBeDefined();

    const blockedInvoke = parseToolEnvelope(
      await client.callTool({
        name: "jlc_api_invoke",
        arguments: { apiId: blockedItem!.apiId, arguments: {} },
      })
    );
    expect(blockedInvoke.ok).toBe(false);
    expect(blockedInvoke.errorCode).toBe("ERR_API_BLOCKED");
  });

  it("handles jlc_connect(launch=false) safely when no GUI is running and keeps jlc_session_status healthy", async () => {
    const connectRes = parseToolEnvelope<{ connected: boolean }>(
      await client.callTool({
        name: "jlc_connect",
        arguments: { launch: false, editorType: "any" },
      })
    );

    if (!connectRes.ok) {
      expect(connectRes.errorCode).toMatch(/^ERR_/);
    } else {
      expect(connectRes.data?.connected).toBe(true);
    }

    const statusRes = parseToolEnvelope<{
      connectedPid: number | null;
      rpcQueueDepth: number;
      allProcesses: unknown[];
      activeModalDialogs: unknown[];
    }>(
      await client.callTool({
        name: "jlc_session_status",
        arguments: {},
      })
    );
    expect(statusRes.ok).toBe(true);
    expect(Array.isArray(statusRes.data?.allProcesses)).toBe(true);
    expect(typeof statusRes.data?.rpcQueueDepth).toBe("number");
    expect(Array.isArray(statusRes.data?.activeModalDialogs)).toBe(true);

    // Ensure logs go to stderr and never broke stdout JSON-RPC transport
    expect(stderrChunks.join("")).toContain("[jlceda-mcp] MCP Server started on stdio");
  });
});

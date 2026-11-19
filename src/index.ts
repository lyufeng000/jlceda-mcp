#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  errEnvelope,
  type ClientEnvironmentInfo,
  type McpEnvelope,
  type McpToolContext,
  type McpToolResponse,
} from "./types/index.js";
import { resolveClientEnvironment } from "./env/path-resolver.js";
import { createCdpSessionManager } from "./cdp/index.js";
import {
  ALL_JLC_TOOLS,
  enrichEnvCatalogStats,
  getToolHandler,
  getWorkspaceState,
} from "./tools/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

function loadInstructions(): string {
  const instructionsPath = path.join(WORKSPACE_ROOT, "instructions.md");
  try {
    if (fs.existsSync(instructionsPath)) {
      return fs.readFileSync(instructionsPath, "utf8");
    }
  } catch (err) {
    console.error("[jlceda-mcp] Failed to read instructions.md:", err);
  }
  return "JLCEDA Pro MCP Server: use mm/deg units, bind CESM via jlc_datasheet_extract before placing parts, and pass jlc_elec_lint before jlc_sch_sync_to_pcb.";
}

function isMcpToolResponse(val: McpEnvelope<unknown> | McpToolResponse): val is McpToolResponse {
  return (
    typeof val === "object" &&
    val !== null &&
    "content" in val &&
    Array.isArray((val as McpToolResponse).content)
  );
}

export async function createJlcMcpServer(): Promise<{
  server: Server;
  context: McpToolContext;
  cleanup: () => Promise<void>;
}> {
  let cachedEnvInfo: ClientEnvironmentInfo | undefined;
  try {
    cachedEnvInfo = enrichEnvCatalogStats(
      await resolveClientEnvironment({ workspaceRoot: WORKSPACE_ROOT })
    );
  } catch (err) {
    console.error("[jlceda-mcp] Environment resolution warning:", err);
  }

  const sessionManager = createCdpSessionManager({
    exePath: cachedEnvInfo?.paths.exePath ?? null,
    defaultUserDataDir: cachedEnvInfo?.paths.userDataDir ?? null,
    headlessProfileDir: cachedEnvInfo?.paths.headlessProfileDir ?? null,
    portRange: [
      cachedEnvInfo?.paths.cdpPort ?? 19222,
      (cachedEnvInfo?.paths.cdpPort ?? 19222) + 7,
    ],
  });

  const context: McpToolContext = {
    sessionManager,
    envInfo: cachedEnvInfo,
  };

  // Pre-seed workspace state envInfo
  if (cachedEnvInfo) {
    getWorkspaceState(context).envInfo = cachedEnvInfo;
  }

  const instructions = loadInstructions();
  const server = new Server(
    {
      name: "jlceda-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_JLC_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object" as const,
          ...t.inputSchema,
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const handler = getToolHandler(toolName);
    if (!handler) {
      const err = errEnvelope("ERR_UNKNOWN_TOOL", `Unknown tool '${toolName}'.`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(err) }],
        isError: true,
      };
    }

    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const res = await handler.execute(args, context);
      if (isMcpToolResponse(res)) {
        return {
          content: res.content,
          ...(res.structuredContent !== undefined
            ? { structuredContent: res.structuredContent as Record<string, unknown> }
            : {}),
          isError: Boolean(res.isError),
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res) }],
        structuredContent: res as unknown as Record<string, unknown>,
        isError: !res.ok,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[jlceda-mcp] Unhandled error in tool '${toolName}':`, msg);
      const env = errEnvelope("ERR_TOOL_EXECUTION_FAILED", msg);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(env) }],
        isError: true,
      };
    }
  });

  const cleanup = async (): Promise<void> => {
    try {
      getWorkspaceState(context).cesmBinder.close();
    } catch {
      // Ignore cleanup errors
    }
    try {
      await sessionManager.disconnect();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { server, context, cleanup };
}

async function main(): Promise<void> {
  const { server, cleanup } = await createJlcMcpServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[jlceda-mcp] Received ${signal}, releasing session and exiting...`);
    await cleanup();
    await server.close().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  console.error(`[jlceda-mcp] MCP Server started on stdio (${ALL_JLC_TOOLS.length} tools registered).`);
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  main().catch((err) => {
    console.error("[jlceda-mcp] Fatal startup error:", err);
    process.exit(1);
  });
}

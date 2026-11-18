import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, describe, expect, it } from "vitest";
import { verifyZeroSourceCatalog } from "../src/rea/zero-source-verifier.js";

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG_DIR = path.join(WORKSPACE_ROOT, "catalog");
const REAL_SQLITE_PATH = path.join(CATALOG_DIR, "api_catalog.sqlite");
const HAS_REAL_CATALOG = fs.existsSync(REAL_SQLITE_PATH);

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
});

describe("REA Zero-Source Persistence & Schema Compliance Gate", () => {
  it.skipIf(!HAS_REAL_CATALOG)(
    "audits real generated catalog/api_catalog.sqlite & adapter_bindings.<sha256>.json with 0 bytes pseudo-source",
    () => {
      const report = verifyZeroSourceCatalog({
        catalogDir: CATALOG_DIR,
        sqlitePath: REAL_SQLITE_PATH,
      });

      expect(report.violations).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.pseudoSourceBytesPersisted).toBe(0);
      expect(report.scannedEntries).toBeGreaterThan(2000);
      expect(report.scannedBindingFiles).toBeGreaterThanOrEqual(1);
      expect(report.blockedSensitiveCount).toBeGreaterThan(0);

      // Verify every persisted catalog entry conforms strictly to schemas/rea-api-entry.schema.json
      const schemaJson = JSON.parse(
        fs.readFileSync(path.join(WORKSPACE_ROOT, "schemas", "rea-api-entry.schema.json"), "utf8")
      ) as Record<string, unknown>;
      type AjvLike = { compile: (s: Record<string, unknown>) => (data: unknown) => boolean };
      type AjvCtor = new (opts: Record<string, unknown>) => AjvLike;
      type FormatsFn = (ajv: AjvLike) => unknown;
      const ajvMod = Ajv2020 as unknown as { default?: AjvCtor } | AjvCtor;
      const fmtMod = addFormats as unknown as { default?: FormatsFn } | FormatsFn;
      const AjvCtorImpl = typeof ajvMod === "function" ? ajvMod : (ajvMod.default as AjvCtor);
      const fmtImpl = typeof fmtMod === "function" ? fmtMod : (fmtMod.default as FormatsFn);
      const ajv = new AjvCtorImpl({ allErrors: true, strict: false });
      fmtImpl(ajv);
      const validate = ajv.compile(schemaJson);

      const db = new DatabaseSync(REAL_SQLITE_PATH, { readOnly: true });
      try {
        const rows = db.prepare("SELECT entry_json FROM api_entries").all() as Array<{
          entry_json: string;
        }>;
        expect(rows.length).toBe(report.scannedEntries);
        for (const r of rows) {
          expect(validate(JSON.parse(r.entry_json))).toBe(true);
        }
      } finally {
        db.close();
      }
    }
  );

  it("rejects SQLite catalogs containing decompiled JS function bodies or bundler code", () => {
    const dir = mkTmp("rea-zs-bad-db-");
    const sqlitePath = path.join(dir, "api_catalog.sqlite");
    const bindingsPath = path.join(dir, "adapter_bindings.abc123.json");

    fs.writeFileSync(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        asarSha256: "abc123",
        generatedAt: new Date().toISOString(),
        bindings: {},
        degradedCapabilities: [],
      })
    );

    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE api_entries (
        api_id TEXT PRIMARY KEY, tier TEXT, domain TEXT, kind TEXT,
        namespace TEXT, member_name TEXT, summary_zh TEXT, keywords_en TEXT,
        param_names TEXT, return_type_name TEXT, security_policy TEXT, entry_json TEXT
      );
      CREATE TABLE api_catalog_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE VIRTUAL TABLE api_entries_fts USING fts5(api_id, summary_zh, cjk_tokens);
    `);
    db.prepare(
      "INSERT INTO api_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cap:pcb.bad.leak",
      "L3_ENGINE",
      "PCB",
      "method",
      "Bad",
      "leak",
      "function leakedFn(a, b) { return a + b; }",
      "bad",
      "a b",
      "void",
      "ALLOW",
      JSON.stringify({ apiId: "cap:pcb.bad.leak", summaryZh: "ok" })
    );
    db.close();

    const audit = verifyZeroSourceCatalog({ catalogDir: dir, sqlitePath, bindingsPath });
    expect(audit.passed).toBe(false);
    expect(audit.pseudoSourceBytesPersisted).toBeGreaterThan(0);
    expect(audit.violations.some((v) => v.rule === "JS_FUNCTION_BODY")).toBe(true);
  });

  it("rejects adapter_bindings JSON with embedded JS arrow code, unblocked auth channels, or .js dumps", () => {
    const dir = mkTmp("rea-zs-bad-json-");
    const sqlitePath = path.join(dir, "api_catalog.sqlite");
    const bindingsPath = path.join(dir, "adapter_bindings.deadbeef.json");

    fs.writeFileSync(path.join(dir, "decompiled_dump.js"), "console.log('leak');");
    fs.writeFileSync(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        asarSha256: "deadbeef",
        generatedAt: new Date().toISOString(),
        bindings: {
          "cap:pcb.evil": {
            reason: "const x = (a) => { return a * 2; }",
          },
        },
        degradedCapabilities: [],
      })
    );

    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE api_entries (
        api_id TEXT PRIMARY KEY, tier TEXT, domain TEXT, kind TEXT,
        namespace TEXT, member_name TEXT, summary_zh TEXT, keywords_en TEXT,
        param_names TEXT, return_type_name TEXT, security_policy TEXT, entry_json TEXT
      );
      CREATE TABLE api_catalog_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE VIRTUAL TABLE api_entries_fts USING fts5(api_id, summary_zh, cjk_tokens);
    `);
    db.prepare(
      "INSERT INTO api_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cap:ipc.auth.getToken",
      "L4_IPC",
      "IPC",
      "ipc_channel",
      "ElectronIpcBridge",
      "auth:getToken",
      "未拦截的敏感登录接口",
      "auth token",
      "",
      "string",
      "ALLOW",
      JSON.stringify({ apiId: "cap:ipc.auth.getToken", securityPolicy: "ALLOW" })
    );
    db.close();

    const audit = verifyZeroSourceCatalog({ catalogDir: dir, sqlitePath, bindingsPath });
    expect(audit.passed).toBe(false);
    expect(audit.violations.some((v) => v.rule.startsWith("FORBIDDEN_SOURCE_FILE"))).toBe(true);
    expect(audit.violations.some((v) => v.rule === "ARROW_FUNCTION_BLOCK")).toBe(true);
    expect(audit.violations.some((v) => v.rule === "UNBLOCKED_SENSITIVE_CHANNEL")).toBe(true);
  });
});

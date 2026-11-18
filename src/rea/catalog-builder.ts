import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  AdapterBindingFile,
  ReaApiCatalogEntry,
  ReaApiDomain,
  ReaApiTier,
  ReaCatalogStats,
} from "../types/index.js";
import { AsarMemoryVfs } from "./asar-memory-vfs.js";
import { scanVfsBundlesAst, type BundleScanResult } from "./bundle-ast-scanner.js";
import { extractL1FromVfsOrPackage, type DtsExtractionResult } from "./dts-extractor.js";
import { buildAdapterBindings, saveAdapterBindings } from "./fingerprint-adapter.js";

export interface BuildCatalogOptions {
  /** Path to `.asar` file or unpacked `resources/app` directory (optional for offline L1-only mode). */
  sourcePath?: string | null;
  /** Output directory where `api_catalog.sqlite` and `adapter_bindings.<sha256>.json` are written. */
  outputDir: string;
  /** Workspace root fallback for `@jlceda/pro-api-types` and `schemas/`. */
  workspaceRoot?: string;
  /** Optional precomputed L1 extraction (for fast unit tests). */
  preExtractedL1?: DtsExtractionResult;
  /** Optional precomputed AST bundle scan (for fast unit tests). */
  preScannedBundles?: BundleScanResult;
  /** Optional explicit list of bundles inside VFS to scan. */
  targetBundleFiles?: string[];
  /** Validate every catalog entry against `schemas/rea-api-entry.schema.json`. */
  validateSchema?: boolean;
}

export interface BuildCatalogResult {
  sqlitePath: string;
  bindingsPath: string;
  stats: ReaCatalogStats;
  bindings: AdapterBindingFile;
  scannedBundlesCount: number;
  skippedBundlesCount: number;
}

export interface SearchCatalogOptions {
  tier?: ReaApiTier;
  domain?: ReaApiDomain;
  includeBlocked?: boolean;
  limit?: number;
}

export interface SearchCatalogHit {
  entry: ReaApiCatalogEntry;
  rank: number;
}

export interface SearchCatalogResult {
  hits: SearchCatalogHit[];
  elapsedMs: number;
  queryUsed: string;
}

/**
 * Expand Chinese runs into overlapping 2-gram tokens (plus 1-char fallback for single CJK chars)
 * so SQLite FTS5 `porter unicode61` recalls both Chinese phrases and English keywords accurately.
 */
export function expandSearchTokens(text: string): string {
  const tokens: string[] = [];
  const asciiMatches = text.match(/[A-Za-z0-9_]+/g) ?? [];
  for (const word of asciiMatches) {
    tokens.push(word);
    // Split camelCase / snake_case parts for better FTS recall
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\s]+/)
      .filter((p) => p.length >= 2);
    tokens.push(...parts);
  }

  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return Array.from(new Set(tokens)).join(" ");
}

function buildFtsMatchExpressions(rawQuery: string): string[] {
  const clean = rawQuery.trim();
  if (!clean) return [];

  const tokens: string[] = [];
  const asciiWords = clean.match(/[A-Za-z0-9_]+/g) ?? [];
  for (const w of asciiWords) {
    tokens.push(`"${w.replace(/"/g, "")}"*`);
  }

  const cjkRuns = clean.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length <= 2) {
      tokens.push(`"${run}"`);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(`"${run.slice(i, i + 2)}"`);
      }
    }
  }

  if (tokens.length === 0) return [];
  if (tokens.length === 1) return [tokens[0]];
  return [tokens.join(" AND "), tokens.join(" OR ")];
}

function createSchemaValidator(workspaceRoot: string): ((data: unknown) => boolean) | null {
  const schemaPath = path.join(workspaceRoot, "schemas", "rea-api-entry.schema.json");
  if (!fs.existsSync(schemaPath)) {
    return null;
  }
  const schemaJson = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  type AjvLike = {
    compile: (s: Record<string, unknown>) => ((data: unknown) => boolean) & {
      errors?: Array<{ instancePath?: string; message?: string }> | null;
    };
  };
  type AjvCtorLike = new (opts: Record<string, unknown>) => AjvLike;
  type FormatsFnLike = (ajv: AjvLike) => unknown;

  const ajvModule = Ajv2020 as unknown as { default?: AjvCtorLike } | AjvCtorLike;
  const formatsModule = addFormats as unknown as { default?: FormatsFnLike } | FormatsFnLike;
  const AjvCtor =
    typeof ajvModule === "function" ? ajvModule : (ajvModule.default as AjvCtorLike);
  const formatsFn =
    typeof formatsModule === "function"
      ? formatsModule
      : (formatsModule.default as FormatsFnLike);
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  formatsFn(ajv);
  const validate = ajv.compile(schemaJson);
  return (data: unknown) => {
    const ok = validate(data);
    if (!ok) {
      const errs = validate.errors
        ?.map((e: { instancePath?: string; message?: string }) => `${e.instancePath ?? ""} ${e.message ?? ""}`)
        .join("; ");
      throw new Error(`REA catalog entry failed JSON Schema validation: ${errs}`);
    }
    return true;
  };
}

function initCatalogSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS api_entries (
      api_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      namespace TEXT,
      member_name TEXT,
      summary_zh TEXT NOT NULL,
      keywords_en TEXT NOT NULL,
      param_names TEXT NOT NULL,
      return_type_name TEXT NOT NULL,
      security_policy TEXT NOT NULL,
      entry_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_entries_tier ON api_entries(tier);
    CREATE INDEX IF NOT EXISTS idx_api_entries_domain ON api_entries(domain);
    CREATE INDEX IF NOT EXISTS idx_api_entries_security ON api_entries(security_policy);

    CREATE TABLE IF NOT EXISTS api_catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    DROP TABLE IF EXISTS api_entries_fts;
    CREATE VIRTUAL TABLE api_entries_fts USING fts5(
      api_id,
      namespace,
      member_name,
      summary_zh,
      keywords_en,
      param_names,
      return_type_name,
      cjk_tokens,
      tokenize='porter unicode61'
    );
  `);
}

function getReturnTypeName(entry: ReaApiCatalogEntry): string {
  const schema = entry.returns.schema as Record<string, unknown>;
  if (typeof schema["x-tsType"] === "string") return schema["x-tsType"];
  if (typeof schema.type === "string") return schema.type;
  return "any";
}

/**
 * Build the REA SQLite FTS5 catalog (`api_catalog.sqlite`) and fingerprint adapter binding table
 * (`adapter_bindings.<sha256>.json`) strictly in memory without persisting any pseudo-source code.
 */
export function buildReaCatalog(options: BuildCatalogOptions): BuildCatalogResult {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  fs.mkdirSync(options.outputDir, { recursive: true });

  let vfs: AsarMemoryVfs | null = null;
  if (options.sourcePath && fs.existsSync(options.sourcePath)) {
    vfs = AsarMemoryVfs.open(options.sourcePath);
  }

  try {
    const asarSha256 = vfs ? vfs.getSha256() : "offline-l1-only";
    const clientVersion = vfs ? vfs.getClientVersion() : null;

    const l1Result =
      options.preExtractedL1 ??
      extractL1FromVfsOrPackage({
        vfs,
        fallbackWorkspaceRoot: workspaceRoot,
      });

    const bundleScan: BundleScanResult =
      options.preScannedBundles ??
      (vfs
        ? scanVfsBundlesAst(vfs, { targetFiles: options.targetBundleFiles })
        : {
            scannedFiles: [],
            skippedFiles: [],
            classProfiles: [],
            l2Entries: [],
            l3Entries: [],
            l4Entries: [],
            drcRuleKeys: [],
            errorConstants: [],
            stateAccessors: [],
            commandGraphEdges: {},
          });

    const bindings = buildAdapterBindings({
      asarSha256,
      clientVersion,
      scanResult: bundleScan,
    });
    const bindingsPath = saveAdapterBindings(options.outputDir, bindings);

    // Merge L1 -> L2 -> L3 -> L4 deduplicated by apiId
    const mergedMap = new Map<string, ReaApiCatalogEntry>();
    for (const entry of [
      ...l1Result.entries,
      ...bundleScan.l2Entries,
      ...bundleScan.l3Entries,
      ...bundleScan.l4Entries,
    ]) {
      if (!mergedMap.has(entry.apiId)) {
        mergedMap.set(entry.apiId, entry);
      }
    }

    const allEntries = Array.from(mergedMap.values());
    if (options.validateSchema !== false) {
      const validateEntry = createSchemaValidator(workspaceRoot);
      if (validateEntry) {
        for (const entry of allEntries) {
          validateEntry(entry);
        }
      }
    }

    const sqlitePath = path.join(options.outputDir, "api_catalog.sqlite");
    if (fs.existsSync(sqlitePath)) {
      fs.rmSync(sqlitePath, { force: true });
    }
    const walPath = `${sqlitePath}-wal`;
    const shmPath = `${sqlitePath}-shm`;
    if (fs.existsSync(walPath)) fs.rmSync(walPath, { force: true });
    if (fs.existsSync(shmPath)) fs.rmSync(shmPath, { force: true });

    const db = new DatabaseSync(sqlitePath);
    try {
      initCatalogSchema(db);

      const insertEntry = db.prepare(`
        INSERT OR REPLACE INTO api_entries (
          api_id, tier, domain, kind, namespace, member_name,
          summary_zh, keywords_en, param_names, return_type_name,
          security_policy, entry_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertFts = db.prepare(`
        INSERT INTO api_entries_fts (
          api_id, namespace, member_name, summary_zh, keywords_en,
          param_names, return_type_name, cjk_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let l1Count = 0;
      let l2Count = 0;
      let l3Count = 0;
      let l4Count = 0;

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of allEntries) {
          if (entry.tier === "L1_PUBLIC") l1Count++;
          else if (entry.tier === "L2_COMMAND") l2Count++;
          else if (entry.tier === "L3_ENGINE") l3Count++;
          else if (entry.tier === "L4_IPC") l4Count++;

          const keywordsJoined = entry.keywordsEn.join(" ");
          const paramNames = entry.parameters.map((p) => p.name).join(" ");
          const retTypeName = getReturnTypeName(entry);
          const cjkTokens = expandSearchTokens(
            `${entry.summaryZh} ${entry.apiId} ${keywordsJoined} ${paramNames}`
          );

          insertEntry.run(
            entry.apiId,
            entry.tier,
            entry.domain,
            entry.kind,
            entry.namespace ?? "",
            entry.memberName ?? "",
            entry.summaryZh,
            keywordsJoined,
            paramNames,
            retTypeName,
            entry.securityPolicy,
            JSON.stringify(entry)
          );

          insertFts.run(
            entry.apiId,
            entry.namespace ?? "",
            entry.memberName ?? "",
            entry.summaryZh,
            keywordsJoined,
            paramNames,
            retTypeName,
            cjkTokens
          );
        }

        const indexedAt = new Date().toISOString();
        const stats: ReaCatalogStats = {
          totalApis: allEntries.length,
          l1Count,
          l2Count,
          l3Count,
          l4Count,
          degradedCapabilities: bindings.degradedCapabilities,
          asarSha256,
          indexPath: sqlitePath,
          indexedAt,
        };

        const insertMeta = db.prepare(
          "INSERT OR REPLACE INTO api_catalog_meta (key, value) VALUES (?, ?)"
        );
        insertMeta.run("stats", JSON.stringify(stats));
        insertMeta.run("asarSha256", asarSha256);
        insertMeta.run("clientVersion", clientVersion ?? "");
        insertMeta.run("indexedAt", indexedAt);

        db.exec("COMMIT");

        // Flush WAL into main sqlite file so read-only / single-file distribution is clean.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

        return {
          sqlitePath,
          bindingsPath,
          stats,
          bindings,
          scannedBundlesCount: bundleScan.scannedFiles.length,
          skippedBundlesCount: bundleScan.skippedFiles.length,
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback failure.
        }
        throw err;
      }
    } finally {
      db.close();
    }
  } finally {
    vfs?.close();
  }
}

/**
 * Perform sub-3ms SQLite FTS5 BM25 search across `api_catalog.sqlite`.
 * Excludes `BLOCKED` entries by default unless `includeBlocked` is explicitly true.
 */
export function searchReaCatalog(
  dbOrPath: DatabaseSync | string,
  query: string,
  options: SearchCatalogOptions = {}
): SearchCatalogResult {
  const startNs = process.hrtime.bigint();
  const ownedDb = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath, { readOnly: true }) : null;
  const db = ownedDb ?? (dbOrPath as DatabaseSync);

  try {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const matchExprs = buildFtsMatchExpressions(query);

    const buildFilterClauses = (): { whereSql: string; params: Array<string | number> } => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (!options.includeBlocked) {
        clauses.push("e.security_policy != 'BLOCKED'");
      }
      if (options.tier) {
        clauses.push("e.tier = ?");
        params.push(options.tier);
      }
      if (options.domain) {
        clauses.push("e.domain = ?");
        params.push(options.domain);
      }
      return {
        whereSql: clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "",
        params,
      };
    };

    const { whereSql, params: filterParams } = buildFilterClauses();

    if (matchExprs.length === 0) {
      const sql = `
        SELECT e.entry_json, 0 AS rank
        FROM api_entries e
        WHERE 1=1 ${whereSql}
        ORDER BY e.api_id ASC
        LIMIT ?
      `;
      const rows = db.prepare(sql).all(...filterParams, limit) as Array<{
        entry_json: string;
        rank: number;
      }>;
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      return {
        hits: rows.map((r) => ({
          entry: JSON.parse(r.entry_json) as ReaApiCatalogEntry,
          rank: r.rank,
        })),
        elapsedMs,
        queryUsed: "",
      };
    }

    for (const expr of matchExprs) {
      const sql = `
        SELECT e.entry_json, bm25(api_entries_fts, 10.0, 5.0, 8.0, 4.0, 4.0, 2.0, 2.0, 3.0) AS rank
        FROM api_entries_fts f
        JOIN api_entries e ON e.api_id = f.api_id
        WHERE api_entries_fts MATCH ? ${whereSql}
        ORDER BY rank ASC
        LIMIT ?
      `;
      const rows = db.prepare(sql).all(expr, ...filterParams, limit) as Array<{
        entry_json: string;
        rank: number;
      }>;
      if (rows.length > 0 || expr === matchExprs[matchExprs.length - 1]) {
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        return {
          hits: rows.map((r) => ({
            entry: JSON.parse(r.entry_json) as ReaApiCatalogEntry,
            rank: r.rank,
          })),
          elapsedMs,
          queryUsed: expr,
        };
      }
    }

    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    return { hits: [], elapsedMs, queryUsed: matchExprs[0] ?? "" };
  } finally {
    ownedDb?.close();
  }
}

/**
 * Retrieve the full structured metadata entry for a single `apiId`.
 */
export function describeReaApi(
  dbOrPath: DatabaseSync | string,
  apiId: string
): ReaApiCatalogEntry | null {
  const ownedDb = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath, { readOnly: true }) : null;
  const db = ownedDb ?? (dbOrPath as DatabaseSync);
  try {
    const row = db
      .prepare("SELECT entry_json FROM api_entries WHERE api_id = ?")
      .get(apiId) as { entry_json: string } | undefined;
    return row ? (JSON.parse(row.entry_json) as ReaApiCatalogEntry) : null;
  } finally {
    ownedDb?.close();
  }
}

/**
 * Read summary statistics from an existing `api_catalog.sqlite`.
 */
export function readReaCatalogStats(dbOrPath: DatabaseSync | string): ReaCatalogStats {
  const ownedDb = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath, { readOnly: true }) : null;
  const db = ownedDb ?? (dbOrPath as DatabaseSync);
  try {
    const row = db
      .prepare("SELECT value FROM api_catalog_meta WHERE key = 'stats'")
      .get() as { value: string } | undefined;
    if (row) {
      return JSON.parse(row.value) as ReaCatalogStats;
    }
    const counts = db
      .prepare("SELECT tier, COUNT(*) AS cnt FROM api_entries GROUP BY tier")
      .all() as Array<{ tier: string; cnt: number }>;
    const byTier: Record<string, number> = {};
    let total = 0;
    for (const c of counts) {
      byTier[c.tier] = Number(c.cnt);
      total += Number(c.cnt);
    }
    return {
      totalApis: total,
      l1Count: byTier.L1_PUBLIC ?? 0,
      l2Count: byTier.L2_COMMAND ?? 0,
      l3Count: byTier.L3_ENGINE ?? 0,
      l4Count: byTier.L4_IPC ?? 0,
      degradedCapabilities: [],
    };
  } finally {
    ownedDb?.close();
  }
}

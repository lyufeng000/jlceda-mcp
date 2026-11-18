import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ZeroSourceViolation {
  location: string;
  field: string;
  rule: string;
  snippetLength: number;
}

export interface ZeroSourceAuditReport {
  passed: boolean;
  scannedEntries: number;
  scannedBindingFiles: number;
  pseudoSourceBytesPersisted: number;
  blockedSensitiveCount: number;
  violations: ZeroSourceViolation[];
  durationMs: number;
}

export interface VerifyZeroSourceOptions {
  sqlitePath?: string;
  bindingsPath?: string;
  catalogDir?: string;
}

const FORBIDDEN_DUMP_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".map",
]);

const PSEUDO_SOURCE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "JS_FUNCTION_BODY",
    regex: /\bfunction\s*[A-Za-z0-9_$]*\s*\([^)]{0,120}\)\s*\{/,
  },
  {
    name: "ARROW_FUNCTION_BLOCK",
    regex: /=>\s*\{/,
  },
  {
    name: "JS_CLASS_BODY",
    regex: /\bclass\s+[A-Za-z0-9_$]+(?:\s+extends\s+[A-Za-z0-9_$.]+)?\s*\{[\s\S]{8,}\}/,
  },
  {
    name: "BUNDLER_BOILERPLATE",
    regex: /__webpack_require__|__webpack_modules__|module\.exports\s*=/,
  },
  {
    name: "JS_CONTROL_FLOW_BLOCK",
    regex: /\b(?:for|while|switch)\s*\([^)]{1,120}\)\s*\{|\btry\s*\{[\s\S]*\}\s*catch\s*\(/,
  },
  {
    name: "MULTI_STATEMENT_JS_CODE",
    regex: /;\s*(?:const|let|var|return|if|for|while|throw|switch)\b/,
  },
];

const SENSITIVE_CAPABILITY_RE =
  /(?:^|[./:_ -])(?:auth|login|logout|token|cookie|passport|payment|credential|password|setuserinfo|clearuserinfo|authorization)(?:$|[./:_ -])/i;

function scanTextForPseudoSource(
  text: string,
  location: string,
  field: string,
  violations: ZeroSourceViolation[]
): number {
  let bytesFound = 0;
  for (const pat of PSEUDO_SOURCE_PATTERNS) {
    const match = pat.regex.exec(text);
    if (match) {
      const len = Buffer.byteLength(match[0], "utf8");
      bytesFound += len;
      violations.push({
        location,
        field,
        rule: pat.name,
        snippetLength: len,
      });
    }
  }
  return bytesFound;
}

function scanJsonValueRecursively(
  value: unknown,
  location: string,
  fieldPath: string,
  violations: ZeroSourceViolation[]
): number {
  if (typeof value === "string") {
    return scanTextForPseudoSource(value, location, fieldPath, violations);
  }
  if (Array.isArray(value)) {
    let sum = 0;
    for (let i = 0; i < value.length; i++) {
      sum += scanJsonValueRecursively(value[i], location, `${fieldPath}[${i}]`, violations);
    }
    return sum;
  }
  if (value && typeof value === "object") {
    let sum = 0;
    for (const [k, v] of Object.entries(value)) {
      sum += scanJsonValueRecursively(v, location, `${fieldPath}.${k}`, violations);
    }
    return sum;
  }
  return 0;
}

/**
 * Audit generated REA catalog outputs (`api_catalog.sqlite`, `adapter_bindings.<sha256>.json`,
 * and `catalog/` directory) to assert **0 bytes of pseudo-source code persisted** and verify
 * sensitive IPC/command channels are locked down as `securityPolicy: "BLOCKED"`.
 */
export function verifyZeroSourceCatalog(
  options: VerifyZeroSourceOptions
): ZeroSourceAuditReport {
  const startNs = process.hrtime.bigint();
  const violations: ZeroSourceViolation[] = [];
  let pseudoSourceBytesPersisted = 0;
  let scannedEntries = 0;
  let scannedBindingFiles = 0;
  let blockedSensitiveCount = 0;

  const catalogDir =
    options.catalogDir ??
    (options.sqlitePath ? path.dirname(options.sqlitePath) : undefined);

  // 1. Verify no .js / .ts / .map decompiled source dumps exist inside catalogDir
  if (catalogDir && fs.existsSync(catalogDir)) {
    const walkDir = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walkDir(full);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (FORBIDDEN_DUMP_EXTENSIONS.has(ext)) {
            const sz = fs.statSync(full).size;
            pseudoSourceBytesPersisted += sz;
            violations.push({
              location: full,
              field: "file",
              rule: `FORBIDDEN_SOURCE_FILE(${ext})`,
              snippetLength: sz,
            });
          }
        }
      }
    };
    walkDir(catalogDir);
  }

  // 2. Scan SQLite catalog tables (api_entries, api_entries_fts, api_catalog_meta)
  const sqlitePath =
    options.sqlitePath ??
    (catalogDir ? path.join(catalogDir, "api_catalog.sqlite") : undefined);

  if (sqlitePath && fs.existsSync(sqlitePath)) {
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT api_id, tier, kind, member_name, summary_zh, keywords_en, param_names, return_type_name, security_policy, entry_json FROM api_entries"
        )
        .all() as Array<{
        api_id: string;
        tier: string;
        kind: string;
        member_name: string | null;
        summary_zh: string;
        keywords_en: string;
        param_names: string;
        return_type_name: string;
        security_policy: string;
        entry_json: string;
      }>;

      for (const row of rows) {
        scannedEntries++;
        const loc = `sqlite:api_entries:${row.api_id}`;
        pseudoSourceBytesPersisted += scanTextForPseudoSource(
          row.summary_zh,
          loc,
          "summary_zh",
          violations
        );
        pseudoSourceBytesPersisted += scanTextForPseudoSource(
          row.keywords_en,
          loc,
          "keywords_en",
          violations
        );
        pseudoSourceBytesPersisted += scanTextForPseudoSource(
          row.param_names,
          loc,
          "param_names",
          violations
        );
        pseudoSourceBytesPersisted += scanTextForPseudoSource(
          row.return_type_name,
          loc,
          "return_type_name",
          violations
        );
        try {
          const parsed = JSON.parse(row.entry_json) as unknown;
          pseudoSourceBytesPersisted += scanJsonValueRecursively(
            parsed,
            loc,
            "entry_json",
            violations
          );
        } catch {
          pseudoSourceBytesPersisted += scanTextForPseudoSource(
            row.entry_json,
            loc,
            "entry_json_raw",
            violations
          );
        }

        // Security gate check for sensitive L2/L4 channels
        if (
          (row.tier === "L4_IPC" || row.tier === "L2_COMMAND") &&
          SENSITIVE_CAPABILITY_RE.test(`${row.api_id} ${row.member_name ?? ""}`)
        ) {
          if (row.security_policy === "BLOCKED") {
            blockedSensitiveCount++;
          } else {
            violations.push({
              location: loc,
              field: "security_policy",
              rule: "UNBLOCKED_SENSITIVE_CHANNEL",
              snippetLength: row.api_id.length,
            });
          }
        }
      }

      const metaRows = db
        .prepare("SELECT key, value FROM api_catalog_meta")
        .all() as Array<{ key: string; value: string }>;
      for (const m of metaRows) {
        pseudoSourceBytesPersisted += scanTextForPseudoSource(
          m.value,
          `sqlite:api_catalog_meta:${m.key}`,
          "value",
          violations
        );
      }

      const ftsRows = db
        .prepare("SELECT api_id, summary_zh, cjk_tokens FROM api_entries_fts")
        .all() as Array<{ api_id: string; summary_zh: string; cjk_tokens: string }>;
      for (const f of ftsRows) {
        pseudoSourceBytesPersisted += scanTextForPseudoSource(
          f.cjk_tokens,
          `sqlite:api_entries_fts:${f.api_id}`,
          "cjk_tokens",
          violations
        );
      }
    } finally {
      db.close();
    }
  } else if (sqlitePath) {
    violations.push({
      location: sqlitePath,
      field: "file",
      rule: "MISSING_SQLITE_CATALOG",
      snippetLength: 0,
    });
  }

  // 3. Scan adapter_bindings.<sha256>.json files
  const bindingFiles: string[] = [];
  if (options.bindingsPath) {
    if (fs.existsSync(options.bindingsPath)) {
      bindingFiles.push(options.bindingsPath);
    } else {
      violations.push({
        location: options.bindingsPath,
        field: "file",
        rule: "MISSING_ADAPTER_BINDINGS",
        snippetLength: 0,
      });
    }
  } else if (catalogDir && fs.existsSync(catalogDir)) {
    for (const ent of fs.readdirSync(catalogDir)) {
      if (ent.startsWith("adapter_bindings.") && ent.endsWith(".json")) {
        bindingFiles.push(path.join(catalogDir, ent));
      }
    }
  }

  for (const bf of bindingFiles) {
    scannedBindingFiles++;
    const raw = fs.readFileSync(bf, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    pseudoSourceBytesPersisted += scanJsonValueRecursively(
      parsed,
      `json:${path.basename(bf)}`,
      "$",
      violations
    );
  }

  const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  return {
    passed: violations.length === 0 && pseudoSourceBytesPersisted === 0,
    scannedEntries,
    scannedBindingFiles,
    pseudoSourceBytesPersisted,
    blockedSensitiveCount,
    violations,
    durationMs,
  };
}

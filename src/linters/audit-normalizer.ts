import type {
  AuditNormalizedSummary,
  AuditReviewRow,
  ElintDiagnostic,
  MasterValidationReport,
  PlintFinding,
} from "../types/index.js";

export interface RawAuditFinding {
  severity: "BLOCKER" | "WARNING" | "INFO";
  ruleId: string;
  category: string;
  issue: string;
  net?: string;
  refs: string[];
  layer: string;
  evidence: string;
  locationMm?: [number, number];
}

export interface AuditNormalizeOptions {
  /** Collapse repeated WARNING findings of the same (ruleId, category) when count >= threshold (default: 6). */
  groupThreshold?: number;
  /** When true, expand grouped WARNING rows into individual rows. */
  expandAllWarnings?: boolean;
  /** When true, expand grouped INFO rows into individual rows. */
  expandAllInfo?: boolean;
}

const SEVERITY_ORDER: Record<RawAuditFinding["severity"], number> = {
  BLOCKER: 0,
  WARNING: 1,
  INFO: 2,
};

function formatNetAndRef(net: string | undefined, refs: string[]): string {
  const cleanRefs = Array.from(new Set(refs.filter((r) => Boolean(r && r.trim()))));
  const shownRefs =
    cleanRefs.length > 6
      ? [...cleanRefs.slice(0, 6), `…等 ${cleanRefs.length} 个`]
      : cleanRefs;

  if (net && shownRefs.length > 0) {
    return `${net} (${shownRefs.join("、")})`;
  }
  if (net) return net;
  if (shownRefs.length > 0) return shownRefs.join("、");
  return "—";
}

function buildDedupeFingerprint(item: RawAuditFinding): string | null {
  const sortedRefs = Array.from(new Set(item.refs.filter(Boolean))).sort();
  const loc = item.locationMm
    ? `${item.locationMm[0].toFixed(2)},${item.locationMm[1].toFixed(2)}`
    : "";
  const net = (item.net ?? "").trim();

  // Never collapse findings that carry no discriminating location/object/net fields
  if (sortedRefs.length === 0 && !loc && !net) {
    return null;
  }

  return [
    item.ruleId,
    item.category,
    item.layer,
    net,
    sortedRefs.join(","),
    loc,
  ].join("|");
}

/**
 * Three-stage audit noise normalizer inspired by real-board review discipline:
 *   1. Location/object fingerprint deduplication (independent of message wording; promotes highest severity)
 *   2. Deterministic sorting (BLOCKER -> WARNING -> INFO)
 *   3. Threshold-based grouping (BLOCKER never folded; WARNING >= threshold folded; INFO folded by default)
 */
export function normalizeAuditFindings(
  rawItems: RawAuditFinding[],
  options: AuditNormalizeOptions = {}
): AuditNormalizedSummary {
  const groupThreshold = Math.max(2, options.groupThreshold ?? 6);
  const expandAllWarnings = options.expandAllWarnings === true;
  const expandAllInfo = options.expandAllInfo === true;

  // Stage 1: Deduplicate by physical/logical fingerprint (not message text)
  interface DedupedItem extends RawAuditFinding {
    duplicateCount: number;
  }
  const seen = new Map<string, DedupedItem>();
  const deduped: DedupedItem[] = [];

  for (const item of rawItems) {
    const fp = buildDedupeFingerprint(item);
    if (fp && seen.has(fp)) {
      const existing = seen.get(fp)!;
      existing.duplicateCount += 1;
      // Keep the stricter severity when duplicated under mixed levels
      if (SEVERITY_ORDER[item.severity] < SEVERITY_ORDER[existing.severity]) {
        existing.severity = item.severity;
        existing.issue = item.issue;
        existing.evidence = item.evidence;
      }
      continue;
    }
    const entry: DedupedItem = { ...item, duplicateCount: 1 };
    if (fp) seen.set(fp, entry);
    deduped.push(entry);
  }

  // Stage 2: Sort by severity -> ruleId -> category
  deduped.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const r = a.ruleId.localeCompare(b.ruleId);
    if (r !== 0) return r;
    return a.category.localeCompare(b.category);
  });

  const blockerCount = deduped.filter((d) => d.severity === "BLOCKER").length;
  const warningCount = deduped.filter((d) => d.severity === "WARNING").length;
  const infoCount = deduped.filter((d) => d.severity === "INFO").length;

  // Stage 3: Fold high-volume WARNING groups and INFO groups while preserving every BLOCKER
  const rows: AuditReviewRow[] = [];
  let foldedGroupCount = 0;

  const warningBuckets = new Map<string, DedupedItem[]>();
  const infoBuckets = new Map<string, DedupedItem[]>();

  for (const item of deduped) {
    if (item.severity === "BLOCKER") {
      rows.push({
        index: rows.length + 1,
        severity: item.severity,
        ruleId: item.ruleId,
        category: item.category,
        issue: item.issue,
        netAndRef: formatNetAndRef(item.net, item.refs),
        layer: item.layer,
        evidence: item.evidence,
        duplicateCount: item.duplicateCount,
      });
    } else if (item.severity === "WARNING") {
      const key = `${item.ruleId}::${item.category}`;
      const list = warningBuckets.get(key) ?? [];
      list.push(item);
      warningBuckets.set(key, list);
    } else {
      const key = `${item.ruleId}::${item.category}`;
      const list = infoBuckets.get(key) ?? [];
      list.push(item);
      infoBuckets.set(key, list);
    }
  }

  const flushBucket = (
    items: DedupedItem[],
    shouldFold: boolean
  ) => {
    if (!shouldFold) {
      for (const item of items) {
        rows.push({
          index: rows.length + 1,
          severity: item.severity,
          ruleId: item.ruleId,
          category: item.category,
          issue: item.issue,
          netAndRef: formatNetAndRef(item.net, item.refs),
          layer: item.layer,
          evidence: item.evidence,
          duplicateCount: item.duplicateCount,
        });
      }
      return;
    }

    foldedGroupCount += 1;
    const head = items[0];
    const allLayers = Array.from(new Set(items.map((x) => x.layer)));
    const samples = items
      .slice(0, 3)
      .map((x) => formatNetAndRef(x.net, x.refs));
    const totalDupes = items.reduce((s, x) => s + x.duplicateCount, 0);

    rows.push({
      index: rows.length + 1,
      severity: head.severity,
      ruleId: head.ruleId,
      category: head.category,
      issue: `${head.issue}（同类共 ${items.length} 处已折叠）`,
      netAndRef: `${samples.join("；")}${items.length > 3 ? ` …共 ${items.length} 处` : ""}`,
      layer: allLayers.length === 1 ? allLayers[0] : allLayers.join("/"),
      evidence: `Folded ${items.length} unique finding(s) under ${head.ruleId}/${head.category}. Sample: ${head.evidence}`,
      duplicateCount: totalDupes,
      foldedCount: items.length,
      sampleRefs: samples,
    });
  };

  for (const items of warningBuckets.values()) {
    flushBucket(items, !expandAllWarnings && items.length >= groupThreshold);
  }
  for (const items of infoBuckets.values()) {
    flushBucket(items, !expandAllInfo && items.length >= 2);
  }

  return {
    rawCount: rawItems.length,
    dedupedCount: deduped.length,
    displayedRowCount: rows.length,
    blockerCount,
    warningCount,
    infoCount,
    foldedGroupCount,
    groupThreshold,
    rows,
  };
}

export function normalizeElintDiagnostics(
  diagnostics: ElintDiagnostic[],
  options: AuditNormalizeOptions = {}
): AuditNormalizedSummary {
  const raw: RawAuditFinding[] = diagnostics.map((d) => ({
    severity: d.severity,
    ruleId: d.rule_id,
    category: d.category,
    issue: `[${d.category}] ${d.mathematical_evidence}`,
    refs: d.offending_objects,
    layer: "—",
    evidence: `${d.rule_id}: ${d.mathematical_evidence}`,
  }));
  return normalizeAuditFindings(raw, options);
}

export function normalizePlintFindings(
  findings: PlintFinding[],
  nativeDrcErrors: Array<{
    code?: string;
    message: string;
    layer?: string;
    locationMm?: [number, number];
    primitives?: string[];
  }> = [],
  options: AuditNormalizeOptions = {}
): AuditNormalizedSummary {
  const raw: RawAuditFinding[] = [
    ...nativeDrcErrors.map((err): RawAuditFinding => ({
      severity: "BLOCKER",
      ruleId: err.code ?? "NATIVE_DRC",
      category: "NATIVE_DRC",
      issue: err.message,
      refs: err.primitives ?? [],
      layer: err.layer ?? "MultiLayer",
      evidence: `eda.pcb_Drc: ${err.message}`,
      locationMm: err.locationMm,
    })),
    ...findings.map((f): RawAuditFinding => ({
      severity: f.severity,
      ruleId: f.ruleId,
      category: f.category,
      issue: `[${f.category}] ${f.measuredValue} (threshold: ${f.threshold})`,
      net: f.net,
      refs: f.involvedPrimitives,
      layer: f.layer,
      evidence: `${f.ruleId}: measured=${f.measuredValue}, threshold=${f.threshold}`,
      locationMm: f.locationMm,
    })),
  ];
  return normalizeAuditFindings(raw, options);
}

export function normalizeMasterReport(
  blockers: MasterValidationReport["blockers"],
  warnings: MasterValidationReport["warnings"],
  options: AuditNormalizeOptions = {}
): AuditNormalizedSummary {
  const raw: RawAuditFinding[] = [
    ...blockers.map((b): RawAuditFinding => ({
      severity: "BLOCKER",
      ruleId: b.code,
      category: b.stage,
      issue: b.message,
      refs: [b.stage, b.code],
      layer: b.stage.startsWith("PCB") ? "PCB" : "—",
      evidence: `${b.stage}/${b.code}: ${b.message}`,
      locationMm: b.locationMm,
    })),
    ...warnings.map((w): RawAuditFinding => ({
      severity: "WARNING",
      ruleId: w.code,
      category: w.stage,
      issue: w.message,
      refs: [w.stage, w.code],
      layer: w.stage.startsWith("PCB") ? "PCB" : "—",
      evidence: `${w.stage}/${w.code}: ${w.message}`,
    })),
  ];
  return normalizeAuditFindings(raw, options);
}

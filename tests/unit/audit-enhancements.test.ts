import { describe, expect, it } from "vitest";
import {
  MIL_TO_MM,
  classifyCopperSensitiveComponent,
  computeContoursBbox,
  normalizeAuditFindings,
  parseEasyEdaContour,
  parseEasyEdaRect,
  parseEasyEdaSourceContours,
  pointInComplexContours,
  runElectricalLinter,
  runGeometryPcbLinter,
  runMasterValidationWithDetails,
  selfCheckSourceGeometry,
  type PcbBoardGeometrySnapshot,
} from "../../src/linters/index.js";
import type { CompiledNetlist } from "../../src/types/index.js";

describe("Audit Enhancements: EasyEDA source geometry, binary layer copper check, noise folding & uncovered disclosures", () => {
  it("parses EasyEDA ['R', x0, y0, w, h, rot, 0] across 0/90/180/270 deg quadrants and passes bbox self-check", () => {
    const cases: Array<{
      id: string;
      rot: number;
      expected: [number, number, number, number];
    }> = [
      { id: "rot0", rot: 0, expected: [10, 15, 30, 20] },
      { id: "rot90", rot: 90, expected: [10, 20, 15, 40] },
      { id: "rot180", rot: 180, expected: [-10, 20, 10, 25] },
      { id: "rot270", rot: 270, expected: [5, 0, 10, 20] },
    ];

    for (const c of cases) {
      const rect = parseEasyEdaRect(["R", 10, 20, 20, 5, c.rot, 0], "mm");
      const bb = computeContoursBbox([rect]);
      expect(bb).not.toBeNull();
      for (let i = 0; i < 4; i++) {
        expect(bb![i]).toBeCloseTo(c.expected[i], 6);
      }
    }

    // Verify mil -> mm scaling and self-check pass
    const milRect = ["R", 1000, 2000, 500, 200, 180, 0];
    const selfCheck = selfCheckSourceGeometry([
      {
        id: "KO_MIL_180",
        source: milRect,
        unit: "mil",
        expectedBboxMm: [
          500 * MIL_TO_MM,
          2000 * MIL_TO_MM,
          1000 * MIL_TO_MM,
          2200 * MIL_TO_MM,
        ],
      },
    ]);
    expect(selfCheck.passed).toBe(true);
    expect(selfCheck.checkedBboxCount).toBe(1);
    expect(selfCheck.bboxMismatches).toHaveLength(0);
  });

  it("parses EasyEDA ARC (sweep, endX, endY) dual-180° circles and 90° arcs accurately and flags bad bbox self-check", () => {
    // Full circle centered at (50, 50), radius 10: start (60,50) -> ARC 180 (40,50) -> ARC 180 (60,50)
    const circleSeg = [60, 50, "ARC", 180, 40, 50, "ARC", 180, 60, 50];
    const checkOk = selfCheckSourceGeometry([
      {
        id: "HOLE_CIRCLE",
        source: [circleSeg],
        expectedBboxMm: [40, 40, 60, 60],
      },
    ]);
    expect(checkOk.passed).toBe(true);
    expect(checkOk.checkedCircleCount).toBe(1);
    expect(checkOk.circleMismatches).toHaveLength(0);

    // 90-degree CCW quarter arc from (10, 0) to (0, 10) around origin (0, 0)
    const quarterArc = parseEasyEdaContour([10, 0, "ARC", 90, 0, 10], { arcSteps: 16 });
    expect(quarterArc.length).toBe(17);
    for (const [x, y] of quarterArc) {
      expect(Math.hypot(x, y)).toBeCloseTo(10, 4);
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
    }

    // Mismatched expected bbox must fail self-check
    const checkBad = selfCheckSourceGeometry([
      {
        id: "BAD_BBOX",
        source: [circleSeg],
        expectedBboxMm: [0, 0, 100, 100],
      },
    ]);
    expect(checkBad.passed).toBe(false);
    expect(checkBad.bboxMismatches).toHaveLength(1);
  });

  it("evaluates multi-contour even-odd copper polygons so inner keepout cutouts are excluded instead of filled solid", () => {
    // Outer pour [0..100, 0..100] with inner cutout [40..60, 40..60]
    const complexPourSource = [
      [0, 0, "L", 100, 0, 100, 100, 0, 100, 0, 0],
      [40, 40, "L", 60, 40, 60, 60, 40, 60, 40, 40],
    ];
    const contours = parseEasyEdaSourceContours(complexPourSource);
    expect(contours).toHaveLength(2);
    expect(pointInComplexContours([10, 10], contours)).toBe(true);
    expect(pointInComplexContours([50, 50], contours)).toBe(false);
    expect(pointInComplexContours([110, 50], contours)).toBe(false);
  });

  it("classifies copper-sensitive components accurately without misclassifying LED1 as an inductor", () => {
    expect(classifyCopperSensitiveComponent("LED1", "GREEN_LED", "0603")).toBeNull();
    expect(classifyCopperSensitiveComponent("L1", "4.7uH", "IND-SMD_L4.0-W4.0")).toBe("inductor");
    expect(classifyCopperSensitiveComponent("X1", "8MHz", "SMD-3225")).toBe("crystal");
    expect(classifyCopperSensitiveComponent("Y1", "TCXO_26M", "OSC-3225")).toBe("oscillator");
    expect(classifyCopperSensitiveComponent("E1", "2.4G_CHIP_ANT", "ANT-3216")).toBe("antenna");
  });

  it("catches 2-layer crystal signal pads covered by BottomLayer GND pour + single-layer keepout gap while honoring even-odd cutouts", () => {
    // Reproduces the classic 2-layer real-board bug: TopLayer has no-pour keepout + cutout around X1,
    // but BottomLayer forgot keepout and poured solid GND right under X1's OSC_IN/OSC_OUT pads!
    const topPourWithCutout = [
      [0, 0, "L", 80, 0, 80, 60, 0, 60, 0, 0],
      [25, 25, "L", 35, 25, 35, 35, 25, 35, 25, 25], // cutout around X1 at (30,30)
    ];
    const bottomSolidPour = [[0, 0, "L", 80, 0, 80, 60, 0, 60, 0, 0]];

    const board2L: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_2L_XTAL_COPPER_BUG",
      boardOutline: { widthMm: 80, heightMm: 60, layerCount: 2 },
      components: [
        {
          primitiveId: "X1",
          designator: "X1",
          mpn: "8MHz_XTAL",
          package: "SMD-3225",
          category: "XTAL_PASSIVE",
          layer: "TopLayer",
          centerMm: [30, 30],
          rotationDeg: 0,
          bboxMm: [28, 28.5, 32, 31.5],
          pads: [
            { primitiveId: "X1_1", designator: "X1", padNumber: "1", net: "OSC_IN", layer: "TopLayer", centerMm: [28.8, 29.2], sizeMm: [0.8, 0.8] },
            { primitiveId: "X1_2", designator: "X1", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [31.2, 29.2], sizeMm: [0.8, 0.8] },
            { primitiveId: "X1_3", designator: "X1", padNumber: "3", net: "OSC_OUT", layer: "TopLayer", centerMm: [31.2, 30.8], sizeMm: [0.8, 0.8] },
            { primitiveId: "X1_4", designator: "X1", padNumber: "4", net: "GND", layer: "TopLayer", centerMm: [28.8, 30.8], sizeMm: [0.8, 0.8] },
          ],
        },
        {
          primitiveId: "LED1",
          designator: "LED1",
          mpn: "0603_GREEN_LED",
          package: "0603",
          category: "LED",
          layer: "TopLayer",
          centerMm: [10, 10],
          rotationDeg: 0,
          bboxMm: [9, 9.5, 11, 10.5],
          pads: [
            { primitiveId: "LED1_1", designator: "LED1", padNumber: "1", net: "LED_DRV", layer: "TopLayer", centerMm: [9.4, 10], sizeMm: [0.6, 0.6] },
            { primitiveId: "LED1_2", designator: "LED1", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [10.6, 10], sizeMm: [0.6, 0.6] },
          ],
        },
      ],
      tracks: [],
      vias: [],
      pours: [
        {
          primitiveId: "POUR_TOP_GND",
          net: "GND",
          layer: "TopLayer",
          polygon2D: [],
          rawSource: topPourWithCutout,
          expectedBboxMm: [0, 0, 80, 60],
        },
        {
          primitiveId: "POUR_BOT_GND",
          net: "GND",
          layer: "BottomLayer",
          polygon2D: [],
          rawSource: bottomSolidPour,
          expectedBboxMm: [0, 0, 80, 60],
        },
      ],
      keepoutZones: [
        {
          id: "KO_X1_TOP_ONLY",
          category: "PASSIVE_CRYSTAL",
          ownerDesignator: "X1",
          polygon2D: [[26, 26], [34, 26], [34, 34], [26, 34]],
          layerSet: ["TopLayer"],
          disallowMask: ["COPPER_POUR"],
          allowedNets: [],
          mountSide: "TOP",
        },
      ],
    };

    const report = runGeometryPcbLinter(board2L);
    const copperFindings = report.customGeoLintFindings.filter(
      (f) => f.category === "SENSITIVE_PAD_UNDER_FOREIGN_COPPER"
    );
    // TopLayer cutout must prevent TopLayer false positives; BottomLayer must flag X1.1 and X1.3 ONLY (not GND pads X1.2/X1.4, not LED1)
    expect(copperFindings).toHaveLength(2);
    expect(copperFindings.every((f) => f.layer === "BottomLayer" && f.severity === "BLOCKER")).toBe(true);
    expect(copperFindings.map((f) => f.involvedPrimitives[0]).sort()).toEqual(["X1.1", "X1.3"]);

    const gapFindings = report.customGeoLintFindings.filter(
      (f) => f.category === "KEEPOUT_PARTIAL_LAYER_GAP"
    );
    expect(gapFindings).toHaveLength(1);
    expect(gapFindings[0].layer).toBe("BottomLayer");
    expect(gapFindings[0].severity).toBe("WARNING");
  });

  it("normalizes audit findings: deduplicates by location fingerprint, never folds BLOCKER, folds >=6 WARNINGs", () => {
    const raw = [
      // Duplicate at exact same location with different wording & mixed severities -> keep 1 BLOCKER, duplicateCount=2
      {
        severity: "WARNING" as const,
        ruleId: "PLINT-10",
        category: "ZERO_LEN_WIRE",
        issue: "零长度导线",
        net: "NET_A",
        refs: ["W1"],
        layer: "TopLayer",
        evidence: "warn msg",
        locationMm: [12.34, 56.78] as [number, number],
      },
      {
        severity: "BLOCKER" as const,
        ruleId: "PLINT-10",
        category: "ZERO_LEN_WIRE",
        issue: "wire contains a zero-length segment",
        net: "NET_A",
        refs: ["W1"],
        layer: "TopLayer",
        evidence: "error msg",
        locationMm: [12.34, 56.78] as [number, number],
      },
      // Two unlocated items must NOT be blindly merged
      {
        severity: "WARNING" as const,
        ruleId: "MISC-1",
        category: "UNLOCATED",
        issue: "unlocated finding A",
        refs: [],
        layer: "—",
        evidence: "ev A",
      },
      {
        severity: "WARNING" as const,
        ruleId: "MISC-1",
        category: "UNLOCATED",
        issue: "unlocated finding B",
        refs: [],
        layer: "—",
        evidence: "ev B",
      },
      // 7 distinct WARNINGs under same (ruleId, category) -> folded into 1 row by default
      ...Array.from({ length: 7 }, (_, i) => ({
        severity: "WARNING" as const,
        ruleId: "PLINT-16",
        category: "SILK_OVERLAP",
        issue: "丝印重叠",
        refs: [`R${i + 1}`],
        layer: "TopLayer",
        evidence: `R${i + 1} silkscreen overlaps pad`,
        locationMm: [i * 5, 10] as [number, number],
      })),
      // 7 distinct BLOCKERs -> must NEVER be folded
      ...Array.from({ length: 7 }, (_, i) => ({
        severity: "BLOCKER" as const,
        ruleId: "PLINT-14",
        category: "HV_CLEARANCE",
        issue: "高压间距不足",
        net: `HV_${i}`,
        refs: [`TR_${i}`],
        layer: "TopLayer",
        evidence: `clearance < 1.5mm`,
        locationMm: [i * 3, 20] as [number, number],
      })),
    ];

    const folded = normalizeAuditFindings(raw);
    expect(folded.rawCount).toBe(18);
    expect(folded.dedupedCount).toBe(17);
    expect(folded.blockerCount).toBe(8);
    expect(folded.warningCount).toBe(9);
    expect(folded.foldedGroupCount).toBe(1);
    // 8 BLOCKER rows + 2 unlocated WARNING rows + 1 folded SILK_OVERLAP row = 11 rows
    expect(folded.displayedRowCount).toBe(11);

    const dedupedRow = folded.rows.find((r) => r.category === "ZERO_LEN_WIRE");
    expect(dedupedRow?.severity).toBe("BLOCKER");
    expect(dedupedRow?.duplicateCount).toBe(2);

    const silkRow = folded.rows.find((r) => r.category === "SILK_OVERLAP");
    expect(silkRow?.foldedCount).toBe(7);
    expect(silkRow?.sampleRefs).toHaveLength(3);

    // Expanding all warnings displays all 7 silkscreen rows individually
    const expanded = normalizeAuditFindings(raw, { expandAllWarnings: true });
    expect(expanded.foldedGroupCount).toBe(0);
    expect(expanded.displayedRowCount).toBe(17);
  });

  it("explicitly discloses uncovered/degraded audit areas across ELINT, PLINT, and jlc_validate (missing data != pass)", () => {
    const minimalNetlist: CompiledNetlist = {
      netlistSource: "eda.sch_Netlist",
      documentName: "SCH_PARTIAL",
      components: [
        {
          primitiveId: "U1",
          designator: "U1",
          mpn: "UNKNOWN_IC",
          footprint: "SOIC-8",
          pins: [
            { pinNumber: "1", pinName: "VDD", elecType: "POWER_IN", net: "3V3", isConnected: true },
            { pinNumber: "2", pinName: "GND", elecType: "GND", net: "GND", isConnected: true },
          ],
        },
      ],
      nets: [
        {
          netName: "3V3",
          endpoints: [{ designator: "U1", pinNumber: "1", pinName: "VDD", elecType: "POWER_IN" }],
        },
        {
          netName: "GND",
          endpoints: [{ designator: "U1", pinNumber: "2", pinName: "GND", elecType: "GND" }],
        },
      ],
    };

    const elint = runElectricalLinter(minimalNetlist, {
      strictness: "prototype",
      isPartialSheetScope: true,
    });
    const elintAreas = new Set((elint.uncoveredItems ?? []).map((u) => u.area));
    expect(elintAreas.has("CROSS_PAGE_NET_COMPLETENESS")).toBe(true);
    expect(elintAreas.has("CESM_DATASHEET_RATINGS")).toBe(true);
    expect(elint.normalizedSummary).toBeDefined();

    const pcbNetlist: CompiledNetlist = {
      ...minimalNetlist,
      netlistSource: "eda.pcb_Netlist",
    };

    const pcbBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_UNMATERIALIZED",
      boardOutline: { widthMm: 50, heightMm: 50, layerCount: 2 },
      components: [],
      tracks: [],
      vias: [],
      pours: [
        {
          primitiveId: "POUR_NOT_REBUILT",
          net: "GND",
          layer: "BottomLayer",
          polygon2D: [[0, 0], [50, 0], [50, 50], [0, 50]],
          materialized: false,
        },
      ],
      nativeDrcResult: {
        unroutedRatlineCount: 0,
        errors: [{ code: "DRC_ABORT", message: "Netlist Error: schematic and PCB do not match" }],
      },
      observationMeta: {
        copperAvailability: { poured: "unavailable" },
        hasUnmaterializedPourOutlines: true,
        degradedNotes: ["Top outline downgraded to AABB (<50% bbox area)."],
      },
    };

    const detailed = runMasterValidationWithDetails({
      schDocument: "SCH_PARTIAL",
      pcbDocument: "PCB_UNMATERIALIZED",
      schNetlist: minimalNetlist,
      pcbNetlist,
      pcbGeometry: pcbBoard,
      strictness: "prototype",
      verifyManufacturability: false,
    });

    const areas = new Set((detailed.report.uncoveredItems ?? []).map((u) => u.area));
    expect(areas.has("COPPER_POUR_AUDIT")).toBe(true);
    expect(areas.has("COPPER_TELEMETRY_POURED")).toBe(true);
    expect(areas.has("NATIVE_PLATFORM_DRC")).toBe(true);
    expect(areas.has("CONTROLLED_IMPEDANCE")).toBe(true);
    expect(areas.has("TELEMETRY_DEGRADATION")).toBe(true);
    expect(areas.has("DFM_SMT_READINESS")).toBe(true);
    expect(detailed.report.normalizedSummary).toBeDefined();
  });
});

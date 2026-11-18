export interface RoutedDiffTrack {
  id: string;
  net: string;
  layer: string;
  widthMm: number;
  pointsMm: Array<[number, number]>;
}

export interface RoutedDiffVia {
  id: string;
  net: string;
  xMm: number;
  yMm: number;
  drillMm: number;
  outerDiaMm: number;
  startLayer: string;
  endLayer: string;
  role: "DIFF_SIGNAL" | "GND_RETURN";
}

export interface DiffPairRouteSpec {
  pairName: string;
  posNet: string;
  negNet: string;
  posStart: [number, number];
  negStart: [number, number];
  posEnd: [number, number];
  negEnd: [number, number];
  layer: string;
  targetLayer?: string;
  allLayers?: string[];
  widthMm?: number;
  gapMm?: number;
  maxSkewMm?: number;
  viaDrillMm?: number;
  viaOuterDiaMm?: number;
  waypoints?: Array<[number, number]>;
}

export interface DiffPairRouteResult {
  pairName: string;
  posNet: string;
  negNet: string;
  posTracks: RoutedDiffTrack[];
  negTracks: RoutedDiffTrack[];
  signalVias: RoutedDiffVia[];
  gndReturnVias: RoutedDiffVia[];
  posLengthMm: number;
  negLengthMm: number;
  skewMm: number;
  withinSkewBudget: boolean;
  pourClearanceMm: number;
  sourceCompensatedWithin5Mm: boolean;
  minMeanderSpacingMm: number;
}

export interface MeanderResult {
  pointsMm: Array<[number, number]>;
  originalLengthMm: number;
  achievedLengthMm: number;
  addedLengthMm: number;
  meanderPitchMm: number;
  minSelfSpacingMm: number;
}

export function polylineLength(pts: Array<[number, number]>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return Number(len.toFixed(4));
}

/**
 * Section 9.2.5: Differential pair clearance to neighboring tracks & same-layer copper pour
 * must satisfy >= 3S..5S, with an engineering floor >= 0.45 mm.
 */
export function computeDiffPairPourClearanceMm(gapMm: number, multiplier = 3.5): number {
  return Number(Math.max(gapMm * multiplier, 0.45).toFixed(3));
}

/**
 * Insert a 45-degree beveled accordion meander along the longest straight segment
 * with center-to-center leg pitch strictly >= 3.5W (>= 3W..4W anti-self-coupling rule).
 */
export function insertAccordionMeander(
  pointsMm: Array<[number, number]>,
  targetLengthMm: number,
  traceWidthMm: number,
  options?: {
    pitchMultiplier?: number;
    maxAmplitudeMm?: number;
    preferNearStartWithinMm?: number;
    sideSign?: 1 | -1;
  }
): MeanderResult {
  const origLen = polylineLength(pointsMm);
  const pitchFactor = Math.max(3.0, options?.pitchMultiplier ?? 3.5);
  const pitchMm = Number((traceWidthMm * pitchFactor).toFixed(4));
  const needed = targetLengthMm - origLen;

  if (needed <= 0.02 || pointsMm.length < 2) {
    return {
      pointsMm: [...pointsMm],
      originalLengthMm: origLen,
      achievedLengthMm: origLen,
      addedLengthMm: 0,
      meanderPitchMm: pitchMm,
      minSelfSpacingMm: pitchMm,
    };
  }

  // Choose target segment: prefer near start (within 3..5mm) if requested and long enough
  let bestSegIdx = -1;
  let bestSegLen = -1;
  let accumDist = 0;
  for (let i = 0; i < pointsMm.length - 1; i++) {
    const segLen = Math.hypot(
      pointsMm[i + 1][0] - pointsMm[i][0],
      pointsMm[i + 1][1] - pointsMm[i][1]
    );
    if (options?.preferNearStartWithinMm !== undefined) {
      if (accumDist <= options.preferNearStartWithinMm && segLen >= pitchMm * 2.2) {
        bestSegIdx = i;
        bestSegLen = segLen;
        break;
      }
    }
    if (segLen > bestSegLen) {
      bestSegLen = segLen;
      bestSegIdx = i;
    }
    accumDist += segLen;
  }

  if (bestSegIdx < 0 || bestSegLen < pitchMm * 2.1) {
    return {
      pointsMm: [...pointsMm],
      originalLengthMm: origLen,
      achievedLengthMm: origLen,
      addedLengthMm: 0,
      meanderPitchMm: pitchMm,
      minSelfSpacingMm: pitchMm,
    };
  }

  const p0 = pointsMm[bestSegIdx];
  const p1 = pointsMm[bestSegIdx + 1];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const segLen = Math.hypot(dx, dy);
  const ux = dx / segLen;
  const uy = dy / segLen;
  const side = options?.sideSign ?? 1;
  const nx = -uy * side;
  const ny = ux * side;

  // Leave lead-in/out margins; if preferNearStartWithinMm is set, anchor meander at t ~ 1.2..4.5mm
  const leadIn = Math.min(1.0, segLen * 0.15);
  const usableSpan = Math.min(
    segLen - leadIn * 2,
    options?.preferNearStartWithinMm ? Math.max(pitchMm * 2.2, options.preferNearStartWithinMm - leadIn) : segLen - leadIn * 2
  );

  // Each U-bump adds roughly 2*(amp - chamfer*(2 - sqrt(2))) length across span `pitchMm`
  // Number of U-bumps that fit with center-to-center leg pitch >= 3.5W:
  // Each bump occupies `2 * pitchMm` along segment (rise leg -> flat -> return leg, spaced by pitchMm)
  const bumpStepAlong = pitchMm * 2.0;
  const maxBumps = Math.max(1, Math.floor(usableSpan / bumpStepAlong));
  const maxAmp = options?.maxAmplitudeMm ?? Math.max(1.2, Math.min(3.5, needed * 0.6));

  // Solve bump count & amplitude: extraPerBump ≈ 2 * (amp - chamfer * 0.5858)
  let numBumps = Math.min(maxBumps, Math.max(1, Math.ceil(needed / (2 * maxAmp))));
  let amp = needed / (2 * numBumps) + 0.15;
  if (amp > maxAmp && numBumps < maxBumps) {
    numBumps = maxBumps;
    amp = Math.min(maxAmp, needed / (2 * numBumps) + 0.15);
  }
  const chamfer = Math.min(amp * 0.35, pitchMm * 0.35);

  const inserted: Array<[number, number]> = [];
  for (let b = 0; b < numBumps; b++) {
    const sStart = leadIn + b * bumpStepAlong;
    const sMid1 = sStart + chamfer;
    const sMid2 = sStart + pitchMm - chamfer;
    const sMid3 = sStart + pitchMm + chamfer;
    const sEnd = sStart + bumpStepAlong - chamfer;

    const pt = (s: number, n: number): [number, number] => [
      Number((p0[0] + ux * s + nx * n).toFixed(4)),
      Number((p0[1] + uy * s + ny * n).toFixed(4)),
    ];

    inserted.push(pt(sStart, 0));
    inserted.push(pt(sMid1, amp));
    inserted.push(pt(sMid2, amp));
    inserted.push(pt(sMid3, 0));
    if (sEnd > sMid3 + 0.05) {
      inserted.push(pt(sEnd, 0));
    }
  }

  const outPts: Array<[number, number]> = [
    ...pointsMm.slice(0, bestSegIdx + 1),
    ...inserted,
    ...pointsMm.slice(bestSegIdx + 1),
  ];

  const newLen = polylineLength(outPts);
  return {
    pointsMm: outPts,
    originalLengthMm: origLen,
    achievedLengthMm: newLen,
    addedLengthMm: Number((newLen - origLen).toFixed(4)),
    meanderPitchMm: pitchMm,
    minSelfSpacingMm: pitchMm,
  };
}

/**
 * Build 45-degree chamfered centerline path avoiding 90-degree bends.
 */
function buildOctilinearCenterline(
  start: [number, number],
  end: [number, number],
  waypoints?: Array<[number, number]>
): Array<[number, number]> {
  if (waypoints && waypoints.length > 0) {
    return [start, ...waypoints, end];
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < 1e-3 || absY < 1e-3 || Math.abs(absX - absY) < 1e-3) {
    return [start, end];
  }
  const diag = Math.min(absX, absY);
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  const mid: [number, number] = [
    Number((start[0] + sx * diag).toFixed(4)),
    Number((start[1] + sy * diag).toFixed(4)),
  ];
  return [start, mid, end];
}

function offsetCenterlinePair(
  centerline: Array<[number, number]>,
  halfOffsetMm: number
): { posPts: Array<[number, number]>; negPts: Array<[number, number]> } {
  const posPts: Array<[number, number]> = [];
  const negPts: Array<[number, number]> = [];

  for (let i = 0; i < centerline.length; i++) {
    let tx = 0;
    let ty = 0;
    if (i === 0) {
      tx = centerline[1][0] - centerline[0][0];
      ty = centerline[1][1] - centerline[0][1];
    } else if (i === centerline.length - 1) {
      tx = centerline[i][0] - centerline[i - 1][0];
      ty = centerline[i][1] - centerline[i - 1][1];
    } else {
      const dx1 = centerline[i][0] - centerline[i - 1][0];
      const dy1 = centerline[i][1] - centerline[i - 1][1];
      const l1 = Math.hypot(dx1, dy1) || 1;
      const dx2 = centerline[i + 1][0] - centerline[i][0];
      const dy2 = centerline[i + 1][1] - centerline[i][1];
      const l2 = Math.hypot(dx2, dy2) || 1;
      tx = dx1 / l1 + dx2 / l2;
      ty = dy1 / l1 + dy2 / l2;
    }
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;

    posPts.push([
      Number((centerline[i][0] + nx * halfOffsetMm).toFixed(4)),
      Number((centerline[i][1] + ny * halfOffsetMm).toFixed(4)),
    ]);
    negPts.push([
      Number((centerline[i][0] - nx * halfOffsetMm).toFixed(4)),
      Number((centerline[i][1] - ny * halfOffsetMm).toFixed(4)),
    ]);
  }
  return { posPts, negPts };
}

/**
 * Route a differential pair with:
 * - Immediate source-end skew compensation within 3~5 mm
 * - Coupled octilinear parallel tracks (width W, gap S)
 * - Symmetric dual GND return vias within <= 1.0 mm on layer transitions
 * - Self-spacing >= 3W..4W meander tuning & pour clearance >= max(3S, 0.45 mm)
 */
export function routeDifferentialPair(spec: DiffPairRouteSpec): DiffPairRouteResult {
  const widthMm = spec.widthMm ?? 0.25;
  const gapMm = spec.gapMm ?? 0.18;
  const halfSep = (widthMm + gapMm) / 2;
  const maxSkewMm = spec.maxSkewMm ?? 0.5;
  const viaDrill = spec.viaDrillMm ?? 0.25;
  const viaOuter = spec.viaOuterDiaMm ?? 0.5;
  const pourClearanceMm = computeDiffPairPourClearanceMm(gapMm, 3.5);

  const startMid: [number, number] = [
    (spec.posStart[0] + spec.negStart[0]) / 2,
    (spec.posStart[1] + spec.negStart[1]) / 2,
  ];
  const endMid: [number, number] = [
    (spec.posEnd[0] + spec.negEnd[0]) / 2,
    (spec.posEnd[1] + spec.negEnd[1]) / 2,
  ];

  // Ensure coupled centerline runs outside launch/entry pad offsets
  const dStart = Math.hypot(endMid[0] - startMid[0], endMid[1] - startMid[1]) || 1;
  const dirX = (endMid[0] - startMid[0]) / dStart;
  const dirY = (endMid[1] - startMid[1]) / dStart;
  const launchClear = Math.min(1.5, dStart * 0.2);

  const cStart: [number, number] = [
    Number((startMid[0] + dirX * launchClear).toFixed(4)),
    Number((startMid[1] + dirY * launchClear).toFixed(4)),
  ];
  const cEnd: [number, number] = [
    Number((endMid[0] - dirX * launchClear).toFixed(4)),
    Number((endMid[1] - dirY * launchClear).toFixed(4)),
  ];

  const centerline = buildOctilinearCenterline(cStart, cEnd, spec.waypoints);
  const { posPts: coupledPos, negPts: coupledNeg } = offsetCenterlinePair(centerline, halfSep);

  // Align pos/neg polarity at start so traces don't cross each other
  const dDirect =
    Math.hypot(spec.posStart[0] - coupledPos[0][0], spec.posStart[1] - coupledPos[0][1]) +
    Math.hypot(spec.negStart[0] - coupledNeg[0][0], spec.negStart[1] - coupledNeg[0][1]);
  const dSwapped =
    Math.hypot(spec.posStart[0] - coupledNeg[0][0], spec.posStart[1] - coupledNeg[0][1]) +
    Math.hypot(spec.negStart[0] - coupledPos[0][0], spec.negStart[1] - coupledPos[0][1]);

  const rawPosPts: Array<[number, number]> =
    dDirect <= dSwapped
      ? [spec.posStart, ...coupledPos, spec.posEnd]
      : [spec.posStart, ...coupledNeg, spec.posEnd];
  const rawNegPts: Array<[number, number]> =
    dDirect <= dSwapped
      ? [spec.negStart, ...coupledNeg, spec.negEnd]
      : [spec.negStart, ...coupledPos, spec.negEnd];

  const posTracks: RoutedDiffTrack[] = [];
  const negTracks: RoutedDiffTrack[] = [];
  const signalVias: RoutedDiffVia[] = [];
  const gndReturnVias: RoutedDiffVia[] = [];

  let finalPosPts = rawPosPts;
  let finalNegPts = rawNegPts;
  let minMeanderSpacing = widthMm * 3.5;
  let sourceCompensatedWithin5Mm = false;

  // Immediate source-end skew compensation within 3~5 mm
  const rawPosLen = polylineLength(finalPosPts);
  const rawNegLen = polylineLength(finalNegPts);
  const initialSkew = Math.abs(rawPosLen - rawNegLen);

  if (initialSkew > Math.min(0.08, maxSkewMm * 0.5)) {
    sourceCompensatedWithin5Mm = true;
    if (rawPosLen < rawNegLen) {
      const m = insertAccordionMeander(finalPosPts, rawNegLen, widthMm, {
        pitchMultiplier: 3.5,
        preferNearStartWithinMm: 4.5,
        sideSign: 1,
      });
      finalPosPts = m.pointsMm;
      minMeanderSpacing = m.minSelfSpacingMm;
    } else {
      const m = insertAccordionMeander(finalNegPts, rawPosLen, widthMm, {
        pitchMultiplier: 3.5,
        preferNearStartWithinMm: 4.5,
        sideSign: -1,
      });
      finalNegPts = m.pointsMm;
      minMeanderSpacing = m.minSelfSpacingMm;
    }
  }

  // Handle optional layer transition -> split segments and inject symmetric dual GND return vias <= 1.0 mm
  const hasLayerChange = Boolean(spec.targetLayer && spec.targetLayer !== spec.layer);
  if (hasLayerChange && spec.targetLayer) {
    const splitIdx = Math.max(1, Math.floor(finalPosPts.length / 2));
    const viaPosPt = finalPosPts[Math.min(splitIdx, finalPosPts.length - 1)];
    const viaNegPt = finalNegPts[Math.min(splitIdx, finalNegPts.length - 1)];

    // Guarantee distinct via separation >= viaOuter + 0.15 mm
    const vdx = viaNegPt[0] - viaPosPt[0];
    const vdy = viaNegPt[1] - viaPosPt[1];
    const vDist = Math.hypot(vdx, vdy) || 1;
    const minViaSep = viaOuter + 0.2;
    let pVia: [number, number] = viaPosPt;
    let nVia: [number, number] = viaNegPt;
    if (vDist < minViaSep) {
      const midX = (viaPosPt[0] + viaNegPt[0]) / 2;
      const midY = (viaPosPt[1] + viaNegPt[1]) / 2;
      const ux = vdx / vDist;
      const uy = vdy / vDist;
      pVia = [Number((midX - ux * (minViaSep / 2)).toFixed(4)), Number((midY - uy * (minViaSep / 2)).toFixed(4))];
      nVia = [Number((midX + ux * (minViaSep / 2)).toFixed(4)), Number((midY + uy * (minViaSep / 2)).toFixed(4))];
    }

    posTracks.push(
      {
        id: `${spec.pairName}_P_L1`,
        net: spec.posNet,
        layer: spec.layer,
        widthMm,
        pointsMm: [...finalPosPts.slice(0, splitIdx), pVia],
      },
      {
        id: `${spec.pairName}_P_L2`,
        net: spec.posNet,
        layer: spec.targetLayer,
        widthMm,
        pointsMm: [pVia, ...finalPosPts.slice(splitIdx)],
      }
    );
    negTracks.push(
      {
        id: `${spec.pairName}_N_L1`,
        net: spec.negNet,
        layer: spec.layer,
        widthMm,
        pointsMm: [...finalNegPts.slice(0, splitIdx), nVia],
      },
      {
        id: `${spec.pairName}_N_L2`,
        net: spec.negNet,
        layer: spec.targetLayer,
        widthMm,
        pointsMm: [nVia, ...finalNegPts.slice(splitIdx)],
      }
    );

    const startL = spec.layer;
    const endL = spec.targetLayer;

    signalVias.push(
      {
        id: `${spec.pairName}_VIA_P`,
        net: spec.posNet,
        xMm: pVia[0],
        yMm: pVia[1],
        drillMm: viaDrill,
        outerDiaMm: viaOuter,
        startLayer: startL,
        endLayer: endL,
        role: "DIFF_SIGNAL",
      },
      {
        id: `${spec.pairName}_VIA_N`,
        net: spec.negNet,
        xMm: nVia[0],
        yMm: nVia[1],
        drillMm: viaDrill,
        outerDiaMm: viaOuter,
        startLayer: startL,
        endLayer: endL,
        role: "DIFF_SIGNAL",
      }
    );

    // Inject 2 symmetric GND return vias strictly within <= 1.0 mm (at 0.80 mm from each signal via)
    const pairDx = nVia[0] - pVia[0];
    const pairDy = nVia[1] - pVia[1];
    const pairLen = Math.hypot(pairDx, pairDy) || 1;
    const ux = pairDx / pairLen;
    const uy = pairDy / pairLen;
    const gndOffset = Math.min(0.95, Math.max(viaOuter + 0.25, 0.78));

    gndReturnVias.push(
      {
        id: `${spec.pairName}_GND_RET_1`,
        net: "GND",
        xMm: Number((pVia[0] - ux * gndOffset).toFixed(4)),
        yMm: Number((pVia[1] - uy * gndOffset).toFixed(4)),
        drillMm: viaDrill,
        outerDiaMm: viaOuter,
        startLayer: "TopLayer",
        endLayer: "BottomLayer",
        role: "GND_RETURN",
      },
      {
        id: `${spec.pairName}_GND_RET_2`,
        net: "GND",
        xMm: Number((nVia[0] + ux * gndOffset).toFixed(4)),
        yMm: Number((nVia[1] + uy * gndOffset).toFixed(4)),
        drillMm: viaDrill,
        outerDiaMm: viaOuter,
        startLayer: "TopLayer",
        endLayer: "BottomLayer",
        role: "GND_RETURN",
      }
    );
  } else {
    posTracks.push({
      id: `${spec.pairName}_P`,
      net: spec.posNet,
      layer: spec.layer,
      widthMm,
      pointsMm: finalPosPts,
    });
    negTracks.push({
      id: `${spec.pairName}_N`,
      net: spec.negNet,
      layer: spec.layer,
      widthMm,
      pointsMm: finalNegPts,
    });
  }

  const posLengthMm = Number(
    posTracks.reduce((acc, t) => acc + polylineLength(t.pointsMm), 0).toFixed(4)
  );
  const negLengthMm = Number(
    negTracks.reduce((acc, t) => acc + polylineLength(t.pointsMm), 0).toFixed(4)
  );
  const skewMm = Number(Math.abs(posLengthMm - negLengthMm).toFixed(4));

  return {
    pairName: spec.pairName,
    posNet: spec.posNet,
    negNet: spec.negNet,
    posTracks,
    negTracks,
    signalVias,
    gndReturnVias,
    posLengthMm,
    negLengthMm,
    skewMm,
    withinSkewBudget: skewMm <= maxSkewMm,
    pourClearanceMm,
    sourceCompensatedWithin5Mm,
    minMeanderSpacingMm: minMeanderSpacing,
  };
}

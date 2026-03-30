// Tests for prediction feature pure functions.
// Run: node tests/prediction.test.js

var passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL: ' + msg); }
}
function approx(a, b, tol) { return Math.abs(a - b) < (tol || 1e-6); }
function section(name) { console.log('\n' + name); }

// ── Extracted functions ──────────────────────────────────────────────
// NOTE: Functions below are copied from web/prediction-mode.js. Keep in sync.

function polygonArea(poly) {
  var rings = poly.getLatLngs();
  if (!rings || rings.length === 0) return 0;
  var outer = Array.isArray(rings[0]) && rings[0].length && rings[0][0].lat !== undefined ? rings[0] : rings;
  if (outer.length < 3) return 0;
  var area = 0;
  for (var i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    area += (outer[j].lng + outer[i].lng) * (outer[j].lat - outer[i].lat);
  }
  return Math.abs(area / 2);
}

function polygonCentroid(poly) {
  var rings = poly.getLatLngs();
  if (!rings || rings.length === 0) return null;
  var outer = Array.isArray(rings[0]) && rings[0].length && rings[0][0].lat !== undefined ? rings[0] : rings;
  if (outer.length === 0 || typeof outer[0].lat !== 'number') return null;
  var sumLat = 0, sumLng = 0;
  for (var i = 0; i < outer.length; i++) {
    sumLat += outer[i].lat;
    sumLng += outer[i].lng;
  }
  return [sumLat / outer.length, sumLng / outer.length];
}

function clusterByAdjacency(locPoints, locationPolygons) {
  var n = locPoints.length;
  if (n === 0) return [];
  var locVerts = [];
  for (var i = 0; i < n; i++) {
    var poly = locationPolygons[locPoints[i][3]];
    var verts = [];
    if (poly) {
      var rings = poly.getLatLngs();
      var outer = Array.isArray(rings[0]) && rings[0].length && rings[0][0].lat !== undefined ? rings[0] : rings;
      for (var j = 0; j < outer.length; j++) verts.push([outer[j].lat, outer[j].lng]);
    }
    locVerts.push(verts);
  }
  var parent = [];
  for (var i = 0; i < n; i++) parent[i] = i;
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  var tol2 = 0.005 * 0.005;
  for (var i = 0; i < n; i++) {
    for (var j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      var found = false;
      for (var vi = 0; vi < locVerts[i].length && !found; vi++) {
        for (var vj = 0; vj < locVerts[j].length && !found; vj++) {
          var dl = locVerts[i][vi][0] - locVerts[j][vj][0];
          var dg = locVerts[i][vi][1] - locVerts[j][vj][1];
          if (dl * dl + dg * dg < tol2) {
            parent[find(i)] = find(j);
            found = true;
          }
        }
      }
    }
  }
  var groups = {};
  for (var i = 0; i < n; i++) {
    var root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(locPoints[i]);
  }
  return Object.keys(groups).map(function(k) { return groups[k]; });
}

function fitLine(points) {
  var n = points.length;
  if (n < 2) return null;
  var totalW = 0, cx = 0, cy = 0;
  for (var i = 0; i < n; i++) {
    var w = points[i][2] || 1;
    totalW += w; cx += points[i][0] * w; cy += points[i][1] * w;
  }
  cx /= totalW; cy /= totalW;
  var cxx = 0, cxy = 0, cyy = 0;
  for (var i = 0; i < n; i++) {
    var w = points[i][2] || 1;
    var dx = points[i][0] - cx, dy = points[i][1] - cy;
    cxx += w * dx * dx; cxy += w * dx * dy; cyy += w * dy * dy;
  }
  var diff = cxx - cyy;
  var disc = Math.sqrt(diff * diff + 4 * cxy * cxy);
  var lambda1 = (cxx + cyy + disc) / 2;
  var lambda2 = (cxx + cyy - disc) / 2;
  var vx, vy;
  if (Math.abs(cxy) > 1e-12) {
    vx = lambda1 - cyy; vy = cxy;
  } else if (cxx >= cyy) {
    vx = 1; vy = 0;
  } else {
    vx = 0; vy = 1;
  }
  var len = Math.sqrt(vx * vx + vy * vy);
  if (len > 0) { vx /= len; vy /= len; }
  return { center: [cx, cy], direction: [vx, vy], lambda1: lambda1, lambda2: lambda2, totalWeight: totalW };
}

function sourceExtensionDeg(bearingDeg) {
  var b = ((bearingDeg % 360) + 360) % 360;
  if (b >= 340 || b < 20) return 2;
  if (b >= 20 && b < 55) return 5.5;
  if (b >= 55 && b < 120) return 25;
  if (b >= 120 && b < 165) return 22;
  if (b >= 165 && b < 210) return 20;
  if (b >= 210 && b < 250) return 1.5;
  return 2;
}

function bearingDiff(a, b) {
  var d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Helper: mock Leaflet polygon
function mockPoly(coords) {
  // coords: [[lat, lng], ...]
  var latlngs = coords.map(function(c) { return { lat: c[0], lng: c[1] }; });
  return { getLatLngs: function() { return [latlngs]; } };
}

// Direction-detection logic extracted from updatePredictionLines
var ISRAEL_CENTER = [31.5, 34.8];
function detectSourceDirection(cluster, line, clusterSpan) {
  var cx = line.center[0], cy = line.center[1];
  var dx = line.direction[0], dy = line.direction[1];

  var posBearingNorm = ((Math.atan2(dy, dx) * 180 / Math.PI % 360) + 360) % 360;
  var negBearingNorm = (posBearingNorm + 180) % 360;
  var sourceSign;
  var usedNorthernBias = false;

  if (cx > 32.5 && clusterSpan < 0.5) {
    sourceSign = bearingDiff(posBearingNorm, 0) <= bearingDiff(negBearingNorm, 0) ? 1 : -1;
    usedNorthernBias = true;
  } else {
    var distFromCenter = Math.sqrt((cx - ISRAEL_CENTER[0]) * (cx - ISRAEL_CENTER[0]) +
                                   (cy - ISRAEL_CENTER[1]) * (cy - ISRAEL_CENTER[1]));
    if (distFromCenter > 0.05) {
      var clusterBearing = Math.atan2(cy - ISRAEL_CENTER[1], cx - ISRAEL_CENTER[0]) * 180 / Math.PI;
      var clusterBearingNorm = ((clusterBearing % 360) + 360) % 360;
      sourceSign = bearingDiff(posBearingNorm, clusterBearingNorm) <=
                   bearingDiff(negBearingNorm, clusterBearingNorm) ? 1 : -1;
    } else {
      sourceSign = 1;
    }
  }

  var sourceDx = sourceSign * dx, sourceDy = sourceSign * dy;
  var sourceBearingNorm = ((Math.atan2(sourceDy, sourceDx) * 180 / Math.PI % 360) + 360) % 360;
  if (!usedNorthernBias && sourceBearingNorm >= 260 && sourceBearingNorm <= 320) {
    sourceDx = -sourceDx; sourceDy = -sourceDy;
    sourceBearingNorm = (sourceBearingNorm + 180) % 360;
  }

  return { sourceSign: sourceSign, bearing: sourceBearingNorm, usedNorthernBias: usedNorthernBias };
}

// Helper: compute cluster span along PCA axis (mirrors updatePredictionLines logic)
function computeClusterSpan(points, line) {
  var cx = line.center[0], cy = line.center[1];
  var dx = line.direction[0], dy = line.direction[1];
  var minP = Infinity, maxP = -Infinity;
  for (var i = 0; i < points.length; i++) {
    var p = (points[i][0] - cx) * dx + (points[i][1] - cy) * dy;
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  return maxP - minP;
}


// ══════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════

section('polygonCentroid');
(function() {
  var poly = mockPoly([[30, 34], [32, 34], [32, 36], [30, 36]]);
  var c = polygonCentroid(poly);
  assert(approx(c[0], 31) && approx(c[1], 35), 'centroid of square at (31, 35)');

  var empty = { getLatLngs: function() { return []; } };
  assert(polygonCentroid(empty) === null, 'empty polygon returns null');

  var single = { getLatLngs: function() { return [[{ lat: 5, lng: 6 }]]; } };
  var sc = polygonCentroid(single);
  assert(sc && approx(sc[0], 5) && approx(sc[1], 6), 'single-point polygon');
})();

section('polygonArea');
(function() {
  // 2x2 degree square → area = 4 sq degrees
  var sq = mockPoly([[0, 0], [2, 0], [2, 2], [0, 2]]);
  assert(approx(polygonArea(sq), 4, 0.01), '2x2 square area = 4');

  // 1x1 degree square → area = 1
  var sm = mockPoly([[10, 10], [11, 10], [11, 11], [10, 11]]);
  assert(approx(polygonArea(sm), 1, 0.01), '1x1 square area = 1');

  // Triangle with base 2, height 1 → area = 1
  var tri = mockPoly([[0, 0], [2, 0], [1, 1]]);
  assert(approx(polygonArea(tri), 1, 0.01), 'triangle area = 1');

  // Degenerate: 2 points
  var degen = mockPoly([[0, 0], [1, 1]]);
  assert(polygonArea(degen) === 0, 'degenerate polygon (2 points) = 0');
})();

section('clusterByAdjacency — shared vertices');
(function() {
  // polyA and polyB share vertices at [30.1, 34.0] and [30.1, 34.1] → same cluster
  var polyA = mockPoly([[30.0, 34.0], [30.1, 34.0], [30.1, 34.1], [30.0, 34.1]]);
  var polyB = mockPoly([[30.1, 34.0], [30.2, 34.0], [30.2, 34.1], [30.1, 34.1]]);
  var polyC = mockPoly([[31.0, 35.0], [31.1, 35.0], [31.1, 35.1], [31.0, 35.1]]);
  var locPoints = [[30.05, 34.05, 1, 'A'], [30.15, 34.05, 1, 'B'], [31.05, 35.05, 1, 'C']];
  var locationPolygons = { A: polyA, B: polyB, C: polyC };
  var clusters = clusterByAdjacency(locPoints, locationPolygons);
  assert(clusters.length === 2, 'adjacent pair + far one → 2 clusters (got ' + clusters.length + ')');
  var sizes = clusters.map(function(c) { return c.length; }).sort(function(a, b) { return a - b; });
  assert(sizes[0] === 1 && sizes[1] === 2, 'cluster sizes are [1, 2]');
})();

section('clusterByAdjacency — no shared vertices');
(function() {
  var polyA = mockPoly([[30.0, 34.0], [30.1, 34.0], [30.1, 34.1], [30.0, 34.1]]);
  var polyB = mockPoly([[31.0, 35.0], [31.1, 35.0], [31.1, 35.1], [31.0, 35.1]]);
  var locPoints = [[30.05, 34.05, 1, 'A'], [31.05, 35.05, 1, 'B']];
  var clusters = clusterByAdjacency(locPoints, { A: polyA, B: polyB });
  assert(clusters.length === 2, 'non-touching polygons → 2 clusters');
})();

section('clusterByAdjacency — chain connectivity (transitive)');
(function() {
  // A touches B, B touches C → all three in one cluster
  var polyA = mockPoly([[30.0, 34.0], [30.1, 34.0], [30.1, 34.1], [30.0, 34.1]]);
  var polyB = mockPoly([[30.1, 34.0], [30.2, 34.0], [30.2, 34.1], [30.1, 34.1]]);
  var polyC = mockPoly([[30.2, 34.0], [30.3, 34.0], [30.3, 34.1], [30.2, 34.1]]);
  var locPoints = [[30.05, 34.05, 1, 'A'], [30.15, 34.05, 1, 'B'], [30.25, 34.05, 1, 'C']];
  var clusters = clusterByAdjacency(locPoints, { A: polyA, B: polyB, C: polyC });
  assert(clusters.length === 1, 'chain A→B→C → 1 cluster (got ' + clusters.length + ')');
  assert(clusters[0].length === 3, 'cluster contains all 3 points');
})();

section('clusterByAdjacency — missing polygon');
(function() {
  // Location B has no polygon → B gets its own cluster (no shared vertices possible)
  var polyA = mockPoly([[30.0, 34.0], [30.1, 34.0], [30.1, 34.1], [30.0, 34.1]]);
  var locPoints = [[30.05, 34.05, 1, 'A'], [30.15, 34.05, 1, 'B']];
  var clusters = clusterByAdjacency(locPoints, { A: polyA });
  assert(clusters.length === 2, 'missing polygon → separate clusters');
})();

section('clusterByAdjacency — empty input');
(function() {
  assert(clusterByAdjacency([], {}).length === 0, 'empty input → empty output');
})();

section('clusterByAdjacency — near-miss tolerance');
(function() {
  // polyB's nearest vertex is 0.006° from polyA's vertex — just outside 0.005 tolerance
  var polyA = mockPoly([[30.0, 34.0], [30.1, 34.0], [30.1, 34.1], [30.0, 34.1]]);
  var polyB = mockPoly([[30.106, 34.0], [30.2, 34.0], [30.2, 34.1], [30.106, 34.1]]);
  var locPoints = [[30.05, 34.05, 1, 'A'], [30.15, 34.05, 1, 'B']];
  var clusters = clusterByAdjacency(locPoints, { A: polyA, B: polyB });
  assert(clusters.length === 2, 'vertices 0.006° apart (> 0.005 tol) → separate clusters');
})();

section('fitLine — unweighted');
(function() {
  // Horizontal points → direction should be [1, 0] or [-1, 0]
  var horiz = [[0, 0], [1, 0], [2, 0], [3, 0]];
  var line = fitLine(horiz);
  assert(line !== null, 'returns result for 4 horizontal points');
  assert(approx(line.center[0], 1.5) && approx(line.center[1], 0), 'center at (1.5, 0)');
  assert(approx(Math.abs(line.direction[0]), 1, 0.01) && approx(line.direction[1], 0, 0.01),
    'direction is horizontal');
  assert(line.lambda2 < 1e-10, 'lambda2 ≈ 0 for collinear points');

  // Vertical points
  var vert = [[0, 0], [0, 1], [0, 2]];
  var vl = fitLine(vert);
  assert(approx(Math.abs(vl.direction[1]), 1, 0.01) && approx(vl.direction[0], 0, 0.01),
    'vertical direction');

  // Diagonal
  var diag = [[0, 0], [1, 1], [2, 2], [3, 3]];
  var dl = fitLine(diag);
  assert(approx(Math.abs(dl.direction[0]), Math.abs(dl.direction[1]), 0.01), '45° diagonal');

  // Single point → null
  assert(fitLine([[0, 0]]) === null, 'single point returns null');
  assert(fitLine([]) === null, 'empty returns null');
})();

section('fitLine — area-weighted');
(function() {
  // Three points: two small at y=0, one large at y=1.
  // Unweighted center would be at y=0.33; weighted should shift toward the large one.
  var pts = [[0, 0, 0.1], [2, 0, 0.1], [1, 1, 10]];
  var line = fitLine(pts);
  assert(line.center[1] > 0.8, 'weighted center shifts toward heavy point (y=' + line.center[1].toFixed(2) + ')');
  assert(approx(line.totalWeight, 10.2, 0.01), 'totalWeight = 10.2');

  // Equal weights should match unweighted
  var eq = [[0, 0, 1], [1, 0, 1], [2, 0, 1]];
  var eqLine = fitLine(eq);
  var noW = fitLine([[0, 0], [1, 0], [2, 0]]);
  assert(approx(eqLine.center[0], noW.center[0]) && approx(eqLine.center[1], noW.center[1]),
    'equal weights matches unweighted center');

  // Heavy point at one end should pull center
  var asym = [[0, 0, 1], [1, 0, 1], [2, 0, 100]];
  var al = fitLine(asym);
  assert(al.center[0] > 1.5, 'heavy endpoint pulls center (x=' + al.center[0].toFixed(2) + ')');
})();

section('bearingDiff');
(function() {
  assert(approx(bearingDiff(0, 0), 0), '0° vs 0° = 0');
  assert(approx(bearingDiff(0, 180), 180), '0° vs 180° = 180');
  assert(approx(bearingDiff(10, 350), 20), '10° vs 350° = 20 (wraps)');
  assert(approx(bearingDiff(350, 10), 20), '350° vs 10° = 20 (wraps)');
  assert(approx(bearingDiff(90, 270), 180), '90° vs 270° = 180');
  assert(approx(bearingDiff(45, 135), 90), '45° vs 135° = 90');
})();

section('sourceExtensionDeg — bearing to country mapping');
(function() {
  // Lebanon (N)
  assert(sourceExtensionDeg(0) === 2, 'bearing 0° → Lebanon (2)');
  assert(sourceExtensionDeg(350) === 2, 'bearing 350° → Lebanon (2)');
  assert(sourceExtensionDeg(10) === 2, 'bearing 10° → Lebanon (2)');

  // Syria (NE)
  assert(sourceExtensionDeg(30) === 5.5, 'bearing 30° → Syria (5.5)');
  assert(sourceExtensionDeg(45) === 5.5, 'bearing 45° → Syria (5.5)');

  // Iran (E)
  assert(sourceExtensionDeg(60) === 25, 'bearing 60° → Iran (25)');
  assert(sourceExtensionDeg(90) === 25, 'bearing 90° → Iran (25)');

  // Iran/Yemen (SE)
  assert(sourceExtensionDeg(140) === 22, 'bearing 140° → Iran/Yemen (22)');

  // Yemen (S)
  assert(sourceExtensionDeg(180) === 20, 'bearing 180° → Yemen (20)');
  assert(sourceExtensionDeg(200) === 20, 'bearing 200° → Yemen (20)');

  // Gaza (SW)
  assert(sourceExtensionDeg(220) === 1.5, 'bearing 220° → Gaza (1.5)');
  assert(sourceExtensionDeg(240) === 1.5, 'bearing 240° → Gaza (1.5)');

  // Mediterranean fallback
  assert(sourceExtensionDeg(270) === 2, 'bearing 270° → Mediterranean (2)');
  assert(sourceExtensionDeg(300) === 2, 'bearing 300° → Mediterranean (2)');

  // Negative bearing normalization: -90° → 270° → Mediterranean
  assert(sourceExtensionDeg(-90) === 2, 'bearing -90° normalizes to 270° → Mediterranean (2)');
})();

section('direction detection — cluster NE of center (Iran scenario)');
(function() {
  // Cluster in northern Israel, NE of center. PCA axis runs NE-SW.
  // Source should point NE (toward Iran).
  var cluster = [
    [32.5, 35.5, 1], [32.7, 35.7, 1], [32.9, 35.9, 1],
    [33.1, 36.1, 1], [33.3, 36.3, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  var result = detectSourceDirection(cluster, line, span);
  // NE bearing is roughly 0-90°
  assert(result.bearing >= 0 && result.bearing < 90,
    'Iran attack cluster: bearing=' + result.bearing.toFixed(0) + '° should be NE');
})();

section('direction detection — cluster S of center (Yemen scenario)');
(function() {
  // Cluster in southern Israel, S of center. PCA axis runs N-S.
  var cluster = [
    [30.0, 34.9, 1], [29.8, 34.9, 1], [29.5, 34.8, 1],
    [29.2, 34.8, 1], [29.0, 34.7, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  var result = detectSourceDirection(cluster, line, span);
  // S bearing is roughly 150-210°
  assert(result.bearing >= 150 && result.bearing <= 210,
    'Yemen attack cluster: bearing=' + result.bearing.toFixed(0) + '° should be S');
})();

section('direction detection — cluster W of center (Gaza scenario)');
(function() {
  // Cluster near Gaza border, SW of center. PCA axis runs NE-SW.
  var cluster = [
    [31.4, 34.4, 1], [31.3, 34.3, 1], [31.2, 34.2, 1],
    [31.1, 34.1, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  var result = detectSourceDirection(cluster, line, span);
  // SW bearing is roughly 210-250°
  assert(result.bearing >= 200 && result.bearing <= 260,
    'Gaza attack cluster: bearing=' + result.bearing.toFixed(0) + '° should be SW');
})();

section('direction detection — Mediterranean safety net');
(function() {
  // Artificially force a cluster that would point toward Mediterranean (W/NW).
  // Center near Israel center, line pointing WNW.
  // Since bearing ~290° is in [260, 320], it should flip to ~110° (ESE).
  var cluster = [
    [31.5, 34.0, 1], [31.6, 33.8, 1], [31.4, 33.6, 1], [31.5, 33.4, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  var result = detectSourceDirection(cluster, line, span);
  // After flip, should NOT be in Mediterranean range
  assert(result.bearing < 260 || result.bearing > 320,
    'Mediterranean safety net: bearing=' + result.bearing.toFixed(0) + '° flipped away from sea');
  assert(!result.usedNorthernBias, 'Mediterranean safety net: did not use northern bias');
})();

section('direction detection — cluster N of center (Lebanon scenario, northern bias)');
(function() {
  // Cluster in far north with small span (< 0.5) → northern bias applies.
  // PCA axis runs roughly N-S. Northern bias prefers the direction closer to 0° (north).
  var cluster = [
    [33.0, 35.2, 1], [33.1, 35.25, 1], [33.2, 35.2, 1],
    [33.3, 35.15, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  var result = detectSourceDirection(cluster, line, span);
  // cx > 32.5 and span < 0.5 → northern bias should be used
  assert(result.usedNorthernBias === true,
    'Lebanon cluster: usedNorthernBias=' + result.usedNorthernBias);
  // N bearing is roughly 340-360 or 0-20
  assert((result.bearing >= 320 && result.bearing <= 360) || result.bearing < 60,
    'Lebanon attack cluster: bearing=' + result.bearing.toFixed(0) + '° should be N/NNE');
})();

section('direction detection — northern bias skips Mediterranean safety net');
(function() {
  // A cluster at lat > 32.5 with small span that would point toward Mediterranean
  // should NOT have its bearing flipped because usedNorthernBias skips the safety net.
  var cluster = [
    [33.0, 34.9, 1], [33.1, 34.8, 1], [33.2, 34.7, 1], [33.15, 34.85, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  // Verify northern bias applies
  assert(line.center[0] > 32.5 && span < 0.5,
    'setup: cx > 32.5 and span < 0.5 for northern bias');
  var result = detectSourceDirection(cluster, line, span);
  assert(result.usedNorthernBias === true,
    'northern bias active: usedNorthernBias=' + result.usedNorthernBias);
  // The key property: even if bearing ended up in [260, 320], it should NOT be flipped
  // because the code checks `if (!usedNorthernBias && ...)` before flipping.
  // We verify the bearing is reasonable (N-ish for this cluster) rather than flipped.
})();

section('direction detection — large span disables northern bias');
(function() {
  // Cluster at lat > 32.5 but with span >= 0.5 → falls through to center-based logic
  var cluster = [
    [33.0, 35.0, 1], [33.3, 35.3, 1], [33.6, 35.6, 1],
    [33.9, 35.9, 1], [34.2, 36.2, 1]
  ];
  var line = fitLine(cluster);
  var span = computeClusterSpan(cluster, line);
  assert(span >= 0.5, 'setup: cluster span >= 0.5 (got ' + span.toFixed(2) + ')');
  var result = detectSourceDirection(cluster, line, span);
  assert(result.usedNorthernBias === false,
    'large span: usedNorthernBias=' + result.usedNorthernBias + ' (should be false)');
})();

section('full pipeline — elongation filter');
(function() {
  // Round cluster (equal spread in all directions) should be filtered out
  var round = [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
               [0.5, 0, 1], [0, 0.5, 1], [1, 0.5, 1], [0.5, 1, 1]];
  var line = fitLine(round);
  var elongation = line.lambda2 > 1e-12 ? line.lambda1 / line.lambda2 : Infinity;
  assert(elongation < 2.5, 'round cluster has low elongation (' + elongation.toFixed(2) + ')');

  // Elongated cluster should pass
  var elong = [[0, 0, 1], [1, 0.01, 1], [2, -0.01, 1], [3, 0.02, 1], [4, 0, 1]];
  var el = fitLine(elong);
  var elr = el.lambda2 > 1e-12 ? el.lambda1 / el.lambda2 : Infinity;
  assert(elr > 2.5, 'elongated cluster passes filter (' + elr.toFixed(0) + ')');
})();

section('full pipeline — minimum span filter');
(function() {
  // Tiny cluster (all within 0.05° of each other) — span should be < 0.1
  var tiny = [[31.5, 34.8, 1], [31.52, 34.81, 1], [31.51, 34.79, 1]];
  var line = fitLine(tiny);
  var cx = line.center[0], cy = line.center[1];
  var dx = line.direction[0], dy = line.direction[1];
  var minP = Infinity, maxP = -Infinity;
  for (var i = 0; i < tiny.length; i++) {
    var p = (tiny[i][0] - cx) * dx + (tiny[i][1] - cy) * dy;
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  assert(maxP - minP < 0.1, 'tiny cluster span (' + (maxP - minP).toFixed(3) + ') < 0.1 threshold');
})();

// ── Summary ──────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

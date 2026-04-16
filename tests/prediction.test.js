// Tests for prediction feature pure functions.
// Run: node tests/prediction.test.js

var passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL: ' + msg); }
}
function approx(a, b, tol) { return Math.abs(a - b) < (tol || 1e-6); }
function section(name) { console.log('\n' + name); }

// ── Extracted pure functions (mirrored from prediction-mode.js) ───────

var YELLOW_WINDOW_MS = 40 * 60 * 1000;
var CORRIDOR_DIST_DEG = 5000 / 111.32;

// Andrew's monotone chain convex hull. Points are [lat, lng] pairs.
function convexHull(points) {
  var n = points.length;
  if (n < 3) return points.slice();
  var pts = points.slice().sort(function(a, b) {
    return a[0] - b[0] || a[1] - b[1];
  });
  function cross(O, A, B) {
    return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  }
  var lower = [];
  for (var i = 0; i < n; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
    lower.push(pts[i]);
  }
  var upper = [];
  for (var i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
    upper.push(pts[i]);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Point-in-polygon (ray casting). border = {bbox, points: [[lat,lng], ...]}.
function pointInBorder(lat, lng, border) {
  var bbox = border.bbox;
  if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) return false;
  var pts = border.points;
  var n = pts.length;
  var inside = false;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var latI = pts[i][0], lngI = pts[i][1];
    var latJ = pts[j][0], lngJ = pts[j][1];
    if ((latI > lat) !== (latJ > lat)) {
      var lngInt = lngI + (lngJ - lngI) * (lat - latI) / (latJ - latI + 1e-20);
      if (lng < lngInt) inside = !inside;
    }
  }
  return inside;
}

function distToSegment(p, a, b) {
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var L2 = dx * dx + dy * dy;
  if (L2 < 1e-20) {
    var ddx = p[0] - a[0], ddy = p[1] - a[1];
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  var px = a[0] + t * dx, py = a[1] + t * dy;
  var qx = p[0] - px, qy = p[1] - py;
  return Math.sqrt(qx * qx + qy * qy);
}

function distToPolygonBoundary(p, polyVerts) {
  var min = Infinity;
  var n = polyVerts.length;
  for (var i = 0; i < n; i++) {
    var d = distToSegment(p, polyVerts[i], polyVerts[(i + 1) % n]);
    if (d < min) min = d;
  }
  return min;
}

function ellipsePoints(params, numPts) {
  var cx = params[0], cy = params[1], a = params[2], b = params[3], theta = params[4];
  var cosT = Math.cos(theta), sinT = Math.sin(theta);
  var pts = new Array(numPts);
  for (var i = 0; i < numPts; i++) {
    var phi = (i / numPts) * 2 * Math.PI;
    var cp = Math.cos(phi), sp = Math.sin(phi);
    pts[i] = [cx + a * cp * cosT - b * sp * sinT, cy + a * cp * sinT + b * sp * cosT];
  }
  return pts;
}

function ellipseInitialGuess(points) {
  var n = points.length;
  var sx = 0, sy = 0;
  for (var i = 0; i < n; i++) { sx += points[i][0]; sy += points[i][1]; }
  var cx = sx / n, cy = sy / n;
  var cxx = 0, cxy = 0, cyy = 0;
  for (var i = 0; i < n; i++) {
    var dx = points[i][0] - cx, dy = points[i][1] - cy;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  cxx /= n; cxy /= n; cyy /= n;
  var diff = cxx - cyy;
  var disc = Math.sqrt(diff * diff + 4 * cxy * cxy);
  var lambda1 = (cxx + cyy + disc) / 2;
  var lambda2 = (cxx + cyy - disc) / 2;
  if (lambda1 < 0) lambda1 = 0;
  if (lambda2 < 0) lambda2 = 0;
  var a = Math.sqrt(2 * lambda1);
  var b = Math.sqrt(2 * lambda2);
  var vx, vy;
  if (Math.abs(cxy) > 1e-12) { vx = lambda1 - cyy; vy = cxy; }
  else if (cxx >= cyy) { vx = 1; vy = 0; }
  else { vx = 0; vy = 1; }
  var theta = Math.atan2(vy, vx);
  if (a < b) { var t = a; a = b; b = t; theta += Math.PI / 2; }
  theta = ((theta + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2;
  if (a < 1e-6) a = 1e-6;
  if (b < 1e-6) b = 1e-6;
  return [cx, cy, a, b, theta];
}

function nelderMead(f, x0, step, maxIter) {
  var n = x0.length;
  var alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
  var simplex = new Array(n + 1);
  var values = new Array(n + 1);
  simplex[0] = x0.slice();
  values[0] = f(simplex[0]);
  for (var i = 0; i < n; i++) {
    var p = x0.slice();
    p[i] += step[i];
    simplex[i + 1] = p;
    values[i + 1] = f(p);
  }
  var order = new Array(n + 1);
  function reorder() {
    for (var i = 0; i <= n; i++) order[i] = i;
    order.sort(function(a, b) { return values[a] - values[b]; });
  }
  for (var iter = 0; iter < maxIter; iter++) {
    reorder();
    if (Math.abs(values[order[n]] - values[order[0]]) < 1e-8) break;
    var cent = new Array(n).fill(0);
    for (var i = 0; i < n; i++) { var s = simplex[order[i]]; for (var j = 0; j < n; j++) cent[j] += s[j]; }
    for (var j = 0; j < n; j++) cent[j] /= n;
    var xw = simplex[order[n]];
    var xr = new Array(n);
    for (var j = 0; j < n; j++) xr[j] = cent[j] + alpha * (cent[j] - xw[j]);
    var fr = f(xr);
    if (fr < values[order[n - 1]] && fr >= values[order[0]]) {
      simplex[order[n]] = xr; values[order[n]] = fr; continue;
    }
    if (fr < values[order[0]]) {
      var xe = new Array(n);
      for (var j = 0; j < n; j++) xe[j] = cent[j] + gamma * (xr[j] - cent[j]);
      var fe = f(xe);
      if (fe < fr) { simplex[order[n]] = xe; values[order[n]] = fe; }
      else { simplex[order[n]] = xr; values[order[n]] = fr; }
      continue;
    }
    var xc = new Array(n);
    for (var j = 0; j < n; j++) xc[j] = cent[j] + rho * (xw[j] - cent[j]);
    var fc = f(xc);
    if (fc < values[order[n]]) { simplex[order[n]] = xc; values[order[n]] = fc; continue; }
    var xb = simplex[order[0]];
    for (var i = 1; i <= n; i++) {
      var ss = simplex[order[i]];
      for (var j = 0; j < n; j++) ss[j] = xb[j] + sigma * (ss[j] - xb[j]);
      values[order[i]] = f(ss);
    }
  }
  reorder();
  return { x: simplex[order[0]], f: values[order[0]] };
}

function ellipseFitLoss(params, boundaryVerts, border, numPts, rMin, aspectMax) {
  var a = params[2], b = params[3];
  if (a <= 1e-9 || b <= 1e-9) return 1e12;
  var pts = ellipsePoints(params, numPts);
  var sumSq = 0, nInside = 0;
  for (var i = 0; i < numPts; i++) {
    if (!pointInBorder(pts[i][0], pts[i][1], border)) continue;
    nInside++;
    var d = distToPolygonBoundary(pts[i], boundaryVerts);
    sumSq += d * d;
  }
  if (nInside === 0) return 1e12;
  var ar = a > b ? a / b : b / a;
  var lossAspect = ar > aspectMax ? (ar - aspectMax) : 0;
  var lossSize = 0;
  if (a < rMin) lossSize += (rMin - a) / rMin;
  if (b < rMin) lossSize += (rMin - b) / rMin;
  return sumSq / nInside + lossAspect + lossSize;
}

var YELLOW_PATTERNS = [
  /בדקות הקרובות צפויות להתקבל התרעות/,
  /לשפר את המיקום למיגון/
];
function isYellowTitle(title) {
  if (!title) return false;
  var norm = String(title).replace(/\s+/g, ' ').trim();
  for (var i = 0; i < YELLOW_PATTERNS.length; i++) {
    if (YELLOW_PATTERNS[i].test(norm)) return true;
  }
  return false;
}

function parseAlertDateMs(s) {
  if (!s) return null;
  var d = new Date(String(s).replace(' ', 'T'));
  var t = d.getTime();
  return isNaN(t) ? null : t;
}

// adjacentNames: optional object used as a set of location names to restrict
// the yellow search (falsy = check all locations).
function hasPrecedingYellow(earliestRedMs, locationHistory, extHistory, adjacentNames) {
  if (!earliestRedMs) return false;
  var lo = earliestRedMs - YELLOW_WINDOW_MS;
  var hi = earliestRedMs;
  for (var name in locationHistory) {
    if (adjacentNames && !adjacentNames[name]) continue;
    var arr = locationHistory[name]; if (!arr) continue;
    for (var j = 0; j < arr.length; j++) {
      var e = arr[j]; if (!e || !isYellowTitle(e.title)) continue;
      var ts = parseAlertDateMs(e.alertDate);
      if (ts && ts >= lo && ts <= hi) return true;
    }
  }
  if (extHistory) {
    for (var i = 0; i < extHistory.length; i++) {
      var e = extHistory[i]; if (!e || !isYellowTitle(e.title)) continue;
      if (adjacentNames && e.location && !adjacentNames[e.location]) continue;
      var ts = typeof e.alertDate === 'number' ? e.alertDate : parseAlertDateMs(e.alertDate);
      if (ts && ts >= lo && ts <= hi) return true;
    }
  }
  return false;
}

function eastwardVector(theta) {
  var dLat = Math.cos(theta);
  var dLng = Math.sin(theta);
  if (dLng < 0) { dLat = -dLat; dLng = -dLng; }
  var bearingDeg = Math.atan2(dLng, dLat) * 180 / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;
  return { dLat: dLat, dLng: dLng, bearing: bearingDeg };
}

// Union polygon boundary — standalone version using raw [lat,lng] arrays.
// (Production version uses Leaflet polygon objects via polygonOuterRing.)
function clusterUnionBoundaryRaw(polygons) {
  var QFACTOR = 1e4;
  function qn(x) { return Math.round(x * QFACTOR) / QFACTOR; }
  function vkey(lat, lng) { return qn(lat) + ',' + qn(lng); }

  var edgeCount = Object.create(null);
  var edgeEnds  = Object.create(null);

  for (var i = 0; i < polygons.length; i++) {
    var outer = polygons[i];
    var nn = outer.length;
    for (var j = 0; j < nn; j++) {
      var lat1 = outer[j][0], lng1 = outer[j][1];
      var lat2 = outer[(j+1)%nn][0], lng2 = outer[(j+1)%nn][1];
      var ak = vkey(lat1, lng1), bk = vkey(lat2, lng2);
      if (ak === bk) continue;
      var ekey = ak < bk ? ak + '|' + bk : bk + '|' + ak;
      edgeCount[ekey] = (edgeCount[ekey] || 0) + 1;
      if (!edgeEnds[ekey]) edgeEnds[ekey] = [[qn(lat1), qn(lng1)], [qn(lat2), qn(lng2)]];
    }
  }

  var adj = Object.create(null);
  var pos = Object.create(null);

  for (var ekey in edgeCount) {
    if (edgeCount[ekey] !== 1) continue;
    var e = edgeEnds[ekey];
    var ak = vkey(e[0][0], e[0][1]), bk = vkey(e[1][0], e[1][1]);
    pos[ak] = e[0]; pos[bk] = e[1];
    if (!adj[ak]) adj[ak] = [];
    if (!adj[bk]) adj[bk] = [];
    adj[ak].push(bk);
    adj[bk].push(ak);
  }

  var vkeys = Object.keys(adj);
  if (vkeys.length === 0) return [];

  // Start from southernmost vertex
  var startKey = vkeys[0];
  for (var i = 1; i < vkeys.length; i++) {
    var p = pos[vkeys[i]], sp = pos[startKey];
    if (p[0] < sp[0] || (p[0] === sp[0] && p[1] < sp[1])) startKey = vkeys[i];
  }

  var adjCopy = Object.create(null);
  for (var k in adj) adjCopy[k] = adj[k].slice();

  var ring = [pos[startKey]];
  var prev = null, curr = startKey;

  for (var step = 0; step < vkeys.length + 4; step++) {
    var neighbors = adjCopy[curr];
    if (!neighbors || neighbors.length === 0) break;
    var next;
    if (neighbors.length === 1) {
      next = neighbors[0];
    } else {
      var cp = pos[curr], pp = prev ? pos[prev] : null;
      var bestKey = null, bestAng = Math.PI * 3;
      for (var ni = 0; ni < neighbors.length; ni++) {
        var nk = neighbors[ni];
        if (pp) {
          var v1x = cp[0]-pp[0], v1y = cp[1]-pp[1];
          var np = pos[nk];
          var v2x = np[0]-cp[0], v2y = np[1]-cp[1];
          var a1 = Math.atan2(v1y, v1x), a2 = Math.atan2(v2y, v2x);
          var d = (a2-a1+Math.PI) % (2*Math.PI) - Math.PI;
          if (Math.abs(d) < bestAng) { bestAng = Math.abs(d); bestKey = nk; }
        } else { bestKey = nk; break; }
      }
      next = bestKey || neighbors[0];
    }
    adjCopy[curr] = adjCopy[curr].filter(function(k) { return k !== next; });
    if (adjCopy[next]) adjCopy[next] = adjCopy[next].filter(function(k) { return k !== curr; });
    if (next === startKey) break;
    ring.push(pos[next]);
    prev = curr; curr = next;
  }

  return ring;
}

// ══════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════

section('constants');
(function() {
  assert(approx(CORRIDOR_DIST_DEG, 5000 / 111.32, 0.01),
    'CORRIDOR_DIST_DEG ≈ 44.9° (5000 km)');
  assert(YELLOW_WINDOW_MS === 40 * 60 * 1000, 'YELLOW_WINDOW_MS = 40 min');
})();

section('convexHull — basic cases');
(function() {
  // Square → all four corners on hull
  var square = [[0,0],[0,1],[1,0],[1,1],[0.5,0.5]];
  var hull = convexHull(square);
  assert(hull.length === 4, 'square: hull has 4 vertices, got ' + hull.length);

  // Collinear → hull still works (middle point removed)
  var line = [[0,0],[1,0],[2,0],[3,0]];
  var hLine = convexHull(line);
  assert(hLine.length === 2, 'collinear points → hull has 2 vertices');

  // Single-point passthrough
  var one = [[5,5]];
  assert(convexHull(one).length === 1, 'single point passes through');

  // Elongated set along diagonal
  var diag = [[0,0],[1,0.1],[2,0.05],[3,0.1],[4,0]];
  var hd = convexHull(diag);
  assert(hd.length >= 3, 'elongated set: hull has ≥ 3 vertices');

  // Hull encloses all input points
  var pts = [[1,2],[3,4],[2,1],[4,2],[3,3],[2,3]];
  var h = convexHull(pts);
  assert(h.length >= 3, 'random points → hull has ≥ 3 vertices');
})();

section('pointInBorder — ray-casting');
(function() {
  var squareBorder = {
    bbox: { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 },
    points: [[0,0],[10,0],[10,10],[0,10]]
  };
  assert(pointInBorder(5, 5, squareBorder), 'center is inside');
  assert(!pointInBorder(15, 5, squareBorder), 'outside (lat too high)');
  assert(!pointInBorder(5, -1, squareBorder), 'outside (lng negative)');
  assert(!pointInBorder(-1, 5, squareBorder), 'outside (lat negative)');

  var triBorder = {
    bbox: { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 },
    points: [[0,0],[10,0],[5,10]]
  };
  assert(pointInBorder(5, 4, triBorder), 'center-ish of triangle is inside');
  assert(!pointInBorder(1, 9, triBorder), 'top-left corner of bbox is outside triangle');
  assert(pointInBorder(1, 1, triBorder), 'bottom-left corner: inside triangle');
  assert(!pointInBorder(100, 100, squareBorder), 'far outside bbox → false');
})();

section('distToSegment');
(function() {
  assert(approx(distToSegment([1,0], [0,0], [2,0]), 0), 'projection to segment = 0 (on segment)');
  assert(approx(distToSegment([1,1], [0,0], [2,0]), 1), 'perpendicular distance = 1');
  assert(approx(distToSegment([-1,0], [0,0], [2,0]), 1), 'clamps to start endpoint');
  assert(approx(distToSegment([3,0], [0,0], [2,0]), 1), 'clamps to end endpoint');
  assert(approx(distToSegment([3,4], [0,0], [0,0]), 5), 'degenerate segment → point distance');
})();

section('distToPolygonBoundary');
(function() {
  var square = [[-1,-1],[-1,1],[1,1],[1,-1]];
  assert(approx(distToPolygonBoundary([0,0], square), 1, 0.01), 'center of unit square → dist 1');
  assert(approx(distToPolygonBoundary([1,0], square), 0, 0.01), 'on boundary → dist 0');
})();

section('ellipsePoints — parametric equations');
(function() {
  var r = 2;
  var params = [5, 5, r, r, 0];
  var pts = ellipsePoints(params, 100);
  for (var i = 0; i < pts.length; i++) {
    var dl = pts[i][0] - 5, dg = pts[i][1] - 5;
    assert(approx(Math.sqrt(dl*dl + dg*dg), r, 0.01),
      'circle point ' + i + ' at radius ' + r);
    if (!approx(Math.sqrt(dl*dl + dg*dg), r, 0.01)) break;
  }

  var params2 = [0, 0, 3, 1, 0];
  var pts2 = ellipsePoints(params2, 4);
  assert(approx(pts2[0][0], 3, 0.01) && approx(pts2[0][1], 0, 0.01), 'phi=0 → (cx+a, cy)');
  assert(approx(pts2[1][0], 0, 0.01) && approx(pts2[1][1], 1, 0.01), 'phi=pi/2 → (cx, cy+b)');
})();

section('ellipseInitialGuess — PCA-based');
(function() {
  var horiz = [];
  for (var i = 0; i < 10; i++) horiz.push([i * 0.1, 0]);
  var g = ellipseInitialGuess(horiz);
  assert(approx(g[0], 0.45, 0.01) && approx(g[1], 0, 0.01),
    'horizontal: center at (0.45, 0)');
  assert(approx(g[4], 0, 0.1), 'horizontal: theta ≈ 0, got ' + g[4].toFixed(3));
  assert(g[2] > g[3], 'horizontal: a > b');

  var vert = [];
  for (var i = 0; i < 10; i++) vert.push([0, i * 0.1]);
  var gv = ellipseInitialGuess(vert);
  assert(Math.abs(Math.abs(gv[4]) - Math.PI / 2) < 0.1,
    'vertical: theta ≈ ±pi/2, got ' + gv[4].toFixed(3));
  assert(gv[2] > gv[3], 'vertical: a > b');

  var tilted = [];
  for (var i = 0; i < 20; i++) {
    var phi = (i / 20) * 2 * Math.PI;
    tilted.push([3 * Math.cos(phi) * Math.cos(0.5) - 1 * Math.sin(phi) * Math.sin(0.5),
                 3 * Math.cos(phi) * Math.sin(0.5) + 1 * Math.sin(phi) * Math.cos(0.5)]);
  }
  var gt = ellipseInitialGuess(tilted);
  assert(approx(gt[0], 0, 0.1) && approx(gt[1], 0, 0.1),
    'tilted ellipse: center near origin, got (' + gt[0].toFixed(2) + ',' + gt[1].toFixed(2) + ')');
})();

section('nelderMead — simple 2D minimization');
(function() {
  var f = function(p) { return (p[0]-3)*(p[0]-3) + (p[1]-7)*(p[1]-7); };
  var res = nelderMead(f, [0, 0], [1, 1], 500);
  assert(approx(res.x[0], 3, 0.01) && approx(res.x[1], 7, 0.01),
    'quadratic min at (3,7): got (' + res.x[0].toFixed(3) + ',' + res.x[1].toFixed(3) + ')');
  assert(res.f < 0.001, 'loss ≈ 0 at minimum');

  var rosenbrock = function(p) {
    return (1 - p[0]) * (1 - p[0]) + 100 * (p[1] - p[0]*p[0]) * (p[1] - p[0]*p[0]);
  };
  var rRes = nelderMead(rosenbrock, [0, 0], [0.5, 0.5], 2000);
  assert(approx(rRes.x[0], 1, 0.05) && approx(rRes.x[1], 1, 0.05),
    'Rosenbrock min ≈ (1,1): got (' + rRes.x[0].toFixed(3) + ',' + rRes.x[1].toFixed(3) + ')');
})();

section('ellipseFitLoss — loss is zero when ellipse matches boundary exactly');
(function() {
  var bigBorder = {
    bbox: { minLat: -100, maxLat: 100, minLng: -100, maxLng: 100 },
    points: [[-100,-100],[100,-100],[100,100],[-100,100]]
  };
  var hull = [];
  for (var i = 0; i < 20; i++) {
    var phi = (i / 20) * 2 * Math.PI;
    hull.push([2 * Math.cos(phi), 2 * Math.sin(phi)]);
  }
  var params = [0, 0, 2, 2, 0];
  var loss = ellipseFitLoss(params, hull, bigBorder, 40, 0.1, 4);
  assert(loss < 0.01, 'circle fits circle boundary: loss ≈ 0, got ' + loss.toFixed(4));

  var tinyBorder = {
    bbox: { minLat: 90, maxLat: 91, minLng: 90, maxLng: 91 },
    points: [[90,90],[91,90],[91,91],[90,91]]
  };
  var lossOuts = ellipseFitLoss(params, hull, tinyBorder, 40, 0.1, 4);
  assert(lossOuts === 1e12, 'ellipse outside border → loss = 1e12');
})();

section('ellipseFitLoss — border truncation reduces loss');
(function() {
  var landBorder = {
    bbox: { minLat: 30, maxLat: 34, minLng: 35, maxLng: 40 },
    points: [[30,35],[34,35],[34,40],[30,40]]
  };
  var hullOnLand = [];
  for (var i = 0; i < 20; i++) {
    var phi = -Math.PI / 2 + (i / 19) * Math.PI;
    var lat = 32 + 2 * Math.cos(phi);
    var lng = 35 + 1 * Math.sin(phi);
    if (lng >= 35) hullOnLand.push([lat, lng]);
  }
  assert(hullOnLand.length >= 5, 'setup: hull has points on land');

  var trueParams = [32, 35, 2, 1, 0];
  var lossTrue = ellipseFitLoss(trueParams, hullOnLand, landBorder, 40, 0.1, 4);
  assert(lossTrue < 5, 'true ellipse has bounded loss against truncated hull: ' + lossTrue.toFixed(4));
})();

section('isYellowTitle — Iran/Yemen early warning detection');
(function() {
  assert(isYellowTitle('בדקות הקרובות צפויות להתקבל התרעות באזורך'), 'early warning title matches');
  assert(isYellowTitle('בדקות  הקרובות  צפויות  להתקבל  התרעות'), 'double-space variant matches');
  assert(isYellowTitle('על תושבי האזורים הבאים לשפר את המיקום למיגון המיטבי בקרבתך...'), 'preparedness notice matches');
  assert(!isYellowTitle('ירי רקטות וטילים'), 'rocket alert is not yellow');
  assert(!isYellowTitle('ירי רקטות וטילים - האירוע הסתיים'), 'all-clear is not yellow');
  assert(!isYellowTitle(''), 'empty string is not yellow');
  assert(!isYellowTitle(null), 'null is not yellow');
  assert(!isYellowTitle('יש לשהות בסמיכות למרחב המוגן'), 'stay-near-shelter is not Iran/Yemen yellow');
})();

section('hasPrecedingYellow — gate logic (no spatial filter)');
(function() {
  var base = new Date('2026-04-10T12:00:00Z').getTime();
  var fmtDate = function(ts) { return new Date(ts).toISOString().slice(0, 19) + 'Z'; };

  var histWithYellow = {
    'תל אביב': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 2 * 60 * 1000) },
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };
  assert(hasPrecedingYellow(base, histWithYellow, null, null), 'yellow 2 min before red → gate passes');

  var histJustOutside = {
    'תל אביב': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 41 * 60 * 1000) },
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };
  assert(!hasPrecedingYellow(base, histJustOutside, null, null), 'yellow 41 min before red → gate fails');

  var histOnlyRed = {
    'תל אביב': [{ title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }]
  };
  assert(!hasPrecedingYellow(base, histOnlyRed, null, null), 'no yellow at all → gate fails');

  // Yellow on a different location — no spatial filter, so it passes
  var histOtherLoc = {
    'באר שבע': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 3 * 60 * 1000) }
    ],
    'תל אביב': [{ title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }]
  };
  assert(hasPrecedingYellow(base, histOtherLoc, null, null), 'yellow on different location → gate passes');

  assert(!hasPrecedingYellow(base, {}, null, null), 'empty history → gate fails');
  assert(!hasPrecedingYellow(null, histWithYellow, null, null), 'null earliestRed → gate fails');

  // extendedHistory path (ms timestamp, with location field)
  var extHistYellow = [
    { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: base - 4 * 60 * 1000, state: 'yellow', location: 'חיפה' }
  ];
  assert(hasPrecedingYellow(base, {}, extHistYellow, null), 'extHistory ms yellow 4 min before red → gate passes');

  var extHistTooOld = [
    { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: base - 41 * 60 * 1000, state: 'yellow', location: 'חיפה' }
  ];
  assert(!hasPrecedingYellow(base, {}, extHistTooOld, null), 'extHistory ms yellow 41 min before → gate fails');
})();

section('hasPrecedingYellow — spatial filter (adjacentNames)');
(function() {
  var base = new Date('2026-04-10T12:00:00Z').getTime();
  var fmtDate = function(ts) { return new Date(ts).toISOString().slice(0, 19) + 'Z'; };

  // History contains yellow for 'חיפה' (north) and red cluster is in center Israel.
  var hist = {
    'חיפה': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 2 * 60 * 1000) }
    ],
    'תל אביב': [
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };

  // Without filter → passes (any yellow anywhere)
  assert(hasPrecedingYellow(base, hist, null, null),
    'no adjacentNames filter → yellow from חיפה counts');

  // With filter that only allows center-Israel locations → חיפה excluded → fails
  var centerAdj = { 'תל אביב': true, 'ראשון לציון': true, 'רמת גן': true };
  assert(!hasPrecedingYellow(base, hist, null, centerAdj),
    'adjacentNames excludes חיפה → gate fails for center cluster');

  // With filter that includes חיפה → passes
  var northAdj = { 'חיפה': true, 'עכו': true, 'נהריה': true };
  assert(hasPrecedingYellow(base, hist, null, northAdj),
    'adjacentNames includes חיפה → gate passes for north cluster');

  // extendedHistory with spatial filter
  var extHist = [
    { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: base - 3 * 60 * 1000, location: 'חיפה' }
  ];
  assert(!hasPrecedingYellow(base, {}, extHist, centerAdj),
    'extHistory: adjacentNames excludes חיפה → gate fails');
  assert(hasPrecedingYellow(base, {}, extHist, northAdj),
    'extHistory: adjacentNames includes חיפה → gate passes');

  // extHistory entry without a location field → treated as matching any filter
  var extHistNoLoc = [
    { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: base - 3 * 60 * 1000 }
  ];
  assert(hasPrecedingYellow(base, {}, extHistNoLoc, centerAdj),
    'extHistory entry with no location → always matches adjacentNames');
})();

section('eastwardVector — always returns positive-lng direction');
(function() {
  var v = eastwardVector(Math.PI / 4);
  assert(v.dLng > 0, 'NE: dLng > 0');
  assert(approx(v.bearing, 45, 0.5), 'NE: bearing ≈ 45°, got ' + v.bearing.toFixed(1));

  var vFlip = eastwardVector(-Math.PI / 4);
  assert(vFlip.dLng > 0, 'flipped NW→SE: dLng > 0');
  assert(approx(vFlip.bearing, 135, 0.5), 'flipped: bearing ≈ 135° (SE), got ' + vFlip.bearing.toFixed(1));

  var vE = eastwardVector(Math.PI / 2);
  assert(approx(vE.bearing, 90, 0.5), 'due east: bearing = 90°');

  var vW = eastwardVector(-Math.PI / 2);
  assert(approx(vW.bearing, 90, 0.5), 'west flipped to east: bearing = 90°');

  var vN = eastwardVector(0);
  assert(approx(vN.bearing, 0, 0.5), 'due north: bearing = 0° (N-S edge case)');
})();

section('clusterUnionBoundaryRaw — two adjacent squares');
(function() {
  // Two unit squares sharing an edge: left=[0,0]-[1,1], right=[0,1]-[1,2]
  // Union boundary should be a rectangle: 6 unique boundary edges → 6-vertex ring
  // (or 4 corners of the 1×2 bounding rect, but union boundary keeps the vertex count)
  var leftSquare = [[0,0],[1,0],[1,1],[0,1]];
  var rightSquare = [[0,1],[1,1],[1,2],[0,2]];
  var ring = clusterUnionBoundaryRaw([leftSquare, rightSquare]);
  assert(ring.length >= 4, 'two adjacent squares → union ring has ≥ 4 vertices, got ' + ring.length);
  // Interior edge ([0,1]–[1,1]) should NOT appear in the ring;
  // the boundary should span lat∈[0,1], lng∈[0,2].
  var lats = ring.map(function(p) { return p[0]; });
  var lngs = ring.map(function(p) { return p[1]; });
  assert(Math.min.apply(null, lats) >= 0 - 1e-4 && Math.max.apply(null, lats) <= 1 + 1e-4,
    'union ring lat range [0,1]');
  assert(Math.min.apply(null, lngs) >= 0 - 1e-4 && Math.max.apply(null, lngs) <= 2 + 1e-4,
    'union ring lng range [0,2]');

  // Single polygon → all edges are boundary edges → ring = polygon
  var tri = [[0,0],[1,0],[0.5,1]];
  var triRing = clusterUnionBoundaryRaw([tri]);
  assert(triRing.length === 3, 'single triangle → ring has 3 vertices, got ' + triRing.length);
})();

section('clusterUnionBoundaryRaw — L-shaped cluster');
(function() {
  // Three unit squares forming an L-shape:
  //   bottom-left=[0,0]-[1,1], bottom-right=[0,1]-[1,2], top-left=[1,0]-[2,1]
  var sq1 = [[0,0],[1,0],[1,1],[0,1]]; // bottom-left
  var sq2 = [[0,1],[1,1],[1,2],[0,2]]; // bottom-right
  var sq3 = [[1,0],[2,0],[2,1],[1,1]]; // top-left
  var ring = clusterUnionBoundaryRaw([sq1, sq2, sq3]);
  assert(ring.length >= 6, 'L-shaped cluster → ring has ≥ 6 vertices (has concavity), got ' + ring.length);
  // Bounding box should cover full extents
  var lats = ring.map(function(p) { return p[0]; });
  var lngs = ring.map(function(p) { return p[1]; });
  assert(Math.min.apply(null, lats) < 0.1, 'L-shape: ring reaches lat ≈ 0');
  assert(Math.max.apply(null, lats) > 1.9, 'L-shape: ring reaches lat ≈ 2');
  assert(Math.max.apply(null, lngs) > 1.9, 'L-shape: ring reaches lng ≈ 2');
})();

section('full pipeline — ellipse fit converges on synthetic truncated data');
(function() {
  var cx_true = 31.5, cy_true = 35.5, a_true = 0.8, b_true = 0.3, theta_true = 0.6;
  var fullPts = [];
  for (var i = 0; i < 40; i++) {
    var phi = (i / 40) * 2 * Math.PI;
    var cp = Math.cos(phi), sp = Math.sin(phi);
    var cosT = Math.cos(theta_true), sinT = Math.sin(theta_true);
    var lat = cx_true + a_true * cp * cosT - b_true * sp * sinT;
    var lng = cy_true + a_true * cp * sinT + b_true * sp * cosT;
    fullPts.push([lat, lng]);
  }
  var border = {
    bbox: { minLat: 28, maxLat: 36, minLng: 35.2, maxLng: 42 },
    points: [[28,35.2],[36,35.2],[36,42],[28,42]]
  };
  var landPts = fullPts.filter(function(p) { return p[1] >= 35.2; });
  var hull = convexHull(landPts);
  assert(hull.length >= 4, 'hull has enough points: ' + hull.length);

  var guess = ellipseInitialGuess(hull);
  assert(guess[0] > 30 && guess[0] < 33, 'initial guess center lat in range');

  var lossTrue = ellipseFitLoss(
    [cx_true, cy_true, a_true, b_true, theta_true],
    hull, border, 40, 0.05, 4
  );
  var lossBad = ellipseFitLoss(
    [cx_true + 2, cy_true + 2, a_true, b_true, theta_true],
    hull, border, 40, 0.05, 4
  );
  assert(lossTrue < lossBad, 'true params have lower loss than shifted params');
  assert(lossTrue < 5, 'true ellipse loss is finite and bounded: ' + lossTrue.toFixed(4));
})();

// ── Summary ──────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

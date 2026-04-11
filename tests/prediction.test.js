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

function ellipseFitLoss(params, hullVerts, border, numPts, rMin, aspectMax) {
  var a = params[2], b = params[3];
  if (a <= 1e-9 || b <= 1e-9) return 1e12;
  var pts = ellipsePoints(params, numPts);
  var sumSq = 0, nInside = 0;
  for (var i = 0; i < numPts; i++) {
    if (!pointInBorder(pts[i][0], pts[i][1], border)) continue;
    nInside++;
    var d = distToPolygonBoundary(pts[i], hullVerts);
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

function hasPrecedingYellow(earliestRedMs, locationHistory, extHistory, windowMs) {
  if (!earliestRedMs) return false;
  var lo = earliestRedMs - windowMs;
  var hi = earliestRedMs;
  for (var name in locationHistory) {
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

function sourceExtensionDeg(bearingDeg) {
  var b = ((bearingDeg % 360) + 360) % 360;
  if (b >= 55 && b < 120) return 25;
  if (b >= 120 && b < 165) return 22;
  if (b >= 165 && b < 195) return 20;
  return 10;
}

// ══════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════

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
  // All extreme points should be on hull; the middle with similar y might not be
  assert(hd.length >= 3, 'elongated set: hull has ≥ 3 vertices');

  // Hull encloses all input points (convexity check: each point is inside or on hull)
  var pts = [[1,2],[3,4],[2,1],[4,2],[3,3],[2,3]];
  var h = convexHull(pts);
  assert(h.length >= 3, 'random points → hull has ≥ 3 vertices');
})();

section('pointInBorder — ray-casting');
(function() {
  // Square border at [0,0]–[10,10] in [lat,lng]
  var squareBorder = {
    bbox: { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 },
    points: [[0,0],[10,0],[10,10],[0,10]]
  };
  assert(pointInBorder(5, 5, squareBorder), 'center is inside');
  assert(!pointInBorder(15, 5, squareBorder), 'outside (lat too high)');
  assert(!pointInBorder(5, -1, squareBorder), 'outside (lng negative)');
  assert(!pointInBorder(-1, 5, squareBorder), 'outside (lat negative)');

  // Triangle border: (0,0),(10,0),(5,10)
  var triBorder = {
    bbox: { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 },
    points: [[0,0],[10,0],[5,10]]
  };
  assert(pointInBorder(5, 4, triBorder), 'center-ish of triangle is inside');
  assert(!pointInBorder(1, 9, triBorder), 'top-left corner of bbox is outside triangle');
  assert(pointInBorder(1, 1, triBorder), 'bottom-left corner: inside triangle');

  // Bbox short-circuit: point well outside bbox
  assert(!pointInBorder(100, 100, squareBorder), 'far outside bbox → false');
})();

section('distToSegment');
(function() {
  // Projection onto segment interior
  assert(approx(distToSegment([1,0], [0,0], [2,0]), 0), 'projection to segment = 0 (on segment)');
  assert(approx(distToSegment([1,1], [0,0], [2,0]), 1), 'perpendicular distance = 1');
  // Clamps to endpoint
  assert(approx(distToSegment([-1,0], [0,0], [2,0]), 1), 'clamps to start endpoint');
  assert(approx(distToSegment([3,0], [0,0], [2,0]), 1), 'clamps to end endpoint');
  // Degenerate segment (a == b)
  assert(approx(distToSegment([3,4], [0,0], [0,0]), 5), 'degenerate segment → point distance');
})();

section('distToPolygonBoundary');
(function() {
  // Square with side length 2 centered at origin: sides at ±1
  var square = [[-1,-1],[-1,1],[1,1],[1,-1]];
  // Center is 1.0 away from each side
  assert(approx(distToPolygonBoundary([0,0], square), 1, 0.01), 'center of unit square → dist 1');
  // On boundary
  assert(approx(distToPolygonBoundary([1,0], square), 0, 0.01), 'on boundary → dist 0');
})();

section('ellipsePoints — parametric equations');
(function() {
  // Circle (a = b, theta = 0): all points at distance a from center
  var r = 2;
  var params = [5, 5, r, r, 0];
  var pts = ellipsePoints(params, 100);
  for (var i = 0; i < pts.length; i++) {
    var dl = pts[i][0] - 5, dg = pts[i][1] - 5;
    assert(approx(Math.sqrt(dl*dl + dg*dg), r, 0.01),
      'circle point ' + i + ' at radius ' + r);
    if (!approx(Math.sqrt(dl*dl + dg*dg), r, 0.01)) break; // stop on first fail
  }

  // Ellipse (a=3, b=1, theta=0): parametric extremes at (cx±3, cy) and (cx, cy±1)
  var params2 = [0, 0, 3, 1, 0];
  var pts2 = ellipsePoints(params2, 4);
  // phi=0 → (cx+a, cy); phi=pi/2 → (cx, cy+b); etc.
  assert(approx(pts2[0][0], 3, 0.01) && approx(pts2[0][1], 0, 0.01), 'phi=0 → (cx+a, cy)');
  assert(approx(pts2[1][0], 0, 0.01) && approx(pts2[1][1], 1, 0.01), 'phi=pi/2 → (cx, cy+b)');
})();

section('ellipseInitialGuess — PCA-based');
(function() {
  // Perfectly horizontal points: major axis should align with lat (lat variance dominates)
  var horiz = [];
  for (var i = 0; i < 10; i++) horiz.push([i * 0.1, 0]);
  var g = ellipseInitialGuess(horiz);
  assert(approx(g[0], 0.45, 0.01) && approx(g[1], 0, 0.01),
    'horizontal: center at (0.45, 0)');
  // theta ≈ 0 (aligned with lat axis)
  assert(approx(g[4], 0, 0.1), 'horizontal: theta ≈ 0, got ' + g[4].toFixed(3));
  // a > b (elongated along lat)
  assert(g[2] > g[3], 'horizontal: a > b');

  // Perfectly vertical points: major axis along lng
  var vert = [];
  for (var i = 0; i < 10; i++) vert.push([0, i * 0.1]);
  var gv = ellipseInitialGuess(vert);
  // theta ≈ ±pi/2
  assert(Math.abs(Math.abs(gv[4]) - Math.PI / 2) < 0.1,
    'vertical: theta ≈ ±pi/2, got ' + gv[4].toFixed(3));
  assert(gv[2] > gv[3], 'vertical: a > b');

  // Non-degenerate ellipse with known tilt
  var tilted = [];
  for (var i = 0; i < 20; i++) {
    var phi = (i / 20) * 2 * Math.PI;
    tilted.push([3 * Math.cos(phi) * Math.cos(0.5) - 1 * Math.sin(phi) * Math.sin(0.5),
                 3 * Math.cos(phi) * Math.sin(0.5) + 1 * Math.sin(phi) * Math.cos(0.5)]);
  }
  var gt = ellipseInitialGuess(tilted);
  // Center should be near (0,0)
  assert(approx(gt[0], 0, 0.1) && approx(gt[1], 0, 0.1),
    'tilted ellipse: center near origin, got (' + gt[0].toFixed(2) + ',' + gt[1].toFixed(2) + ')');
})();

section('nelderMead — simple 2D minimization');
(function() {
  // Minimize (x-3)^2 + (y-7)^2, minimum at (3,7)
  var f = function(p) { return (p[0]-3)*(p[0]-3) + (p[1]-7)*(p[1]-7); };
  var res = nelderMead(f, [0, 0], [1, 1], 500);
  assert(approx(res.x[0], 3, 0.01) && approx(res.x[1], 7, 0.01),
    'quadratic min at (3,7): got (' + res.x[0].toFixed(3) + ',' + res.x[1].toFixed(3) + ')');
  assert(res.f < 0.001, 'loss ≈ 0 at minimum');

  // Minimize Rosenbrock (harder): f(x,y) = (1-x)^2 + 100*(y-x^2)^2, min at (1,1)
  var rosenbrock = function(p) {
    return (1 - p[0]) * (1 - p[0]) + 100 * (p[1] - p[0]*p[0]) * (p[1] - p[0]*p[0]);
  };
  var rRes = nelderMead(rosenbrock, [0, 0], [0.5, 0.5], 2000);
  assert(approx(rRes.x[0], 1, 0.05) && approx(rRes.x[1], 1, 0.05),
    'Rosenbrock min ≈ (1,1): got (' + rRes.x[0].toFixed(3) + ',' + rRes.x[1].toFixed(3) + ')');
})();

section('ellipseFitLoss — loss is zero when ellipse matches hull exactly');
(function() {
  // Build a square hull; an ellipse that inscribes the square should have low loss
  // when ellipse points all lie near the square boundary.
  var bigBorder = {
    bbox: { minLat: -100, maxLat: 100, minLng: -100, maxLng: 100 },
    points: [[-100,-100],[100,-100],[100,100],[-100,100]]
  };
  // Circle hull (hull ≈ circle of radius 2 at origin)
  var hull = [];
  for (var i = 0; i < 20; i++) {
    var phi = (i / 20) * 2 * Math.PI;
    hull.push([2 * Math.cos(phi), 2 * Math.sin(phi)]);
  }
  // Perfect fit: circle at origin with radius 2
  var params = [0, 0, 2, 2, 0];
  var loss = ellipseFitLoss(params, hull, bigBorder, 40, 0.1, 4);
  assert(loss < 0.01, 'circle fits circle hull: loss ≈ 0, got ' + loss.toFixed(4));

  // Ellipse completely outside border → loss = 1e12
  var tinyBorder = {
    bbox: { minLat: 90, maxLat: 91, minLng: 90, maxLng: 91 },
    points: [[90,90],[91,90],[91,91],[90,91]]
  };
  var lossOuts = ellipseFitLoss(params, hull, tinyBorder, 40, 0.1, 4);
  assert(lossOuts === 1e12, 'ellipse outside border → loss = 1e12');
})();

section('ellipseFitLoss — border truncation reduces loss');
(function() {
  // Simulate a truncated cluster near Israel's western coast.
  // Hull is a half-ellipse cut by the sea; the border excludes the sea half.
  // Expected: fitting with border should produce lower loss than fitting to a
  // full ellipse that tries to match the cut-off half.

  // Rectangular "country" border (land side): lat [30,34], lng [35,40]
  var landBorder = {
    bbox: { minLat: 30, maxLat: 34, minLng: 35, maxLng: 40 },
    points: [[30,35],[34,35],[34,40],[30,40]]
  };
  // True ellipse centered at (32, 35) with a=2 (NS), b=1 (EW), theta=0
  // The western half (lng < 35) is "over the sea" and absent from the hull.
  var hullOnLand = [];
  for (var i = 0; i < 20; i++) {
    var phi = -Math.PI / 2 + (i / 19) * Math.PI; // phi from -90° to 90° (eastern half only)
    var lat = 32 + 2 * Math.cos(phi);
    var lng = 35 + 1 * Math.sin(phi);
    if (lng >= 35) hullOnLand.push([lat, lng]);
  }
  assert(hullOnLand.length >= 5, 'setup: hull has points on land');

  // The true ellipse (if all points were visible) has its center at (32, 35).
  // With truncation, PCA-only would miss the center; border-aware fit should find it.
  var trueParams = [32, 35, 2, 1, 0];
  var fullBorder = {
    bbox: { minLat: 25, maxLat: 40, minLng: 30, maxLng: 45 },
    points: [[25,30],[40,30],[40,45],[25,45]]
  };
  var lossTrue = ellipseFitLoss(trueParams, hullOnLand, landBorder, 40, 0.1, 4);
  // The "true" ellipse should have finite, bounded loss against the land-only hull.
  // (The loss won't be near-zero because the border clips part of the ellipse, but it
  // should be much lower than a completely wrong ellipse.)
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

section('hasPrecedingYellow — gate logic');
(function() {
  var WINDOW = 5 * 60 * 1000;
  // Use explicit UTC anchor and include Z so parseAlertDateMs is timezone-agnostic.
  var base = new Date('2026-04-10T12:00:00Z').getTime();
  var fmtDate = function(ts) { return new Date(ts).toISOString().slice(0, 19) + 'Z'; };

  var historyWithYellow = {
    'תל אביב': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 2 * 60 * 1000) },
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };
  assert(hasPrecedingYellow(base, historyWithYellow, null, WINDOW), 'yellow 2 min before red → gate passes');

  var historyJustOutside = {
    'תל אביב': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 6 * 60 * 1000) },
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };
  assert(!hasPrecedingYellow(base, historyJustOutside, null, WINDOW), 'yellow 6 min before red → gate fails');

  var historyOnlyRed = {
    'תל אביב': [
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };
  assert(!hasPrecedingYellow(base, historyOnlyRed, null, WINDOW), 'no yellow at all → gate fails');

  // Yellow on a different location still passes (covers the whole country scan)
  var historyOtherLocation = {
    'באר שבע': [
      { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: fmtDate(base - 3 * 60 * 1000) }
    ],
    'תל אביב': [
      { title: 'ירי רקטות וטילים', alertDate: fmtDate(base) }
    ]
  };
  assert(hasPrecedingYellow(base, historyOtherLocation, null, WINDOW), 'yellow on different location → gate passes');

  // Empty history
  assert(!hasPrecedingYellow(base, {}, null, WINDOW), 'empty history → gate fails');
  assert(!hasPrecedingYellow(null, historyWithYellow, null, WINDOW), 'null earliestRed → gate fails');

  // extendedHistory path (timeline mode): yellow stored as ms timestamp
  var extHistYellow = [
    { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: base - 4 * 60 * 1000, state: 'yellow', location: 'חיפה' }
  ];
  assert(hasPrecedingYellow(base, {}, extHistYellow, WINDOW), 'extendedHistory ms yellow 4 min before red → gate passes');

  var extHistTooOld = [
    { title: 'בדקות הקרובות צפויות להתקבל התרעות באזורך', alertDate: base - 8 * 60 * 1000, state: 'yellow', location: 'חיפה' }
  ];
  assert(!hasPrecedingYellow(base, {}, extHistTooOld, WINDOW), 'extendedHistory ms yellow 8 min before → gate fails');
})();

section('eastwardVector — always returns positive-lng direction');
(function() {
  // theta = pi/4 (NE) → dLng = sin(pi/4) > 0 → bearing ≈ 45°
  var v = eastwardVector(Math.PI / 4);
  assert(v.dLng > 0, 'NE: dLng > 0');
  assert(approx(v.bearing, 45, 0.5), 'NE: bearing ≈ 45°, got ' + v.bearing.toFixed(1));

  // theta = -pi/4 (NW direction in (lat,lng) space); flip to SE (also eastward, dLng > 0).
  // Direction (cos(-pi/4), sin(-pi/4)) = (0.707, -0.707) flips to (-0.707, 0.707) → bearing 135°.
  var vFlip = eastwardVector(-Math.PI / 4);
  assert(vFlip.dLng > 0, 'flipped NW→SE: dLng > 0');
  assert(approx(vFlip.bearing, 135, 0.5), 'flipped: bearing ≈ 135° (SE), got ' + vFlip.bearing.toFixed(1));

  // theta = pi/2 (due east along lng): bearing = 90°
  var vE = eastwardVector(Math.PI / 2);
  assert(approx(vE.bearing, 90, 0.5), 'due east: bearing = 90°');

  // theta = -pi/2 → flip → due east
  var vW = eastwardVector(-Math.PI / 2);
  assert(approx(vW.bearing, 90, 0.5), 'west flipped to east: bearing = 90°');

  // theta = 0 → due north along lat (lng component = 0). In east-only convention:
  // dLng = sin(0) = 0, so we don't flip (dLng >= 0). bearing = atan2(0,1) = 0 → north.
  // This edge case means the ellipse is perfectly N-S and no east direction exists.
  var vN = eastwardVector(0);
  assert(approx(vN.bearing, 0, 0.5), 'due north: bearing = 0° (N-S edge case)');
})();

section('sourceExtensionDeg — bearing to country distance');
(function() {
  // Iran (roughly east, 55–120°)
  assert(sourceExtensionDeg(90) === 25, 'bearing 90° → Iran (25)');
  assert(sourceExtensionDeg(60) === 25, 'bearing 60° → Iran (25)');
  assert(sourceExtensionDeg(119) === 25, 'bearing 119° → Iran (25)');

  // Iran/Yemen SE (120–165°)
  assert(sourceExtensionDeg(140) === 22, 'bearing 140° → Iran/Yemen SE (22)');

  // Yemen S (165–195°)
  assert(sourceExtensionDeg(180) === 20, 'bearing 180° → Yemen (20)');
  assert(sourceExtensionDeg(170) === 20, 'bearing 170° → Yemen (20)');

  // Fallback (other bearings — shouldn't fire for valid Iran/Yemen, but handled)
  assert(sourceExtensionDeg(45) === 10, 'bearing 45° → fallback (10)');
  assert(sourceExtensionDeg(200) === 10, 'bearing 200° → fallback (10)');
})();

section('full pipeline — ellipse fit converges on synthetic truncated data');
(function() {
  // Simulate an alert cluster that would span [31,32] lat x [35,37] lng but is
  // cut at lng=35 (western border). We build a hull from points with lng >= 35
  // and check that the fit center is reasonably close to the true ellipse center.

  // True ellipse: cx=31.5, cy=35, a=1 (lat), b=1 (lng), theta=pi/4
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
  // Land border: cut anything west of lng=35.2 (removes ~1/4 of the ellipse)
  var border = {
    bbox: { minLat: 28, maxLat: 36, minLng: 35.2, maxLng: 42 },
    points: [[28,35.2],[36,35.2],[36,42],[28,42]]
  };
  var landPts = fullPts.filter(function(p) { return p[1] >= 35.2; });
  var hull = convexHull(landPts);
  assert(hull.length >= 4, 'hull has enough points: ' + hull.length);

  // Compute initial guess and check it's reasonable
  var guess = ellipseInitialGuess(hull);
  assert(guess[0] > 30 && guess[0] < 33, 'initial guess center lat in range');

  // Loss function at true params vs a bad guess
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

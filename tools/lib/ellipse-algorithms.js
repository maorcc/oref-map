import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import alphaShape from 'alpha-shape';

const EARTH_RADIUS_METERS = 6378137;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const ALG_C_COAST_PATH = path.join(ROOT_DIR, 'web', 'israel_mediterranean_coast_0.5km.csv');

const ALG_A_DEFAULT_OPTIONS = {
  marginMajorMeters: 600,
  marginMinorMeters: 350,
  minSemiMajorMeters: 700,
  minSemiMinorMeters: 350,
  maxAspectRatio: 8,
  maxIterations: 220,
  stepDecay: 0.7,
  initialSteps: {
    centerMeters: 1200,
    axisMeters: 900,
    angleRadians: Math.PI / 20,
  },
  weights: {
    alertedOutside: 12000,
    contrastInside: 18,
    area: 0.0000025,
  },
  contrastRadiusPaddingMeters: 18000,
  ellipseSamples: 180,
};

const ALG_B_SEMI_MAJOR_METERS = 35000;
const ALG_B_SEMI_MINOR_METERS = 17500;
const ALG_B_SEARCH_CONFIG = {
  coarseAngleStepDeg: 1,
  coarseCenterStepMeters: 1000,
  coarseWestPaddingMeters: 30000,
  coarseVerticalPaddingMeters: 12000,
  refineAngleWindowDeg: 1.5,
  refineAngleStepDeg: 0.25,
  refineCenterStepMeters: 250,
  refineCenterWindowMeters: 3000,
  ellipseSamples: 180,
};

const ALG_C_DEFAULT_OPTIONS = {
  clusterEpsMeters: 10000,
  clusterMinSamples: 10,
  alpha: 0.1,
  boundaryThresholdDegrees: 0.03,
  coastMinDistanceMeters: 4000,
  minBoundaryPoints: 6,
  minSemiMajorMeters: 450,
  minSemiMinorMeters: 250,
  majorPaddingMeters: 350,
  minorPaddingMeters: 250,
  minMinorRatio: 0.32,
};

const ALG_D_DEFAULT_OPTIONS = {
  ...ALG_C_DEFAULT_OPTIONS,
  robustFitMaxTrials: 90,
  robustFitSampleRatio: 0.6,
  robustFitInlierThreshold: 0.28,
  robustFitRefinePasses: 3,
};

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function normalizeVector(vector, fallback) {
  const length = Math.sqrt((vector.x * vector.x) + (vector.y * vector.y));
  if (length < 1e-12) return fallback;
  return { x: vector.x / length, y: vector.y / length };
}

function projectEllipsePoint(point) {
  const lat = Math.max(Math.min(point.lat, 85.0511287798), -85.0511287798);
  return {
    x: EARTH_RADIUS_METERS * degToRad(point.lng),
    y: EARTH_RADIUS_METERS * Math.log(Math.tan((Math.PI / 4) + (degToRad(lat) / 2))),
  };
}

function unprojectEllipsePoint(point) {
  return {
    lat: radToDeg((2 * Math.atan(Math.exp(point.y / EARTH_RADIUS_METERS))) - (Math.PI / 2)),
    lng: radToDeg(point.x / EARTH_RADIUS_METERS),
  };
}

function buildProjection(points) {
  let latSum = 0;
  let lngSum = 0;
  for (const point of points) {
    latSum += point.lat;
    lngSum += point.lng;
  }

  const lat0 = latSum / points.length;
  const lng0 = lngSum / points.length;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(toRad(lat0));

  return {
    lat0,
    lng0,
    metersPerDegLat,
    metersPerDegLng,
    project(latlng) {
      return {
        x: (latlng.lng - lng0) * metersPerDegLng,
        y: (latlng.lat - lat0) * metersPerDegLat,
      };
    },
    unproject(projected) {
      return {
        lat: lat0 + projected.y / metersPerDegLat,
        lng: lng0 + projected.x / metersPerDegLng,
      };
    },
  };
}

function buildRange(min, max, step) {
  const values = [];
  if (max < min) return [min];
  for (let value = min; value <= max + 1e-9; value += step) {
    values.push(Number(value.toFixed(6)));
  }
  if (!values.length || values[values.length - 1] < max - 1e-6) {
    values.push(Number(max.toFixed(6)));
  }
  return values;
}

let algCCoastlineCache = null;

function loadAlgCCoastline() {
  if (algCCoastlineCache) return algCCoastlineCache;

  const text = fs.readFileSync(ALG_C_COAST_PATH, 'utf8').trim();
  const lines = text.split(/\r?\n/).slice(1);
  algCCoastlineCache = lines
    .map((line) => line.split(','))
    .map(([lat, lng]) => ({ lat: Number(lat), lng: Number(lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  return algCCoastlineCache;
}

function rotatePoint(point, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x * cos + point.y * sin,
    y: -point.x * sin + point.y * cos,
  };
}

function inverseRotatePoint(point, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function getProjectedBounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  return { minX, maxX, minY, maxY };
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx) + (dy * dy);
}

function cross(o, a, b) {
  return ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
}

function buildConvexHull(points) {
  if (points.length <= 1) return points.slice();

  const sorted = points.slice().sort((a, b) => (
    Math.abs(a.x - b.x) > 1e-9 ? a.x - b.x : a.y - b.y
  ));

  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 1e-12) return Math.sqrt(squaredDistance(point, start));

  const t = clamp((((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared, 0, 1);
  const projected = {
    x: start.x + (t * dx),
    y: start.y + (t * dy),
  };
  return Math.sqrt(squaredDistance(point, projected));
}

function detectMainCluster(projectedPoints, options) {
  if (projectedPoints.length < options.clusterMinSamples) return projectedPoints.slice();

  const epsSquared = options.clusterEpsMeters * options.clusterEpsMeters;
  const neighbors = projectedPoints.map(() => []);

  for (let i = 0; i < projectedPoints.length; i += 1) {
    for (let j = i; j < projectedPoints.length; j += 1) {
      if (squaredDistance(projectedPoints[i], projectedPoints[j]) <= epsSquared) {
        neighbors[i].push(j);
        if (i !== j) neighbors[j].push(i);
      }
    }
  }

  const isCore = neighbors.map((list) => list.length >= options.clusterMinSamples);
  if (!isCore.some(Boolean)) return projectedPoints.slice();

  const visited = new Array(projectedPoints.length).fill(false);
  let bestCluster = [];

  for (let start = 0; start < projectedPoints.length; start += 1) {
    if (!isCore[start] || visited[start]) continue;

    const queue = [start];
    const cluster = new Set();
    visited[start] = true;

    while (queue.length) {
      const current = queue.shift();
      cluster.add(current);

      for (const neighborIndex of neighbors[current]) {
        cluster.add(neighborIndex);
        if (isCore[neighborIndex] && !visited[neighborIndex]) {
          visited[neighborIndex] = true;
          queue.push(neighborIndex);
        }
      }
    }

    if (cluster.size > bestCluster.length) {
      bestCluster = Array.from(cluster);
    }
  }

  if (!bestCluster.length) return projectedPoints.slice();
  return bestCluster.map((index) => projectedPoints[index]);
}

function buildAlphaShapeBoundaryPoints(projectedPoints, options) {
  if (projectedPoints.length <= options.minBoundaryPoints) return projectedPoints.slice();

  const alphaInputPoints = projectedPoints.map((point) => [point.source.lng, point.source.lat]);
  const edges = alphaShape(options.alpha, alphaInputPoints)
    .filter((edge) => Array.isArray(edge) && edge.length === 2);

  if (!edges.length) return buildConvexHull(projectedPoints);

  const boundary = [];
  for (const point of projectedPoints) {
    const rawPoint = { x: point.source.lng, y: point.source.lat };
    let minDistance = Infinity;

    for (const [startIndex, endIndex] of edges) {
      const start = alphaInputPoints[startIndex];
      const end = alphaInputPoints[endIndex];
      if (!start || !end) continue;

      const distance = pointToSegmentDistance(
        rawPoint,
        { x: start[0], y: start[1] },
        { x: end[0], y: end[1] },
      );
      if (distance < minDistance) minDistance = distance;
    }

    if (minDistance < options.boundaryThresholdDegrees) {
      boundary.push(point);
    }
  }

  return boundary.length ? boundary : buildConvexHull(projectedPoints);
}

function filterPointsAwayFromCoast(projectedPoints, projection, options) {
  const coastlineProjected = loadAlgCCoastline().map((point) => projection.project(point));
  const filtered = [];
  const minDistances = [];

  for (const point of projectedPoints) {
    let minDistanceSquared = Infinity;
    for (const coastPoint of coastlineProjected) {
      const distanceSquared = squaredDistance(point, coastPoint);
      if (distanceSquared < minDistanceSquared) minDistanceSquared = distanceSquared;
    }
    const minDistance = Math.sqrt(minDistanceSquared);
    minDistances.push(minDistance);
    if (minDistance > options.coastMinDistanceMeters) filtered.push(point);
  }

  return { filtered, minDistances };
}

function fitProjectedEllipseFromBoundaryApprox(projectedPoints, options) {
  const raw = fitProjectedEllipseCore(projectedPoints);
  return finalizeEllipseCandidate(raw, options);
}

function fitProjectedEllipseCore(projectedPoints) {
  let centerX = 0;
  let centerY = 0;
  for (const point of projectedPoints) {
    centerX += point.x;
    centerY += point.y;
  }
  centerX /= projectedPoints.length;
  centerY /= projectedPoints.length;

  let covXX = 0;
  let covXY = 0;
  let covYY = 0;
  for (const point of projectedPoints) {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    covXX += dx * dx;
    covXY += dx * dy;
    covYY += dy * dy;
  }

  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const point of projectedPoints) {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const offsetU = (minU + maxU) / 2;
  const offsetV = (minV + maxV) / 2;

  return normalizeAxes({
    centerX: centerX + (offsetU * cos) - (offsetV * sin),
    centerY: centerY + (offsetU * sin) + (offsetV * cos),
    semiMajor: Math.max((maxU - minU) / 2, 1),
    semiMinor: Math.max((maxV - minV) / 2, 1),
    angle,
  });
}

function finalizeEllipseCandidate(candidate, options) {
  const normalized = normalizeAxes(candidate);
  let semiMajor = Math.max(normalized.semiMajor, options.minSemiMajorMeters);
  let semiMinor = Math.max(normalized.semiMinor, options.minSemiMinorMeters);
  semiMajor += options.majorPaddingMeters;
  semiMinor = Math.max(semiMinor + options.minorPaddingMeters, semiMajor * options.minMinorRatio);

  return normalizeAxes({
    centerX: normalized.centerX,
    centerY: normalized.centerY,
    semiMajor,
    semiMinor,
    angle: normalized.angle,
  });
}

async function fitOpenCvEllipseFromBoundary(projectedPoints, options) {
  if (projectedPoints.length < 5 || projectedPoints.some((point) => !point.source)) {
    const approx = fitProjectedEllipseFromBoundaryApprox(projectedPoints, options);
    return {
      coordinateSpace: 'projected',
      centerX: approx.centerX,
      centerY: approx.centerY,
      semiMajor: approx.semiMajor,
      semiMinor: approx.semiMinor,
      angle: approx.angle,
    };
  }

  const rawPoints = projectedPoints.map((point) => [point.source.lng, point.source.lat]);
  const script = `
import fs from 'node:fs';
import cvModule from '@techstark/opencv-js';

const points = JSON.parse(fs.readFileSync(0, 'utf8') || '[]');
let cv;
if (cvModule && typeof cvModule.fitEllipse === 'function' && typeof cvModule.Mat === 'function') {
  cv = cvModule;
} else if (cvModule instanceof Promise) {
  cv = await cvModule;
} else {
  await new Promise((resolve) => { cvModule.onRuntimeInitialized = () => resolve(); });
  cv = cvModule;
}

const data = new Float32Array(points.length * 2);
for (let i = 0; i < points.length; i += 1) {
  data[i * 2] = points[i][0];
  data[(i * 2) + 1] = points[i][1];
}

const mat = cv.matFromArray(points.length, 1, cv.CV_32FC2, data);
const ellipse = cv.fitEllipse(mat);
mat.delete();
console.log(JSON.stringify(ellipse));
process.exit(0);
`;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT_DIR,
    input: JSON.stringify(rawPoints),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const ellipse = JSON.parse(stdout.trim());

  return {
    coordinateSpace: 'raw-degrees',
    centerLng: ellipse.center.x,
    centerLat: ellipse.center.y,
    widthDegrees: ellipse.size.width,
    heightDegrees: ellipse.size.height,
    angleDegrees: ellipse.angle,
    angle: degToRad(ellipse.angle),
  };
}

function createDeterministicRandom(seed) {
  let state = (seed >>> 0) || 1;
  return function nextRandom() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pickRandomSubset(points, count, nextRandom) {
  const chosen = new Set();
  while (chosen.size < count) {
    chosen.add(Math.floor(nextRandom() * points.length));
  }
  return Array.from(chosen, (index) => points[index]);
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return Number.POSITIVE_INFINITY;
  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.round((sortedValues.length - 1) * ratio)));
  return sortedValues[index];
}

function evaluateBoundaryCandidate(candidate, projectedPoints, options) {
  const residuals = [];
  const inliers = [];
  const bins = new Set();
  const threshold = options.robustFitInlierThreshold;

  for (const point of projectedPoints) {
    const local = projectToEllipse(candidate, point);
    const radius = Math.sqrt(ellipseValue(candidate, point));
    const residual = Math.abs(radius - 1);
    residuals.push(residual);

    if (residual <= threshold) {
      inliers.push(point);
      let theta = Math.atan2(local.v / candidate.semiMinor, local.u / candidate.semiMajor);
      if (theta < 0) theta += Math.PI * 2;
      bins.add(Math.floor((theta / (Math.PI * 2)) * 12));
    }
  }

  residuals.sort((a, b) => a - b);
  return {
    candidate,
    inliers,
    inlierCount: inliers.length,
    coverage: bins.size,
    medianResidual: percentile(residuals, 0.5),
    p85Residual: percentile(residuals, 0.85),
  };
}

function isBoundaryScoreBetter(candidateScore, bestScore) {
  if (!bestScore) return true;
  if (candidateScore.inlierCount !== bestScore.inlierCount) {
    return candidateScore.inlierCount > bestScore.inlierCount;
  }
  if (candidateScore.coverage !== bestScore.coverage) {
    return candidateScore.coverage > bestScore.coverage;
  }
  if (Math.abs(candidateScore.p85Residual - bestScore.p85Residual) > 1e-9) {
    return candidateScore.p85Residual < bestScore.p85Residual;
  }
  return candidateScore.medianResidual < bestScore.medianResidual;
}

function fitRobustProjectedEllipseFromBoundary(projectedPoints, options) {
  if (projectedPoints.length < 5) {
    return finalizeEllipseCandidate(fitProjectedEllipseCore(projectedPoints), options);
  }

  const trials = Math.max(12, options.robustFitMaxTrials | 0);
  const sampleCount = Math.max(
    5,
    Math.min(projectedPoints.length, Math.round(projectedPoints.length * options.robustFitSampleRatio))
  );
  const nextRandom = createDeterministicRandom(projectedPoints.length * 2654435761);

  let bestScore = evaluateBoundaryCandidate(
    fitProjectedEllipseCore(projectedPoints),
    projectedPoints,
    options,
  );

  for (let trial = 0; trial < trials; trial += 1) {
    const sample = pickRandomSubset(projectedPoints, sampleCount, nextRandom);
    let candidate = fitProjectedEllipseCore(sample);
    let score = evaluateBoundaryCandidate(candidate, projectedPoints, options);

    for (let pass = 0; pass < options.robustFitRefinePasses; pass += 1) {
      if (score.inliers.length < 5) break;
      candidate = fitProjectedEllipseCore(score.inliers);
      const refined = evaluateBoundaryCandidate(candidate, projectedPoints, options);
      if (!isBoundaryScoreBetter(refined, score)) break;
      score = refined;
    }

    if (isBoundaryScoreBetter(score, bestScore)) {
      bestScore = score;
    }
  }

  return finalizeEllipseCandidate(bestScore.candidate, options);
}

async function fitRobustEllipseFromBoundary(projectedPoints, options) {
  if (projectedPoints.length < 5 || projectedPoints.some((point) => !point.source)) {
    const approx = fitProjectedEllipseFromBoundaryApprox(projectedPoints, options);
    return {
      coordinateSpace: 'projected',
      centerX: approx.centerX,
      centerY: approx.centerY,
      semiMajor: approx.semiMajor,
      semiMinor: approx.semiMinor,
      angle: approx.angle,
      fitSource: 'approx',
    };
  }

  const robust = fitRobustProjectedEllipseFromBoundary(projectedPoints, options);
  return {
    coordinateSpace: 'projected',
    centerX: robust.centerX,
    centerY: robust.centerY,
    semiMajor: robust.semiMajor,
    semiMinor: robust.semiMinor,
    angle: robust.angle,
    fitSource: 'robust-js',
  };
}

function buildEllipseCandidateLatLngs(candidate, projection, sampleCount = 180) {
  const points = [];
  const cos = Math.cos(candidate.angle);
  const sin = Math.sin(candidate.angle);

  for (let index = 0; index < sampleCount; index += 1) {
    const theta = (Math.PI * 2 * index) / sampleCount;
    const u = Math.cos(theta) * candidate.semiMajor;
    const v = Math.sin(theta) * candidate.semiMinor;
    const x = candidate.centerX + u * cos - v * sin;
    const y = candidate.centerY + u * sin + v * cos;
    points.push(projection.unproject({ x, y }));
  }

  return points;
}

function buildMercatorEllipseLatLngs(candidate, sampleCount = 180) {
  const points = [];
  const cos = Math.cos(candidate.angle);
  const sin = Math.sin(candidate.angle);

  for (let index = 0; index < sampleCount; index += 1) {
    const theta = (Math.PI * 2 * index) / sampleCount;
    const u = Math.cos(theta) * candidate.semiMajor;
    const v = Math.sin(theta) * candidate.semiMinor;
    const x = candidate.centerX + u * cos - v * sin;
    const y = candidate.centerY + u * sin + v * cos;
    points.push(unprojectEllipsePoint({ x, y }));
  }

  return points;
}

function buildEllipseGeometry(points) {
  if (!points.length) return null;

  const projectedPoints = points.map(projectEllipsePoint);
  if (projectedPoints.length === 1) {
    return {
      type: 'circle',
      center: points[0],
      radiusMeters: 700,
    };
  }

  let centerX = 0;
  let centerY = 0;
  for (const point of projectedPoints) {
    centerX += point.x;
    centerY += point.y;
  }
  centerX /= projectedPoints.length;
  centerY /= projectedPoints.length;

  let majorAxis;
  if (projectedPoints.length === 2) {
    majorAxis = normalizeVector({
      x: projectedPoints[1].x - projectedPoints[0].x,
      y: projectedPoints[1].y - projectedPoints[0].y,
    }, { x: 1, y: 0 });
  } else {
    let covXX = 0;
    let covXY = 0;
    let covYY = 0;
    for (const point of projectedPoints) {
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      covXX += dx * dx;
      covXY += dx * dy;
      covYY += dy * dy;
    }
    const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
    majorAxis = { x: Math.cos(angle), y: Math.sin(angle) };
  }

  majorAxis = normalizeVector(majorAxis, { x: 1, y: 0 });
  const minorAxis = { x: -majorAxis.y, y: majorAxis.x };

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (const point of projectedPoints) {
    const offsetX = point.x - centerX;
    const offsetY = point.y - centerY;
    const u = (offsetX * majorAxis.x) + (offsetY * majorAxis.y);
    const v = (offsetX * minorAxis.x) + (offsetY * minorAxis.y);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  let semiMajor = Math.max((maxU - minU) / 2, 450);
  let semiMinor = Math.max((maxV - minV) / 2, 250);
  semiMajor += 350;
  semiMinor = Math.max(semiMinor + 250, semiMajor * 0.32);

  const offsetU = (minU + maxU) / 2;
  const offsetV = (minV + maxV) / 2;
  const ellipseCenter = {
    x: centerX + (majorAxis.x * offsetU) + (minorAxis.x * offsetV),
    y: centerY + (majorAxis.y * offsetU) + (minorAxis.y * offsetV),
  };

  return {
    type: 'ellipse',
    center: unprojectEllipsePoint(ellipseCenter),
    centerProjected: ellipseCenter,
    majorAxis,
    minorAxis,
    semiMajor,
    semiMinor,
    angle: Math.atan2(majorAxis.y, majorAxis.x),
  };
}

function normalizeAngle(angle) {
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  return angle;
}

function normalizeAxes(candidate) {
  let semiMajor = candidate.semiMajor;
  let semiMinor = candidate.semiMinor;
  let angle = candidate.angle;

  if (semiMajor < semiMinor) {
    const swap = semiMajor;
    semiMajor = semiMinor;
    semiMinor = swap;
    angle += Math.PI / 2;
  }

  if (semiMinor <= 1) semiMinor = 1;
  if (semiMajor <= semiMinor) semiMajor = semiMinor + 1;

  return {
    centerX: candidate.centerX,
    centerY: candidate.centerY,
    semiMajor,
    semiMinor,
    angle: normalizeAngle(angle),
  };
}

function projectToEllipse(candidate, point) {
  const dx = point.x - candidate.centerX;
  const dy = point.y - candidate.centerY;
  const cos = Math.cos(candidate.angle);
  const sin = Math.sin(candidate.angle);

  return {
    u: dx * cos + dy * sin,
    v: -dx * sin + dy * cos,
  };
}

function ellipseValue(candidate, point) {
  const local = projectToEllipse(candidate, point);
  return (
    (local.u * local.u) / (candidate.semiMajor * candidate.semiMajor) +
    (local.v * local.v) / (candidate.semiMinor * candidate.semiMinor)
  );
}

function buildAlgAInitialCandidate(projectedAlertedPoints, options) {
  let centerX = 0;
  let centerY = 0;
  for (const point of projectedAlertedPoints) {
    centerX += point.x;
    centerY += point.y;
  }
  centerX /= projectedAlertedPoints.length;
  centerY /= projectedAlertedPoints.length;

  let angle = 0;
  if (projectedAlertedPoints.length === 2) {
    angle = Math.atan2(
      projectedAlertedPoints[1].y - projectedAlertedPoints[0].y,
      projectedAlertedPoints[1].x - projectedAlertedPoints[0].x
    );
  } else if (projectedAlertedPoints.length > 2) {
    let covXX = 0;
    let covXY = 0;
    let covYY = 0;
    for (const point of projectedAlertedPoints) {
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      covXX += dx * dx;
      covXY += dx * dy;
      covYY += dy * dy;
    }
    angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (const point of projectedAlertedPoints) {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const offsetU = (minU + maxU) / 2;
  const offsetV = (minV + maxV) / 2;
  const adjustedCenterX = centerX + offsetU * cos - offsetV * sin;
  const adjustedCenterY = centerY + offsetU * sin + offsetV * cos;

  return normalizeAxes({
    centerX: adjustedCenterX,
    centerY: adjustedCenterY,
    semiMajor: Math.max((maxU - minU) / 2 + options.marginMajorMeters, options.minSemiMajorMeters),
    semiMinor: Math.max((maxV - minV) / 2 + options.marginMinorMeters, options.minSemiMinorMeters),
    angle,
  });
}

function buildAlgAContrastPoints(allEntries, alertedNamesSet, projection, initialCandidate, options) {
  const radiusLimit = Math.max(initialCandidate.semiMajor, initialCandidate.semiMinor) + options.contrastRadiusPaddingMeters;
  const radiusLimitSquared = radiusLimit * radiusLimit;
  const contrast = [];

  for (const entry of allEntries) {
    if (alertedNamesSet.has(entry.name)) continue;
    const projected = projection.project(entry);
    const dx = projected.x - initialCandidate.centerX;
    const dy = projected.y - initialCandidate.centerY;
    if ((dx * dx) + (dy * dy) <= radiusLimitSquared) {
      contrast.push(projected);
    }
  }

  return contrast;
}

function scoreAlgACandidate(candidate, alertedProjectedPoints, contrastProjectedPoints, options) {
  const normalized = normalizeAxes(candidate);
  if (normalized.semiMajor / normalized.semiMinor > options.maxAspectRatio) {
    return Number.POSITIVE_INFINITY;
  }

  let alertedOutsidePenalty = 0;
  let alertedOutsideCount = 0;
  for (const point of alertedProjectedPoints) {
    const value = ellipseValue(normalized, point);
    if (value > 1) {
      const delta = value - 1;
      alertedOutsidePenalty += delta * delta;
      alertedOutsideCount += 1;
    }
  }

  let contrastInsidePenalty = 0;
  let contrastInsideCount = 0;
  for (const point of contrastProjectedPoints) {
    const value = ellipseValue(normalized, point);
    if (value < 1) {
      const delta = 1 - value;
      contrastInsidePenalty += delta * delta;
      contrastInsideCount += 1;
    }
  }

  const area = Math.PI * normalized.semiMajor * normalized.semiMinor;
  const score =
    options.weights.alertedOutside * alertedOutsidePenalty +
    options.weights.contrastInside * contrastInsidePenalty +
    options.weights.area * area;

  return {
    score,
    candidate: normalized,
    metrics: {
      alertedOutsidePenalty,
      alertedOutsideCount,
      contrastInsidePenalty,
      contrastInsideCount,
      area,
    },
  };
}

function optimizeAlgACandidate(initialCandidate, alertedProjectedPoints, contrastProjectedPoints, options) {
  let best = scoreAlgACandidate(initialCandidate, alertedProjectedPoints, contrastProjectedPoints, options);
  let stepCenter = options.initialSteps.centerMeters;
  let stepAxis = options.initialSteps.axisMeters;
  let stepAngle = options.initialSteps.angleRadians;

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    let improved = false;
    const seeds = [
      { centerX: best.candidate.centerX + stepCenter, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle },
      { centerX: best.candidate.centerX - stepCenter, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY + stepCenter, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY - stepCenter, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor + stepAxis, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY, semiMajor: Math.max(best.candidate.semiMajor - stepAxis, best.candidate.semiMinor + 1), semiMinor: best.candidate.semiMinor, angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor + stepAxis, angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor, semiMinor: Math.max(best.candidate.semiMinor - stepAxis, 1), angle: best.candidate.angle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle + stepAngle },
      { centerX: best.candidate.centerX, centerY: best.candidate.centerY, semiMajor: best.candidate.semiMajor, semiMinor: best.candidate.semiMinor, angle: best.candidate.angle - stepAngle },
    ];

    for (const seed of seeds) {
      const candidateScore = scoreAlgACandidate(seed, alertedProjectedPoints, contrastProjectedPoints, options);
      if (candidateScore.score + 1e-9 < best.score) {
        best = candidateScore;
        improved = true;
      }
    }

    if (!improved) {
      stepCenter *= options.stepDecay;
      stepAxis *= options.stepDecay;
      stepAngle *= options.stepDecay;
      if (stepCenter < 20 && stepAxis < 20 && stepAngle < 0.0025) break;
    }
  }

  return best;
}

function fitEllipse(alertedPoints, allEntries, options = ALG_A_DEFAULT_OPTIONS) {
  const projection = buildProjection(alertedPoints);
  const alertedProjectedPoints = alertedPoints.map((point) => projection.project(point));
  const initialCandidate = buildAlgAInitialCandidate(alertedProjectedPoints, options);
  const alertedNamesSet = new Set(alertedPoints.map((point) => point.name));
  const contrastProjectedPoints = buildAlgAContrastPoints(allEntries, alertedNamesSet, projection, initialCandidate, options);
  const optimized = optimizeAlgACandidate(initialCandidate, alertedProjectedPoints, contrastProjectedPoints, options);

  return {
    projection,
    alertedProjectedPoints,
    contrastProjectedPoints,
    initialCandidate,
    optimized,
  };
}

function evaluateAlgBCandidate(centerRotated, thetaRad, rotatedPoints) {
  let insideCount = 0;
  let outsideError = 0;
  let farthestOutside = 0;

  for (const point of rotatedPoints) {
    const dx = point.x - centerRotated.x;
    const dy = point.y - centerRotated.y;
    const value =
      (dx * dx) / (ALG_B_SEMI_MAJOR_METERS * ALG_B_SEMI_MAJOR_METERS) +
      (dy * dy) / (ALG_B_SEMI_MINOR_METERS * ALG_B_SEMI_MINOR_METERS);

    if (value <= 1) {
      insideCount += 1;
    } else {
      const error = value - 1;
      outsideError += error;
      if (error > farthestOutside) farthestOutside = error;
    }
  }

  const centerProjected = inverseRotatePoint(centerRotated, thetaRad);
  return {
    thetaRad,
    centerProjected,
    insideCount,
    outsideError,
    farthestOutside,
  };
}

function isBetterAlgBCandidate(a, b) {
  if (!b) return true;
  if (a.insideCount !== b.insideCount) return a.insideCount > b.insideCount;
  if (Math.abs(a.centerProjected.x - b.centerProjected.x) > 1e-6) {
    return a.centerProjected.x < b.centerProjected.x;
  }
  if (Math.abs(a.outsideError - b.outsideError) > 1e-9) {
    return a.outsideError < b.outsideError;
  }
  if (Math.abs(a.farthestOutside - b.farthestOutside) > 1e-9) {
    return a.farthestOutside < b.farthestOutside;
  }
  return a.thetaRad < b.thetaRad;
}

function searchAlgBCandidates(projectedPoints, angleValuesDeg, centerConfig) {
  let best = null;

  for (const angleDeg of angleValuesDeg) {
    const thetaRad = toRad(angleDeg);
    const rotatedPoints = projectedPoints.map((point) => rotatePoint(point, thetaRad));
    const bounds = getProjectedBounds(rotatedPoints);
    const xValues = buildRange(
      bounds.minX - centerConfig.westPaddingMeters,
      bounds.maxX,
      centerConfig.stepMeters
    );
    const yValues = buildRange(
      bounds.minY - centerConfig.verticalPaddingMeters,
      bounds.maxY + centerConfig.verticalPaddingMeters,
      centerConfig.stepMeters
    );

    for (const centerX of xValues) {
      for (const centerY of yValues) {
        const candidate = evaluateAlgBCandidate({ x: centerX, y: centerY }, thetaRad, rotatedPoints);
        if (isBetterAlgBCandidate(candidate, best)) best = candidate;
      }
    }
  }

  return best;
}

function refineAlgBCandidate(projectedPoints, best) {
  const minAngleDeg = Math.max(0, toDeg(best.thetaRad) - ALG_B_SEARCH_CONFIG.refineAngleWindowDeg);
  const maxAngleDeg = Math.min(20, toDeg(best.thetaRad) + ALG_B_SEARCH_CONFIG.refineAngleWindowDeg);
  const angleValues = buildRange(minAngleDeg, maxAngleDeg, ALG_B_SEARCH_CONFIG.refineAngleStepDeg);

  let refinedBest = best;
  for (const angleDeg of angleValues) {
    const thetaRad = toRad(angleDeg);
    const rotatedPoints = projectedPoints.map((point) => rotatePoint(point, thetaRad));
    const targetCenter = rotatePoint(best.centerProjected, thetaRad);
    const xValues = buildRange(
      targetCenter.x - ALG_B_SEARCH_CONFIG.refineCenterWindowMeters,
      targetCenter.x + ALG_B_SEARCH_CONFIG.refineCenterWindowMeters,
      ALG_B_SEARCH_CONFIG.refineCenterStepMeters
    );
    const yValues = buildRange(
      targetCenter.y - ALG_B_SEARCH_CONFIG.refineCenterWindowMeters,
      targetCenter.y + ALG_B_SEARCH_CONFIG.refineCenterWindowMeters,
      ALG_B_SEARCH_CONFIG.refineCenterStepMeters
    );

    for (const centerX of xValues) {
      for (const centerY of yValues) {
        const candidate = evaluateAlgBCandidate({ x: centerX, y: centerY }, thetaRad, rotatedPoints);
        if (isBetterAlgBCandidate(candidate, refinedBest)) refinedBest = candidate;
      }
    }
  }

  return refinedBest;
}

function fitFixedLeftmostEllipse(alertedPoints) {
  const projection = buildProjection(alertedPoints);
  const projectedPoints = alertedPoints.map((point) => projection.project(point));
  const coarseAngles = buildRange(0, 20, ALG_B_SEARCH_CONFIG.coarseAngleStepDeg);

  const coarseBest = searchAlgBCandidates(projectedPoints, coarseAngles, {
    westPaddingMeters: ALG_B_SEARCH_CONFIG.coarseWestPaddingMeters,
    verticalPaddingMeters: ALG_B_SEARCH_CONFIG.coarseVerticalPaddingMeters,
    stepMeters: ALG_B_SEARCH_CONFIG.coarseCenterStepMeters,
  });

  const best = refineAlgBCandidate(projectedPoints, coarseBest);
  return {
    projection,
    projectedPoints,
    best,
  };
}

async function fitAlgC(alertedPoints, options = ALG_C_DEFAULT_OPTIONS) {
  const projection = buildProjection(alertedPoints);
  const projectedPoints = alertedPoints.map((point) => ({
    ...projection.project(point),
    source: point,
  }));

  const clusteredPoints = detectMainCluster(projectedPoints, options);
  if (clusteredPoints.length < options.minBoundaryPoints) {
    return {
      projection,
      clusteredPoints,
      boundaryPoints: clusteredPoints,
      filteredBoundaryPoints: clusteredPoints,
      candidate: await fitOpenCvEllipseFromBoundary(clusteredPoints, options),
      metrics: {
        clusteredCount: clusteredPoints.length,
        boundaryCount: clusteredPoints.length,
        filteredBoundaryCount: clusteredPoints.length,
        coastRejectedCount: 0,
        minCoastDistanceMeters: null,
      },
    };
  }

  const boundaryPoints = buildAlphaShapeBoundaryPoints(clusteredPoints, options);
  const coastFilter = filterPointsAwayFromCoast(boundaryPoints, projection, options);
  const filteredBoundaryPoints = coastFilter.filtered.length >= options.minBoundaryPoints
    ? coastFilter.filtered
    : boundaryPoints;
  const candidate = await fitOpenCvEllipseFromBoundary(filteredBoundaryPoints, options);
  const usableDistances = coastFilter.minDistances.filter(Number.isFinite);

  return {
    projection,
    clusteredPoints,
    boundaryPoints,
    filteredBoundaryPoints,
    candidate,
    metrics: {
      clusteredCount: clusteredPoints.length,
      boundaryCount: boundaryPoints.length,
      filteredBoundaryCount: filteredBoundaryPoints.length,
      coastRejectedCount: Math.max(boundaryPoints.length - filteredBoundaryPoints.length, 0),
      minCoastDistanceMeters: usableDistances.length ? Math.min(...usableDistances) : null,
    },
  };
}

async function fitAlgD(alertedPoints, options = ALG_D_DEFAULT_OPTIONS) {
  const projection = buildProjection(alertedPoints);
  const projectedPoints = alertedPoints.map((point) => ({
    ...projection.project(point),
    source: point,
  }));

  const clusteredPoints = detectMainCluster(projectedPoints, options);
  if (clusteredPoints.length < options.minBoundaryPoints) {
    return {
      projection,
      clusteredPoints,
      boundaryPoints: clusteredPoints,
      filteredBoundaryPoints: clusteredPoints,
      candidate: await fitRobustEllipseFromBoundary(clusteredPoints, options),
      metrics: {
        clusteredCount: clusteredPoints.length,
        boundaryCount: clusteredPoints.length,
        filteredBoundaryCount: clusteredPoints.length,
        coastRejectedCount: 0,
        minCoastDistanceMeters: null,
      },
    };
  }

  const boundaryPoints = buildAlphaShapeBoundaryPoints(clusteredPoints, options);
  const coastFilter = filterPointsAwayFromCoast(boundaryPoints, projection, options);
  const filteredBoundaryPoints = coastFilter.filtered.length >= options.minBoundaryPoints
    ? coastFilter.filtered
    : boundaryPoints;
  const candidate = await fitRobustEllipseFromBoundary(filteredBoundaryPoints, options);
  const usableDistances = coastFilter.minDistances.filter(Number.isFinite);

  return {
    projection,
    clusteredPoints,
    boundaryPoints,
    filteredBoundaryPoints,
    candidate,
    metrics: {
      clusteredCount: clusteredPoints.length,
      boundaryCount: boundaryPoints.length,
      filteredBoundaryCount: filteredBoundaryPoints.length,
      coastRejectedCount: Math.max(boundaryPoints.length - filteredBoundaryPoints.length, 0),
      minCoastDistanceMeters: usableDistances.length ? Math.min(...usableDistances) : null,
    },
  };
}

export {
  ALG_A_DEFAULT_OPTIONS,
  ALG_C_DEFAULT_OPTIONS,
  ALG_D_DEFAULT_OPTIONS,
  ALG_B_SEARCH_CONFIG,
  ALG_B_SEMI_MAJOR_METERS,
  ALG_B_SEMI_MINOR_METERS,
  buildEllipseCandidateLatLngs,
  buildEllipseGeometry,
  buildMercatorEllipseLatLngs,
  buildProjection,
  fitAlgC,
  fitAlgD,
  fitEllipse,
  fitFixedLeftmostEllipse,
  normalizeAxes,
  radToDeg,
  toDeg,
};

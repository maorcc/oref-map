#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ALG_A_DEFAULT_OPTIONS,
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
  radToDeg,
} from './lib/ellipse-algorithms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OREF_POINTS_PATH = path.join(ROOT_DIR, 'web', 'oref_points.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]
  ));
}

function parseJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function ensureNameArray(value) {
  if (!Array.isArray(value)) fail('Input must be a JSON array of location names.');
  if (!value.length) fail('Input array is empty.');
  return value.map((entry) => String(entry));
}

function resolvePoints(names, allPoints) {
  const missing = [];
  const points = [];

  for (const name of names) {
    const coords = allPoints[name];
    if (!coords || !Array.isArray(coords) || coords.length < 2) {
      missing.push(name);
      continue;
    }
    points.push({ name, lat: coords[0], lng: coords[1] });
  }

  if (missing.length) {
    fail('Missing locations in web/oref_points.json: ' + missing.join(', '));
  }

  return points;
}

function getBounds(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lng < minLng) minLng = point.lng;
    if (point.lng > maxLng) maxLng = point.lng;
  }

  return {
    southWest: [minLat, minLng],
    northEast: [maxLat, maxLng],
  };
}

function buildAllEntries(pointsMap) {
  return Object.entries(pointsMap)
    .filter(([, coords]) => Array.isArray(coords) && coords.length >= 2)
    .map(([name, coords]) => ({ name, lat: coords[0], lng: coords[1] }));
}

function buildRenderableGeometry(result, projection, style) {
  if (result.type === 'circle') {
    return {
      type: 'circle',
      center: result.center,
      radiusMeters: result.radiusMeters,
      style,
      label: style.label,
      metrics: result.metrics || null,
    };
  }

  if (result.coordinateSpace === 'raw-degrees') {
    const latlngs = buildRawDegreeEllipseLatLngs(result.rawCandidate, ALG_B_SEARCH_CONFIG.ellipseSamples);
    const axisMetrics = measureRawDegreeEllipseAxesMeters(result.rawCandidate);
    return {
      type: 'ellipse',
      center: {
        lat: result.rawCandidate.centerLat,
        lng: result.rawCandidate.centerLng,
      },
      semiMajorMeters: axisMetrics.semiMajorMeters,
      semiMinorMeters: axisMetrics.semiMinorMeters,
      majorAxisLengthMeters: axisMetrics.semiMajorMeters * 2,
      minorAxisLengthMeters: axisMetrics.semiMinorMeters * 2,
      angleDeg: axisMetrics.angleDeg,
      latlngs,
      style,
      label: style.label,
      metrics: result.metrics || null,
    };
  }

  let candidate;
  if (result.centerProjected) {
    candidate = {
      centerX: result.centerProjected.x,
      centerY: result.centerProjected.y,
      semiMajor: result.semiMajor,
      semiMinor: result.semiMinor,
      angle: result.angle,
    };
  } else {
    candidate = {
      centerX: result.projectionCenterX,
      centerY: result.projectionCenterY,
      semiMajor: result.semiMajor,
      semiMinor: result.semiMinor,
      angle: result.angle,
    };
  }

  return {
    type: 'ellipse',
    center: result.center,
    semiMajorMeters: result.semiMajor,
    semiMinorMeters: result.semiMinor,
    majorAxisLengthMeters: result.semiMajor * 2,
    minorAxisLengthMeters: result.semiMinor * 2,
    angleDeg: (radToDeg(result.angle) + 360) % 360,
    latlngs: result.projectionType === 'mercator'
      ? buildMercatorEllipseLatLngs(candidate, ALG_B_SEARCH_CONFIG.ellipseSamples)
      : buildEllipseCandidateLatLngs(candidate, projection, ALG_B_SEARCH_CONFIG.ellipseSamples),
    style,
    label: style.label,
    metrics: result.metrics || null,
  };
}

function buildAlgCRenderableInput(fitResult) {
  if (fitResult.candidate.coordinateSpace === 'raw-degrees') {
    return {
      type: 'ellipse',
      coordinateSpace: fitResult.candidate.coordinateSpace,
      rawCandidate: fitResult.candidate,
      metrics: fitResult.metrics,
    };
  }

  return {
    type: 'ellipse',
    center: fitResult.projection.unproject({
      x: fitResult.candidate.centerX,
      y: fitResult.candidate.centerY,
    }),
    semiMajor: fitResult.candidate.semiMajor,
    semiMinor: fitResult.candidate.semiMinor,
    angle: fitResult.candidate.angle,
    projectionCenterX: fitResult.candidate.centerX,
    projectionCenterY: fitResult.candidate.centerY,
    metrics: fitResult.metrics,
  };
}

function toLatLngStagePoints(points) {
  return points.map((point) => {
    if (point && point.source && Number.isFinite(point.source.lat) && Number.isFinite(point.source.lng)) {
      return {
        lat: point.source.lat,
        lng: point.source.lng,
        name: point.source.name || null,
      };
    }
    return {
      lat: point.lat,
      lng: point.lng,
      name: point.name || null,
    };
  });
}

function withAlpha(color, alpha) {
  const normalized = String(color || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return color;
  const clamped = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return normalized + clamped.toString(16).padStart(2, '0');
}

function buildAlgorithmDebugStages(geometryLabel, color, fitResult) {
  if (!fitResult) return null;

  const fitInputPoints = fitResult.filteredBoundaryPoints.length >= 6
    ? fitResult.filteredBoundaryPoints
    : fitResult.boundaryPoints;

  return [
    {
      id: `${geometryLabel}-clustered`,
      label: 'clustered',
      points: toLatLngStagePoints(fitResult.clusteredPoints),
      style: {
        color,
        fillColor: withAlpha(color, 0.18),
        radius: 2.5,
      },
    },
    {
      id: `${geometryLabel}-boundary`,
      label: 'boundary',
      points: toLatLngStagePoints(fitResult.boundaryPoints),
      style: {
        color,
        fillColor: withAlpha(color, 0.28),
        radius: 3.25,
      },
    },
    {
      id: `${geometryLabel}-filtered`,
      label: 'filtered',
      points: toLatLngStagePoints(fitResult.filteredBoundaryPoints),
      style: {
        color,
        fillColor: withAlpha(color, 0.42),
        radius: 4,
      },
    },
    {
      id: `${geometryLabel}-fit-input`,
      label: 'fit input',
      points: toLatLngStagePoints(fitInputPoints),
      style: {
        color,
        fillColor: withAlpha(color, 0.58),
        radius: 4.75,
      },
    },
  ];
}

function buildRawDegreeEllipseLatLngs(candidate, sampleCount = 180) {
  const points = [];
  const angleRad = candidate.angleDegrees * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const semiX = candidate.widthDegrees / 2;
  const semiY = candidate.heightDegrees / 2;

  for (let index = 0; index < sampleCount; index += 1) {
    const theta = (Math.PI * 2 * index) / sampleCount;
    const u = Math.cos(theta) * semiX;
    const v = Math.sin(theta) * semiY;
    const lng = candidate.centerLng + u * cos - v * sin;
    const lat = candidate.centerLat + u * sin + v * cos;
    points.push({ lat, lng });
  }

  return points;
}

function measureRawDegreeEllipseAxesMeters(candidate) {
  const center = { lat: candidate.centerLat, lng: candidate.centerLng };
  const projection = buildProjection([center]);
  const angleRad = candidate.angleDegrees * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const semiX = candidate.widthDegrees / 2;
  const semiY = candidate.heightDegrees / 2;
  const majorEnd = projection.project({
    lng: candidate.centerLng + semiX * cos,
    lat: candidate.centerLat + semiX * sin,
  });
  const minorEnd = projection.project({
    lng: candidate.centerLng - semiY * sin,
    lat: candidate.centerLat + semiY * cos,
  });
  const centerProjected = projection.project(center);

  const widthSemiMeters = Math.hypot(majorEnd.x - centerProjected.x, majorEnd.y - centerProjected.y);
  const heightSemiMeters = Math.hypot(minorEnd.x - centerProjected.x, minorEnd.y - centerProjected.y);

  if (widthSemiMeters >= heightSemiMeters) {
    return {
      semiMajorMeters: widthSemiMeters,
      semiMinorMeters: heightSemiMeters,
      angleDeg: (candidate.angleDegrees + 360) % 360,
    };
  }

  return {
    semiMajorMeters: heightSemiMeters,
    semiMinorMeters: widthSemiMeters,
    angleDeg: (candidate.angleDegrees + 90 + 360) % 360,
  };
}

function collectMapBounds(alertedPoints, geometries) {
  const points = alertedPoints.map((point) => ({ lat: point.lat, lng: point.lng }));

  for (const geometry of geometries) {
    if (geometry.type === 'circle') {
      const projection = buildProjection([geometry.center]);
      const centerProjected = projection.project(geometry.center);
      const offsets = [
        { x: centerProjected.x - geometry.radiusMeters, y: centerProjected.y },
        { x: centerProjected.x + geometry.radiusMeters, y: centerProjected.y },
        { x: centerProjected.x, y: centerProjected.y - geometry.radiusMeters },
        { x: centerProjected.x, y: centerProjected.y + geometry.radiusMeters },
      ];
      for (const offset of offsets) points.push(projection.unproject(offset));
      continue;
    }
    points.push(...geometry.latlngs);
  }

  return getBounds(points);
}

function buildSummary(geometry) {
  if (geometry.type === 'circle') {
    return `${geometry.label}: circle, r=${Math.round(geometry.radiusMeters)}m`;
  }
  return `${geometry.label}: ${geometry.angleDeg.toFixed(1)}°, ${Math.round(geometry.majorAxisLengthMeters / 1000)}km x ${Math.round(geometry.minorAxisLengthMeters / 1000)}km`;
}

function buildMetricLines(geometry) {
  if (geometry.type === 'circle') return [`radius=${Math.round(geometry.radiusMeters)}m`];

  const lines = [
    `major=${Math.round(geometry.majorAxisLengthMeters)}m`,
    `minor=${Math.round(geometry.minorAxisLengthMeters)}m`,
    `angle=${geometry.angleDeg.toFixed(1)} deg`,
  ];

  if (geometry.label === 'Alg-A' && geometry.metrics) {
    lines.push(`missedPenalty=${geometry.metrics.alertedOutsidePenalty.toFixed(4)}`);
    lines.push(`contrastPenalty=${geometry.metrics.contrastInsidePenalty.toFixed(4)}`);
  }

  if (geometry.label === 'Alg-B' && geometry.metrics) {
    lines.push(`inside=${geometry.metrics.insideCount}`);
    lines.push(`outside=${geometry.metrics.outsideCount}`);
  }

  if ((geometry.label === 'Alg-C' || geometry.label === 'Alg-D') && geometry.metrics) {
    lines.push(`clustered=${geometry.metrics.clusteredCount}`);
    lines.push(`boundary=${geometry.metrics.boundaryCount}`);
    lines.push(`coastRejected=${geometry.metrics.coastRejectedCount}`);
    if (Number.isFinite(geometry.metrics.minCoastDistanceMeters)) {
      lines.push(`minCoastDist=${Math.round(geometry.metrics.minCoastDistanceMeters)}m`);
    }
  }

  return lines;
}

function buildHtml(payload) {
  const title = `${path.basename(payload.inputPath)} Ellipse Comparison`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  >
  <style>
    :root {
      --bg-top: #f5f2ea;
      --bg-bottom: #e3eaee;
      --panel: rgba(255,255,255,0.92);
      --ink: #172126;
      --grid: rgba(23,33,38,0.08);
      --point: #111827;
    }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background: linear-gradient(160deg, var(--bg-top), var(--bg-bottom));
    }
    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      padding: 22px 20px;
      box-sizing: border-box;
      background: var(--panel);
      border-right: 1px solid var(--grid);
      overflow: auto;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.05;
    }
    p {
      margin: 0 0 16px;
      line-height: 1.45;
    }
    .meta {
      margin: 0 0 8px;
      font-size: 14px;
      line-height: 1.35;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 10px 0;
      font-size: 14px;
    }
    .legend-subitem {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 6px 0 6px 26px;
      font-size: 12px;
      color: rgba(23, 33, 38, 0.86);
    }
    .legend-toggle {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--ink);
      flex: 0 0 auto;
    }
    .legend-subtoggle {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--ink);
      flex: 0 0 auto;
    }
    .swatch {
      width: 34px;
      height: 12px;
      border-radius: 999px;
      flex: 0 0 auto;
      border: 2px solid transparent;
      box-sizing: border-box;
    }
    .stage-swatch {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      flex: 0 0 auto;
      border: 1px solid transparent;
      box-sizing: border-box;
    }
    #map {
      min-height: 100vh;
    }
    @media (max-width: 960px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--grid);
      }
      #map {
        min-height: 70vh;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <h1>${escapeHtml(title)}</h1>
      <p>Comparison map for <code>alg-basic</code>, <code>alg-A</code>, <code>alg-B</code>, <code>alg-C</code>, and <code>alg-D</code>, built from a JSON file of alerted settlement names.</p>
      <div class="meta">Input: ${escapeHtml(path.basename(payload.inputPath))}</div>
      <div class="meta">Alerted settlements: ${payload.alertedPoints.length}</div>
      ${payload.geometries.map((geometry) => `
        <div class="legend-item">
          <input class="legend-toggle" type="checkbox" data-geometry-label="${escapeHtml(geometry.label)}" checked>
          <span class="swatch" style="background:${geometry.style.color}; border-color:${geometry.style.color}"></span>
          <span>${escapeHtml(buildSummary(geometry))}</span>
        </div>
        ${(geometry.debugStages || []).map((stage) => `
          <div class="legend-subitem">
            <input class="legend-subtoggle" type="checkbox" data-stage-id="${escapeHtml(stage.id)}">
            <span class="stage-swatch" style="background:${stage.style.fillColor}; border-color:${stage.style.color}"></span>
            <span>${escapeHtml(stage.label)} (${stage.points.length})</span>
          </div>
        `).join('')}
      `).join('')}
      <div class="legend-item">
        <span class="swatch" style="background:var(--point); border-color:var(--point)"></span>
        <span>Alerted settlements (${payload.alertedPoints.length})</span>
      </div>
    </aside>
    <div id="map"></div>
  </div>
  <script>
    window.__ELLIPSE_COMPARE__ = ${JSON.stringify(payload)};
  </script>
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>
  <script>
    (function() {
      const payload = window.__ELLIPSE_COMPARE__;
      const map = L.map('map', { zoomControl: true, preferCanvas: true });
      const geometryLayersByLabel = new Map();
      const stageLayersById = new Map();

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      map.fitBounds(L.latLngBounds(payload.bounds.southWest, payload.bounds.northEast).pad(0.08));

      const geometries = payload.geometries.slice().sort((a, b) => {
        if (a.label === 'alg-basic' && b.label !== 'alg-basic') return 1;
        if (b.label === 'alg-basic' && a.label !== 'alg-basic') return -1;
        return 0;
      });

      for (const geometry of geometries) {
        const popup = [geometry.label, ...geometry.metricLines].join('<br>');
        const weight = geometry.style.weight || 4;
        const layerGroup = L.layerGroup();

        if (geometry.type === 'circle') {
          L.circle([geometry.center.lat, geometry.center.lng], {
            radius: geometry.radiusMeters,
            color: geometry.style.color,
            weight,
            opacity: 0.95,
            fillColor: geometry.style.color,
            fillOpacity: geometry.style.fillOpacity
          }).addTo(layerGroup).bindPopup(popup);
        } else {
          L.polygon(geometry.latlngs, {
            color: geometry.style.color,
            weight,
            opacity: 0.95,
            fillColor: geometry.style.color,
            fillOpacity: geometry.style.fillOpacity
          }).addTo(layerGroup).bindPopup(popup);
        }

        L.circleMarker([geometry.center.lat, geometry.center.lng], {
          radius: 5,
          color: geometry.style.color,
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 1
        }).addTo(layerGroup).bindPopup(geometry.label + ' center');

        layerGroup.addTo(map);
        geometryLayersByLabel.set(geometry.label, layerGroup);

        for (const stage of (geometry.debugStages || [])) {
          const stageLayer = L.layerGroup();
          for (const point of stage.points) {
            L.circleMarker([point.lat, point.lng], {
              radius: stage.style.radius,
              color: stage.style.color,
              weight: 1,
              fillColor: stage.style.fillColor,
              fillOpacity: 0.9
            }).addTo(stageLayer).bindPopup(
              geometry.label + ' ' + stage.label + (point.name ? ': ' + point.name : '')
            );
          }
          stageLayersById.set(stage.id, stageLayer);
        }
      }

      for (const checkbox of document.querySelectorAll('[data-geometry-label]')) {
        checkbox.addEventListener('change', () => {
          const layerGroup = geometryLayersByLabel.get(checkbox.dataset.geometryLabel);
          if (!layerGroup) return;
          if (checkbox.checked) {
            layerGroup.addTo(map);
          } else {
            layerGroup.remove();
          }
        });
      }

      for (const checkbox of document.querySelectorAll('[data-stage-id]')) {
        checkbox.addEventListener('change', () => {
          const layerGroup = stageLayersById.get(checkbox.dataset.stageId);
          if (!layerGroup) return;
          if (checkbox.checked) {
            layerGroup.addTo(map);
          } else {
            layerGroup.remove();
          }
        });
      }

      for (const point of payload.alertedPoints) {
        L.circleMarker([point.lat, point.lng], {
          radius: 3,
          color: '#111827',
          weight: 1,
          fillColor: '#111827',
          fillOpacity: 0.75
        }).addTo(map).bindPopup(point.name);
      }
    })();
  </script>
</body>
</html>`;
}

function makeOutputPath(inputPath, explicitOutputPath) {
  if (explicitOutputPath) return path.resolve(explicitOutputPath);
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, parsed.name + '.ellipse-comparison.html');
}

async function main() {
  const inputPathArg = process.argv[2];
  const outputPathArg = process.argv[3];

  if (!inputPathArg) {
    fail('Usage: node tools/gen_ellipses.js <locations.json> [output.html]');
  }

  const inputPath = path.resolve(process.cwd(), inputPathArg);
  if (!fs.existsSync(inputPath)) fail('Input file not found: ' + inputPath);

  const outputPath = makeOutputPath(inputPath, outputPathArg);
  const names = ensureNameArray(parseJsonFile(inputPath));
  const pointsMap = parseJsonFile(OREF_POINTS_PATH);
  const alertedPoints = resolvePoints(names, pointsMap);
  const allEntries = buildAllEntries(pointsMap);
  const projection = buildProjection(alertedPoints);

  const basicGeometry = buildEllipseGeometry(alertedPoints);
  basicGeometry.projectionType = 'mercator';
  const algAFit = fitEllipse(alertedPoints, allEntries, ALG_A_DEFAULT_OPTIONS);
  const algBFit = fitFixedLeftmostEllipse(alertedPoints);
  const algCFit = await fitAlgC(alertedPoints);
  const algDFit = await fitAlgD(alertedPoints);

  const styles = [
    { label: 'alg-basic', color: '#8e1b1b', fillOpacity: 0.05, weight: 8 },
    { label: 'Alg-A', color: '#1b5e20', fillOpacity: 0.05 },
    { label: 'Alg-B', color: '#1839b7', fillOpacity: 0.04 },
    { label: 'Alg-C', color: '#8a3ffc', fillOpacity: 0.04 },
    { label: 'Alg-D', color: '#d97706', fillOpacity: 0.04 },
  ];

  const geometries = [
    buildRenderableGeometry(basicGeometry, projection, styles[0]),
    buildRenderableGeometry({
      type: 'ellipse',
      center: algAFit.projection.unproject({
        x: algAFit.optimized.candidate.centerX,
        y: algAFit.optimized.candidate.centerY,
      }),
      semiMajor: algAFit.optimized.candidate.semiMajor,
      semiMinor: algAFit.optimized.candidate.semiMinor,
      angle: algAFit.optimized.candidate.angle,
      projectionCenterX: algAFit.optimized.candidate.centerX,
      projectionCenterY: algAFit.optimized.candidate.centerY,
      metrics: algAFit.optimized.metrics,
    }, projection, styles[1]),
    buildRenderableGeometry({
      type: 'ellipse',
      center: algBFit.projection.unproject(algBFit.best.centerProjected),
      semiMajor: ALG_B_SEMI_MAJOR_METERS,
      semiMinor: ALG_B_SEMI_MINOR_METERS,
      angle: algBFit.best.thetaRad,
      projectionCenterX: algBFit.best.centerProjected.x,
      projectionCenterY: algBFit.best.centerProjected.y,
      metrics: {
        insideCount: algBFit.best.insideCount,
        outsideCount: alertedPoints.length - algBFit.best.insideCount,
        outsideError: algBFit.best.outsideError,
        farthestOutside: algBFit.best.farthestOutside,
      },
    }, projection, styles[2]),
    buildRenderableGeometry(buildAlgCRenderableInput(algCFit), projection, styles[3]),
    buildRenderableGeometry(buildAlgCRenderableInput(algDFit), projection, styles[4]),
  ].map((geometry) => ({
    ...geometry,
    metricLines: buildMetricLines(geometry),
  }));

  geometries[3].debugStages = buildAlgorithmDebugStages('Alg-C', styles[3].color, algCFit);
  geometries[4].debugStages = buildAlgorithmDebugStages('Alg-D', styles[4].color, algDFit);

  const payload = {
    inputPath,
    alertedPoints,
    geometries,
    bounds: collectMapBounds(alertedPoints, geometries),
  };

  fs.writeFileSync(outputPath, buildHtml(payload), 'utf8');

  console.log(JSON.stringify({
    inputPath,
    outputPath,
    alertedPointCount: alertedPoints.length,
    geometries: geometries.map((geometry) => ({
      label: geometry.label,
      type: geometry.type,
      center: {
        lat: Number(geometry.center.lat.toFixed(6)),
        lng: Number(geometry.center.lng.toFixed(6)),
      },
      radiusMeters: geometry.radiusMeters ? Number(geometry.radiusMeters.toFixed(2)) : undefined,
      semiMajorMeters: geometry.semiMajorMeters ? Number(geometry.semiMajorMeters.toFixed(2)) : undefined,
      semiMinorMeters: geometry.semiMinorMeters ? Number(geometry.semiMinorMeters.toFixed(2)) : undefined,
      angleDeg: Number((geometry.angleDeg || 0).toFixed(2)),
    })),
  }, null, 2));
}

await main();
process.exit(0);

#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ALG_A_DEFAULT_OPTIONS,
  buildEllipseCandidateLatLngs,
  fitEllipse,
  toDeg,
} from '../tools/lib/ellipse-algorithms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OREF_POINTS_PATH = path.join(ROOT_DIR, 'web', 'oref_points.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseCaseJson(text, filePath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const endIndex = text.indexOf(']\n');
    if (endIndex !== -1) return JSON.parse(text.slice(0, endIndex + 1));
    if (text.trimEnd().endsWith(']')) return JSON.parse(text.trim());
    fail('Failed to parse JSON from ' + filePath + ': ' + error.message);
  }
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) return parseCaseJson(text, filePath);
  return JSON.parse(text);
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) fail(label + ' must contain a JSON array');
  return value;
}

function sanitizeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function buildBounds(latlngs) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of latlngs) {
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

function makeOutputPath(inputPath, explicitOutputPath) {
  if (explicitOutputPath) return path.resolve(explicitOutputPath);
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, parsed.name + '.html');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]
  ));
}

function buildHtml(inputPath, outputPath, alertedPoints, fitResult, options) {
  const finalCandidate = fitResult.optimized.candidate;
  const initialCandidate = fitResult.initialCandidate;
  const ellipseLatLngs = buildEllipseCandidateLatLngs(finalCandidate, fitResult.projection, options.ellipseSamples);
  const initialLatLngs = buildEllipseCandidateLatLngs(initialCandidate, fitResult.projection, options.ellipseSamples);
  const mapBounds = buildBounds(alertedPoints.concat(ellipseLatLngs).concat(initialLatLngs));

  const payload = {
    inputPath,
    outputPath,
    alertedPoints: alertedPoints.map((point) => ({
      name: point.name,
      lat: point.lat,
      lng: point.lng,
    })),
    initialEllipse: {
      center: fitResult.projection.unproject({ x: initialCandidate.centerX, y: initialCandidate.centerY }),
      semiMajor: initialCandidate.semiMajor,
      semiMinor: initialCandidate.semiMinor,
      angleDegrees: toDeg(initialCandidate.angle),
      latlngs: initialLatLngs,
    },
    finalEllipse: {
      center: fitResult.projection.unproject({ x: finalCandidate.centerX, y: finalCandidate.centerY }),
      semiMajor: finalCandidate.semiMajor,
      semiMinor: finalCandidate.semiMinor,
      angleDegrees: toDeg(finalCandidate.angle),
      latlngs: ellipseLatLngs,
    },
    fitMetrics: fitResult.optimized.metrics,
    contrastPointCount: fitResult.contrastProjectedPoints.length,
    bounds: mapBounds,
  };

  const caseLabel = path.basename(inputPath);
  const summaryLines = [
    `Input: ${escapeHtml(caseLabel)}`,
    `Alerted points: ${alertedPoints.length}`,
    `Nearby contrast points: ${payload.contrastPointCount}`,
    `Semi-major: ${Math.round(payload.finalEllipse.semiMajor)} m`,
    `Semi-minor: ${Math.round(payload.finalEllipse.semiMinor)} m`,
    `Angle: ${payload.finalEllipse.angleDegrees.toFixed(1)} deg`,
    `Missed-alert penalty: ${payload.fitMetrics.alertedOutsidePenalty.toFixed(4)}`,
    `Contrast penalty: ${payload.fitMetrics.contrastInsidePenalty.toFixed(4)}`,
    `Ellipse area: ${Math.round(payload.fitMetrics.area).toLocaleString('en-US')} sq m`,
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ellipse Suggestion - ${escapeHtml(caseLabel)}</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  >
  <style>
    :root {
      color-scheme: light;
      --bg: #f2eee5;
      --panel: rgba(255, 251, 245, 0.92);
      --ink: #172126;
      --accent: #0f5a7a;
      --alert: #b64037;
      --alert-fill: rgba(182, 64, 55, 0.12);
      --seed: #7c8a96;
      --seed-fill: rgba(124, 138, 150, 0.08);
      --grid: rgba(23, 33, 38, 0.08);
    }

    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 90, 122, 0.15), transparent 35%),
        linear-gradient(160deg, #f4f1e8, #e5ebef);
    }

    .layout {
      display: grid;
      grid-template-columns: 340px 1fr;
      min-height: 100vh;
    }

    .sidebar {
      padding: 22px 20px;
      border-right: 1px solid var(--grid);
      background: var(--panel);
      backdrop-filter: blur(10px);
      box-sizing: border-box;
      overflow: auto;
    }

    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 12px;
      color: var(--accent);
      margin-bottom: 8px;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.05;
    }

    p {
      margin: 0 0 14px;
      line-height: 1.45;
    }

    .stat {
      margin: 0 0 8px;
      font-size: 14px;
    }

    .legend {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--grid);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 8px 0;
      font-size: 14px;
    }

    .swatch {
      width: 28px;
      height: 10px;
      border-radius: 999px;
      flex: 0 0 auto;
      border: 2px solid transparent;
      box-sizing: border-box;
    }

    .points {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--grid);
      font-size: 13px;
      line-height: 1.45;
      columns: 1;
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
      <div class="eyebrow">Ellipse Prototype</div>
      <h1>${escapeHtml(caseLabel)}</h1>
      <p>Suggested symmetric ellipse fitted from alerted settlements, with nearby non-alerted settlements used as an inland overreach penalty.</p>
      ${summaryLines.map((line) => `<div class="stat">${escapeHtml(line)}</div>`).join('\n')}
      <div class="legend">
        <div class="legend-item"><span class="swatch" style="background: var(--alert); border-color: var(--alert);"></span>Alerted settlements</div>
        <div class="legend-item"><span class="swatch" style="background: var(--alert-fill); border-color: var(--alert);"></span>Suggested ellipse</div>
        <div class="legend-item"><span class="swatch" style="background: var(--seed-fill); border-color: var(--seed);"></span>Initial PCA ellipse</div>
      </div>
      <div class="points">${alertedPoints.map((point) => escapeHtml(point.name)).join('<br>')}</div>
    </aside>
    <div id="map"></div>
  </div>

  <script>
    window.__ELLIPSE_CASE__ = ${JSON.stringify(payload)};
  </script>
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>
  <script>
    (function() {
      const payload = window.__ELLIPSE_CASE__;
      const map = L.map('map', {
        zoomControl: true,
        preferCanvas: true
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      const bounds = L.latLngBounds(payload.bounds.southWest, payload.bounds.northEast);
      map.fitBounds(bounds.pad(0.12));

      const initialEllipse = L.polygon(payload.initialEllipse.latlngs, {
        color: '#7c8a96',
        weight: 2,
        opacity: 0.9,
        fillColor: '#7c8a96',
        fillOpacity: 0.08,
        dashArray: '10 8'
      }).addTo(map);
      initialEllipse.bindPopup('Initial PCA ellipse');

      const finalEllipse = L.polygon(payload.finalEllipse.latlngs, {
        color: '#113ea9',
        weight: 4,
        opacity: 0.95,
        fillColor: '#b64037',
        fillOpacity: 0.12
      }).addTo(map);

      const centerMarker = L.circleMarker(payload.finalEllipse.center, {
        radius: 5,
        color: '#113ea9',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1
      }).addTo(map);

      finalEllipse.bindPopup(
        'Suggested ellipse<br>' +
        'a=' + Math.round(payload.finalEllipse.semiMajor) + 'm<br>' +
        'b=' + Math.round(payload.finalEllipse.semiMinor) + 'm<br>' +
        'angle=' + payload.finalEllipse.angleDegrees.toFixed(1) + '&deg;'
      );
      centerMarker.bindPopup('Ellipse center');

      for (const point of payload.alertedPoints) {
        const marker = L.circleMarker([point.lat, point.lng], {
          radius: 5,
          color: '#7a1f18',
          weight: 2,
          fillColor: '#d45a50',
          fillOpacity: 0.95
        }).addTo(map);
        marker.bindPopup(point.name);
      }
    })();
  </script>
</body>
</html>`;
}

function loadAlertedPoints(inputPath, pointsMap) {
  const names = ensureArray(readJson(inputPath), inputPath);
  const alertedPoints = [];
  const missing = [];

  for (const name of names) {
    const coords = pointsMap[name];
    if (!coords || coords.length < 2) {
      missing.push(name);
      continue;
    }

    alertedPoints.push({
      name,
      lat: coords[0],
      lng: coords[1],
    });
  }

  if (!alertedPoints.length) {
    fail('No alerted points from ' + inputPath + ' could be resolved in web/oref_points.json');
  }

  return { alertedPoints, missing };
}

function main() {
  const inputPathArg = process.argv[2];
  const outputPathArg = process.argv[3];

  if (!inputPathArg) {
    fail('Usage: node tests/ellipse-alg.js <case-json> [output-html]');
  }

  const inputPath = path.resolve(process.cwd(), inputPathArg);
  const outputPath = makeOutputPath(inputPath, outputPathArg);

  if (!fs.existsSync(inputPath)) {
    fail('Input file not found: ' + inputPath);
  }

  const pointsMap = readJson(OREF_POINTS_PATH);
  const { alertedPoints, missing } = loadAlertedPoints(inputPath, pointsMap);
  const allEntries = Object.keys(pointsMap).map((name) => ({
    name,
    lat: sanitizeNumber(pointsMap[name]?.[0]),
    lng: sanitizeNumber(pointsMap[name]?.[1]),
  })).filter((entry) => entry.lat !== null && entry.lng !== null);
  const fitResult = fitEllipse(alertedPoints, allEntries, ALG_A_DEFAULT_OPTIONS);
  const html = buildHtml(inputPath, outputPath, alertedPoints, fitResult, ALG_A_DEFAULT_OPTIONS);

  fs.writeFileSync(outputPath, html, 'utf8');

  console.log(JSON.stringify({
    inputPath,
    outputPath,
    alertedPointCount: alertedPoints.length,
    missingPointCount: missing.length,
    missingPoints: missing,
    semiMajorMeters: Math.round(fitResult.optimized.candidate.semiMajor),
    semiMinorMeters: Math.round(fitResult.optimized.candidate.semiMinor),
    angleDegrees: Number(toDeg(fitResult.optimized.candidate.angle).toFixed(2)),
    alertedOutsideCount: fitResult.optimized.metrics.alertedOutsideCount,
    contrastInsideCount: fitResult.optimized.metrics.contrastInsideCount,
  }, null, 2));
}

main();

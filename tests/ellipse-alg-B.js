#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ALG_B_SEARCH_CONFIG,
  ALG_B_SEMI_MAJOR_METERS,
  ALG_B_SEMI_MINOR_METERS,
  buildEllipseCandidateLatLngs,
  fitFixedLeftmostEllipse,
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
  return path.join(parsed.dir, parsed.name + '.alg-B.html');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]
  ));
}

function buildHtml(inputPath, alertedPoints, fitResult) {
  const ellipseLatLngs = buildEllipseCandidateLatLngs({
    centerX: fitResult.best.centerProjected.x,
    centerY: fitResult.best.centerProjected.y,
    semiMajor: ALG_B_SEMI_MAJOR_METERS,
    semiMinor: ALG_B_SEMI_MINOR_METERS,
    angle: fitResult.best.thetaRad,
  }, fitResult.projection, ALG_B_SEARCH_CONFIG.ellipseSamples);
  const centerLatLng = fitResult.projection.unproject(fitResult.best.centerProjected);
  const bounds = buildBounds(alertedPoints.concat(ellipseLatLngs));
  const payload = {
    inputPath,
    alertedPoints,
    ellipse: {
      center: centerLatLng,
      semiMajor: ALG_B_SEMI_MAJOR_METERS,
      semiMinor: ALG_B_SEMI_MINOR_METERS,
      angleDegrees: toDeg(fitResult.best.thetaRad),
      latlngs: ellipseLatLngs,
    },
    metrics: {
      insideCount: fitResult.best.insideCount,
      outsideCount: alertedPoints.length - fitResult.best.insideCount,
      outsideError: fitResult.best.outsideError,
      farthestOutside: fitResult.best.farthestOutside,
    },
    bounds,
  };

  const caseLabel = path.basename(inputPath);
  const summaryLines = [
    `Input: ${escapeHtml(caseLabel)}`,
    `Alerted points: ${alertedPoints.length}`,
    `Inside ellipse: ${payload.metrics.insideCount}`,
    `Outside ellipse: ${payload.metrics.outsideCount}`,
    `Semi-major: ${ALG_B_SEMI_MAJOR_METERS} m`,
    `Semi-minor: ${ALG_B_SEMI_MINOR_METERS} m`,
    `Angle: ${payload.ellipse.angleDegrees.toFixed(2)} deg`,
    `Outside error: ${payload.metrics.outsideError.toFixed(4)}`,
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ellipse Suggestion B - ${escapeHtml(caseLabel)}</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  >
  <style>
    :root {
      --bg: #efe9de;
      --panel: rgba(253, 251, 247, 0.94);
      --ink: #172126;
      --accent: #0a4d68;
      --alert: #b03d2e;
      --ellipse: #173bb8;
      --ellipse-fill: rgba(176, 61, 46, 0.12);
      --grid: rgba(23, 33, 38, 0.08);
    }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(10, 77, 104, 0.18), transparent 35%),
        linear-gradient(165deg, #f6f2ea, #e1e7ea);
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
    .points {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--grid);
      font-size: 13px;
      line-height: 1.45;
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
      <div class="eyebrow">Ellipse Prototype B</div>
      <h1>${escapeHtml(caseLabel)}</h1>
      <p>Fixed-size ellipse: 70km by 35km. Search over angles from 0 to 20 degrees, then choose the leftmost placement that catches the most known alerted points.</p>
      ${summaryLines.map((line) => `<div class="stat">${escapeHtml(line)}</div>`).join('\n')}
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
      const map = L.map('map', { zoomControl: true, preferCanvas: true });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      const bounds = L.latLngBounds(payload.bounds.southWest, payload.bounds.northEast);
      map.fitBounds(bounds.pad(0.12));

      const ellipse = L.polygon(payload.ellipse.latlngs, {
        color: '#173bb8',
        weight: 4,
        opacity: 0.95,
        fillColor: '#b03d2e',
        fillOpacity: 0.12
      }).addTo(map);

      const centerMarker = L.circleMarker(payload.ellipse.center, {
        radius: 5,
        color: '#173bb8',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1
      }).addTo(map);

      ellipse.bindPopup(
        'Fixed ellipse<br>' +
        'a=' + payload.ellipse.semiMajor + 'm<br>' +
        'b=' + payload.ellipse.semiMinor + 'm<br>' +
        'angle=' + payload.ellipse.angleDegrees.toFixed(2) + '&deg;'
      );
      centerMarker.bindPopup('Ellipse center');

      for (const point of payload.alertedPoints) {
        L.circleMarker([point.lat, point.lng], {
          radius: 5,
          color: '#7a1f18',
          weight: 2,
          fillColor: '#d45a50',
          fillOpacity: 0.95
        }).addTo(map).bindPopup(point.name);
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
    alertedPoints.push({ name, lat: coords[0], lng: coords[1] });
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
    fail('Usage: node tests/ellipse-alg-B.js <case-json> [output-html]');
  }

  const inputPath = path.resolve(process.cwd(), inputPathArg);
  const outputPath = makeOutputPath(inputPath, outputPathArg);
  if (!fs.existsSync(inputPath)) fail('Input file not found: ' + inputPath);

  const pointsMap = readJson(OREF_POINTS_PATH);
  const { alertedPoints, missing } = loadAlertedPoints(inputPath, pointsMap);
  const fitResult = fitFixedLeftmostEllipse(alertedPoints);
  const html = buildHtml(inputPath, alertedPoints, fitResult);
  fs.writeFileSync(outputPath, html, 'utf8');

  console.log(JSON.stringify({
    inputPath,
    outputPath,
    alertedPointCount: alertedPoints.length,
    missingPointCount: missing.length,
    missingPoints: missing,
    insideCount: fitResult.best.insideCount,
    outsideCount: alertedPoints.length - fitResult.best.insideCount,
    semiMajorMeters: ALG_B_SEMI_MAJOR_METERS,
    semiMinorMeters: ALG_B_SEMI_MINOR_METERS,
    angleDegrees: Number(toDeg(fitResult.best.thetaRad).toFixed(2)),
    center: {
      lat: Number(fitResult.projection.unproject(fitResult.best.centerProjected).lat.toFixed(6)),
      lng: Number(fitResult.projection.unproject(fitResult.best.centerProjected).lng.toFixed(6)),
    },
    outsideError: Number(fitResult.best.outsideError.toFixed(6)),
  }, null, 2));
}

main();

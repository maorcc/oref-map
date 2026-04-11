#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildEllipseGeometry, radToDeg } from './lib/ellipse-algorithms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OREF_POINTS_PATH = path.join(ROOT_DIR, 'web', 'oref_points.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readInputArgument(rawArg) {
  if (!rawArg) {
    fail('Usage: node tools/ellipse-from-locations.js \'["ירושלים - מערב", "בית שמש"]\'\n   or: node tools/ellipse-from-locations.js --file /path/to/locations.json');
  }

  if (rawArg === '--file') return null;

  try {
    return JSON.parse(rawArg);
  } catch (error) {
    fail('Failed to parse inline JSON array: ' + error.message);
  }
}

function readInputFile(filePath) {
  const text = fs.readFileSync(path.resolve(filePath), 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('Failed to parse JSON file ' + filePath + ': ' + error.message);
  }
}

function ensureNameArray(value) {
  if (!Array.isArray(value)) {
    fail('Input must be a JSON array of location names.');
  }
  const names = value.map((entry) => String(entry));
  if (!names.length) {
    fail('Input array is empty.');
  }
  return names;
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
    points.push({
      name,
      lat: coords[0],
      lng: coords[1],
    });
  }

  if (missing.length) {
    fail('Missing locations in web/oref_points.json: ' + missing.join(', '));
  }

  return points;
}

function main() {
  const args = process.argv.slice(2);
  let names;

  if (args[0] === '--file') {
    if (!args[1]) fail('Missing file path after --file');
    names = ensureNameArray(readInputFile(args[1]));
  } else {
    names = ensureNameArray(readInputArgument(args[0]));
  }

  const allPoints = JSON.parse(fs.readFileSync(OREF_POINTS_PATH, 'utf8'));
  const points = resolvePoints(names, allPoints);
  const geometry = buildEllipseGeometry(points);

  if (!geometry) fail('Failed to build geometry.');

  if (geometry.type === 'circle') {
    console.log(JSON.stringify({
      type: 'circle',
      pointCount: points.length,
      center: geometry.center,
      radiusMeters: geometry.radiusMeters,
      diameterMeters: geometry.radiusMeters * 2,
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    type: geometry.type,
    pointCount: points.length,
    center: geometry.center,
    semiMajorMeters: geometry.semiMajor,
    semiMinorMeters: geometry.semiMinor,
    majorAxisLengthMeters: geometry.semiMajor * 2,
    minorAxisLengthMeters: geometry.semiMinor * 2,
    majorAxisBearingDegrees: (radToDeg(Math.atan2(geometry.majorAxis.x, geometry.majorAxis.y)) + 360) % 360,
  }, null, 2));
}

main();

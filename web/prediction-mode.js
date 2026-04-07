(function() {
  'use strict';

  function initPrediction() {
    var A = window.AppState;
    var map = A.map;
    var showToast = A.showToast;

    var predictionFeatures = [];
    var enabled = localStorage.getItem('oref-predict') === 'true';
    var predictionUpdateScheduled = false;

    var PREDICTION_ELONGATION_MIN = 2.5;
    var PREDICTION_MIN_SPAN = 0.1;
    var ISRAEL_CENTER = [31.5, 34.8];

    // GeoJSON feature → [lat, lng] centroid of outer ring
    function polygonCentroid(feature) {
      var outer = feature.geometry.coordinates[0];
      if (!outer || outer.length === 0) return null;
      var sumLat = 0, sumLng = 0;
      for (var i = 0; i < outer.length; i++) {
        sumLat += outer[i][1];
        sumLng += outer[i][0];
      }
      return [sumLat / outer.length, sumLng / outer.length];
    }

    // GeoJSON feature → approximate polygon area (degrees²)
    function polygonArea(feature) {
      var outer = feature.geometry.coordinates[0];
      if (!outer || outer.length < 3) return 0;
      var area = 0;
      for (var i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        area += (outer[j][0] + outer[i][0]) * (outer[j][1] - outer[i][1]);
      }
      return Math.abs(area / 2);
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

    var MED_COAST = [
      [29.5, 32.53], [30.5, 33.60], [31.0, 34.10], [31.33, 34.23],
      [31.67, 34.53], [31.85, 34.62], [32.08, 34.74], [32.50, 34.87],
      [32.82, 34.95], [33.09, 35.07], [33.50, 35.25], [34.0, 35.47],
      [34.5, 35.70], [35.0, 35.90], [36.0, 35.80]
    ];

    function coastLng(lat) {
      if (lat <= MED_COAST[0][0] || lat >= MED_COAST[MED_COAST.length - 1][0]) return null;
      for (var i = 0; i < MED_COAST.length - 1; i++) {
        if (lat >= MED_COAST[i][0] && lat <= MED_COAST[i + 1][0]) {
          var t = (lat - MED_COAST[i][0]) / (MED_COAST[i + 1][0] - MED_COAST[i][0]);
          return MED_COAST[i][1] + t * (MED_COAST[i + 1][1] - MED_COAST[i][1]);
        }
      }
      return null;
    }

    function isOverSea(pt) {
      var cl = coastLng(pt[0]);
      return cl !== null && pt[1] < cl;
    }

    function clipAtCoast(coords) {
      if (coords.length < 2) return coords;
      var startIdx = 0;
      while (startIdx < coords.length && isOverSea(coords[startIdx])) startIdx++;
      if (startIdx >= coords.length) return [];
      var endIdx = coords.length - 1;
      while (endIdx >= 0 && isOverSea(coords[endIdx])) endIdx--;
      if (endIdx < startIdx) return [];
      var result = coords.slice(startIdx, endIdx + 1);
      if (startIdx > 0) {
        var a = coords[startIdx - 1], b = coords[startIdx];
        var clA = coastLng(a[0]), clB = coastLng(b[0]);
        if (clA !== null && clB !== null) {
          var dA = clA - a[1], dB = clB - b[1];
          if (Math.abs(dA - dB) > 1e-10) {
            var t = dA / (dA - dB);
            result.unshift([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
          }
        }
      }
      if (endIdx < coords.length - 1) {
        var a = coords[endIdx], b = coords[endIdx + 1];
        var clA = coastLng(a[0]), clB = coastLng(b[0]);
        if (clA !== null && clB !== null) {
          var dA = clA - a[1], dB = clB - b[1];
          if (Math.abs(dA - dB) > 1e-10) {
            var t = dA / (dA - dB);
            result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
          }
        }
      }
      return result;
    }

    function gcDest(lat, lng, bearingDeg, distDeg) {
      var toRad = Math.PI / 180, toDeg = 180 / Math.PI;
      var lat1 = lat * toRad, lng1 = lng * toRad, brng = bearingDeg * toRad, d = distDeg * toRad;
      var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
      var lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
                                    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
      return [lat2 * toDeg, lng2 * toDeg];
    }

    function clearPredictionLines() {
      if (predictionFeatures.length === 0) return;
      predictionFeatures = [];
      updatePredictionSource();
    }

    function updatePredictionSource() {
      var src = map.getSource('prediction-source');
      if (src) src.setData({ type: 'FeatureCollection', features: predictionFeatures });
    }

    // Cluster alerted locations by polygon adjacency.
    // Two alerted locations are in the same cluster if their polygons share a vertex.
    function clusterByAdjacency(locPoints, featureMap) {
      var n = locPoints.length;
      if (n === 0) return [];
      // Collect polygon vertices for each location
      var locVerts = [];
      for (var i = 0; i < n; i++) {
        var feature = featureMap[locPoints[i][3]];
        var verts = [];
        if (feature) {
          var outer = feature.geometry.coordinates[0];
          for (var j = 0; j < outer.length; j++) verts.push([outer[j][1], outer[j][0]]);
        }
        locVerts.push(verts);
      }
      // Union-find
      var parent = [];
      for (var i = 0; i < n; i++) parent[i] = i;
      function find(i) {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
      }
      // Adjacent = any vertex within tolerance (shared Voronoi edge)
      var tol2 = 0.005 * 0.005; // ~500m
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

    function updatePredictionLines() {
      if (!enabled) {
        clearPredictionLines();
        return;
      }

      A.ensureOrefPoints().then(function(orefPts) {
        var locationStates = A.locationStates;
        var featureMap = A.featureMap;

        var locPoints = [];
        for (var name in locationStates) {
          var entry = locationStates[name];
          if (!entry || entry.state !== 'red') continue;
          var pt = orefPts[name];
          if (!pt) { var feature = featureMap[name]; if (feature) pt = polygonCentroid(feature); }
          if (pt) locPoints.push([pt[0], pt[1], 1, name]);
        }
        if (locPoints.length < 3) {
          clearPredictionLines();
          return;
        }

        var clusters = clusterByAdjacency(locPoints, featureMap);
        var newFeatures = [];

        for (var ci = 0; ci < clusters.length; ci++) {
          var cluster = clusters[ci];
          if (cluster.length < 3) continue;

          var VERTS_PER_POLY = 12;
          var vertices = [];
          for (var i = 0; i < cluster.length; i++) {
            var feature = featureMap[cluster[i][3]];
            if (!feature) continue;
            var outer = feature.geometry.coordinates[0];
            var step = Math.max(1, Math.floor(outer.length / VERTS_PER_POLY));
            for (var j = 0; j < outer.length; j += step) vertices.push([outer[j][1], outer[j][0], 1]);
          }
          if (vertices.length < 6) continue;

          var line = fitLine(vertices);
          if (!line) continue;

          // Area-weighted centroid
          var awLat = 0, awLng = 0, awTotal = 0;
          for (var i = 0; i < cluster.length; i++) {
            var locName = cluster[i][3];
            var polyFeature = featureMap[locName];
            var a = polyFeature ? Math.max(polygonArea(polyFeature), 1e-6) : 1e-6;
            var pc = polyFeature ? polygonCentroid(polyFeature) : null;
            if (pc) { awLat += pc[0] * a; awLng += pc[1] * a; awTotal += a; }
          }
          if (awTotal < 1e-12) continue;
          var cx = awLat / awTotal, cy = awLng / awTotal;
          var elongation = line.lambda2 > 1e-12 ? line.lambda1 / line.lambda2 : Infinity;
          if (elongation < PREDICTION_ELONGATION_MIN) continue;

          var dx = line.direction[0], dy = line.direction[1];
          var _minP = Infinity, _maxP = -Infinity;
          for (var i = 0; i < vertices.length; i++) {
            var _p = (vertices[i][0] - cx) * dx + (vertices[i][1] - cy) * dy;
            if (_p < _minP) _minP = _p;
            if (_p > _maxP) _maxP = _p;
          }
          var clusterSpan = _maxP - _minP;

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

          var minProj = Infinity, maxProj = -Infinity;
          for (var i = 0; i < vertices.length; i++) {
            var proj = (vertices[i][0] - cx) * sourceDx + (vertices[i][1] - cy) * sourceDy;
            if (proj < minProj) minProj = proj;
            if (proj > maxProj) maxProj = proj;
          }
          if (maxProj - minProj < PREDICTION_MIN_SPAN) continue;

          var extSource = sourceExtensionDeg(sourceBearingNorm);
          var cosLat = Math.cos(cx * Math.PI / 180);
          var projToArc = Math.sqrt(sourceDx * sourceDx + sourceDy * sourceDy * cosLat * cosLat);
          var arcInward = Math.min(minProj, 0) * projToArc;
          var arcSource = Math.max(maxProj, 0) * projToArc + extSource;

          var totalArc = arcSource - arcInward;
          var numSeg = Math.max(20, Math.round(totalArc * 5));
          var lineCoords = []; // [lat, lng] pairs
          for (var si = 0; si <= numSeg; si++) {
            var d = arcInward + (si / numSeg) * totalArc;
            if (d >= 0) {
              lineCoords.push(gcDest(cx, cy, sourceBearingNorm, d));
            } else {
              lineCoords.push(gcDest(cx, cy, (sourceBearingNorm + 180) % 360, -d));
            }
          }
          lineCoords = clipAtCoast(lineCoords);
          if (lineCoords.length < 2) continue;

          // Main dashed line — convert [lat, lng] → [lng, lat] for GeoJSON
          newFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: lineCoords.map(function(c) { return [c[1], c[0]]; })
            },
            properties: { kind: 'line' }
          });

          // Arrowhead
          var arrowSize = 0.08;
          var tipPt = lineCoords[lineCoords.length - 1];
          var px = -sourceDy, py = sourceDx;
          var tip   = [tipPt[0] + sourceDx * arrowSize, tipPt[1] + sourceDy * arrowSize];
          var left  = [tipPt[0] + px * arrowSize * 0.5,  tipPt[1] + py * arrowSize * 0.5];
          var right = [tipPt[0] - px * arrowSize * 0.5,  tipPt[1] - py * arrowSize * 0.5];
          newFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [[left[1], left[0]], [tip[1], tip[0]], [right[1], right[0]]]
            },
            properties: { kind: 'arrow' }
          });

          // Uncertainty band
          var sigmaPerp = Math.sqrt(Math.max(0, line.lambda2) / line.totalWeight);
          var lambda1Safe = Math.max(line.lambda1, 1e-6);
          if (sigmaPerp > 0.001) {
            var perpDx = -sourceDy, perpDy = sourceDx;
            var bandLeft = [], bandRight = [];
            for (var bi = 0; bi < lineCoords.length; bi++) {
              var pt = lineCoords[bi];
              var dMain = (pt[0] - cx) * sourceDx + (pt[1] - cy) * sourceDy;
              var w = sigmaPerp * Math.sqrt(1 + dMain * dMain / lambda1Safe);
              bandLeft.push([pt[1] + perpDy * w, pt[0] + perpDx * w]); // [lng, lat]
              bandRight.push([pt[1] - perpDy * w, pt[0] - perpDx * w]);
            }
            bandRight.reverse();
            var ring = bandLeft.concat(bandRight);
            ring.push(ring[0]); // close GeoJSON ring
            newFeatures.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [ring] },
              properties: { kind: 'band' }
            });
          }
        }

        predictionFeatures = newFeatures;
        updatePredictionSource();
      });
    }

    function schedulePredictionUpdate() {
      if (predictionUpdateScheduled) return;
      predictionUpdateScheduled = true;
      requestAnimationFrame(function() {
        predictionUpdateScheduled = false;
        updatePredictionLines();
      });
    }

    function sync() {
      if (!enabled) return;
      schedulePredictionUpdate();
    }

    function setEnabled(val, opts) {
      enabled = !!val;
      localStorage.setItem('oref-predict', enabled);
      if (opts && opts.showToast) {
        showToast(enabled ? 'חיזוי כיוון שיגור מופעל' : 'חיזוי כיוון שיגור כובה');
      }
      if (enabled) {
        sync();
      } else {
        clearPredictionLines();
      }
    }

    // Add MapLibre source and layers for prediction overlays
    function setupLayers() {
      map.addSource('prediction-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'prediction-band',
        type: 'fill',
        source: 'prediction-source',
        filter: ['==', ['get', 'kind'], 'band'],
        paint: { 'fill-color': '#ff4444', 'fill-opacity': 0.1 }
      });
      map.addLayer({
        id: 'prediction-line',
        type: 'line',
        source: 'prediction-source',
        filter: ['==', ['get', 'kind'], 'line'],
        paint: { 'line-color': '#ff4444', 'line-width': 2.5, 'line-opacity': 0.7, 'line-dasharray': [10, 8] }
      });
      map.addLayer({
        id: 'prediction-arrow',
        type: 'line',
        source: 'prediction-source',
        filter: ['==', ['get', 'kind'], 'arrow'],
        paint: { 'line-color': '#ff4444', 'line-width': 2.5, 'line-opacity': 0.7 }
      });
    }

    if (map.loaded()) {
      setupLayers();
    } else {
      map.once('load', setupLayers);
    }

    // Wire up menu toggle in #ext-menu
    var menuItem = document.getElementById('menu-predict');
    if (menuItem) {
      if (enabled) menuItem.classList.add('active');
      menuItem.querySelector('.menu-item-row').addEventListener('click', function() {
        var next = !enabled;
        setEnabled(next, { showToast: true });
        menuItem.classList.toggle('active', next);
      });
    }

    // Listen for state changes
    document.addEventListener('app:stateChanged', function() { sync(); });

    // Initial render if enabled
    if (enabled) sync();
  }

  // Self-init: wait for AppState if needed
  if (window.AppState) {
    initPrediction();
  } else {
    document.addEventListener('app:ready', initPrediction);
  }
})();

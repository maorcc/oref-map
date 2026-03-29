(function() {
  'use strict';

  window.initPredictionMode = function(options) {
    var map = options.map;
    var getLocationStates = options.getLocationStates;
    var getLocationPolygons = options.getLocationPolygons;
    var showToast = options.showToast;

    var orefPoints = null;
    var orefPointsPromise = null;
    var predictionLines = [];
    var enabled = localStorage.getItem('oref-predict') === 'true';
    var predictionUpdateScheduled = false;

    var PREDICTION_CLUSTER_THRESHOLD = 0.15;
    var PREDICTION_ELONGATION_MIN = 2.5;
    var PREDICTION_MIN_SPAN = 0.1;
    var ISRAEL_CENTER = [31.5, 34.8];

    function ensureOrefPoints() {
      if (orefPoints) return Promise.resolve(orefPoints);
      if (orefPointsPromise) return orefPointsPromise;

      orefPointsPromise = fetch('oref_points.json')
        .then(function(resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function(data) {
          orefPoints = data || {};
          return orefPoints;
        })
        .finally(function() {
          orefPointsPromise = null;
        });

      return orefPointsPromise;
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

    function clusterPoints(points, eps, minPts) {
      if (!minPts) minPts = 2;
      var n = points.length;
      var eps2 = eps * eps;
      var labels = [];
      for (var i = 0; i < n; i++) labels[i] = -1;
      function neighbors(i) {
        var nb = [];
        for (var j = 0; j < n; j++) {
          var dl = points[i][0] - points[j][0], dg = points[i][1] - points[j][1];
          if (dl * dl + dg * dg <= eps2) nb.push(j);
        }
        return nb;
      }
      var cluster = 0;
      for (var i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;
        var nb = neighbors(i);
        if (nb.length < minPts) { labels[i] = -2; continue; }
        labels[i] = cluster;
        var queue = nb.slice(), qi = 0;
        while (qi < queue.length) {
          var j = queue[qi++];
          if (labels[j] === -2) labels[j] = cluster;
          if (labels[j] !== -1) continue;
          labels[j] = cluster;
          var jnb = neighbors(j);
          if (jnb.length >= minPts) {
            for (var k = 0; k < jnb.length; k++) queue.push(jnb[k]);
          }
        }
        cluster++;
      }
      if (cluster === 0) return [];
      for (var i = 0; i < n; i++) {
        if (labels[i] >= 0) continue;
        var best = Infinity, bestC = -1;
        for (var j = 0; j < n; j++) {
          if (labels[j] < 0) continue;
          var dl = points[i][0] - points[j][0], dg = points[i][1] - points[j][1];
          var d2 = dl * dl + dg * dg;
          if (d2 < best) { best = d2; bestC = labels[j]; }
        }
        if (bestC < 0) continue;
        labels[i] = bestC;
      }
      var groups = {};
      for (var i = 0; i < n; i++) {
        var c = labels[i];
        if (c < 0) continue;
        if (!groups[c]) groups[c] = [];
        groups[c].push(points[i]);
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
      for (var i = 0; i < predictionLines.length; i++) {
        map.removeLayer(predictionLines[i]);
      }
      predictionLines = [];
    }

    function updatePredictionLines() {
      clearPredictionLines();
      if (!enabled) return;

      ensureOrefPoints().then(function(orefPts) {
        var locationStates = getLocationStates();
        var locationPolygons = getLocationPolygons();

        var locPoints = [];
        for (var name in locationStates) {
          var entry = locationStates[name];
          if (!entry || entry.state !== 'red') continue;
          var pt = orefPts[name];
          if (!pt) { var poly = locationPolygons[name]; if (poly) pt = polygonCentroid(poly); }
          if (pt) locPoints.push([pt[0], pt[1], 1, name]);
        }
        if (locPoints.length < 3) return;

        var clusters = clusterPoints(locPoints, PREDICTION_CLUSTER_THRESHOLD);
        for (var ci = 0; ci < clusters.length; ci++) {
          var cluster = clusters[ci];
          if (cluster.length < 3) continue;

          var VERTS_PER_POLY = 12;
          var vertices = [];
          for (var i = 0; i < cluster.length; i++) {
            var poly = locationPolygons[cluster[i][3]];
            if (!poly) continue;
            var rings = poly.getLatLngs();
            var outer = Array.isArray(rings[0]) && rings[0].length && rings[0][0].lat !== undefined ? rings[0] : rings;
            var step = Math.max(1, Math.floor(outer.length / VERTS_PER_POLY));
            for (var j = 0; j < outer.length; j += step) vertices.push([outer[j].lat, outer[j].lng, 1]);
          }
          if (vertices.length < 6) continue;

          var line = fitLine(vertices);
          if (!line) continue;

          var awLat = 0, awLng = 0, awTotal = 0;
          for (var i = 0; i < cluster.length; i++) {
            var poly = locationPolygons[cluster[i][3]];
            if (!poly) continue;
            var c = polygonCentroid(poly);
            if (!c) continue;
            var a = Math.max(polygonArea(poly), 1e-6);
            awLat += c[0] * a; awLng += c[1] * a; awTotal += a;
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
          var lineCoords = [];
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

          var polyline = L.polyline(lineCoords, {
            color: '#ff4444', weight: 2.5, opacity: 0.7, dashArray: '10, 8', interactive: false
          }).addTo(map);
          predictionLines.push(polyline);

          var arrowSize = 0.08;
          var tipPt = lineCoords[lineCoords.length - 1];
          var px = -sourceDy, py = sourceDx;
          var tip = [tipPt[0] + sourceDx * arrowSize, tipPt[1] + sourceDy * arrowSize];
          var left = [tipPt[0] + px * arrowSize * 0.5, tipPt[1] + py * arrowSize * 0.5];
          var right = [tipPt[0] - px * arrowSize * 0.5, tipPt[1] - py * arrowSize * 0.5];
          var arrow = L.polyline([left, tip, right], {
            color: '#ff4444', weight: 2.5, opacity: 0.7, interactive: false
          }).addTo(map);
          predictionLines.push(arrow);

          var sigmaPerp = Math.sqrt(Math.max(0, line.lambda2) / line.totalWeight);
          var lambda1Safe = Math.max(line.lambda1, 1e-6);
          if (sigmaPerp > 0.001) {
            var perpDx = -sourceDy, perpDy = sourceDx;
            var bandLeft = [], bandRight = [];
            for (var bi = 0; bi < lineCoords.length; bi++) {
              var pt = lineCoords[bi];
              var dMain = (pt[0] - cx) * sourceDx + (pt[1] - cy) * sourceDy;
              var w = sigmaPerp * Math.sqrt(1 + dMain * dMain / lambda1Safe);
              bandLeft.push([pt[0] + perpDx * w, pt[1] + perpDy * w]);
              bandRight.push([pt[0] - perpDx * w, pt[1] - perpDy * w]);
            }
            bandRight.reverse();
            var band = L.polygon(bandLeft.concat(bandRight), {
              color: '#ff4444', fillColor: '#ff4444', fillOpacity: 0.1,
              opacity: 0.2, weight: 1, interactive: false
            }).addTo(map);
            predictionLines.push(band);
          }
        }
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

    return {
      sync: sync,
      setEnabled: setEnabled,
      clear: clearPredictionLines,
      isEnabled: function() { return enabled; }
    };
  };
})();

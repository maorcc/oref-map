(function() {
  'use strict';

  window.initEllipseMode = function(options) {
    var map = options.map;
    var getLocationStates = options.getLocationStates;
    var getLocationHistory = options.getLocationHistory;
    var getLocationPolygons = options.getLocationPolygons;
    var getIsLiveMode = options.getIsLiveMode;
    var getCurrentViewTime = options.getCurrentViewTime;
    var showToast = options.showToast;

    var orefPoints = null;
    var orefPointsPromise = null;
    var ellipseMarkers = [];
    var ellipseOverlays = [];

    function getDisplayedRedAlerts() {
      var locationStates = getLocationStates();
      var locationHistory = getLocationHistory();
      var names = Object.keys(locationStates).filter(function(name) {
        return locationStates[name] && locationStates[name].state === 'red';
      }).sort(function(a, b) {
        return a.localeCompare(b, 'he');
      });

      return names.map(function(name) {
        var entries = locationHistory[name] || [];
        var latest = entries.length > 0 ? entries[entries.length - 1] : null;
        return {
          location: name,
          title: latest && latest.title ? latest.title : 'ירי רקטות וטילים',
          alertDate: latest && latest.alertDate ? latest.alertDate : '',
        };
      });
    }

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

    function clear() {
      for (var i = 0; i < ellipseMarkers.length; i++) {
        map.removeLayer(ellipseMarkers[i]);
      }
      ellipseMarkers = [];
      for (var j = 0; j < ellipseOverlays.length; j++) {
        map.removeLayer(ellipseOverlays[j]);
      }
      ellipseOverlays = [];
    }

    function projectEllipsePoint(point) {
      var projected = map.options.crs.project(L.latLng(point.lat, point.lng));
      return { x: projected.x, y: projected.y, lat: point.lat, lng: point.lng };
    }

    function unprojectEllipsePoint(point) {
      return map.options.crs.unproject(L.point(point.x, point.y));
    }

    function normalizeVector(vector, fallback) {
      var length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
      if (length < 1e-12) return fallback;
      return { x: vector.x / length, y: vector.y / length };
    }

    function buildEllipseGeometry(points) {
      if (!points.length) return null;

      var projectedPoints = points.map(projectEllipsePoint);
      if (projectedPoints.length === 1) {
        return {
          type: 'circle',
          center: points[0],
          radiusMeters: 700
        };
      }

      var centerX = 0;
      var centerY = 0;
      for (var i = 0; i < projectedPoints.length; i++) {
        centerX += projectedPoints[i].x;
        centerY += projectedPoints[i].y;
      }
      centerX /= projectedPoints.length;
      centerY /= projectedPoints.length;

      var majorAxis;
      if (projectedPoints.length === 2) {
        majorAxis = normalizeVector({
          x: projectedPoints[1].x - projectedPoints[0].x,
          y: projectedPoints[1].y - projectedPoints[0].y
        }, { x: 1, y: 0 });
      } else {
        var covXX = 0;
        var covXY = 0;
        var covYY = 0;
        for (var j = 0; j < projectedPoints.length; j++) {
          var dx = projectedPoints[j].x - centerX;
          var dy = projectedPoints[j].y - centerY;
          covXX += dx * dx;
          covXY += dx * dy;
          covYY += dy * dy;
        }
        var angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
        majorAxis = { x: Math.cos(angle), y: Math.sin(angle) };
      }
      majorAxis = normalizeVector(majorAxis, { x: 1, y: 0 });
      var minorAxis = { x: -majorAxis.y, y: majorAxis.x };

      var minU = Infinity;
      var maxU = -Infinity;
      var minV = Infinity;
      var maxV = -Infinity;
      for (var k = 0; k < projectedPoints.length; k++) {
        var offsetX = projectedPoints[k].x - centerX;
        var offsetY = projectedPoints[k].y - centerY;
        var u = offsetX * majorAxis.x + offsetY * majorAxis.y;
        var v = offsetX * minorAxis.x + offsetY * minorAxis.y;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }

      var semiMajor = Math.max((maxU - minU) / 2, 450);
      var semiMinor = Math.max((maxV - minV) / 2, 250);
      semiMajor += 350;
      semiMinor = Math.max(semiMinor + 250, semiMajor * 0.32);

      var offsetU = (minU + maxU) / 2;
      var offsetV = (minV + maxV) / 2;
      var ellipseCenter = {
        x: centerX + majorAxis.x * offsetU + minorAxis.x * offsetV,
        y: centerY + majorAxis.y * offsetU + minorAxis.y * offsetV
      };

      return {
        type: 'ellipse',
        center: unprojectEllipsePoint(ellipseCenter),
        centerProjected: ellipseCenter,
        majorAxis: majorAxis,
        minorAxis: minorAxis,
        semiMajor: semiMajor,
        semiMinor: semiMinor
      };
    }

    function buildEllipseLatLngs(geometry) {
      var latlngs = [];
      for (var i = 0; i < 72; i++) {
        var theta = (Math.PI * 2 * i) / 72;
        var x = geometry.centerProjected.x +
          geometry.majorAxis.x * Math.cos(theta) * geometry.semiMajor +
          geometry.minorAxis.x * Math.sin(theta) * geometry.semiMinor;
        var y = geometry.centerProjected.y +
          geometry.majorAxis.y * Math.cos(theta) * geometry.semiMajor +
          geometry.minorAxis.y * Math.sin(theta) * geometry.semiMinor;
        latlngs.push(unprojectEllipsePoint({ x: x, y: y }));
      }
      return latlngs;
    }

    function addEllipseOverlay(points, alerts) {
      if (!points.length) return;

      var geometry = buildEllipseGeometry(points);
      if (!geometry) return;

      var popupHtml = alerts.map(function(alert) {
        return alert.location + (alert.alertDate ? '<br><small>' + alert.alertDate + '</small>' : '');
      }).join('<hr style="border:none;border-top:1px solid #eee;margin:6px 0;">');

      var overlay;
      if (geometry.type === 'circle') {
        overlay = L.circle([geometry.center.lat, geometry.center.lng], {
          radius: geometry.radiusMeters,
          color: '#9922cc',
          weight: 2,
          opacity: 0.95,
          fillColor: '#9922cc',
          fillOpacity: 0.08
        });
      } else {
        overlay = L.polygon(buildEllipseLatLngs(geometry), {
          color: '#9922cc',
          weight: 2,
          opacity: 0.95,
          fillColor: '#9922cc',
          fillOpacity: 0.08
        });
      }

      overlay.bindPopup(popupHtml, { maxWidth: 260 });
      overlay.addTo(map);
      ellipseOverlays.push(overlay);
    }

    function flattenPolygonLatLngs(polygon) {
      var latlngs = polygon.getLatLngs();
      if (!latlngs || !latlngs.length) return [];
      if (Array.isArray(latlngs[0])) return latlngs[0];
      return latlngs;
    }

    function latLngsAlmostEqual(a, b) {
      return Math.abs(a.lat - b.lat) < 1e-8 && Math.abs(a.lng - b.lng) < 1e-8;
    }

    function orientation(a, b, c) {
      var val = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
      if (Math.abs(val) < 1e-12) return 0;
      return val > 0 ? 1 : -1;
    }

    function onSegment(a, b, p) {
      return Math.min(a.lng, b.lng) - 1e-12 <= p.lng && p.lng <= Math.max(a.lng, b.lng) + 1e-12 &&
        Math.min(a.lat, b.lat) - 1e-12 <= p.lat && p.lat <= Math.max(a.lat, b.lat) + 1e-12;
    }

    function segmentsTouch(a1, a2, b1, b2) {
      var o1 = orientation(a1, a2, b1);
      var o2 = orientation(a1, a2, b2);
      var o3 = orientation(b1, b2, a1);
      var o4 = orientation(b1, b2, a2);

      if (o1 !== o2 && o3 !== o4) return true;
      if (o1 === 0 && onSegment(a1, a2, b1)) return true;
      if (o2 === 0 && onSegment(a1, a2, b2)) return true;
      if (o3 === 0 && onSegment(b1, b2, a1)) return true;
      if (o4 === 0 && onSegment(b1, b2, a2)) return true;
      return false;
    }

    function polygonsTouch(nameA, nameB) {
      var locationPolygons = getLocationPolygons();
      var polyA = locationPolygons[nameA];
      var polyB = locationPolygons[nameB];
      if (!polyA || !polyB) return false;
      if (!polyA.getBounds().intersects(polyB.getBounds())) return false;

      var ptsA = flattenPolygonLatLngs(polyA);
      var ptsB = flattenPolygonLatLngs(polyB);
      if (ptsA.length < 2 || ptsB.length < 2) return false;

      for (var i = 0; i < ptsA.length; i++) {
        for (var j = 0; j < ptsB.length; j++) {
          if (latLngsAlmostEqual(ptsA[i], ptsB[j])) return true;
        }
      }

      for (var a = 0; a < ptsA.length; a++) {
        var a1 = ptsA[a];
        var a2 = ptsA[(a + 1) % ptsA.length];
        for (var b = 0; b < ptsB.length; b++) {
          var b1 = ptsB[b];
          var b2 = ptsB[(b + 1) % ptsB.length];
          if (segmentsTouch(a1, a2, b1, b2)) return true;
        }
      }

      return false;
    }

    function buildRedAlertClusters(redAlerts) {
      var byLocation = {};
      for (var i = 0; i < redAlerts.length; i++) {
        byLocation[redAlerts[i].location] = redAlerts[i];
      }

      var names = Object.keys(byLocation);
      var visited = {};
      var clusters = [];

      for (var n = 0; n < names.length; n++) {
        var start = names[n];
        if (visited[start]) continue;

        var queue = [start];
        visited[start] = true;
        var cluster = [];

        while (queue.length) {
          var current = queue.shift();
          cluster.push(byLocation[current]);
          for (var m = 0; m < names.length; m++) {
            var candidate = names[m];
            if (visited[candidate] || candidate === current) continue;
            if (polygonsTouch(current, candidate)) {
              visited[candidate] = true;
              queue.push(candidate);
            }
          }
        }

        clusters.push(cluster);
      }

      return clusters;
    }

    function drawEllipseOverlays(redAlerts, pointsMap) {
      clear();

      var missing = [];
      var clusters = buildRedAlertClusters(redAlerts);
      var icon = L.divIcon({
        className: 'ellipse-pin',
        html: '<div style="width:9px;height:9px;background:transparent;border:1px solid #fff;border-radius:50%;box-shadow:0 1px 6px rgba(0,0,0,0.4);box-sizing:border-box;"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      for (var c = 0; c < clusters.length; c++) {
        var placedPoints = [];
        for (var i = 0; i < clusters[c].length; i++) {
          var alert = clusters[c][i];
          var point = pointsMap[alert.location];
          if (!point || point.length < 2) {
            missing.push(alert.location);
            continue;
          }

          var marker = L.marker([point[0], point[1]], {
            icon: icon,
            keyboard: false
          });
          marker.bindPopup(alert.location + (alert.alertDate ? '<br>' + alert.alertDate : ''));
          marker.addTo(map);
          ellipseMarkers.push(marker);
          placedPoints.push({ lat: point[0], lng: point[1] });
        }
        addEllipseOverlay(placedPoints, clusters[c]);
      }
      return { missing: missing, clusterCount: clusters.length };
    }

    function render() {
      var redAlerts = getDisplayedRedAlerts();

      ensureOrefPoints().then(function(pointsMap) {
        if (redAlerts.length === 0) {
          clear();
          showToast('אין התרעות אדומות מוצגות');
        } else {
          var result = drawEllipseOverlays(redAlerts, pointsMap);
          if (result.missing.length > 0) {
            showToast('סומנו ' + result.clusterCount + ' אשכולות, חסרות נקודות עבור ' + result.missing.length + ' יישובים');
          } else {
            showToast('סומנו ' + result.clusterCount + ' אשכולות אדומים');
          }
        }
      }).catch(function(err) {
        clear();
        console.error('Failed to load oref_points.json:', err);
        showToast('שגיאה בטעינת נקודות התרעה');
      });
    }

    return {
      clear: clear,
      render: render,
      isLiveMode: function() { return getIsLiveMode(); },
      currentViewTime: function() { return getCurrentViewTime(); }
    };
  };
})();

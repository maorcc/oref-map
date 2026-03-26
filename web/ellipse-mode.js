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
    var ellipseCircles = [];

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
      for (var j = 0; j < ellipseCircles.length; j++) {
        map.removeLayer(ellipseCircles[j]);
      }
      ellipseCircles = [];
    }

    function projectEllipsePoint(point) {
      var projected = map.options.crs.project(L.latLng(point.lat, point.lng));
      return { x: projected.x, y: projected.y, lat: point.lat, lng: point.lng };
    }

    function circleRadiusMeters(circle, point) {
      return map.distance([circle.center.lat, circle.center.lng], [point.lat, point.lng]);
    }

    function pointInCircle(point, circle) {
      if (!circle) return false;
      var dx = point.x - circle.cx;
      var dy = point.y - circle.cy;
      return (dx * dx + dy * dy) <= (circle.r2 + 1e-12);
    }

    function circleFromTwoPoints(a, b) {
      var cx = (a.x + b.x) / 2;
      var cy = (a.y + b.y) / 2;
      var dx = a.x - cx;
      var dy = a.y - cy;
      var centerLatLng = map.options.crs.unproject(L.point(cx, cy));
      return {
        cx: cx,
        cy: cy,
        r2: dx * dx + dy * dy,
        center: { lat: centerLatLng.lat, lng: centerLatLng.lng }
      };
    }

    function circleFromThreePoints(a, b, c) {
      var ax = a.x, ay = a.y;
      var bx = b.x, by = b.y;
      var cx = c.x, cy = c.y;
      var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

      if (Math.abs(d) < 1e-12) {
        var candidates = [
          circleFromTwoPoints(a, b),
          circleFromTwoPoints(a, c),
          circleFromTwoPoints(b, c)
        ];
        var best = null;
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i];
          if (pointInCircle(a, candidate) && pointInCircle(b, candidate) && pointInCircle(c, candidate)) {
            if (!best || candidate.r2 < best.r2) best = candidate;
          }
        }
        return best;
      }

      var ux = (
        (ax * ax + ay * ay) * (by - cy) +
        (bx * bx + by * by) * (cy - ay) +
        (cx * cx + cy * cy) * (ay - by)
      ) / d;
      var uy = (
        (ax * ax + ay * ay) * (cx - bx) +
        (bx * bx + by * by) * (ax - cx) +
        (cx * cx + cy * cy) * (bx - ax)
      ) / d;
      var centerLatLng = map.options.crs.unproject(L.point(ux, uy));
      var dx = ax - ux;
      var dy = ay - uy;
      return {
        cx: ux,
        cy: uy,
        r2: dx * dx + dy * dy,
        center: { lat: centerLatLng.lat, lng: centerLatLng.lng }
      };
    }

    function shufflePoints(points) {
      var shuffled = points.slice();
      for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
      }
      return shuffled;
    }

    function minimalEnclosingCircle(points) {
      if (!points.length) return null;
      if (points.length === 1) {
        return {
          cx: points[0].x,
          cy: points[0].y,
          r2: 0,
          center: { lat: points[0].lat, lng: points[0].lng }
        };
      }

      var shuffled = shufflePoints(points);
      var circle = null;

      for (var i = 0; i < shuffled.length; i++) {
        var p = shuffled[i];
        if (circle && pointInCircle(p, circle)) continue;

        circle = {
          cx: p.x,
          cy: p.y,
          r2: 0,
          center: { lat: p.lat, lng: p.lng }
        };
        for (var j = 0; j < i; j++) {
          var q = shuffled[j];
          if (pointInCircle(q, circle)) continue;

          circle = circleFromTwoPoints(p, q);
          for (var k = 0; k < j; k++) {
            var r = shuffled[k];
            if (pointInCircle(r, circle)) continue;
            circle = circleFromThreePoints(p, q, r);
          }
        }
      }

      return circle;
    }

    function addEllipseCircle(points) {
      if (!points.length) return;

      var projectedPoints = points.map(projectEllipsePoint);
      var circle = minimalEnclosingCircle(projectedPoints);
      if (!circle) return;

      var radiusMeters = 0;
      for (var i = 0; i < points.length; i++) {
        radiusMeters = Math.max(radiusMeters, circleRadiusMeters(circle, points[i]));
      }

      ellipseCircles.push(L.circle([circle.center.lat, circle.center.lng], {
        radius: radiusMeters,
        color: '#9922cc',
        weight: 2,
        opacity: 0.95,
        fillColor: '#9922cc',
        fillOpacity: 0.06,
        interactive: false
      }).addTo(map));
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
        html: '<div style="width:16px;height:16px;background:#d00;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 6px rgba(0,0,0,0.4);"></div>',
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
        addEllipseCircle(placedPoints);
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

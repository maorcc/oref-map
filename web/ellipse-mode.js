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
    var ellipseVisualLayers = [];
    var enabled = false;
    var lastRenderKey = '';
    var displayMode = 0;

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
      clearExtendedVisual();
    }

    function formatPercent(ratio) {
      if (ratio === null || !Number.isFinite(ratio)) return 'N/A';
      return Math.round(ratio * 100) + '%';
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, function(ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
      });
    }

    function clearExtendedVisual() {
      for (var i = 0; i < ellipseVisualLayers.length; i++) {
        map.removeLayer(ellipseVisualLayers[i]);
      }
      ellipseVisualLayers = [];
    }

    function drawExtendedVisual(cluster, userPos) {
      if (!cluster || !cluster.geometry || !userPos) return;
      clearExtendedVisual();

      var centerLatLng = [cluster.geometry.center.lat, cluster.geometry.center.lng];
      var userLatLng = [userPos.lat, userPos.lng];
      var midLatLng = [
        (centerLatLng[0] + userLatLng[0]) / 2,
        (centerLatLng[1] + userLatLng[1]) / 2
      ];

      var centerMarker = L.circleMarker(centerLatLng, {
        radius: 6,
        color: '#1d4ed8',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1
      }).addTo(map);

      var connectionLine = L.polyline([centerLatLng, userLatLng], {
        color: '#1d4ed8',
        weight: 2,
        opacity: 0.9,
        dashArray: '6 6'
      }).addTo(map);

      var ratioLabel = L.marker(midLatLng, {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: '<div style="background:rgba(255,255,255,0.96);border:1px solid #93c5fd;border-radius:12px;padding:4px 8px;color:#1d4ed8;font:12px Arial,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.15);">' +
            escapeHtml(formatPercent(cluster.normalizedDistanceRatio)) + '</div>',
          iconSize: null
        })
      }).addTo(map);

      ellipseVisualLayers.push(centerMarker, connectionLine, ratioLabel);
    }

    function buildRenderKey(redAlerts) {
      if (!redAlerts.length) return '';
      return redAlerts.map(function(alert) {
        return [
          alert.location || '',
          alert.title || '',
          alert.alertDate || ''
        ].join('|');
      }).join('||');
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

    function geometryContainsLatLng(geometry, latlng) {
      if (!geometry || !latlng) return false;
      if (geometry.type === 'circle') {
        return map.distance(
          [geometry.center.lat, geometry.center.lng],
          [latlng.lat, latlng.lng]
        ) <= geometry.radiusMeters;
      }

      var projected = projectEllipsePoint({ lat: latlng.lat, lng: latlng.lng });
      var dx = projected.x - geometry.centerProjected.x;
      var dy = projected.y - geometry.centerProjected.y;
      var u = dx * geometry.majorAxis.x + dy * geometry.majorAxis.y;
      var v = dx * geometry.minorAxis.x + dy * geometry.minorAxis.y;
      var ellipseEq =
        (u * u) / (geometry.semiMajor * geometry.semiMajor) +
        (v * v) / (geometry.semiMinor * geometry.semiMinor);
      return ellipseEq <= 1;
    }

    function getGeometryPositionMetrics(geometry, latlng) {
      if (!geometry || !latlng) return null;
      if (geometry.type === 'circle') {
        var distanceMeters = map.distance(
          [geometry.center.lat, geometry.center.lng],
          [latlng.lat, latlng.lng]
        );
        return {
          centerDistanceMeters: distanceMeters,
          normalizedDistanceRatio: geometry.radiusMeters > 0 ? distanceMeters / geometry.radiusMeters : null
        };
      }

      var projected = projectEllipsePoint({ lat: latlng.lat, lng: latlng.lng });
      var dx = projected.x - geometry.centerProjected.x;
      var dy = projected.y - geometry.centerProjected.y;
      var u = dx * geometry.majorAxis.x + dy * geometry.majorAxis.y;
      var v = dx * geometry.minorAxis.x + dy * geometry.minorAxis.y;
      var normalizedDistanceRatio = Math.sqrt(
        (u * u) / (geometry.semiMajor * geometry.semiMajor) +
        (v * v) / (geometry.semiMinor * geometry.semiMinor)
      );

      return {
        centerDistanceMeters: map.distance(
          [geometry.center.lat, geometry.center.lng],
          [latlng.lat, latlng.lng]
        ),
        normalizedDistanceRatio: normalizedDistanceRatio
      };
    }

    function buildClusterLabel(cluster) {
      if (!cluster.length) return '';
      if (cluster.length === 1) return cluster[0].location;
      return cluster[0].location + ' +' + (cluster.length - 1);
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

    function polygonRings(polygon) {
      var latlngs = polygon.getLatLngs();
      if (!latlngs || !latlngs.length) return [];
      if (Array.isArray(latlngs[0])) return latlngs;
      return [latlngs];
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

    function ringContainsPoint(ring, point) {
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i];
        var b = ring[j];
        if (orientation(a, b, point) === 0 && onSegment(a, b, point)) return true;
        var intersects = ((a.lat > point.lat) !== (b.lat > point.lat)) &&
          (point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng);
        if (intersects) inside = !inside;
      }
      return inside;
    }

    function polygonContainsPoint(rings, point) {
      if (!rings.length || rings[0].length < 3) return false;
      if (!ringContainsPoint(rings[0], point)) return false;
      for (var i = 1; i < rings.length; i++) {
        if (rings[i].length >= 3 && ringContainsPoint(rings[i], point)) return false;
      }
      return true;
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

      var ringsA = polygonRings(polyA);
      var ringsB = polygonRings(polyB);
      if (!ringsA.length || !ringsB.length) return false;

      for (var ra = 0; ra < ringsA.length; ra++) {
        for (var rb = 0; rb < ringsB.length; rb++) {
          var ptsA = ringsA[ra];
          var ptsB = ringsB[rb];
          for (var i = 0; i < ptsA.length; i++) {
            for (var j = 0; j < ptsB.length; j++) {
              if (latLngsAlmostEqual(ptsA[i], ptsB[j])) return true;
            }
          }
        }
      }

      for (var ra = 0; ra < ringsA.length; ra++) {
        for (var rb = 0; rb < ringsB.length; rb++) {
          var ptsA = ringsA[ra];
          var ptsB = ringsB[rb];
          for (var a = 0; a < ptsA.length; a++) {
            var a1 = ptsA[a];
            var a2 = ptsA[(a + 1) % ptsA.length];
            for (var b = 0; b < ptsB.length; b++) {
              var b1 = ptsB[b];
              var b2 = ptsB[(b + 1) % ptsB.length];
              if (segmentsTouch(a1, a2, b1, b2)) return true;
            }
          }
        }
      }

      var outerA = ringsA[0];
      var outerB = ringsB[0];
      for (var i = 0; i < outerA.length; i++) {
        if (polygonContainsPoint(ringsB, outerA[i])) return true;
      }
      for (var j = 0; j < outerB.length; j++) {
        if (polygonContainsPoint(ringsA, outerB[j])) return true;
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

    function buildUserEllipseAnalysis(userLatLng) {
      if (!enabled) {
        return Promise.resolve({
          enabled: false,
          hasAlerts: false,
          clusterCount: 0,
          totalAlerts: 0,
          clusters: []
        });
      }

      var redAlerts = getDisplayedRedAlerts();
      if (!redAlerts.length) {
        return Promise.resolve({
          enabled: true,
          hasAlerts: false,
          clusterCount: 0,
          totalAlerts: 0,
          clusters: []
        });
      }

      return ensureOrefPoints().then(function(pointsMap) {
        var clusters = buildRedAlertClusters(redAlerts);
        var reportClusters = [];

        for (var i = 0; i < clusters.length; i++) {
          var cluster = clusters[i];
          var placedPoints = [];
          var latestAlertDate = '';
          for (var j = 0; j < cluster.length; j++) {
            var alert = cluster[j];
            var point = pointsMap[alert.location];
            if (point && point.length >= 2) {
              placedPoints.push({ lat: point[0], lng: point[1] });
            }
            if (alert.alertDate && (!latestAlertDate || alert.alertDate > latestAlertDate)) {
              latestAlertDate = alert.alertDate;
            }
          }

          var geometry = buildEllipseGeometry(placedPoints);
          var positionMetrics = getGeometryPositionMetrics(geometry, userLatLng);
          var minDistanceMeters = Infinity;
          for (var k = 0; k < placedPoints.length; k++) {
            var distanceMeters = map.distance(
              [userLatLng.lat, userLatLng.lng],
              [placedPoints[k].lat, placedPoints[k].lng]
            );
            if (distanceMeters < minDistanceMeters) minDistanceMeters = distanceMeters;
          }

          reportClusters.push({
            label: buildClusterLabel(cluster),
            locations: cluster.map(function(alert) { return alert.location; }),
            locationCount: cluster.length,
            latestAlertDate: latestAlertDate,
            containsUser: geometryContainsLatLng(geometry, userLatLng),
            distanceMeters: Number.isFinite(minDistanceMeters) ? minDistanceMeters : null,
            geometry: geometry ? {
              type: geometry.type,
              center: {
                lat: geometry.center.lat,
                lng: geometry.center.lng
              },
              widthMeters: geometry.type === 'circle' ? geometry.radiusMeters * 2 : geometry.semiMajor * 2,
              heightMeters: geometry.type === 'circle' ? geometry.radiusMeters * 2 : geometry.semiMinor * 2
            } : null,
            centerDistanceMeters: positionMetrics ? positionMetrics.centerDistanceMeters : null,
            normalizedDistanceRatio: positionMetrics ? positionMetrics.normalizedDistanceRatio : null
          });
        }

        reportClusters.sort(function(a, b) {
          var distA = a.distanceMeters === null ? Infinity : a.distanceMeters;
          var distB = b.distanceMeters === null ? Infinity : b.distanceMeters;
          return distA - distB;
        });

        return {
          enabled: true,
          hasAlerts: reportClusters.length > 0,
          clusterCount: reportClusters.length,
          totalAlerts: redAlerts.length,
          insideClusterCount: reportClusters.filter(function(cluster) {
            return cluster.containsUser;
          }).length,
          nearestClusterDistanceMeters: reportClusters.length ? reportClusters[0].distanceMeters : null,
          clusters: reportClusters
        };
      });
    }

    function refreshExtendedVisual() {
      var getCurrentUserPosition = options.getCurrentUserPosition;
      var userPos = getCurrentUserPosition ? getCurrentUserPosition() : null;
      var shouldDraw = !!(enabled && displayMode === 2 && userPos);
      if (!shouldDraw) {
        clearExtendedVisual();
        return Promise.resolve();
      }

      return buildUserEllipseAnalysis(userPos).then(function(analysis) {
        var nearestCluster = analysis && analysis.clusters && analysis.clusters.length ? analysis.clusters[0] : null;
        if (!nearestCluster || !nearestCluster.geometry) {
          clearExtendedVisual();
          return;
        }
        drawExtendedVisual(nearestCluster, userPos);
      }).catch(function(err) {
        clearExtendedVisual();
        console.error('Failed to build ellipse visual:', err);
      });
    }

    function sync(force, opts) {
      if (!enabled) {
        clear();
        lastRenderKey = '';
        return Promise.resolve();
      }

      opts = opts || {};
      var redAlerts = getDisplayedRedAlerts();
      var renderKey = buildRenderKey(redAlerts);

      if (!force && renderKey === lastRenderKey) {
        return Promise.resolve();
      }

      return ensureOrefPoints().then(function(pointsMap) {
        if (redAlerts.length === 0) {
          clear();
          lastRenderKey = renderKey;
          if (opts.showToast) showToast('אין התרעות אדומות מוצגות');
        } else {
          var result = drawEllipseOverlays(redAlerts, pointsMap);
          lastRenderKey = renderKey;
          refreshExtendedVisual();
          if (result.missing.length > 0) {
            if (opts.showToast) showToast('סומנו ' + result.clusterCount + ' אשכולות, חסרות נקודות עבור ' + result.missing.length + ' יישובים');
          } else if (opts.showToast) {
            showToast('סומנו ' + result.clusterCount + ' אשכולות אדומים');
          }
        }
      }).catch(function(err) {
        clear();
        lastRenderKey = '';
        console.error('Failed to load oref_points.json:', err);
        if (opts.showToast) showToast('שגיאה בטעינת נקודות התרעה');
      });
    }

    function setEnabled(nextEnabled, opts) {
      enabled = !!nextEnabled;
      if (!enabled) {
        clear();
        lastRenderKey = '';
        return Promise.resolve();
      }
      return sync(true, opts);
    }

    function setDisplayMode(nextMode) {
      displayMode = nextMode;
      return refreshExtendedVisual();
    }

    return {
      clear: clear,
      render: function() { return setEnabled(true, { showToast: true }); },
      sync: sync,
      setEnabled: setEnabled,
      setDisplayMode: setDisplayMode,
      refreshExtendedVisual: refreshExtendedVisual,
      clearExtendedVisual: clearExtendedVisual,
      buildUserEllipseAnalysis: buildUserEllipseAnalysis,
      isEnabled: function() { return enabled; },
      getDisplayMode: function() { return displayMode; },
      isLiveMode: function() { return getIsLiveMode(); },
      currentViewTime: function() { return getCurrentViewTime(); }
    };
  };
})();

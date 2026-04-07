(function() {
  'use strict';

  // Module-level state — assigned in app:ready handler before createController() is called
  var map = null;
  var getLocationStates = function() { return {}; };
  var getLocationHistory = function() { return {}; };
  var getFeatureMap = function() { return {}; };
  var getCurrentUserPosition = function() { return null; };
  var getIsLiveMode = function() { return true; };
  var getCurrentViewTime = function() { return 0; };
  var showToast = function() {};

  function createController() {
    var MIN_ELLIPSE_CLUSTER_SIZE = 20;

    var ellipseMarkers = [];
    var ellipseOverlays = [];
    var ellipseVisualLayers = [];
    var enabled = false;
    var lastRenderKey = '';
    var polygonTouchCache = Object.create(null);
    var lastClusterTopologyKey = '';
    var lastClusterTopology = null;
    var lastBaseSummaryKey = '';
    var lastBaseSummaries = null;
    var lastSummaryKey = '';
    var lastSummaryUserKey = '';
    var lastSummaries = null;
    var ellipseOverridesByClusterKey = Object.create(null);
    var editingSession = null;
    var editingLayers = [];
    var editingControl = null;
    var suspendedMapInteractions = null;
    var activeHandleDrag = null;
    var editingSelectionState = null;
    var MIN_EDIT_SEMI_AXIS_METERS = 120;

    function haversineMeters(lat1, lng1, lat2, lng2) {
      var R = 6371008.8;
      var dLat = (lat2 - lat1) * Math.PI / 180;
      var dLng = (lng2 - lng1) * Math.PI / 180;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function featureBbox(feat) {
      var outer = feat.geometry.coordinates[0];
      var minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (var ci = 0; ci < outer.length; ci++) {
        var pt = outer[ci];
        if (pt[0] < minLng) minLng = pt[0];
        if (pt[0] > maxLng) maxLng = pt[0];
        if (pt[1] < minLat) minLat = pt[1];
        if (pt[1] > maxLat) maxLat = pt[1];
      }
      return { minLng: minLng, maxLng: maxLng, minLat: minLat, maxLat: maxLat };
    }

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
      return window.AppState.ensureOrefPoints();
    }

    function clear() {
      for (var i = 0; i < ellipseMarkers.length; i++) {
        ellipseMarkers[i].remove();
      }
      ellipseMarkers = [];
      ellipseOverlays = [];
      var overlaySrc = map.getSource('ellipse-overlays');
      if (overlaySrc) overlaySrc.setData({ type: 'FeatureCollection', features: [] });
      clearExtendedVisual();
    }

    function flushOverlaySource() {
      var src = map.getSource('ellipse-overlays');
      if (src) src.setData({ type: 'FeatureCollection', features: ellipseOverlays });
    }

    function formatPercent(ratio) {
      if (ratio === null || !Number.isFinite(ratio)) return 'N/A';
      return Math.round(ratio * 100) + '%';
    }

    function formatPercentAsScientificFraction(percentValue, fractionDigits) {
      if (percentValue === null || !Number.isFinite(percentValue)) return null;

      var normalizedValue = percentValue / 100;
      if (!Number.isFinite(normalizedValue)) return null;
      if (normalizedValue === 0) return '0E+00';

      var scientific = normalizedValue.toExponential(
        Number.isFinite(fractionDigits) ? fractionDigits : 2
      );
      var parts = scientific.split('e');
      if (parts.length !== 2) return scientific;

      var mantissa = String(parts[0]).split('.')[0];
      var exponent = Number(parts[1]);
      if (!Number.isFinite(exponent)) return scientific;

      var exponentSign = exponent >= 0 ? '+' : '-';
      var exponentDigits = String(Math.abs(exponent)).padStart(2, '0');
      return mantissa + 'E' + exponentSign + exponentDigits;
    }

    function clearExtendedVisual() {
      for (var i = 0; i < ellipseVisualLayers.length; i++) {
        if (ellipseVisualLayers[i] && typeof ellipseVisualLayers[i].remove === 'function') {
          ellipseVisualLayers[i].remove();
        }
      }
      ellipseVisualLayers = [];
      var src = map.getSource('ellipse-visual');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
    }

    function clearEditingLayers() {
      for (var i = 0; i < editingLayers.length; i++) {
        if (editingLayers[i] && typeof editingLayers[i].remove === 'function') {
          editingLayers[i].remove();
        }
      }
      editingLayers = [];
      var src = map.getSource('ellipse-editing');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
    }

    function removeEditingControl() {
      if (editingControl && editingControl.parentNode) {
        editingControl.parentNode.removeChild(editingControl);
      }
      editingControl = null;
    }

    function setEditingTextSelectionDisabled(disabled) {
      if (!document || !document.body) return;
      if (disabled) {
        if (!editingSelectionState) {
          editingSelectionState = {
            userSelect: document.body.style.userSelect,
            webkitUserSelect: document.body.style.webkitUserSelect
          };
        }
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        return;
      }

      if (!editingSelectionState) return;
      document.body.style.userSelect = editingSelectionState.userSelect;
      document.body.style.webkitUserSelect = editingSelectionState.webkitUserSelect;
      editingSelectionState = null;
    }

    function endActiveHandleDrag() {
      if (!activeHandleDrag) return;
      document.removeEventListener('mousemove', activeHandleDrag.onMouseMove, true);
      document.removeEventListener('mouseup', activeHandleDrag.onMouseUp, true);
      document.removeEventListener('touchmove', activeHandleDrag.onTouchMove, true);
      document.removeEventListener('touchend', activeHandleDrag.onTouchEnd, true);
      document.removeEventListener('touchcancel', activeHandleDrag.onTouchEnd, true);
      activeHandleDrag = null;
    }

    function suspendMapInteractions() {
      if (!map || suspendedMapInteractions) return;
      suspendedMapInteractions = {
        dragPan:         map.dragPan         && map.dragPan.isEnabled(),
        scrollZoom:      map.scrollZoom      && map.scrollZoom.isEnabled(),
        touchZoomRotate: map.touchZoomRotate && map.touchZoomRotate.isEnabled(),
        doubleClickZoom: map.doubleClickZoom && map.doubleClickZoom.isEnabled(),
        boxZoom:         map.boxZoom         && map.boxZoom.isEnabled(),
        keyboard:        map.keyboard        && map.keyboard.isEnabled()
      };
      if (suspendedMapInteractions.dragPan)         map.dragPan.disable();
      if (suspendedMapInteractions.scrollZoom)      map.scrollZoom.disable();
      if (suspendedMapInteractions.touchZoomRotate) map.touchZoomRotate.disable();
      if (suspendedMapInteractions.doubleClickZoom) map.doubleClickZoom.disable();
      if (suspendedMapInteractions.boxZoom)         map.boxZoom.disable();
      if (suspendedMapInteractions.keyboard)        map.keyboard.disable();
    }

    function resumeMapInteractions() {
      if (!map || !suspendedMapInteractions) return;
      if (suspendedMapInteractions.dragPan)         map.dragPan.enable();
      if (suspendedMapInteractions.scrollZoom)      map.scrollZoom.enable();
      if (suspendedMapInteractions.touchZoomRotate) map.touchZoomRotate.enable();
      if (suspendedMapInteractions.doubleClickZoom) map.doubleClickZoom.enable();
      if (suspendedMapInteractions.boxZoom)         map.boxZoom.enable();
      if (suspendedMapInteractions.keyboard)        map.keyboard.enable();
      suspendedMapInteractions = null;
    }

    function drawExtendedVisual(cluster, userPos) {
      if (!cluster || !cluster.geometry || !userPos) return;
      clearExtendedVisual();

      var centerLat = cluster.geometry.center.lat;
      var centerLng = cluster.geometry.center.lng;
      var userLat = userPos.lat;
      var userLng = userPos.lng;
      var midLat = (centerLat + userLat) / 2;
      var midLng = (centerLng + userLng) / 2;

      var features = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [centerLng, centerLat] },
          properties: { kind: 'center' }
        },
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [[centerLng, centerLat], [userLng, userLat]]
          },
          properties: { kind: 'line' }
        }
      ];
      var src = map.getSource('ellipse-visual');
      if (src) src.setData({ type: 'FeatureCollection', features: features });

      var labelEl = document.createElement('div');
      labelEl.style.cssText = 'background:rgba(255,255,255,0.96);border:1px solid #93c5fd;border-radius:12px;padding:4px 8px;color:#1d4ed8;font:12px Arial,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.15);pointer-events:none;';
      labelEl.textContent = formatPercent(cluster.normalizedDistanceRatio);
      var ratioMarker = new maplibregl.Marker({ element: labelEl, anchor: 'center' })
        .setLngLat([midLng, midLat])
        .addTo(map);

      ellipseVisualLayers.push(ratioMarker);
    }

    function isClusterEligibleForExtendedVisual(cluster) {
      return !!(
        cluster &&
        cluster.geometry &&
        Number.isFinite(cluster.normalizedDistanceRatio) &&
        cluster.normalizedDistanceRatio < 1.5
      );
    }

    function buildScaledGeometry(sourceGeometry, scaleRatio) {
      if (!sourceGeometry || !Number.isFinite(scaleRatio) || scaleRatio <= 0) return null;
      if (sourceGeometry.type === 'circle') {
        return {
          type: 'circle',
          center: sourceGeometry.center,
          radiusMeters: sourceGeometry.radiusMeters * scaleRatio
        };
      }

      return {
        type: 'ellipse',
        center: sourceGeometry.center,
        centerProjected: sourceGeometry.centerProjected,
        majorAxis: sourceGeometry.majorAxis,
        minorAxis: sourceGeometry.minorAxis,
        semiMajor: sourceGeometry.semiMajor * scaleRatio,
        semiMinor: sourceGeometry.semiMinor * scaleRatio
      };
    }

    function cloneGeometry(geometry) {
      if (!geometry) return null;
      if (geometry.type === 'circle') {
        return {
          type: 'circle',
          center: { lat: geometry.center.lat, lng: geometry.center.lng },
          radiusMeters: geometry.radiusMeters
        };
      }

      return {
        type: 'ellipse',
        center: { lat: geometry.center.lat, lng: geometry.center.lng },
        centerProjected: {
          x: geometry.centerProjected.x,
          y: geometry.centerProjected.y
        },
        majorAxis: { x: geometry.majorAxis.x, y: geometry.majorAxis.y },
        minorAxis: { x: geometry.minorAxis.x, y: geometry.minorAxis.y },
        semiMajor: geometry.semiMajor,
        semiMinor: geometry.semiMinor
      };
    }

    function getGeometryCircumferenceMeters(geometry) {
      if (!geometry) return null;
      if (geometry.type === 'circle') {
        return 2 * Math.PI * geometry.radiusMeters;
      }

      var a = geometry.semiMajor;
      var b = geometry.semiMinor;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
      var h = Math.pow(a - b, 2) / Math.pow(a + b, 2);
      return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    }

    function getGeometryArea(geometry) {
      if (!geometry) return 0;
      if (geometry.type === 'circle') {
        return Math.PI * geometry.radiusMeters * geometry.radiusMeters;
      }
      return Math.PI * geometry.semiMajor * geometry.semiMinor;
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

    function buildClusterTopologyKey(redAlerts) {
      if (!redAlerts.length) return '';
      return redAlerts.map(function(alert) {
        return alert.location || '';
      }).sort(function(a, b) {
        return a.localeCompare(b, 'he');
      }).join('||');
    }

    function buildClusterKey(locations) {
      if (!locations || !locations.length) return '';
      return locations.slice().sort(function(a, b) {
        return a.localeCompare(b, 'he');
      }).join('||');
    }

    function buildUserPositionKey(userLatLng) {
      if (!userLatLng) return '';
      return userLatLng.lat.toFixed(6) + ',' + userLatLng.lng.toFixed(6);
    }

    function projectEllipsePoint(point) {
      var x = point.lng * 20037508.34 / 180;
      var y = Math.log(Math.tan((90 + point.lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
      return { x: x, y: y, lat: point.lat, lng: point.lng };
    }

    function unprojectEllipsePoint(point) {
      return {
        lng: point.x * 180 / 20037508.34,
        lat: Math.atan(Math.exp(point.y * Math.PI / 20037508.34)) * 360 / Math.PI - 90
      };
    }

    function normalizeVector(vector, fallback) {
      var length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
      if (length < 1e-12) return fallback;
      return { x: vector.x / length, y: vector.y / length };
    }

    function erf(x) {
      if (!Number.isFinite(x)) return NaN;
      var sign = x < 0 ? -1 : 1;
      var absX = Math.abs(x);
      var t = 1 / (1 + 0.3275911 * absX);
      var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absX * absX);
      return sign * y;
    }

    function getDirectionalRadiusMeters(geometry, latlng) {
      if (!geometry || !latlng) return null;
      if (geometry.type === 'circle') {
        return Number.isFinite(geometry.radiusMeters) ? geometry.radiusMeters : null;
      }

      var projected = projectEllipsePoint({ lat: latlng.lat, lng: latlng.lng });
      var direction = normalizeVector({
        x: projected.x - geometry.centerProjected.x,
        y: projected.y - geometry.centerProjected.y
      }, geometry.majorAxis);
      if (!direction || !Number.isFinite(direction.x) || !Number.isFinite(direction.y)) return null;

      var dirU = direction.x * geometry.majorAxis.x + direction.y * geometry.majorAxis.y;
      var dirV = direction.x * geometry.minorAxis.x + direction.y * geometry.minorAxis.y;
      var denom =
        (dirU * dirU) / (geometry.semiMajor * geometry.semiMajor) +
        (dirV * dirV) / (geometry.semiMinor * geometry.semiMinor);
      if (!Number.isFinite(denom) || denom <= 0) return null;

      var boundaryScale = 1 / Math.sqrt(denom);
      if (!Number.isFinite(boundaryScale) || boundaryScale <= 0) return null;

      var boundaryPoint = {
        x: geometry.centerProjected.x + direction.x * boundaryScale,
        y: geometry.centerProjected.y + direction.y * boundaryScale
      };
      var boundaryLatLng = unprojectEllipsePoint(boundaryPoint);
      return haversineMeters(
        geometry.center.lat, geometry.center.lng,
        boundaryLatLng.lat, boundaryLatLng.lng
      );
    }

    function halfNormalCdf(x, sigma) {
      if (!Number.isFinite(x) || !Number.isFinite(sigma) || sigma <= 0) return null;
      if (x <= 0) return 0;
      return erf(x / (sigma * Math.SQRT2));
    }

    function getHomeAreaProbability(geometry, latlng, windowHalfWidthMeters, positionMetrics) {
      if (!geometry || !latlng || !Number.isFinite(windowHalfWidthMeters) || windowHalfWidthMeters < 0) return null;

      positionMetrics = positionMetrics || getGeometryPositionMetrics(geometry, latlng);
      if (!positionMetrics || !Number.isFinite(positionMetrics.centerDistanceMeters)) return null;

      var directionalRadiusMeters = getDirectionalRadiusMeters(geometry, latlng);
      if (!Number.isFinite(directionalRadiusMeters) || directionalRadiusMeters <= 0) return null;

      var q99 = 2.5758293035489004;
      var sigma = directionalRadiusMeters / q99;
      if (!Number.isFinite(sigma) || sigma <= 0) return null;

      var lower = Math.max(0, positionMetrics.centerDistanceMeters - windowHalfWidthMeters);
      var upper = positionMetrics.centerDistanceMeters + windowHalfWidthMeters;
      var lowerCdf = halfNormalCdf(lower, sigma);
      var upperCdf = halfNormalCdf(upper, sigma);
      if (lowerCdf === null || upperCdf === null) return null;

      return {
        centerDistanceMeters: positionMetrics.centerDistanceMeters,
        directionalRadiusMeters: directionalRadiusMeters,
        homeStripeProbability: upperCdf - lowerCdf
      };
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

    function getGeometryAxisAnchorLatLng(geometry, axisName, directionSign) {
      if (!geometry || geometry.type !== 'ellipse') return null;
      var axisVector = axisName === 'major' ? geometry.majorAxis : geometry.minorAxis;
      var semiAxis = axisName === 'major' ? geometry.semiMajor : geometry.semiMinor;
      var anchorPoint = {
        x: geometry.centerProjected.x + axisVector.x * semiAxis * directionSign,
        y: geometry.centerProjected.y + axisVector.y * semiAxis * directionSign
      };
      var latlng = unprojectEllipsePoint(anchorPoint);
      return { lat: latlng.lat, lng: latlng.lng };
    }

    function getEffectiveGeometry(summary) {
      if (!summary) return null;
      if (editingSession && editingSession.clusterKey === summary.clusterKey && editingSession.draftGeometry) {
        return editingSession.draftGeometry;
      }
      return ellipseOverridesByClusterKey[summary.clusterKey] || summary.sourceGeometry;
    }

    function buildGeometryGeoJsonFeature(geometry, style) {
      var coords;
      if (geometry.type === 'circle') {
        var ring = [];
        var cp = projectEllipsePoint(geometry.center);
        for (var i = 0; i < 72; i++) {
          var theta = (Math.PI * 2 * i) / 72;
          var x = cp.x + Math.cos(theta) * geometry.radiusMeters;
          var y = cp.y + Math.sin(theta) * geometry.radiusMeters;
          var ll = unprojectEllipsePoint({ x: x, y: y });
          ring.push([ll.lng, ll.lat]);
        }
        ring.push(ring[0]);
        coords = [ring];
      } else {
        var pts = buildEllipseLatLngs(geometry);
        var poly = pts.map(function(ll) { return [ll.lng, ll.lat]; });
        poly.push(poly[0]);
        coords = [poly];
      }
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: coords },
        properties: {
          strokeColor: style.color,
          strokeWidth: style.weight,
          strokeOpacity: style.opacity,
          fillColor: style.fillColor,
          fillOpacity: style.fillOpacity,
          dashArray: style.dashArray || null
        }
      };
    }

    function addGeometryOverlay(geometry, style) {
      if (!geometry) return null;
      return buildGeometryGeoJsonFeature(geometry, style);
    }

    function geometryContainsLatLng(geometry, latlng) {
      if (!geometry || !latlng) return false;
      if (geometry.type === 'circle') {
        return haversineMeters(
          geometry.center.lat, geometry.center.lng,
          latlng.lat, latlng.lng
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
        var distanceMeters = haversineMeters(
          geometry.center.lat, geometry.center.lng,
          latlng.lat, latlng.lng
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
        centerDistanceMeters: haversineMeters(
          geometry.center.lat, geometry.center.lng,
          latlng.lat, latlng.lng
        ),
        normalizedDistanceRatio: normalizedDistanceRatio
      };
    }

    function buildClusterLabel(cluster) {
      if (!cluster.length) return '';
      if (cluster.length === 1) return cluster[0].location;
      return cluster[0].location + ' +' + (cluster.length - 1);
    }

    function shouldSkipCluster(cluster) {
      return !cluster || cluster.length < MIN_ELLIPSE_CLUSTER_SIZE;
    }

    function addClusterGeometryOverlay(geometry, summary) {
      if (!geometry) return null;

      var feature = addGeometryOverlay(geometry, {
        color: '#951111',
        weight: 2,
        opacity: 0.95,
        fillColor: '#951111',
        fillOpacity: 0.08
      });
      if (feature && summary && Array.isArray(summary.locations) && summary.locations.length) {
        feature.properties.clusterKey = summary.clusterKey || '';
        feature.properties.locations = summary.locations.join('||');
      }
      if (feature) ellipseOverlays.push(feature);
      return feature;
    }

    function polygonRings(feature) {
      if (!feature || !feature.geometry || !feature.geometry.coordinates) return [];
      return feature.geometry.coordinates.map(function(ring) {
        return ring.map(function(c) { return { lat: c[1], lng: c[0] }; });
      });
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
      var cacheKey = nameA < nameB ? nameA + '||' + nameB : nameB + '||' + nameA;
      if (Object.prototype.hasOwnProperty.call(polygonTouchCache, cacheKey)) {
        return polygonTouchCache[cacheKey];
      }

      var featureMap = getFeatureMap();
      var polyA = featureMap[nameA];
      var polyB = featureMap[nameB];
      if (!polyA || !polyB) {
        polygonTouchCache[cacheKey] = false;
        return false;
      }
      var bboxA = featureBbox(polyA);
      var bboxB = featureBbox(polyB);
      if (bboxA.maxLng < bboxB.minLng || bboxB.maxLng < bboxA.minLng ||
          bboxA.maxLat < bboxB.minLat || bboxB.maxLat < bboxA.minLat) {
        polygonTouchCache[cacheKey] = false;
        return false;
      }

      var ringsA = polygonRings(polyA);
      var ringsB = polygonRings(polyB);
      if (!ringsA.length || !ringsB.length) {
        polygonTouchCache[cacheKey] = false;
        return false;
      }

      for (var ra = 0; ra < ringsA.length; ra++) {
        for (var rb = 0; rb < ringsB.length; rb++) {
          var ptsA = ringsA[ra];
          var ptsB = ringsB[rb];
          for (var i = 0; i < ptsA.length; i++) {
            for (var j = 0; j < ptsB.length; j++) {
              if (latLngsAlmostEqual(ptsA[i], ptsB[j])) {
                polygonTouchCache[cacheKey] = true;
                return true;
              }
            }
          }
        }
      }

      for (ra = 0; ra < ringsA.length; ra++) {
        for (rb = 0; rb < ringsB.length; rb++) {
          ptsA = ringsA[ra];
          ptsB = ringsB[rb];
          for (var a = 0; a < ptsA.length; a++) {
            var a1 = ptsA[a];
            var a2 = ptsA[(a + 1) % ptsA.length];
            for (var b = 0; b < ptsB.length; b++) {
              var b1 = ptsB[b];
              var b2 = ptsB[(b + 1) % ptsB.length];
              if (segmentsTouch(a1, a2, b1, b2)) {
                polygonTouchCache[cacheKey] = true;
                return true;
              }
            }
          }
        }
      }

      var outerA = ringsA[0];
      var outerB = ringsB[0];
      for (var i = 0; i < outerA.length; i++) {
        if (polygonContainsPoint(ringsB, outerA[i])) {
          polygonTouchCache[cacheKey] = true;
          return true;
        }
      }
      for (var j = 0; j < outerB.length; j++) {
        if (polygonContainsPoint(ringsA, outerB[j])) {
          polygonTouchCache[cacheKey] = true;
          return true;
        }
      }

      polygonTouchCache[cacheKey] = false;
      return false;
    }

    function buildRedAlertClusters(redAlerts) {
      var topologyKey = buildClusterTopologyKey(redAlerts);
      var byLocation = {};
      for (var i = 0; i < redAlerts.length; i++) {
        byLocation[redAlerts[i].location] = redAlerts[i];
      }

      if (topologyKey && topologyKey === lastClusterTopologyKey && lastClusterTopology) {
        return lastClusterTopology.map(function(clusterNames) {
          return clusterNames.map(function(name) {
            return byLocation[name];
          }).filter(Boolean);
        });
      }

      var names = Object.keys(byLocation);
      var visited = {};
      var clusterNamesList = [];

      for (var n = 0; n < names.length; n++) {
        var start = names[n];
        if (visited[start]) continue;

        var queue = [start];
        visited[start] = true;
        var clusterNames = [];

        while (queue.length) {
          var current = queue.shift();
          clusterNames.push(current);
          for (var m = 0; m < names.length; m++) {
            var candidate = names[m];
            if (visited[candidate] || candidate === current) continue;
            if (polygonsTouch(current, candidate)) {
              visited[candidate] = true;
              queue.push(candidate);
            }
          }
        }

        clusterNamesList.push(clusterNames);
      }

      lastClusterTopologyKey = topologyKey;
      lastClusterTopology = clusterNamesList;

      return clusterNamesList.map(function(clusterNames) {
        return clusterNames.map(function(name) {
          return byLocation[name];
        }).filter(Boolean);
      });
    }

    function buildBaseClusterGeometrySummaries(redAlerts, pointsMap) {
      var baseSummaryKey = buildRenderKey(redAlerts);
      if (baseSummaryKey && baseSummaryKey === lastBaseSummaryKey && lastBaseSummaries) {
        return lastBaseSummaries;
      }

      var clusters = buildRedAlertClusters(redAlerts);
      var summaries = [];

      for (var i = 0; i < clusters.length; i++) {
        var cluster = clusters[i];
        if (shouldSkipCluster(cluster)) continue;

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

        summaries.push({
          clusterKey: buildClusterKey(cluster.map(function(alert) { return alert.location; })),
          label: buildClusterLabel(cluster),
          locations: cluster.map(function(alert) { return alert.location; }),
          locationCount: cluster.length,
          latestAlertDate: latestAlertDate,
          sourceGeometry: buildEllipseGeometry(placedPoints)
        });
      }

      lastBaseSummaryKey = baseSummaryKey;
      lastBaseSummaries = summaries;
      return summaries;
    }

    function drawEllipseOverlays(redAlerts, pointsMap) {
      clear();

      var missing = [];
      var summaries = buildBaseClusterGeometrySummaries(redAlerts, pointsMap);
      var renderedClusterCount = 0;
      var pinHtml = '<div style="width:9px;height:9px;background:transparent;border:1px solid #fff;border-radius:50%;box-shadow:0 1px 6px rgba(0,0,0,0.4);box-sizing:border-box;"></div>';

      for (var c = 0; c < summaries.length; c++) {
        var summary = summaries[c];
        for (var i = 0; i < summary.locations.length; i++) {
          var location = summary.locations[i];
          var point = pointsMap[location];
          if (!point || point.length < 2) {
            missing.push(location);
            continue;
          }

          var pinEl = document.createElement('div');
          pinEl.className = 'ellipse-pin';
          pinEl.innerHTML = pinHtml;
          pinEl.style.cursor = 'pointer';
          pinEl.addEventListener('click', (function(loc) {
            return function(event) {
              event.stopPropagation();
              if (window.AppState && typeof window.AppState.openLocationPanel === 'function') {
                window.AppState.openLocationPanel(loc);
              }
            };
          })(location));

          var marker = new maplibregl.Marker({ element: pinEl, anchor: 'center' })
            .setLngLat([point[1], point[0]])
            .addTo(map);
          ellipseMarkers.push(marker);
        }
        if (!getEffectiveGeometry(summary)) {
          continue;
        }
        renderedClusterCount += 1;
        if (editingSession && editingSession.clusterKey === summary.clusterKey) {
          continue;
        }
        addClusterGeometryOverlay(getEffectiveGeometry(summary), summary);
      }
      flushOverlaySource();
      return { missing: missing, clusterCount: renderedClusterCount };
    }

    function buildClusterGeometrySummaries(redAlerts, pointsMap, userLatLng) {
      var summaryKey = buildRenderKey(redAlerts);
      var summaryUserKey = buildUserPositionKey(userLatLng);
      if (summaryKey && summaryKey === lastSummaryKey && summaryUserKey === lastSummaryUserKey && lastSummaries) {
        return lastSummaries;
      }

      var baseSummaries = buildBaseClusterGeometrySummaries(redAlerts, pointsMap);
      var summaries = baseSummaries.map(function(summary) {
        var minDistanceMeters = Infinity;

        if (userLatLng) {
          for (var i = 0; i < summary.locations.length; i++) {
            var point = pointsMap[summary.locations[i]];
            if (!point || point.length < 2) continue;
            var distanceMeters = haversineMeters(
              userLatLng.lat, userLatLng.lng,
              point[0], point[1]
            );
            if (distanceMeters < minDistanceMeters) minDistanceMeters = distanceMeters;
          }
        }

        return {
          clusterKey: summary.clusterKey,
          label: summary.label,
          locations: summary.locations,
          locationCount: summary.locationCount,
          latestAlertDate: summary.latestAlertDate,
          distanceMeters: Number.isFinite(minDistanceMeters) ? minDistanceMeters : null,
          sourceGeometry: summary.sourceGeometry
        };
      });

      summaries.sort(function(a, b) {
        var distA = a.distanceMeters === null ? Infinity : a.distanceMeters;
        var distB = b.distanceMeters === null ? Infinity : b.distanceMeters;
        return distA - distB;
      });

      lastSummaryKey = summaryKey;
      lastSummaryUserKey = summaryUserKey;
      lastSummaries = summaries;
      return summaries;
    }

    function buildClusterReportEntry(summary, userLatLng) {
      var effectiveGeometry = getEffectiveGeometry(summary);
      var positionMetrics = getGeometryPositionMetrics(effectiveGeometry, userLatLng);

      return {
        clusterKey: summary.clusterKey,
        label: summary.label,
        locations: summary.locations,
        locationCount: summary.locationCount,
        latestAlertDate: summary.latestAlertDate,
        containsUser: geometryContainsLatLng(effectiveGeometry, userLatLng),
        distanceMeters: summary.distanceMeters,
        geometry: effectiveGeometry ? {
          type: effectiveGeometry.type,
          center: {
            lat: effectiveGeometry.center.lat,
            lng: effectiveGeometry.center.lng
          },
          widthMeters: effectiveGeometry.type === 'circle'
            ? effectiveGeometry.radiusMeters * 2
            : effectiveGeometry.semiMajor * 2,
          heightMeters: effectiveGeometry.type === 'circle'
            ? effectiveGeometry.radiusMeters * 2
            : effectiveGeometry.semiMinor * 2
        } : null,
        sourceGeometry: effectiveGeometry,
        centerDistanceMeters: positionMetrics ? positionMetrics.centerDistanceMeters : null,
        normalizedDistanceRatio: positionMetrics ? positionMetrics.normalizedDistanceRatio : null,
        directionalRadiusMeters: null,
        homeStripeProbability: null,
        homeEllipseCircumferenceMeters: null,
        homeStripePerCircumferenceProbability: null
      };
    }

    function normalizeHorizonAngleDegrees(angleDegrees) {
      while (angleDegrees > 90) angleDegrees -= 180;
      while (angleDegrees <= -90) angleDegrees += 180;
      return Math.round(angleDegrees * 10) / 10;
    }

    function formatMeters(meters) {
      return Math.round(meters).toLocaleString('en-US') + ' m';
    }

    function formatCenterPoint(lat, lng) {
      return '(' + lat.toFixed(3) + ', ' + lng.toFixed(3) + ')';
    }

    function buildEllipseInfoEntry(summary) {
      if (!summary) return null;

      var geometry = getEffectiveGeometry(summary);
      if (!geometry) return null;
      if (geometry.type === 'circle') {
        return {
          locationCount: summary.locationCount,
          center: formatCenterPoint(geometry.center.lat, geometry.center.lng),
          majorAxisLength: formatMeters(geometry.radiusMeters * 2),
          minorAxisLength: formatMeters(geometry.radiusMeters * 2),
          majorAxisHorizontalAngle: '0.0°'
        };
      }

      return {
        locationCount: summary.locationCount,
        center: formatCenterPoint(geometry.center.lat, geometry.center.lng),
        majorAxisLength: formatMeters(geometry.semiMajor * 2),
        minorAxisLength: formatMeters(geometry.semiMinor * 2),
        majorAxisHorizontalAngle:
          normalizeHorizonAngleDegrees(
            Math.atan2(geometry.majorAxis.y, geometry.majorAxis.x) * 180 / Math.PI
          ).toFixed(1) + '\u00B0'
      };
    }

    function printEllipsesInfos() {
      if (!enabled) {
        console.log('Ellipse mode is disabled, so there are no displayed ellipses.');
        return Promise.resolve([]);
      }

      var redAlerts = getDisplayedRedAlerts();
      if (!redAlerts.length) {
        console.log('No red alerts are currently displayed.');
        return Promise.resolve([]);
      }

      return ensureOrefPoints().then(function(pointsMap) {
        var summaries = buildBaseClusterGeometrySummaries(redAlerts, pointsMap);
        var infos = summaries.map(buildEllipseInfoEntry).filter(Boolean);
        console.log(JSON.stringify(infos, null, 2));
        return infos;
      });
    }

    function syncEditingMarkersFromDraft(activeAnchorName) {
      if (!editingSession || !editingSession.draftGeometry || editingSession.draftGeometry.type !== 'ellipse') return;

      var geometry = editingSession.draftGeometry;
      if (editingSession.overlay) {
        var lls = buildEllipseLatLngs(geometry);
        var coords = lls.map(function(ll) { return [ll.lng, ll.lat]; });
        coords.push(coords[0]);
        var editingSrc = map.getSource('ellipse-editing');
        if (editingSrc) editingSrc.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [coords] },
            properties: {}
          }]
        });
      }
      if (editingSession.centerMarker && activeAnchorName !== 'center') {
        editingSession.centerMarker.setLatLng([geometry.center.lat, geometry.center.lng]);
      }
      if (editingSession.majorPositiveMarker && activeAnchorName !== 'majorPositive') {
        editingSession.majorPositiveMarker.setLatLng(getGeometryAxisAnchorLatLng(geometry, 'major', 1));
      }
      if (editingSession.majorNegativeMarker && activeAnchorName !== 'majorNegative') {
        editingSession.majorNegativeMarker.setLatLng(getGeometryAxisAnchorLatLng(geometry, 'major', -1));
      }
      if (editingSession.minorPositiveMarker && activeAnchorName !== 'minorPositive') {
        editingSession.minorPositiveMarker.setLatLng(getGeometryAxisAnchorLatLng(geometry, 'minor', 1));
      }
      if (editingSession.minorNegativeMarker && activeAnchorName !== 'minorNegative') {
        editingSession.minorNegativeMarker.setLatLng(getGeometryAxisAnchorLatLng(geometry, 'minor', -1));
      }
    }

    function applyCenterDrag(latlng) {
      if (!editingSession || !editingSession.draftGeometry || editingSession.draftGeometry.type !== 'ellipse') return;
      var projected = projectEllipsePoint(latlng);
      editingSession.draftGeometry.center = { lat: latlng.lat, lng: latlng.lng };
      editingSession.draftGeometry.centerProjected = { x: projected.x, y: projected.y };
      syncEditingMarkersFromDraft('center');
    }

    function applyAxisDrag(axisName, directionSign, latlng) {
      if (!editingSession || !editingSession.draftGeometry || editingSession.draftGeometry.type !== 'ellipse') return;

      var projected = projectEllipsePoint(latlng);
      var geometry = editingSession.draftGeometry;
      var direction = normalizeVector({
        x: (projected.x - geometry.centerProjected.x) * directionSign,
        y: (projected.y - geometry.centerProjected.y) * directionSign
      }, axisName === 'major' ? geometry.majorAxis : geometry.minorAxis);
      var distance = Math.sqrt(
        Math.pow(projected.x - geometry.centerProjected.x, 2) +
        Math.pow(projected.y - geometry.centerProjected.y, 2)
      );
      var nextSemiAxis = Math.max(distance, MIN_EDIT_SEMI_AXIS_METERS);

      if (axisName === 'major') {
        geometry.majorAxis = direction;
        geometry.minorAxis = { x: -direction.y, y: direction.x };
        geometry.semiMajor = nextSemiAxis;
      } else {
        geometry.minorAxis = direction;
        geometry.majorAxis = { x: direction.y, y: -direction.x };
        geometry.semiMinor = nextSemiAxis;
      }

      syncEditingMarkersFromDraft(
        axisName + (directionSign > 0 ? 'Positive' : 'Negative')
      );
    }

    function createEditAnchorIcon(fillColor, borderColor, size) {
      return '<div style="' +
        'width:' + size + 'px;' +
        'height:' + size + 'px;' +
        'border-radius:50%;' +
        'background:' + fillColor + ';' +
        'border:2px solid ' + borderColor + ';' +
        'box-shadow:0 1px 6px rgba(0,0,0,0.25);' +
        'box-sizing:border-box;' +
        '"></div>';
    }

    function normalizeHandleLatLng(latlng) {
      if (!latlng) return null;
      if (Array.isArray(latlng) && latlng.length >= 2) {
        return { lat: latlng[0], lng: latlng[1] };
      }
      if (Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)) {
        return { lat: latlng.lat, lng: latlng.lng };
      }
      return null;
    }

    function createEditableHandle(latlng, iconHtml, onDrag) {
      var mapContainer = map.getContainer();
      var element = document.createElement('div');
      element.style.position = 'absolute';
      element.style.zIndex = '900';
      element.style.cursor = 'grab';
      element.style.pointerEvents = 'auto';
      element.innerHTML = iconHtml || '';
      mapContainer.appendChild(element);

      var handle = {
        _latlng: normalizeHandleLatLng(latlng),
        setLatLng: function(nextLatLng) {
          var normalized = normalizeHandleLatLng(nextLatLng);
          if (!normalized) return;
          this._latlng = normalized;
          var point = map.project([normalized.lng, normalized.lat]);
          element.style.left = point.x + 'px';
          element.style.top = point.y + 'px';
          element.style.transform = 'translate(-50%, -50%)';
        },
        getLatLng: function() {
          return { lat: this._latlng.lat, lng: this._latlng.lng };
        },
        remove: function() {
          endActiveHandleDrag();
          map.off('zoom', syncPosition);
          map.off('move', syncPosition);
          map.off('resize', syncPosition);
          element.removeEventListener('mousedown', beginHandleDrag, true);
          element.removeEventListener('touchstart', beginHandleDrag, true);
          if (element.parentNode) element.parentNode.removeChild(element);
        }
      };

      function pointEventToLatLng(event) {
        var source = event.touches && event.touches.length ? event.touches[0] : event;
        var rect = mapContainer.getBoundingClientRect();
        var px = source.clientX - rect.left;
        var py = source.clientY - rect.top;
        return map.unproject([px, py]);
      }

      function syncPosition() {
        handle.setLatLng(handle._latlng);
      }

      function finishHandleDrag(finishEvent) {
        element.style.cursor = 'grab';
        if (finishEvent) {
          finishEvent.preventDefault();
          if (finishEvent.stopPropagation) finishEvent.stopPropagation();
        }
        resumeMapInteractions();
        endActiveHandleDrag();
      }

      function moveHandleDrag(moveEvent) {
        var nextLatLng = pointEventToLatLng(moveEvent);
        handle.setLatLng(nextLatLng);
        onDrag(nextLatLng);
        moveEvent.preventDefault();
        if (moveEvent.stopPropagation) moveEvent.stopPropagation();
      }

      function beginHandleDrag(event) {
        if (activeHandleDrag) endActiveHandleDrag();
        suspendMapInteractions();
        element.style.cursor = 'grabbing';
        activeHandleDrag = {
          onMouseMove: moveHandleDrag,
          onMouseUp: finishHandleDrag,
          onTouchMove: moveHandleDrag,
          onTouchEnd: finishHandleDrag
        };
        document.addEventListener('mousemove', moveHandleDrag, true);
        document.addEventListener('mouseup', finishHandleDrag, true);
        document.addEventListener('touchmove', moveHandleDrag, true);
        document.addEventListener('touchend', finishHandleDrag, true);
        document.addEventListener('touchcancel', finishHandleDrag, true);
        event.preventDefault();
        event.stopPropagation();
      }

      element.addEventListener('click', function(e) { e.stopPropagation(); });
      element.addEventListener('wheel', function(e) { e.stopPropagation(); });
      element.addEventListener('mousedown', beginHandleDrag, true);
      element.addEventListener('touchstart', beginHandleDrag, { capture: true, passive: false });
      map.on('zoom', syncPosition);
      map.on('move', syncPosition);
      map.on('resize', syncPosition);
      syncPosition();
      return handle;
    }

    function createEditingMarker(latlng, icon, onDrag) {
      var marker = createEditableHandle(
        latlng,
        typeof icon === 'string' ? icon : (icon && icon.options && icon.options.html ? icon.options.html : ''),
        onDrag
      );
      editingLayers.push(marker);
      return marker;
    }

    function endEditingSession() {
      endActiveHandleDrag();
      resumeMapInteractions();
      setEditingTextSelectionDisabled(false);
      editingSession = null;
      clearEditingLayers();
      removeEditingControl();
    }

    function cancelEllipseEditing() {
      if (!editingSession) return false;
      endEditingSession();
      sync(true);
      return true;
    }

    function renderEditingControl() {
      removeEditingControl();

      var control = document.createElement('div');
      control.style.position = 'absolute';
      control.style.top = '16px';
      control.style.left = '56px';
      control.style.zIndex = '800';
      control.style.display = 'flex';
      control.style.gap = '8px';
      control.style.padding = '8px';
      control.style.borderRadius = '12px';
      control.style.background = 'rgba(255,255,255,0.96)';
      control.style.boxShadow = '0 2px 10px rgba(0,0,0,0.18)';
      control.style.border = '1px solid rgba(0,0,0,0.12)';

      function makeButton(label, background, textColor, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.border = 'none';
        btn.style.borderRadius = '10px';
        btn.style.padding = '8px 12px';
        btn.style.font = '600 13px Arial, sans-serif';
        btn.style.cursor = 'pointer';
        btn.style.background = background;
        btn.style.color = textColor;
        btn.addEventListener('click', onClick);
        control.appendChild(btn);
      }

      makeButton('Reset', '#e5e7eb', '#111827', function() {
        if (!editingSession || !editingSession.baseGeometry) return;
        editingSession.draftGeometry = cloneGeometry(editingSession.baseGeometry);
        syncEditingMarkersFromDraft();
      });
      makeButton('OK', '#16a34a', '#ffffff', function() {
        if (!editingSession || !editingSession.draftGeometry) return;
        ellipseOverridesByClusterKey[editingSession.clusterKey] = cloneGeometry(editingSession.draftGeometry);
        endEditingSession();
        sync(true);
      });
      makeButton('Cancel', '#dc2626', '#ffffff', function() {
        endEditingSession();
        sync(true);
      });

      control.addEventListener('click', function(e) { e.stopPropagation(); });
      control.addEventListener('wheel', function(e) { e.stopPropagation(); });
      map.getContainer().appendChild(control);
      editingControl = control;
    }

    function renderEditingSession() {
      clearEditingLayers();
      removeEditingControl();

      if (!editingSession || !editingSession.draftGeometry || editingSession.draftGeometry.type !== 'ellipse') return;

      var geometry = editingSession.draftGeometry;
      var lls = buildEllipseLatLngs(geometry);
      var coords = lls.map(function(ll) { return [ll.lng, ll.lat]; });
      coords.push(coords[0]);
      var editingSrc = map.getSource('ellipse-editing');
      if (editingSrc) editingSrc.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: {}
        }]
      });
      editingSession.overlay = true; // sentinel for syncEditingMarkersFromDraft

      editingSession.centerMarker = createEditingMarker(
        editingSession.draftGeometry.center,
        createEditAnchorIcon('#ffffff', '#1d4ed8', 18),
        applyCenterDrag
      );
      editingSession.majorPositiveMarker = createEditingMarker(
        getGeometryAxisAnchorLatLng(editingSession.draftGeometry, 'major', 1),
        createEditAnchorIcon('#1d4ed8', '#ffffff', 16),
        function(latlng) { applyAxisDrag('major', 1, latlng); }
      );
      editingSession.majorNegativeMarker = createEditingMarker(
        getGeometryAxisAnchorLatLng(editingSession.draftGeometry, 'major', -1),
        createEditAnchorIcon('#1d4ed8', '#ffffff', 16),
        function(latlng) { applyAxisDrag('major', -1, latlng); }
      );
      editingSession.minorPositiveMarker = createEditingMarker(
        getGeometryAxisAnchorLatLng(editingSession.draftGeometry, 'minor', 1),
        createEditAnchorIcon('#7c3aed', '#ffffff', 16),
        function(latlng) { applyAxisDrag('minor', 1, latlng); }
      );
      editingSession.minorNegativeMarker = createEditingMarker(
        getGeometryAxisAnchorLatLng(editingSession.draftGeometry, 'minor', -1),
        createEditAnchorIcon('#7c3aed', '#ffffff', 16),
        function(latlng) { applyAxisDrag('minor', -1, latlng); }
      );

      renderEditingControl();
    }

    function syncEditingSessionSelection(summaries) {
      if (!editingSession) return;
      var matchingSummary = null;
      for (var i = 0; i < summaries.length; i++) {
        if (summaries[i].clusterKey === editingSession.clusterKey) {
          matchingSummary = summaries[i];
          break;
        }
      }
      if (!matchingSummary || !matchingSummary.sourceGeometry || matchingSummary.sourceGeometry.type !== 'ellipse') {
        endEditingSession();
        return;
      }
      renderEditingSession();
    }

    function startEllipseEditing() {
      if (!enabled) {
        showToast('יש להפעיל תחילה את מצב האליפסה');
        console.warn('Ellipse editing requires ellipse mode to be enabled.');
        return Promise.resolve(false);
      }

      var redAlerts = getDisplayedRedAlerts();
      if (!redAlerts.length) {
        showToast('אין אליפסות פעילות לעריכה');
        console.warn('No displayed red-alert clusters are available for editing.');
        return Promise.resolve(false);
      }

      return ensureOrefPoints().then(function(pointsMap) {
        var summaries = buildBaseClusterGeometrySummaries(redAlerts, pointsMap)
          .filter(function(summary) {
            var geometry = getEffectiveGeometry(summary);
            return !!geometry && geometry.type === 'ellipse';
          })
          .sort(function(a, b) {
            return getGeometryArea(getEffectiveGeometry(b)) - getGeometryArea(getEffectiveGeometry(a));
          });

        if (!summaries.length) {
          showToast('אין אליפסה זמינה לעריכה');
          console.warn('No ellipse geometry is available for editing.');
          return false;
        }

        var selectedSummary = summaries[0];
        var selectedGeometry = getEffectiveGeometry(selectedSummary);
        if (!selectedGeometry || selectedGeometry.type !== 'ellipse' || !selectedSummary.sourceGeometry) {
          showToast('העריכה זמינה רק לאליפסה מרובת נקודות');
          console.warn('The selected geometry is not an editable ellipse.');
          return false;
        }

        editingSession = {
          clusterKey: selectedSummary.clusterKey,
          baseGeometry: cloneGeometry(selectedSummary.sourceGeometry),
          draftGeometry: cloneGeometry(selectedGeometry),
          overlay: null,
          centerMarker: null,
          majorPositiveMarker: null,
          majorNegativeMarker: null,
          minorPositiveMarker: null,
          minorNegativeMarker: null
        };
        suspendMapInteractions();
        setEditingTextSelectionDisabled(true);
        renderEditingSession();
        sync(true);
        showToast('עריכת האליפסה הופעלה');
        return true;
      }).catch(function(err) {
        console.error('Failed to start ellipse editing:', err);
        showToast('שגיאה בהפעלת עריכת האליפסה');
        return false;
      });
    }

    function populateSelectedClusterProbability(clusterReport, userLatLng) {
      var probabilityMetrics = getHomeAreaProbability(
        clusterReport.sourceGeometry,
        userLatLng,
        100,
        {
          centerDistanceMeters: clusterReport.centerDistanceMeters,
          normalizedDistanceRatio: clusterReport.normalizedDistanceRatio
        }
      );

      clusterReport.directionalRadiusMeters = probabilityMetrics ? probabilityMetrics.directionalRadiusMeters : null;
      clusterReport.homeStripeProbability = probabilityMetrics ? probabilityMetrics.homeStripeProbability : null;

      var detailedGeometry = buildScaledGeometry(
        clusterReport.sourceGeometry,
        clusterReport.normalizedDistanceRatio
      );
      clusterReport.homeEllipseCircumferenceMeters = getGeometryCircumferenceMeters(detailedGeometry);
      clusterReport.homeStripePerCircumferenceProbability =
        Number.isFinite(clusterReport.homeStripeProbability) &&
        Number.isFinite(clusterReport.homeEllipseCircumferenceMeters) &&
        clusterReport.homeEllipseCircumferenceMeters > 0
          ? formatPercentAsScientificFraction(
              (clusterReport.homeStripeProbability / clusterReport.homeEllipseCircumferenceMeters) * 100,
              2
            )
          : null;

      return clusterReport;
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
        var summaries = buildClusterGeometrySummaries(redAlerts, pointsMap, userLatLng);
        syncEditingSessionSelection(summaries);
        var reportClusters = summaries.map(function(summary) {
          return buildClusterReportEntry(summary, userLatLng);
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
      var userPos = getCurrentUserPosition();
      var shouldDraw = !!(enabled && userPos);
      if (!shouldDraw) {
        clearExtendedVisual();
        return Promise.resolve();
      }

      var redAlerts = getDisplayedRedAlerts();
      if (!redAlerts.length) {
        clearExtendedVisual();
        return Promise.resolve();
      }

      return ensureOrefPoints().then(function(pointsMap) {
        var summaries = buildClusterGeometrySummaries(redAlerts, pointsMap, userPos);
        syncEditingSessionSelection(summaries);
        var nearestCluster = null;
        for (var i = 0; i < summaries.length; i++) {
          var candidate = buildClusterReportEntry(summaries[i], userPos);
          if (isClusterEligibleForExtendedVisual(candidate)) {
            nearestCluster = candidate;
            break;
          }
        }
        if (!nearestCluster) {
          clearExtendedVisual();
          return;
        }
        populateSelectedClusterProbability(nearestCluster, userPos);
        console.log(
          `cluster=${nearestCluster.label}, ` +
          `normalizedDistanceRatio=${nearestCluster.normalizedDistanceRatio.toFixed(6)}, ` +
          `centerDistanceMeters=${nearestCluster.centerDistanceMeters.toFixed(2)}, ` +
          `directionalRadiusMeters=${nearestCluster.directionalRadiusMeters.toFixed(2)}, ` +
          `homeStripeProbability=${nearestCluster.homeStripeProbability.toExponential(3)}, ` +
          `homeEllipseCircumferenceMeters=${nearestCluster.homeEllipseCircumferenceMeters.toFixed(2)}, ` +
          `homeStripePerCircumferenceProbability=${nearestCluster.homeStripePerCircumferenceProbability}`
        );
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
        var summaries = buildBaseClusterGeometrySummaries(redAlerts, pointsMap);
        syncEditingSessionSelection(summaries);
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
        endEditingSession();
        clear();
        lastRenderKey = '';
        console.error('Failed to load oref_points.json:', err);
        if (opts.showToast) showToast('שגיאה בטעינת נקודות התרעה');
      });
    }

    function setEnabled(nextEnabled, opts) {
      enabled = !!nextEnabled;
      if (!enabled) {
        endEditingSession();
        clear();
        lastRenderKey = '';
        return Promise.resolve();
      }
      return sync(true, opts);
    }

    return {
      clear: clear,
      sync: sync,
      setEnabled: setEnabled,
      refreshExtendedVisual: refreshExtendedVisual,
      clearExtendedVisual: clearExtendedVisual,
      buildUserEllipseAnalysis: buildUserEllipseAnalysis,
      printEllipsesInfos: printEllipsesInfos,
      startEllipseEditing: startEllipseEditing,
      cancelEllipseEditing: cancelEllipseEditing,
      isEnabled: function() { return enabled; }
    };
  }

  function initEllipse() {
    var AS = window.AppState;
    if (!AS) return;

    // Wire module-level vars to AppState
    map = AS.map;
    getLocationStates      = function() { return AS.locationStates; };
    getLocationHistory     = function() { return AS.locationHistory; };
    getFeatureMap          = function() { return AS.featureMap; };
    getCurrentUserPosition = function() { return AS.userPosition; };
    getIsLiveMode          = function() { return AS.isLiveMode; };
    getCurrentViewTime     = function() { return AS.viewTime; };
    showToast              = function(msg, opts) { AS.showToast(msg, opts); };

    var controller = createController();

    function setupLayers() {
      if (!map.getSource('ellipse-overlays')) {
        map.addSource('ellipse-overlays', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
          id: 'ellipse-overlays-fill',
          type: 'fill',
          source: 'ellipse-overlays',
          paint: {
            'fill-color': ['coalesce', ['get', 'fillColor'], '#951111'],
            'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.08]
          }
        });
        map.addLayer({
          id: 'ellipse-overlays-stroke',
          type: 'line',
          source: 'ellipse-overlays',
          paint: {
            'line-color': ['coalesce', ['get', 'strokeColor'], '#951111'],
            'line-width': ['coalesce', ['get', 'strokeWidth'], 2],
            'line-opacity': ['coalesce', ['get', 'strokeOpacity'], 0.95]
          }
        });
      }

      if (!map.getSource('ellipse-visual')) {
        map.addSource('ellipse-visual', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
          id: 'ellipse-visual-line',
          type: 'line',
          source: 'ellipse-visual',
          filter: ['==', ['get', 'kind'], 'line'],
          paint: {
            'line-color': '#1d4ed8',
            'line-width': 2,
            'line-opacity': 0.9,
            'line-dasharray': [3, 3]
          }
        });
        map.addLayer({
          id: 'ellipse-visual-circle',
          type: 'circle',
          source: 'ellipse-visual',
          filter: ['==', ['get', 'kind'], 'center'],
          paint: {
            'circle-radius': 6,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#1d4ed8',
            'circle-stroke-width': 2
          }
        });
      }

      if (!map.getSource('ellipse-editing')) {
        map.addSource('ellipse-editing', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
          id: 'ellipse-editing-fill',
          type: 'fill',
          source: 'ellipse-editing',
          paint: { 'fill-color': '#93c5fd', 'fill-opacity': 0.08 }
        });
        map.addLayer({
          id: 'ellipse-editing-stroke',
          type: 'line',
          source: 'ellipse-editing',
          paint: {
            'line-color': '#1d4ed8',
            'line-width': 2,
            'line-opacity': 1,
            'line-dasharray': [4, 3]
          }
        });
      }

      if (!map.getSource('algc-overlay')) {
        map.addSource('algc-overlay', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
          id: 'algc-overlay-fill',
          type: 'fill',
          source: 'algc-overlay',
          paint: { 'fill-color': '#60a5fa', 'fill-opacity': 0.12 }
        });
        map.addLayer({
          id: 'algc-overlay-stroke',
          type: 'line',
          source: 'algc-overlay',
          paint: {
            'line-color': '#1d4ed8',
            'line-width': 2,
            'line-opacity': 0.95
          }
        });
      }
    }

    function setupEventHandlers() {
      map.on('dblclick', 'ellipse-overlays-fill', function(event) {
        if (!event.features || !event.features.length) return;
        event.preventDefault();
        var props = event.features[0].properties || {};
        var locations = props.locations ? String(props.locations).split('||') : [];
        if (!locations.length) return;
        window.calcEllipseAlgC({ locations: locations }).catch(function(error) {
          console.error(error);
          showToast('Failed to calculate server ellipse');
        });
      });

      map.on('dblclick', 'algc-overlay-fill', function(event) {
        event.preventDefault();
        clearAlgCServiceOverlay();
      });
    }

    if (map.loaded()) {
      setupLayers();
      setupEventHandlers();
    } else {
      map.once('load', function() {
        setupLayers();
        setupEventHandlers();
      });
    }

    // Restore persisted enabled state
    var ellipseEnabled = false;
    try { ellipseEnabled = Number(localStorage.getItem('oref-ellipse-mode')) > 0; } catch (e) {}

    var stub = document.getElementById('ellipse-stub');
    var algCOverlayLayer = null;

    function getDisplayedRedAlertNamesForAlgC() {
      var locationStates = getLocationStates();
      return Object.keys(locationStates).filter(function(name) {
        return locationStates[name] && locationStates[name].state === 'red';
      }).sort(function(a, b) {
        return a.localeCompare(b, 'he');
      });
    }

    function clearAlgCServiceOverlay() {
      if (!algCOverlayLayer) return;
      if (algCOverlayLayer.marker && typeof algCOverlayLayer.marker.remove === 'function') {
        algCOverlayLayer.marker.remove();
      }
      var algcSrc = map.getSource('algc-overlay');
      if (algcSrc) algcSrc.setData({ type: 'FeatureCollection', features: [] });
      algCOverlayLayer = null;
    }

    function normalizeProjectedVector(vector, fallback) {
      var length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
      if (!Number.isFinite(length) || length < 1e-9) return fallback;
      return { x: vector.x / length, y: vector.y / length };
    }

    function projectEllipseInitPoint(point) {
      var x = point.lng * 20037508.34 / 180;
      var y = Math.log(Math.tan((90 + point.lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
      return { x: x, y: y };
    }

    function unprojectEllipseInitPoint(point) {
      return {
        lng: point.x * 180 / 20037508.34,
        lat: Math.atan(Math.exp(point.y * Math.PI / 20037508.34)) * 360 / Math.PI - 90
      };
    }

    function buildAlgCServiceRenderable(ellipse) {
      if (!ellipse || !ellipse.center || !ellipse.axes) {
        throw new Error('calcEllipseAlgC: server response is missing ellipse geometry');
      }

      var center = { lat: ellipse.center.lat, lng: ellipse.center.lng };
      var centerProjected = projectEllipseInitPoint(center);
      var angleRad = ((Number(ellipse.angle_deg) || 0) * Math.PI) / 180;
      var sampleDeltaDegrees = 0.01;
      var samplePoint = {
        lat: center.lat + Math.sin(angleRad) * sampleDeltaDegrees,
        lng: center.lng + Math.cos(angleRad) * sampleDeltaDegrees
      };
      var sampleProjected = projectEllipseInitPoint(samplePoint);
      var majorAxis = normalizeProjectedVector({
        x: sampleProjected.x - centerProjected.x,
        y: sampleProjected.y - centerProjected.y
      }, { x: 1, y: 0 });
      var minorAxis = { x: -majorAxis.y, y: majorAxis.x };
      var semiMajor = Number(ellipse.axes.semi_major_km) * 1000;
      var semiMinor = Number(ellipse.axes.semi_minor_km) * 1000;

      if (!Number.isFinite(semiMajor) || !Number.isFinite(semiMinor) || semiMajor <= 0 || semiMinor <= 0) {
        throw new Error('calcEllipseAlgC: server returned invalid semi-axis lengths');
      }

      return {
        center: { lat: center.lat, lng: center.lng },
        centerProjected: { x: centerProjected.x, y: centerProjected.y },
        majorAxis: majorAxis,
        minorAxis: minorAxis,
        semiMajor: semiMajor,
        semiMinor: semiMinor
      };
    }

    function buildAlgCServiceLatLngs(renderable) {
      var latlngs = [];
      for (var i = 0; i < 72; i++) {
        var theta = (Math.PI * 2 * i) / 72;
        var x = renderable.centerProjected.x +
          renderable.majorAxis.x * Math.cos(theta) * renderable.semiMajor +
          renderable.minorAxis.x * Math.sin(theta) * renderable.semiMinor;
        var y = renderable.centerProjected.y +
          renderable.majorAxis.y * Math.cos(theta) * renderable.semiMajor +
          renderable.minorAxis.y * Math.sin(theta) * renderable.semiMinor;
        latlngs.push(unprojectEllipseInitPoint({ x: x, y: y }));
      }
      return latlngs;
    }

    function drawAlgCServiceOverlay(renderable, payload, options) {
      clearAlgCServiceOverlay();

      var latlngs = buildAlgCServiceLatLngs(renderable);
      var coords = latlngs.map(function(ll) { return [ll.lng, ll.lat]; });
      coords.push(coords[0]);

      var features = [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {}
      }];

      var algcSrc = map.getSource('algc-overlay');
      if (algcSrc) algcSrc.setData({ type: 'FeatureCollection', features: features });

      var dotEl = document.createElement('div');
      dotEl.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#ffffff;border:2px solid #1d4ed8;box-shadow:0 1px 4px rgba(0,0,0,0.3);box-sizing:border-box;cursor:pointer;';
      dotEl.addEventListener('dblclick', function(event) {
        event.stopPropagation();
        event.preventDefault();
        clearAlgCServiceOverlay();
      });
      var centerMarker = new maplibregl.Marker({ element: dotEl, anchor: 'center' })
        .setLngLat([renderable.center.lng, renderable.center.lat])
        .addTo(map);

      algCOverlayLayer = { marker: centerMarker };

      if (options.fitBounds !== false) {
        var bounds = new maplibregl.LngLatBounds();
        for (var i = 0; i < latlngs.length; i++) {
          bounds.extend([latlngs[i].lng, latlngs[i].lat]);
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 60 });
        }
      }

      if (options.log !== false) {
        console.log('calcEllipseAlgC result', payload);
      }
    }

    async function requestAlgCServiceEllipse(options) {
      options = options || {};

      var locationNames = Array.isArray(options.locations) && options.locations.length
        ? options.locations.map(function(value) { return String(value); })
        : getDisplayedRedAlertNamesForAlgC();

      if (!locationNames.length) {
        throw new Error('calcEllipseAlgC: no red alert locations are currently active');
      }

      var endpoint = typeof options.endpoint === 'string' && options.endpoint
        ? options.endpoint
        : (window.ELLIPSE_SERVICE_URL || 'https://ellipses.oref-map.org/ellipse');

      var response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: locationNames })
      });

      var data = null;
      try {
        data = await response.json();
      } catch (error) {
        throw new Error('calcEllipseAlgC: ellipse service returned non-JSON response');
      }

      if (!response.ok || !data || data.ok !== true || !data.ellipse) {
        throw new Error(
          'calcEllipseAlgC: ellipse service request failed' +
          (data && data.error ? ': ' + data.error : ' (HTTP ' + response.status + ')')
        );
      }

      var renderable = buildAlgCServiceRenderable(data.ellipse);
      var payload = {
        inputLocations: locationNames,
        missingLocations: Array.isArray(data.missing_locations) ? data.missing_locations : [],
        alertedPointCount: data.ellipse.meta && Number.isFinite(data.ellipse.meta.input_count)
          ? data.ellipse.meta.input_count
          : locationNames.length,
        ellipse: data.ellipse,
        renderable: renderable,
        serviceUrl: endpoint
      };

      if (options.draw !== false) {
        drawAlgCServiceOverlay(renderable, payload, options);
      } else if (options.log !== false) {
        console.log('calcEllipseAlgC result', payload);
      }

      return payload;
    }

    function setEnabled(on, opts) {
      ellipseEnabled = on;
      if (stub) stub.classList.toggle('active', on);
      try { localStorage.setItem('oref-ellipse-mode', on ? '3' : '0'); } catch (e) {}
      if (on && opts && opts.showToast) {
        var msg = getCurrentUserPosition()
          ? 'האליפסה מסמנת את אזור ההתרעה ביחס למיקומך'
          : 'האליפסה מסמנת את אזור ההתרעה. הפעל מיקום לניתוח יחסי';
        showToast(msg);
        return controller.setEnabled(on, {});
      }
      return controller.setEnabled(on, opts || {});
    }

    window.printEllipsesInfos = function() {
      return controller.printEllipsesInfos();
    };
    window.editEllipse = function() {
      return controller.startEllipseEditing();
    };
    window.clearAlgCOverlay = function() {
      clearAlgCServiceOverlay();
    };
    window.clearEllipseAlgCOverlay = function() {
      clearAlgCServiceOverlay();
    };
    window.calcEllipseAlgC = function(options) {
      return requestAlgCServiceEllipse(options);
    };

    // Wire enable button: toggle on/off
    var enableBtn = document.getElementById('ellipse-enable-btn');
    if (enableBtn) {
      enableBtn.addEventListener('click', function() {
        setEnabled(!ellipseEnabled, { showToast: true });
      });
    }

    setEnabled(ellipseEnabled);

    document.addEventListener('app:stateChanged', function() {
      controller.sync(false);
    });
    document.addEventListener('app:locationChanged', function() {
      controller.refreshExtendedVisual();
    });
    document.addEventListener('app:escape', function() {
      if (controller.cancelEllipseEditing()) return;
      controller.clearExtendedVisual();
    });
  }

  // Works whether loaded at startup (waits for app:ready) or on-demand (AppState already set)
  if (window.AppState) {
    initEllipse();
  } else {
    document.addEventListener('app:ready', initEllipse);
  }

})();

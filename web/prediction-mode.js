(function() {
  'use strict';

  // ------------------------------------------------------------------
  // Launch-direction prediction — border-aware ellipse fitting.
  //
  // Strategy (see issue #136):
  //  1. Cluster red-alerted locations by polygon adjacency (direct touch OR
  //     bridged through a single non-red polygon).
  //  2. Gate each cluster on "yellow precedes red within 5 min", but only
  //     counting yellow alerts from locations spatially adjacent to the
  //     cluster — this prevents a Lebanon cluster from being triggered by
  //     yellows from a simultaneous Iran event in the centre of the country.
  //  3. Build the outer boundary ring of the union of all cluster polygons.
  //  4. Fit an ellipse to the boundary using a Nelder-Mead optimizer where
  //     the loss is the mean squared distance from ellipse sample points
  //     (that lie inside Israel's land border) to the union boundary.
  //     Ellipse arcs outside the border (e.g. over the Mediterranean) are
  //     ignored — this lets the fit complete truncated alert blobs.
  //  5. Estimate slope uncertainty by re-fitting on even/odd boundary subsets.
  //  6. Draw the corridor eastward only (positive longitude direction) as a
  //     5000 km geodesic. Filter predictions with aspect ratio < 1.2.
  //
  // Debug visuals (always shown when feature is enabled):
  //  - Status bar: per-cluster fit progress and timing.
  //  - Union boundary points: green circles on each boundary vertex.
  //  - Initial-guess ellipse: dashed green polyline (shown immediately).
  //  - Best-fit ellipse: solid green polyline (shown when optimisation done).
  // ------------------------------------------------------------------

  var ASPECT_RATIO_MIN = 1.2;
  var MIN_CLUSTER_RED = 15;
  var YELLOW_WINDOW_MS = 5 * 60 * 1000;
  var FIT_NUM_PTS = 40;
  var FIT_MAX_ITER = 120;
  var CACHE_MAX_AGE_MS = 10 * 60 * 1000;
  var CORRIDOR_DIST_DEG = 5000 / 111.32; // ~44.9° ≈ 5000 km

  var YELLOW_PATTERNS = [
    /בדקות הקרובות צפויות להתקבל התרעות/,
    /לשפר את המיקום למיגון/
  ];

  function initPrediction() {
    var A = window.AppState;
    var map = A.map;
    var showToast = A.showToast;

    var orefPoints = null;
    var orefPointsPromise = null;
    var israelBorder = null;
    var israelBorderPromise = null;
    var predictionLayers = [];   // all map layers managed by this module
    var enabled = localStorage.getItem('oref-predict') === 'true';
    var predictionUpdateScheduled = false;
    var fitCache = Object.create(null);

    // ----------------------------------------------------------------
    // Status bar DOM element
    // ----------------------------------------------------------------
    var statusBar = document.createElement('div');
    statusBar.id = 'predict-status-bar';
    statusBar.style.cssText = [
      'position:fixed',
      'bottom:120px',
      'left:8px',
      'background:rgba(0,0,0,0.78)',
      'color:#fff',
      'padding:6px 10px',
      'border-radius:6px',
      'font-size:11px',
      'font-family:monospace',
      'z-index:1100',
      'pointer-events:none',
      'direction:ltr',
      'white-space:pre',
      'display:none',
      'line-height:1.55',
      'max-width:280px',
    ].join(';');
    document.body.appendChild(statusBar);

    var statusLines = {};   // clusterIdx → status string
    function refreshStatusBar() {
      var keys = Object.keys(statusLines);
      if (keys.length === 0) { statusBar.style.display = 'none'; return; }
      statusBar.style.display = 'block';
      statusBar.textContent = keys.map(function(k) { return statusLines[k]; }).join('\n');
    }
    function setStatus(idx, text) { statusLines[idx] = text; refreshStatusBar(); }
    function clearStatus() { statusLines = {}; refreshStatusBar(); }

    // ----------------------------------------------------------------
    // Data loading
    // ----------------------------------------------------------------
    function ensureOrefPoints() {
      if (orefPoints) return Promise.resolve(orefPoints);
      if (orefPointsPromise) return orefPointsPromise;
      orefPointsPromise = fetch('oref_points.json')
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(d) { orefPoints = d || {}; return orefPoints; })
        .finally(function() { orefPointsPromise = null; });
      return orefPointsPromise;
    }

    function ensureIsraelBorder() {
      if (israelBorder) return Promise.resolve(israelBorder);
      if (israelBorderPromise) return israelBorderPromise;
      israelBorderPromise = fetch('israel_border.json')
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(d) { israelBorder = d; return d; })
        .finally(function() { israelBorderPromise = null; });
      return israelBorderPromise;
    }

    // ----------------------------------------------------------------
    // Geometry helpers
    // ----------------------------------------------------------------
    function polygonCentroid(poly) {
      var rings = poly.getLatLngs();
      if (!rings || rings.length === 0) return null;
      var outer = Array.isArray(rings[0]) && rings[0].length && rings[0][0].lat !== undefined ? rings[0] : rings;
      if (outer.length === 0 || typeof outer[0].lat !== 'number') return null;
      var sumLat = 0, sumLng = 0;
      for (var i = 0; i < outer.length; i++) { sumLat += outer[i].lat; sumLng += outer[i].lng; }
      return [sumLat / outer.length, sumLng / outer.length];
    }

    function polygonOuterRing(poly) {
      var rings = poly.getLatLngs();
      if (!rings || rings.length === 0) return [];
      return Array.isArray(rings[0]) && rings[0].length && rings[0][0].lat !== undefined ? rings[0] : rings;
    }

    // Andrew's monotone chain convex hull. Points are [lat, lng] pairs.
    function convexHull(points) {
      var n = points.length;
      if (n < 3) return points.slice();
      var pts = points.slice().sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
      function cross(O, A, B) {
        return (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
      }
      var lower = [], upper = [];
      for (var i = 0; i < n; i++) {
        while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], pts[i]) <= 0) lower.pop();
        lower.push(pts[i]);
      }
      for (var i = n-1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], pts[i]) <= 0) upper.pop();
        upper.push(pts[i]);
      }
      lower.pop(); upper.pop();
      return lower.concat(upper);
    }

    // Ray-casting point-in-polygon. border = {bbox, points:[[lat,lng],...]}.
    function pointInBorder(lat, lng, border) {
      var bbox = border.bbox;
      if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) return false;
      var pts = border.points, n = pts.length, inside = false;
      for (var i = 0, j = n-1; i < n; j = i++) {
        var latI = pts[i][0], lngI = pts[i][1], latJ = pts[j][0], lngJ = pts[j][1];
        if ((latI > lat) !== (latJ > lat)) {
          var lngInt = lngI + (lngJ-lngI)*(lat-latI)/(latJ-latI+1e-20);
          if (lng < lngInt) inside = !inside;
        }
      }
      return inside;
    }

    function distToSegment(p, a, b) {
      var dx = b[0]-a[0], dy = b[1]-a[1];
      var L2 = dx*dx + dy*dy;
      if (L2 < 1e-20) { var qx=p[0]-a[0],qy=p[1]-a[1]; return Math.sqrt(qx*qx+qy*qy); }
      var t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / L2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var px = a[0]+t*dx, py = a[1]+t*dy, rx=p[0]-px, ry=p[1]-py;
      return Math.sqrt(rx*rx+ry*ry);
    }

    function distToPolygonBoundary(p, poly) {
      var min = Infinity, n = poly.length;
      for (var i = 0; i < n; i++) {
        var d = distToSegment(p, poly[i], poly[(i+1)%n]);
        if (d < min) min = d;
      }
      return min;
    }

    // Parametric ellipse: params = [cx_lat, cy_lng, a, b, theta]
    function ellipsePoints(params, numPts) {
      var cx=params[0], cy=params[1], a=params[2], b=params[3], theta=params[4];
      var cosT=Math.cos(theta), sinT=Math.sin(theta), pts=new Array(numPts);
      for (var i = 0; i < numPts; i++) {
        var phi=(i/numPts)*2*Math.PI, cp=Math.cos(phi), sp=Math.sin(phi);
        pts[i] = [cx + a*cp*cosT - b*sp*sinT, cy + a*cp*sinT + b*sp*cosT];
      }
      return pts;
    }

    // PCA-based initial guess (mirrors calc_ellipse_initial_guess in Python script).
    function ellipseInitialGuess(points) {
      var n=points.length, sx=0, sy=0;
      for (var i=0;i<n;i++){sx+=points[i][0];sy+=points[i][1];}
      var cx=sx/n, cy=sy/n, cxx=0, cxy=0, cyy=0;
      for (var i=0;i<n;i++){
        var dx=points[i][0]-cx, dy=points[i][1]-cy;
        cxx+=dx*dx; cxy+=dx*dy; cyy+=dy*dy;
      }
      cxx/=n; cxy/=n; cyy/=n;
      var diff=cxx-cyy, disc=Math.sqrt(diff*diff+4*cxy*cxy);
      var lam1=Math.max(0,(cxx+cyy+disc)/2), lam2=Math.max(0,(cxx+cyy-disc)/2);
      var a=Math.sqrt(2*lam1), b=Math.sqrt(2*lam2);
      var vx,vy;
      if (Math.abs(cxy)>1e-12){vx=lam1-cyy;vy=cxy;}
      else if(cxx>=cyy){vx=1;vy=0;}else{vx=0;vy=1;}
      var theta=Math.atan2(vy,vx);
      if(a<b){var t=a;a=b;b=t;theta+=Math.PI/2;}
      theta=((theta+Math.PI/2)%Math.PI+Math.PI)%Math.PI-Math.PI/2;
      if(a<1e-6)a=1e-6; if(b<1e-6)b=1e-6;
      return [cx,cy,a,b,theta];
    }

    // Compact Nelder-Mead. Returns {x, f}.
    function nelderMead(f, x0, step, maxIter) {
      var n=x0.length, alpha=1, gamma=2, rho=0.5, sigma=0.5;
      var simplex=new Array(n+1), values=new Array(n+1), order=new Array(n+1);
      simplex[0]=x0.slice(); values[0]=f(simplex[0]);
      for(var i=0;i<n;i++){var p=x0.slice();p[i]+=step[i];simplex[i+1]=p;values[i+1]=f(p);}
      function reorder(){for(var i=0;i<=n;i++)order[i]=i;order.sort(function(a,b){return values[a]-values[b];});}
      for(var iter=0;iter<maxIter;iter++){
        reorder();
        if(Math.abs(values[order[n]]-values[order[0]])<1e-8)break;
        var cent=new Array(n).fill(0);
        for(var i=0;i<n;i++){var s=simplex[order[i]];for(var j=0;j<n;j++)cent[j]+=s[j];}
        for(var j=0;j<n;j++)cent[j]/=n;
        var xw=simplex[order[n]];
        var xr=new Array(n); for(var j=0;j<n;j++)xr[j]=cent[j]+alpha*(cent[j]-xw[j]);
        var fr=f(xr);
        if(fr<values[order[n-1]]&&fr>=values[order[0]]){simplex[order[n]]=xr;values[order[n]]=fr;continue;}
        if(fr<values[order[0]]){
          var xe=new Array(n);for(var j=0;j<n;j++)xe[j]=cent[j]+gamma*(xr[j]-cent[j]);
          var fe=f(xe);
          if(fe<fr){simplex[order[n]]=xe;values[order[n]]=fe;}else{simplex[order[n]]=xr;values[order[n]]=fr;}
          continue;
        }
        var xc=new Array(n);for(var j=0;j<n;j++)xc[j]=cent[j]+rho*(xw[j]-cent[j]);
        var fc=f(xc);
        if(fc<values[order[n]]){simplex[order[n]]=xc;values[order[n]]=fc;continue;}
        var xb=simplex[order[0]];
        for(var i=1;i<=n;i++){var ss=simplex[order[i]];for(var j=0;j<n;j++)ss[j]=xb[j]+sigma*(ss[j]-xb[j]);values[order[i]]=f(ss);}
      }
      reorder(); return {x:simplex[order[0]],f:values[order[0]]};
    }

    function ellipseFitLoss(params, boundaryVerts, border, numPts, rMin, aspectMax) {
      var a=params[2], b=params[3];
      if(a<=1e-9||b<=1e-9) return 1e12;
      var pts=ellipsePoints(params,numPts), sumSq=0, nInside=0;
      for(var i=0;i<numPts;i++){
        if(!pointInBorder(pts[i][0],pts[i][1],border)) continue;
        nInside++;
        var d=distToPolygonBoundary(pts[i],boundaryVerts);
        sumSq+=d*d;
      }
      if(nInside===0) return 1e12;
      var ar=a>b?a/b:b/a;
      var lossAspect=ar>aspectMax?(ar-aspectMax):0;
      var lossSize=0;
      if(a<rMin)lossSize+=(rMin-a)/rMin;
      if(b<rMin)lossSize+=(rMin-b)/rMin;
      return sumSq/nInside+lossAspect+lossSize;
    }

    function runFit(boundaryVerts, border, warmStart) {
      var guess = warmStart ? warmStart.slice() : ellipseInitialGuess(boundaryVerts);
      var rMin = guess[2]/4;
      var minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
      for(var i=0;i<boundaryVerts.length;i++){
        if(boundaryVerts[i][0]<minLat)minLat=boundaryVerts[i][0];
        if(boundaryVerts[i][0]>maxLat)maxLat=boundaryVerts[i][0];
        if(boundaryVerts[i][1]<minLng)minLng=boundaryVerts[i][1];
        if(boundaryVerts[i][1]>maxLng)maxLng=boundaryVerts[i][1];
      }
      var dLat=Math.max(maxLat-minLat,0.01), dLng=Math.max(maxLng-minLng,0.01), dim=Math.max(dLat,dLng);
      var step=[0.15*dLat,0.15*dLng,0.2*dim,0.2*dim,0.1];
      var loss=function(p){return ellipseFitLoss(p,boundaryVerts,border,FIT_NUM_PTS,rMin,4);};
      var res=nelderMead(loss,guess,step,FIT_MAX_ITER);
      var p=res.x;
      if(p[3]>p[2]){var t=p[2];p[2]=p[3];p[3]=t;p[4]+=Math.PI/2;}
      p[4]=((p[4]+Math.PI/2)%Math.PI+Math.PI)%Math.PI-Math.PI/2;
      return {params:p, loss:res.f};
    }

    // ----------------------------------------------------------------
    // Iran/Yemen gate: yellow precedes red within YELLOW_WINDOW_MS,
    // restricted to yellow alerts from locations adjacent to the cluster.
    // ----------------------------------------------------------------
    function parseAlertDateMs(s) {
      if (!s) return null;
      var d = new Date(String(s).replace(' ','T'));
      var t = d.getTime(); return isNaN(t) ? null : t;
    }

    function isYellowTitle(title) {
      if (!title) return false;
      var norm = String(title).replace(/\s+/g,' ').trim();
      for (var i=0;i<YELLOW_PATTERNS.length;i++) if(YELLOW_PATTERNS[i].test(norm)) return true;
      return false;
    }

    // adjacentNames: optional object used as a set of location names to restrict
    // the yellow search to (falsy = check all locations).
    function hasPrecedingYellow(earliestRedMs, locationHistory, extHistory, adjacentNames) {
      if (!earliestRedMs) return false;
      var lo = earliestRedMs - YELLOW_WINDOW_MS, hi = earliestRedMs;

      // Check locationHistory (keyed by location name)
      for (var name in locationHistory) {
        if (adjacentNames && !adjacentNames[name]) continue;
        var arr = locationHistory[name]; if (!arr) continue;
        for (var j=0;j<arr.length;j++) {
          var e=arr[j]; if(!e||!isYellowTitle(e.title)) continue;
          var ts=parseAlertDateMs(e.alertDate);
          if(ts&&ts>=lo&&ts<=hi) return true;
        }
      }

      // Also check extendedHistory (stores events as {location, title, alertDate ms, state}).
      // This covers timeline mode where locationHistory skips entries older than 12 h.
      if (extHistory) {
        for (var i=0;i<extHistory.length;i++) {
          var e=extHistory[i];
          if(!e||!isYellowTitle(e.title)) continue;
          if(adjacentNames && e.location && !adjacentNames[e.location]) continue;
          var ts=typeof e.alertDate==='number' ? e.alertDate : parseAlertDateMs(e.alertDate);
          if(ts&&ts>=lo&&ts<=hi) return true;
        }
      }

      return false;
    }

    // ----------------------------------------------------------------
    // Clustering by polygon adjacency
    //
    // Two red polygons belong to the same cluster if:
    //   (a) they share at least one vertex (within tolerance), OR
    //   (b) they both share vertices with a single non-red polygon
    //       (i.e., they are separated by at most one non-red polygon).
    // ----------------------------------------------------------------
    function clusterByAdjacency(redPoints, locationPolygons, locationStates) {
      var n = redPoints.length; if (n === 0) return [];

      // Build vertex arrays for all red points
      var locVerts = new Array(n);
      for (var i = 0; i < n; i++) {
        var poly = locationPolygons[redPoints[i][3]], vs = [];
        if (poly) {
          var outer = polygonOuterRing(poly);
          for (var j = 0; j < outer.length; j++) vs.push([outer[j].lat, outer[j].lng]);
        }
        locVerts[i] = vs;
      }

      var parent = new Array(n);
      for (var i = 0; i < n; i++) parent[i] = i;
      function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
      function union(i, j) { var ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }

      var tol2 = 0.005 * 0.005;

      // Phase 1: direct touch between red polygons
      for (var i = 0; i < n; i++) {
        for (var j = i+1; j < n; j++) {
          if (find(i) === find(j)) continue;
          var vi = locVerts[i], vj = locVerts[j], found = false;
          for (var a = 0; a < vi.length && !found; a++) {
            for (var b = 0; b < vj.length && !found; b++) {
              var dl = vi[a][0]-vj[b][0], dg = vi[a][1]-vj[b][1];
              if (dl*dl+dg*dg < tol2) { union(i, j); found = true; }
            }
          }
        }
      }

      // Phase 2: bridge through a single non-red polygon.
      // Build a name→index map for the red locations first.
      var redNameToIdx = Object.create(null);
      for (var i = 0; i < n; i++) redNameToIdx[redPoints[i][3]] = i;

      for (var locName in locationPolygons) {
        // Only iterate non-red polygons
        if (redNameToIdx[locName] !== undefined) continue;
        var state = locationStates ? locationStates[locName] : null;
        if (state && state.state === 'red') continue;

        var bridgePoly = locationPolygons[locName];
        if (!bridgePoly) continue;
        var bridgeOuter = polygonOuterRing(bridgePoly);
        if (bridgeOuter.length === 0) continue;

        // Find all red polygon indices that touch this non-red polygon
        var touchingRed = [];
        for (var i = 0; i < n; i++) {
          var vi = locVerts[i], touches = false;
          for (var a = 0; a < bridgeOuter.length && !touches; a++) {
            var bLat = bridgeOuter[a].lat, bLng = bridgeOuter[a].lng;
            for (var b = 0; b < vi.length && !touches; b++) {
              var dl = bLat - vi[b][0], dg = bLng - vi[b][1];
              if (dl*dl + dg*dg < tol2) touches = true;
            }
          }
          if (touches) touchingRed.push(i);
        }

        // Union all red polygons that share this non-red bridge polygon
        for (var ti = 1; ti < touchingRed.length; ti++) {
          union(touchingRed[0], touchingRed[ti]);
        }
      }

      var groups = Object.create(null);
      for (var i = 0; i < n; i++) {
        var r = find(i);
        if (!groups[r]) groups[r] = [];
        groups[r].push(redPoints[i]);
      }
      return Object.keys(groups).map(function(k) { return groups[k]; });
    }

    // ----------------------------------------------------------------
    // Find all location names adjacent to a cluster (for yellow gate).
    // "Adjacent" = polygon shares a vertex with any cluster polygon.
    // The cluster's own locations are always included.
    // ----------------------------------------------------------------
    function clusterAdjacentNames(cluster, locationPolygons) {
      var tol2 = 0.005 * 0.005;

      // Collect all vertices of the cluster's polygons (flat array)
      var clusterVerts = [];
      var adjacent = Object.create(null);
      for (var i = 0; i < cluster.length; i++) {
        adjacent[cluster[i][3]] = true;
        var poly = locationPolygons[cluster[i][3]];
        if (!poly) continue;
        var outer = polygonOuterRing(poly);
        for (var j = 0; j < outer.length; j++) {
          clusterVerts.push([outer[j].lat, outer[j].lng]);
        }
      }

      // Check every other location
      for (var locName in locationPolygons) {
        if (adjacent[locName]) continue;
        var poly = locationPolygons[locName];
        if (!poly) continue;
        var outer = polygonOuterRing(poly);
        var touches = false;
        for (var a = 0; a < outer.length && !touches; a++) {
          var lat = outer[a].lat, lng = outer[a].lng;
          for (var b = 0; b < clusterVerts.length && !touches; b++) {
            var dl = lat - clusterVerts[b][0], dg = lng - clusterVerts[b][1];
            if (dl*dl + dg*dg < tol2) touches = true;
          }
        }
        if (touches) adjacent[locName] = true;
      }

      return adjacent;
    }

    // ----------------------------------------------------------------
    // Union polygon boundary
    //
    // Collects all polygon edges from the cluster.  Edges shared by
    // exactly one polygon are on the outer boundary.  Stitches them
    // into a ring using the smallest-turning-angle heuristic at
    // multi-way junctions (same algorithm as generate_israel_border.py).
    // Falls back to convex hull if stitching fails.
    // ----------------------------------------------------------------
    function clusterUnionBoundary(cluster, locationPolygons) {
      var QFACTOR = 1e4; // ~11 m precision
      function qn(x) { return Math.round(x * QFACTOR) / QFACTOR; }
      function vkey(lat, lng) { return qn(lat) + ',' + qn(lng); }

      var edgeCount = Object.create(null);
      var edgeEnds  = Object.create(null); // canonical ekey → [[lat,lng],[lat,lng]]

      for (var i = 0; i < cluster.length; i++) {
        var poly = locationPolygons[cluster[i][3]];
        if (!poly) continue;
        var outer = polygonOuterRing(poly);
        var nn = outer.length;
        for (var j = 0; j < nn; j++) {
          var lat1 = outer[j].lat, lng1 = outer[j].lng;
          var lat2 = outer[(j+1)%nn].lat, lng2 = outer[(j+1)%nn].lng;
          var ak = vkey(lat1, lng1), bk = vkey(lat2, lng2);
          if (ak === bk) continue;
          var ekey = ak < bk ? ak + '|' + bk : bk + '|' + ak;
          edgeCount[ekey] = (edgeCount[ekey] || 0) + 1;
          if (!edgeEnds[ekey]) {
            edgeEnds[ekey] = [[qn(lat1), qn(lng1)], [qn(lat2), qn(lng2)]];
          }
        }
      }

      // Build adjacency for boundary edges (count === 1)
      var adj = Object.create(null);
      var pos = Object.create(null); // vkey → [lat, lng]

      for (var ekey in edgeCount) {
        if (edgeCount[ekey] !== 1) continue;
        var e = edgeEnds[ekey];
        var ak = vkey(e[0][0], e[0][1]), bk = vkey(e[1][0], e[1][1]);
        pos[ak] = e[0]; pos[bk] = e[1];
        if (!adj[ak]) adj[ak] = [];
        if (!adj[bk]) adj[bk] = [];
        adj[ak].push(bk);
        adj[bk].push(ak);
      }

      var vkeys = Object.keys(adj);
      if (vkeys.length === 0) return [];

      // Start from the southernmost (then westernmost) vertex
      var startKey = vkeys[0];
      for (var i = 1; i < vkeys.length; i++) {
        var p = pos[vkeys[i]], sp = pos[startKey];
        if (p[0] < sp[0] || (p[0] === sp[0] && p[1] < sp[1])) startKey = vkeys[i];
      }

      // Copy adjacency so we can mutate it while walking
      var adjCopy = Object.create(null);
      for (var k in adj) adjCopy[k] = adj[k].slice();

      var ring = [pos[startKey]];
      var prev = null, curr = startKey;

      for (var step = 0; step < vkeys.length + 4; step++) {
        var neighbors = adjCopy[curr];
        if (!neighbors || neighbors.length === 0) break;

        var next;
        if (neighbors.length === 1) {
          next = neighbors[0];
        } else {
          // At a multi-way junction pick the smallest turning angle
          var cp = pos[curr], pp = prev ? pos[prev] : null;
          var bestKey = null, bestAng = Math.PI * 3;
          for (var ni = 0; ni < neighbors.length; ni++) {
            var nk = neighbors[ni];
            if (pp) {
              var v1x = cp[0]-pp[0], v1y = cp[1]-pp[1];
              var np = pos[nk];
              var v2x = np[0]-cp[0], v2y = np[1]-cp[1];
              var a1 = Math.atan2(v1y, v1x), a2 = Math.atan2(v2y, v2x);
              var d = (a2-a1+Math.PI) % (2*Math.PI) - Math.PI;
              if (Math.abs(d) < bestAng) { bestAng = Math.abs(d); bestKey = nk; }
            } else {
              bestKey = nk; break;
            }
          }
          next = bestKey || neighbors[0];
        }

        adjCopy[curr] = adjCopy[curr].filter(function(k) { return k !== next; });
        if (adjCopy[next]) adjCopy[next] = adjCopy[next].filter(function(k) { return k !== curr; });

        if (next === startKey) break;
        ring.push(pos[next]);
        prev = curr; curr = next;
      }

      return ring;
    }

    // ----------------------------------------------------------------
    // Drawing helpers
    // ----------------------------------------------------------------
    function addLayer(layer) { layer.addTo(map); predictionLayers.push(layer); return layer; }

    function drawEllipseLayer(params, numPts, style) {
      var pts = ellipsePoints(params, numPts);
      // Close the ring
      pts.push(pts[0]);
      return addLayer(L.polyline(pts, style));
    }

    function gcDest(lat, lng, bearingDeg, distDeg) {
      var toRad=Math.PI/180, toDeg=180/Math.PI;
      var lat1=lat*toRad, lng1=lng*toRad, brng=bearingDeg*toRad, d=distDeg*toRad;
      var lat2=Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
      var lng2=lng1+Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1),Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
      return [lat2*toDeg, lng2*toDeg];
    }

    function eastwardVector(theta) {
      var dLat=Math.cos(theta), dLng=Math.sin(theta);
      if(dLng<0){dLat=-dLat;dLng=-dLng;}
      var bearing=Math.atan2(dLng,dLat)*180/Math.PI;
      if(bearing<0)bearing+=360;
      return {dLat:dLat, dLng:dLng, bearing:bearing};
    }

    function drawPredictionCorridor(fit) {
      var east = eastwardVector(fit.theta);
      var bearing = east.bearing, numSeg = 24;
      var lineCoords = [];
      for (var i = 0; i <= numSeg; i++) {
        lineCoords.push(gcDest(fit.cx, fit.cy, bearing, (i/numSeg) * CORRIDOR_DIST_DEG));
      }
      addLayer(L.polyline(lineCoords, {color:'#ff4444',weight:2.5,opacity:0.8,dashArray:'10,8',interactive:false}));
      // Arrow tip
      var tip = lineCoords[lineCoords.length-1], base = lineCoords[lineCoords.length-2];
      var vx=tip[0]-base[0], vy=tip[1]-base[1], vlen=Math.sqrt(vx*vx+vy*vy)||1;
      vx/=vlen; vy/=vlen;
      var as=0.12, px=-vy, py=vx;
      addLayer(L.polyline([
        [tip[0]+px*as*0.5-vx*as, tip[1]+py*as*0.5-vy*as],
        tip,
        [tip[0]-px*as*0.5-vx*as, tip[1]-py*as*0.5-vy*as]
      ], {color:'#ff4444',weight:2.5,opacity:0.8,interactive:false}));
      // Uncertainty band
      if (fit.dTheta > 0.005) {
        var bHi = eastwardVector(fit.theta+fit.dTheta).bearing;
        var bLo = eastwardVector(fit.theta-fit.dTheta).bearing;
        var hiC = [], loC = [];
        for (var i = 0; i <= numSeg; i++) {
          var d = (i/numSeg) * CORRIDOR_DIST_DEG;
          hiC.push(gcDest(fit.cx, fit.cy, bHi, d));
          loC.push(gcDest(fit.cx, fit.cy, bLo, d));
        }
        addLayer(L.polygon(hiC.concat(loC.slice().reverse()),
          {color:'#ff4444',fillColor:'#ff4444',fillOpacity:0.12,opacity:0.25,weight:1,interactive:false}));
      }
    }

    function clearPrediction() {
      for (var i = 0; i < predictionLayers.length; i++) map.removeLayer(predictionLayers[i]);
      predictionLayers = [];
      clearStatus();
    }

    // ----------------------------------------------------------------
    // Prepare cluster data (union boundary, initial guess) — synchronous.
    // Returns null if cluster doesn't meet minimum requirements.
    // ----------------------------------------------------------------
    function prepareCluster(cluster, locationPolygons) {
      // Attempt to build the union polygon boundary
      var boundary = clusterUnionBoundary(cluster, locationPolygons);

      // Fallback to convex hull of sampled polygon vertices if stitching fails
      if (boundary.length < 6) {
        var raw = [];
        for (var i = 0; i < cluster.length; i++) {
          var poly = locationPolygons[cluster[i][3]]; if (!poly) continue;
          var outer = polygonOuterRing(poly);
          for (var j = 0; j < outer.length; j++) raw.push([outer[j].lat, outer[j].lng]);
        }
        if (raw.length < 6) return null;
        boundary = convexHull(raw);
      }

      if (boundary.length < 4) return null;
      var guess = ellipseInitialGuess(boundary);
      return {hull: boundary, guess: guess};
    }

    // ----------------------------------------------------------------
    // Full fit for one cluster, plus slope-uncertainty bootstrap.
    // ----------------------------------------------------------------
    function computeFullFit(boundary, border, warmStart) {
      var fit = runFit(boundary, border, warmStart);
      var p = fit.params;
      var a = p[2], b = p[3], aspect = a > b ? a/b : b/a;
      // Slope uncertainty via even/odd boundary subsets
      var evenV = [], oddV = [];
      for (var i = 0; i < boundary.length; i++) (i%2 === 0 ? evenV : oddV).push(boundary[i]);
      var thetas = [p[4]];
      if (evenV.length >= 4 && oddV.length >= 4) {
        thetas = [runFit(evenV, border, p).params[4], runFit(oddV, border, p).params[4]];
      }
      function wrap(t) { return ((t+Math.PI/2)%Math.PI+Math.PI)%Math.PI-Math.PI/2; }
      var t0 = wrap(thetas[0]), t1 = wrap(thetas[thetas.length-1]);
      var dTheta = Math.abs(t0-t1); if (dTheta > Math.PI/2) dTheta = Math.PI - dTheta;
      return {cx:p[0], cy:p[1], a:a, b:b, theta:p[4], aspect:aspect, dTheta:dTheta, loss:fit.loss};
    }

    function clusterSignature(cluster) {
      return cluster.map(function(p) { return p[3]; }).sort().join('|');
    }

    // ----------------------------------------------------------------
    // Main update pipeline
    // ----------------------------------------------------------------
    function updatePredictionLines() {
      clearPrediction();
      if (!enabled) return;

      Promise.all([ensureOrefPoints(), ensureIsraelBorder()]).then(function(res) {
        var orefPts = res[0], border = res[1];
        var locationStates  = A.locationStates;
        var locationHistory = A.locationHistory;
        var locationPolygons = A.locationPolygons;
        var extHistory = A.extendedHistory;

        // Collect red seed points
        var locPoints = [];
        for (var name in locationStates) {
          var entry = locationStates[name]; if (!entry || entry.state !== 'red') continue;
          var pt = orefPts[name];
          if (!pt) { var poly = locationPolygons[name]; if (poly) pt = polygonCentroid(poly); }
          if (pt) locPoints.push([pt[0], pt[1], 1, name]);
        }
        if (locPoints.length < MIN_CLUSTER_RED) return;

        var clusters = clusterByAdjacency(locPoints, locationPolygons, locationStates);
        var now = Date.now(), liveSigs = Object.create(null);

        // ---- Phase 1 (sync): for each eligible cluster, draw boundary points +
        //      initial-guess ellipse immediately so the user sees something
        //      right away while the optimizer runs.
        var workItems = [];
        var clusterLabel = 0;
        for (var ci = 0; ci < clusters.length; ci++) {
          var cluster = clusters[ci];
          if (cluster.length < MIN_CLUSTER_RED) continue;

          // Find the earliest red alert timestamp in this cluster
          var earliest = Infinity;
          for (var k = 0; k < cluster.length; k++) {
            var ns = locationStates[cluster[k][3]];
            if (ns && ns.since && ns.since < earliest) earliest = ns.since;
          }
          if (!isFinite(earliest)) continue;

          // Iran/Yemen gate: spatially scoped to locations adjacent to this cluster
          var adjNames = clusterAdjacentNames(cluster, locationPolygons);
          if (!hasPrecedingYellow(earliest, locationHistory, extHistory, adjNames)) continue;

          var sig = clusterSignature(cluster);
          liveSigs[sig] = true;
          var prep = prepareCluster(cluster, locationPolygons);
          if (!prep) continue;
          clusterLabel++;
          var label = clusterLabel;

          // Draw union boundary vertices (green circles)
          for (var hi = 0; hi < prep.hull.length; hi++) {
            addLayer(L.circleMarker(prep.hull[hi], {
              radius:4, color:'#22cc44', fillColor:'#22cc44',
              fillOpacity:0.7, weight:1, interactive:false
            }));
          }
          // Draw initial-guess ellipse (dashed green)
          drawEllipseLayer(prep.guess, 60,
            {color:'#22cc44', weight:1.5, opacity:0.8, dashArray:'5,4', interactive:false});
          setStatus(label, 'C'+label+': ⟳ fitting…');
          workItems.push({label:label, sig:sig, prep:prep, cluster:cluster});
        }

        if (workItems.length === 0) return;

        // ---- Phase 2 (async, sequential): run full fit per cluster.
        //      setTimeout(0) between clusters yields to the browser so
        //      UI repaints between fits.
        function processNext(i) {
          if (i >= workItems.length) {
            // Clean stale cache
            for (var k in fitCache) {
              if (!liveSigs[k] || (now - fitCache[k].ts) >= CACHE_MAX_AGE_MS) delete fitCache[k];
            }
            return;
          }
          var w = workItems[i];
          var cached = fitCache[w.sig];
          if (cached && (now - cached.ts) < CACHE_MAX_AGE_MS) {
            // Reuse cached result, show original fit time with a "(cached)" note
            var fit = cached.fit;
            var dtStr = cached.dt !== undefined ? cached.dt + 'ms (cached)' : '(cached)';
            var bearingDeg = Math.round(eastwardVector(fit.theta).bearing);
            var statusStr = 'C'+w.label+': ✓ '+dtStr+' | aspect='+fit.aspect.toFixed(2)+' | θ='+bearingDeg+'°';
            if (fit.aspect < ASPECT_RATIO_MIN) statusStr += ' (too round, skipped)';
            setStatus(w.label, statusStr);
            if (fit.aspect >= ASPECT_RATIO_MIN) drawFinalResults(fit);
            setTimeout(function(next) { return function() { processNext(next); }; }(i+1), 0);
            return;
          }
          var t0 = performance.now();
          var fit = computeFullFit(w.prep.hull, border, w.prep.guess);
          var dt = Math.round(performance.now() - t0);
          fitCache[w.sig] = {fit:fit, ts:now, dt:dt};
          var bearingDeg = Math.round(eastwardVector(fit.theta).bearing);
          var statusStr = 'C'+w.label+': ✓ '+dt+'ms | aspect='+fit.aspect.toFixed(2)+' | θ='+bearingDeg+'°';
          if (fit.aspect < ASPECT_RATIO_MIN) statusStr += ' (too round, skipped)';
          setStatus(w.label, statusStr);
          if (fit.aspect >= ASPECT_RATIO_MIN) drawFinalResults(fit);
          setTimeout(function(next) { return function() { processNext(next); }; }(i+1), 0);
        }
        // Yield once before starting so initial-guess ellipses can render.
        setTimeout(function() { processNext(0); }, 0);

        // Clean cache entries for clusters no longer present
        for (var k in fitCache) {
          if (!liveSigs[k] || (now - fitCache[k].ts) >= CACHE_MAX_AGE_MS) delete fitCache[k];
        }

      }).catch(function(err) {
        console.warn('prediction update failed:', err);
      });
    }

    // Draw the best-fit ellipse (solid green) and prediction corridor (red arrow).
    function drawFinalResults(fit) {
      drawEllipseLayer([fit.cx, fit.cy, fit.a, fit.b, fit.theta], 80,
        {color:'#22cc44', weight:2, opacity:0.9, interactive:false});
      drawPredictionCorridor(fit);
    }

    // ----------------------------------------------------------------
    // Scheduling and lifecycle
    // ----------------------------------------------------------------
    function schedulePredictionUpdate() {
      if (predictionUpdateScheduled) return;
      predictionUpdateScheduled = true;
      requestAnimationFrame(function() { predictionUpdateScheduled = false; updatePredictionLines(); });
    }

    function sync() { if (enabled) schedulePredictionUpdate(); }

    function setEnabled(val, opts) {
      enabled = !!val;
      localStorage.setItem('oref-predict', enabled);
      if (opts && opts.showToast) showToast(enabled ? 'חיזוי כיוון שיגור מופעל' : 'חיזוי כיוון שיגור כובה');
      if (enabled) sync(); else clearPrediction();
    }

    var menuItem = document.getElementById('menu-predict');
    if (menuItem) {
      if (enabled) menuItem.classList.add('active');
      menuItem.querySelector('.menu-item-row').addEventListener('click', function() {
        var next = !enabled; setEnabled(next, {showToast:true}); menuItem.classList.toggle('active', next);
      });
    }

    document.addEventListener('app:stateChanged', function() { sync(); });
    document.addEventListener('app:escape', function() { clearPrediction(); });
    if (enabled) sync();
  }

  if (window.AppState) initPrediction();
  else document.addEventListener('app:ready', initPrediction);
})();

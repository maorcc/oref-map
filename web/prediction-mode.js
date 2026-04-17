(function() {
  'use strict';

  // ------------------------------------------------------------------
  // Launch-direction prediction — border-aware ellipse fitting.
  //
  // Strategy (see issue #136):
  //  1. Cluster red-alerted locations by polygon adjacency (direct touch OR
  //     bridged through a single non-red polygon).
  //  2. Gate each cluster on "yellow precedes red within 40 min", counting
  //     only yellow alerts from locations spatially adjacent to the cluster.
  //  3. Build the outer boundary ring of the union of all cluster polygons.
  //  4. Fit an ellipse to the boundary using Nelder-Mead with multiple
  //     starting conditions (PCA guess + rotated variants) to escape local
  //     minima. Loss = mean squared distance from ellipse sample points
  //     (inside Israel's land border) to the union boundary.
  //  5. Estimate slope uncertainty: analytical formula σ_θ≈(k/√N)·(AR/(AR²-1)).
  //  6. Draw the corridor (5000 km) starting from the major axis eastern tip,
  //     plus a cross showing both ellipse axes. Filter aspect ratio < 1.2.
  //
  // Visuals (when feature is enabled):
  //  - Union boundary points: small blue circles on each boundary vertex.
  //  - Initial-guess ellipse: dashed green polyline (drawn immediately).
  //  - Best-fit ellipse: solid green polyline + axis cross.
  //  - Corridor: red dashed line from major axis eastern tip toward source.
  //
  // Coordinate conventions:
  //  - Internal math:  [lat, lng]
  //  - GeoJSON output: [lng, lat]  (MapLibre standard)
  // ------------------------------------------------------------------

  var ASPECT_RATIO_MIN  = 1.2;
  var MIN_CLUSTER_RED   = 10;
  var FIT_NUM_PTS       = 40;
  var FIT_PHASE1_ITER   = 60;   // iterations per candidate starting point
  var FIT_PHASE2_ITER   = 80;   // refinement iterations from best candidate
  var CACHE_MAX_AGE_MS  = 10 * 60 * 1000;
  var CORRIDOR_DIST_DEG = 5000 / 111.32; // ~44.9 degrees
  var CLUSTER_TOL2        = 0.005 * 0.005; // ~500 m vertex proximity
  var BRIDGE_MAX_DIST2    = 0.35 * 0.35;  // ~39 km: bridge polygon cannot link clusters farther than this apart
  var YELLOW_GATE_WINDOW_MS = 40 * 60 * 1000; // 40 min: Iran/Yemen yellow can precede reds by up to ~30+ min

  function initPrediction() {
    var A = window.AppState;
    var map = A.map;
    var showToast = A.showToast;

    var israelBorder = null; // cached {bbox, points:[[lat,lng],...]} derived from A.israelBorder
    var enabled    = localStorage.getItem('oref-predict') === 'true';
    var predictionUpdateScheduled = false;
    var fitCache = Object.create(null);
    var activeRunId = 0; // incremented each updatePredictionLines call; stale processNext chains bail on mismatch

    // ----------------------------------------------------------------
    // Israel border (for border-aware ellipse loss)
    // Source of truth: the `_border` entry in locations_polygons.json, already
    // loaded by the main app and exposed via AppState.israelBorder as a raw
    // [[lng,lat],...] ring.  Convert once on first use: swap to [lat,lng] to
    // match the internal coord convention, and derive a bbox for the fast
    // reject in pointInBorder.
    // ----------------------------------------------------------------
    function getIsraelBorder() {
      if (israelBorder) return israelBorder;
      var raw = A.israelBorder;
      if (!raw || !raw.length) return null;
      var pts = new Array(raw.length);
      var minLat=Infinity, maxLat=-Infinity, minLng=Infinity, maxLng=-Infinity;
      for (var i = 0; i < raw.length; i++) {
        var lng = raw[i][0], lat = raw[i][1];
        pts[i] = [lat, lng];
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      }
      israelBorder = { bbox: {minLat:minLat, maxLat:maxLat, minLng:minLng, maxLng:maxLng}, points: pts };
      return israelBorder;
    }

    // ----------------------------------------------------------------
    // GeoJSON helpers (featureMap stores GeoJSON with [lng,lat] coords)
    // ----------------------------------------------------------------

    // GeoJSON Feature → centroid [lat, lng]
    function featureCentroid(feature) {
      var outer = feature.geometry.coordinates[0];
      if (!outer || outer.length === 0) return null;
      var sLat = 0, sLng = 0;
      for (var i = 0; i < outer.length; i++) { sLng += outer[i][0]; sLat += outer[i][1]; }
      return [sLat / outer.length, sLng / outer.length];
    }

    // Convert internal [lat,lng] to GeoJSON [lng,lat]
    function lngLat(p) { return [p[1], p[0]]; }

    // ----------------------------------------------------------------
    // MapLibre GL source/layer management
    // ----------------------------------------------------------------
    var SOURCE_ID = 'prediction-source';
    var allFeatures = [];
    var labelMarkers = [];   // maplibregl.Marker instances for cluster labels

    function pushFeature(f) { allFeatures.push(f); }

    function flushToMap() {
      var src = map.getSource(SOURCE_ID);
      if (src) src.setData({ type: 'FeatureCollection', features: allFeatures.slice() });
    }

    function clearAll() {
      allFeatures = [];
      var src = map.getSource(SOURCE_ID);
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
      for (var mi = 0; mi < labelMarkers.length; mi++) labelMarkers[mi].remove();
      labelMarkers = [];
    }

    function addLabelMarker(lat, lng, text) {
      var el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = 'color:#22cc44;font-size:11px;font-weight:bold;font-family:monospace;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;user-select:none';
      var m = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);
      labelMarkers.push(m);
    }

    function setupLayers() {
      if (map.getSource(SOURCE_ID)) return;
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({ id: 'prediction-band', type: 'fill', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'band'],
        paint: { 'fill-color': '#ff4444', 'fill-opacity': 0.1 } });
      map.addLayer({ id: 'prediction-corridor', type: 'line', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'corridor'],
        paint: { 'line-color': '#ff4444', 'line-width': 2.5, 'line-opacity': 0.8,
                 'line-dasharray': [10, 8] } });
      map.addLayer({ id: 'prediction-arrow', type: 'line', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'arrow'],
        paint: { 'line-color': '#ff4444', 'line-width': 2.5, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'prediction-ellipse', type: 'line', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'ellipse'],
        paint: { 'line-color': '#22cc44', 'line-width': 2, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'prediction-axes', type: 'line', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'axes'],
        paint: { 'line-color': '#22cc44', 'line-width': 1.5, 'line-opacity': 0.85 } });
      map.addLayer({ id: 'prediction-guess', type: 'line', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'guess'],
        paint: { 'line-color': '#22cc44', 'line-width': 1.5, 'line-opacity': 0.7,
                 'line-dasharray': [4, 4] } });
      map.addLayer({ id: 'prediction-debug-pts', type: 'circle', source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'point'],
        paint: { 'circle-radius': 2, 'circle-color': '#4488ff', 'circle-opacity': 0.8 } });
      // Note: cluster labels are rendered as maplibregl.Marker HTML elements
      // (see addLabelMarker) — no symbol layer needed, avoids glyph-loading errors.
    }

    // ----------------------------------------------------------------
    // Pure math (internal coordinates: [lat, lng])
    // ----------------------------------------------------------------

    // Ray-casting point-in-polygon. border = {bbox, points:[[lat,lng],...]}.
    function pointInBorder(lat, lng, border) {
      var bbox = border.bbox;
      if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) return false;
      var pts = border.points, n = pts.length, inside = false;
      for (var i = 0, j = n-1; i < n; j = i++) {
        var latI=pts[i][0], lngI=pts[i][1], latJ=pts[j][0], lngJ=pts[j][1];
        if ((latI > lat) !== (latJ > lat)) {
          var lngInt = lngI + (lngJ-lngI)*(lat-latI)/(latJ-latI+1e-20);
          if (lng < lngInt) inside = !inside;
        }
      }
      return inside;
    }

    function distToSegment(p, a, b) {
      var dx=b[0]-a[0], dy=b[1]-a[1], L2=dx*dx+dy*dy;
      if (L2 < 1e-20) { var qx=p[0]-a[0],qy=p[1]-a[1]; return Math.sqrt(qx*qx+qy*qy); }
      var t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2;
      if (t<0) t=0; else if (t>1) t=1;
      var px=a[0]+t*dx, py=a[1]+t*dy, rx=p[0]-px, ry=p[1]-py;
      return Math.sqrt(rx*rx+ry*ry);
    }

    function distToPolygonBoundary(p, poly) {
      var min=Infinity, n=poly.length;
      for (var i=0; i<n; i++) { var d=distToSegment(p, poly[i], poly[(i+1)%n]); if (d<min) min=d; }
      return min;
    }

    // Parametric ellipse sample points: params=[cx,cy,a,b,theta], returns [[lat,lng],...]
    function ellipsePoints(params, numPts) {
      var cx=params[0], cy=params[1], a=params[2], b=params[3], theta=params[4];
      var cosT=Math.cos(theta), sinT=Math.sin(theta), pts=new Array(numPts);
      for (var i=0; i<numPts; i++) {
        var phi=(i/numPts)*2*Math.PI, cp=Math.cos(phi), sp=Math.sin(phi);
        pts[i]=[cx+a*cp*cosT-b*sp*sinT, cy+a*cp*sinT+b*sp*cosT];
      }
      return pts;
    }

    // PCA initial guess → [cx, cy, a, b, theta]
    function ellipseInitialGuess(points) {
      var n=points.length, sx=0, sy=0;
      for (var i=0;i<n;i++){sx+=points[i][0];sy+=points[i][1];}
      var cx=sx/n, cy=sy/n, cxx=0, cxy=0, cyy=0;
      for (var i=0;i<n;i++){var dx=points[i][0]-cx,dy=points[i][1]-cy;cxx+=dx*dx;cxy+=dx*dy;cyy+=dy*dy;}
      cxx/=n;cxy/=n;cyy/=n;
      var diff=cxx-cyy, disc=Math.sqrt(diff*diff+4*cxy*cxy);
      var lam1=Math.max(0,(cxx+cyy+disc)/2), lam2=Math.max(0,(cxx+cyy-disc)/2);
      var a=Math.sqrt(2*lam1), b=Math.sqrt(2*lam2);
      var vx,vy;
      if (Math.abs(cxy)>1e-12){vx=lam1-cyy;vy=cxy;}
      else if (cxx>=cyy){vx=1;vy=0;}else{vx=0;vy=1;}
      var theta=Math.atan2(vy,vx);
      if (a<b){var t=a;a=b;b=t;theta+=Math.PI/2;}
      theta=((theta+Math.PI/2)%Math.PI+Math.PI)%Math.PI-Math.PI/2;
      if (a<1e-6)a=1e-6; if (b<1e-6)b=1e-6;
      return [cx,cy,a,b,theta];
    }

    // Compact Nelder-Mead optimizer. Returns {x, f}.
    function nelderMead(f, x0, step, maxIter) {
      var n=x0.length, alpha=1, gamma=2, rho=0.5, sigma=0.5;
      var simplex=new Array(n+1), values=new Array(n+1), order=new Array(n+1);
      simplex[0]=x0.slice(); values[0]=f(simplex[0]);
      for (var i=0;i<n;i++){var p=x0.slice();p[i]+=step[i];simplex[i+1]=p;values[i+1]=f(p);}
      function reorder(){for(var i=0;i<=n;i++)order[i]=i;order.sort(function(a,b){return values[a]-values[b];});}
      for (var iter=0;iter<maxIter;iter++){
        reorder();
        if (Math.abs(values[order[n]]-values[order[0]])<1e-9) break;
        var cent=new Array(n).fill(0);
        for (var i=0;i<n;i++){var s=simplex[order[i]];for(var j=0;j<n;j++)cent[j]+=s[j];}
        for (var j=0;j<n;j++) cent[j]/=n;
        var xw=simplex[order[n]];
        var xr=new Array(n); for(var j=0;j<n;j++) xr[j]=cent[j]+alpha*(cent[j]-xw[j]);
        var fr=f(xr);
        if (fr<values[order[n-1]]&&fr>=values[order[0]]){simplex[order[n]]=xr;values[order[n]]=fr;continue;}
        if (fr<values[order[0]]){
          var xe=new Array(n);for(var j=0;j<n;j++)xe[j]=cent[j]+gamma*(xr[j]-cent[j]);
          var fe=f(xe);
          if (fe<fr){simplex[order[n]]=xe;values[order[n]]=fe;}else{simplex[order[n]]=xr;values[order[n]]=fr;}
          continue;
        }
        var xc=new Array(n);for(var j=0;j<n;j++)xc[j]=cent[j]+rho*(xw[j]-cent[j]);
        var fc=f(xc);
        if (fc<values[order[n]]){simplex[order[n]]=xc;values[order[n]]=fc;continue;}
        var xb=simplex[order[0]];
        for (var i=1;i<=n;i++){var ss=simplex[order[i]];for(var j=0;j<n;j++)ss[j]=xb[j]+sigma*(ss[j]-xb[j]);values[order[i]]=f(ss);}
      }
      reorder(); return {x:simplex[order[0]],f:values[order[0]]};
    }

    function ellipseFitLoss(params, boundaryVerts, border, numPts, rMin, aspectMax) {
      var a=params[2], b=params[3];
      if (a<=1e-9||b<=1e-9) return 1e12;
      var pts=ellipsePoints(params,numPts), sumSq=0, nInside=0;
      for (var i=0;i<numPts;i++){
        if (!pointInBorder(pts[i][0],pts[i][1],border)) continue;
        nInside++; var d=distToPolygonBoundary(pts[i],boundaryVerts); sumSq+=d*d;
      }
      if (nInside===0) return 1e12;
      var ar=a>b?a/b:b/a;
      var lossAspect=ar>aspectMax?(ar-aspectMax):0, lossSize=0;
      if (a<rMin)lossSize+=(rMin-a)/rMin;
      if (b<rMin)lossSize+=(rMin-b)/rMin;
      return sumSq/nInside+lossAspect+lossSize;
    }

    // Single Nelder-Mead run from warmStart. Returns {params, loss}.
    function runFit(boundaryVerts, border, warmStart, maxIter) {
      var guess=warmStart?warmStart.slice():ellipseInitialGuess(boundaryVerts);
      var rMin=guess[2]/4;
      var minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
      for (var i=0;i<boundaryVerts.length;i++){
        if(boundaryVerts[i][0]<minLat)minLat=boundaryVerts[i][0];
        if(boundaryVerts[i][0]>maxLat)maxLat=boundaryVerts[i][0];
        if(boundaryVerts[i][1]<minLng)minLng=boundaryVerts[i][1];
        if(boundaryVerts[i][1]>maxLng)maxLng=boundaryVerts[i][1];
      }
      var dLat=Math.max(maxLat-minLat,0.01), dLng=Math.max(maxLng-minLng,0.01), dim=Math.max(dLat,dLng);
      var step=[0.15*dLat,0.15*dLng,0.2*dim,0.2*dim,0.1];
      var lossF=function(p){return ellipseFitLoss(p,boundaryVerts,border,FIT_NUM_PTS,rMin,4);};
      var res=nelderMead(lossF,guess,step,maxIter||FIT_PHASE1_ITER);
      var p=res.x.slice();
      if(p[3]>p[2]){var t=p[2];p[2]=p[3];p[3]=t;p[4]+=Math.PI/2;}
      p[4]=((p[4]+Math.PI/2)%Math.PI+Math.PI)%Math.PI-Math.PI/2;
      return {params:p, loss:res.f};
    }

    // Multi-start fitting: tries several starting conditions, refines the best.
    // Returns the full fit result. The returned aspect ratio is from the FINAL
    // optimized params — not the initial guess (which may be nearly round).
    function computeFullFit(boundary, border) {
      var guess=ellipseInitialGuess(boundary);
      var cx=guess[0],cy=guess[1],a=guess[2],b=guess[3],theta=guess[4];
      var rMin=a/4;
      var forced_b=Math.min(b, a/3);   // moderate aspect (~3:1)
      var thin_b  =Math.min(b, a/5);   // thin   aspect (~5:1)
      var big_a   =a*1.8;              // larger scale to allow center to drift outside border

      // Evaluate the PCA initial guess as a baseline — the optimizer must beat this.
      var guessLoss=ellipseFitLoss(guess,boundary,border,FIT_NUM_PTS,rMin,4);

      // Systematic exploration: PCA angles + key rotations, multiple aspect ratios,
      // multiple scales.  Phase-1 quickly finds the best basin; phase-2 refines it.
      var candidates=[
        // PCA guess — full angle sweep every 30°
        [cx,cy,a,b,theta],
        [cx,cy,a,b,theta+Math.PI/6],
        [cx,cy,a,b,theta+Math.PI/3],
        [cx,cy,a,b,theta+Math.PI/2],
        [cx,cy,a,b,theta-Math.PI/6],
        [cx,cy,a,b,theta-Math.PI/3],
        // Moderate aspect ratio at key angles
        [cx,cy,a,forced_b,theta],
        [cx,cy,a,forced_b,theta+Math.PI/4],
        [cx,cy,a,forced_b,theta+Math.PI/2],
        [cx,cy,a,forced_b,theta-Math.PI/4],
        // Thin aspect ratio at key angles
        [cx,cy,a,thin_b,theta],
        [cx,cy,a,thin_b,theta+Math.PI/4],
        [cx,cy,a,thin_b,theta+Math.PI/2],
        // Large scale variants (allow center to drift outside border)
        [cx,cy,big_a,forced_b,theta],
        [cx,cy,big_a,thin_b,theta+Math.PI/4]
      ];

      var bestPhase1=null;
      for (var k=0;k<candidates.length;k++){
        var res=runFit(boundary,border,candidates[k],FIT_PHASE1_ITER);
        if (!bestPhase1||res.loss<bestPhase1.loss) bestPhase1=res;
      }

      var finalRes=runFit(boundary,border,bestPhase1.params,FIT_PHASE2_ITER);

      // Revert to the PCA initial guess if the optimizer produced a worse result.
      // Three failure modes all fall back the same way:
      //   1. Optimizer loss > initial-guess loss (NM drifted to a worse basin).
      //   2. Both optimised semi-axes < rMin (= a/4): the ellipse collapsed to a near-
      //      point.  Using rMin (not 'a') avoids false positives when NM legitimately
      //      finds a more compact, better-aligned ellipse (e.g. PCA a=2.0°, NM a=1.5°).
      //   3. < 10% of ellipse sample points inside Israel's border (off-border basin).
      var fa0=finalRes.params[2], fb0=finalRes.params[3];
      var testPts=ellipsePoints(finalRes.params,FIT_NUM_PTS);
      var nInsideTest=0;
      for(var fi=0;fi<FIT_NUM_PTS;fi++){
        if(pointInBorder(testPts[fi][0],testPts[fi][1],border)) nInsideTest++;
      }
      if(guessLoss<finalRes.loss
         ||Math.max(fa0,fb0)<rMin       // collapsed to near-point (< a/4)
         ||nInsideTest/FIT_NUM_PTS<0.10){
        finalRes={params:guess.slice(),loss:guessLoss};
      }

      var p=finalRes.params;
      var fa=p[2],fb=p[3],aspect=fa>fb?fa/fb:fb/fa;

      // Slope uncertainty: analytical formula σ_θ ≈ (k/√N)·(AR/(AR²-1))
      // where k = 2/3 (empirically calibrated to match observed corridor spread
      // across the 08.04.26 and 21.03.26 events), N = boundary sample-point count,
      // AR = aspect ratio.  Near-circular fits (AR ≈ 1) → cap at π/2.
      var N=boundary.length;
      var dTheta;
      if(aspect<1.01){
        dTheta=Math.PI/2;
      }else{
        dTheta=(2.0/3.0/Math.sqrt(N))*(aspect/(aspect*aspect-1));
        if(dTheta>Math.PI/2)dTheta=Math.PI/2;
      }

      return {cx:p[0],cy:p[1],a:fa,b:fb,theta:p[4],aspect:aspect,dTheta:dTheta,loss:finalRes.loss};
    }

    // ----------------------------------------------------------------
    // Clustering: direct touch + single non-red bridge polygon
    // ----------------------------------------------------------------
    function clusterByAdjacency(redPoints, featureMap, locationStates) {
      var n=redPoints.length; if(n===0) return [];
      var locVerts=new Array(n);
      for (var i=0;i<n;i++){
        var feat=featureMap[redPoints[i][3]],vs=[];
        if(feat){var outer=feat.geometry.coordinates[0];for(var j=0;j<outer.length;j++)vs.push([outer[j][1],outer[j][0]]);}
        locVerts[i]=vs;
      }
      var parent=new Array(n); for(var i=0;i<n;i++)parent[i]=i;
      function find(i){while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;}
      function union(i,j){var ri=find(i),rj=find(j);if(ri!==rj)parent[ri]=rj;}

      for(var i=0;i<n;i++){for(var j=i+1;j<n;j++){
        if(find(i)===find(j))continue;
        var vi=locVerts[i],vj=locVerts[j],found=false;
        for(var a=0;a<vi.length&&!found;a++)for(var b=0;b<vj.length&&!found;b++){
          var dl=vi[a][0]-vj[b][0],dg=vi[a][1]-vj[b][1];
          if(dl*dl+dg*dg<CLUSTER_TOL2){union(i,j);found=true;}
        }
      }}

      var redNameToIdx=Object.create(null); for(var i=0;i<n;i++)redNameToIdx[redPoints[i][3]]=i;
      for(var locName in featureMap){
        if(redNameToIdx[locName]!==undefined)continue;
        var st=locationStates?locationStates[locName]:null; if(st&&st.state==='red')continue;
        var bf=featureMap[locName]; if(!bf)continue;
        var bo=bf.geometry.coordinates[0]; if(!bo.length)continue;
        var touchingRed=[];
        for(var i=0;i<n;i++){
          var vi=locVerts[i],touches=false;
          for(var a=0;a<bo.length&&!touches;a++){
            var bLat=bo[a][1],bLng=bo[a][0];
            for(var b=0;b<vi.length&&!touches;b++){
              var dl=bLat-vi[b][0],dg=bLng-vi[b][1];
              if(dl*dl+dg*dg<CLUSTER_TOL2)touches=true;
            }
          }
          if(touches)touchingRed.push(i);
        }
        // Only bridge clusters that are geographically close.  A bridge polygon
        // that would link the southern and central clusters (>100 km apart) must
        // be enormous; limiting to ~39 km prevents accidental long-range merges.
        for(var ti=1;ti<touchingRed.length;ti++){
          var r0=touchingRed[0],ri=touchingRed[ti];
          if(find(r0)===find(ri))continue;
          var dl=redPoints[r0][0]-redPoints[ri][0],dg=redPoints[r0][1]-redPoints[ri][1];
          if(dl*dl+dg*dg<=BRIDGE_MAX_DIST2)union(r0,ri);
        }
      }

      var groups=Object.create(null);
      for(var i=0;i<n;i++){var r=find(i);if(!groups[r])groups[r]=[];groups[r].push(redPoints[i]);}
      return Object.keys(groups).map(function(k){return groups[k];});
    }

    // ----------------------------------------------------------------
    // Union polygon boundary (outer ring of polygon union)
    // ----------------------------------------------------------------
    function convexHull(points) {
      var n=points.length; if(n<3)return points.slice();
      var pts=points.slice().sort(function(a,b){return a[0]-b[0]||a[1]-b[1];});
      function cross(O,A,B){return(A[0]-O[0])*(B[1]-O[1])-(A[1]-O[1])*(B[0]-O[0]);}
      var lower=[],upper=[];
      for(var i=0;i<n;i++){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],pts[i])<=0)lower.pop();lower.push(pts[i]);}
      for(var i=n-1;i>=0;i--){while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],pts[i])<=0)upper.pop();upper.push(pts[i]);}
      lower.pop();upper.pop();return lower.concat(upper);
    }

    function clusterUnionBoundary(cluster, featureMap) {
      var QFACTOR=1e4;
      function qn(x){return Math.round(x*QFACTOR)/QFACTOR;}
      function vkey(lat,lng){return qn(lat)+','+qn(lng);}
      var edgeCount=Object.create(null),edgeEnds=Object.create(null);
      for(var i=0;i<cluster.length;i++){
        var feat=featureMap[cluster[i][3]]; if(!feat)continue;
        var outer=feat.geometry.coordinates[0],nn=outer.length;
        for(var j=0;j<nn;j++){
          var lat1=outer[j][1],lng1=outer[j][0],lat2=outer[(j+1)%nn][1],lng2=outer[(j+1)%nn][0];
          var ak=vkey(lat1,lng1),bk=vkey(lat2,lng2);
          if(ak===bk)continue;
          var ekey=ak<bk?ak+'|'+bk:bk+'|'+ak;
          edgeCount[ekey]=(edgeCount[ekey]||0)+1;
          if(!edgeEnds[ekey])edgeEnds[ekey]=[[qn(lat1),qn(lng1)],[qn(lat2),qn(lng2)]];
        }
      }
      var adj=Object.create(null),pos=Object.create(null);
      for(var ekey in edgeCount){
        if(edgeCount[ekey]!==1)continue;
        var e=edgeEnds[ekey];
        var ak=vkey(e[0][0],e[0][1]),bk=vkey(e[1][0],e[1][1]);
        pos[ak]=e[0];pos[bk]=e[1];
        if(!adj[ak])adj[ak]=[];if(!adj[bk])adj[bk]=[];
        adj[ak].push(bk);adj[bk].push(ak);
      }
      var vkeys=Object.keys(adj); if(vkeys.length===0)return[];
      var startKey=vkeys[0];
      for(var i=1;i<vkeys.length;i++){var p=pos[vkeys[i]],sp=pos[startKey];if(p[0]<sp[0]||(p[0]===sp[0]&&p[1]<sp[1]))startKey=vkeys[i];}
      var adjCopy=Object.create(null);
      for(var k in adj)adjCopy[k]=adj[k].slice();
      var ring=[pos[startKey]],prev=null,curr=startKey;
      // Termination limit: a simple ring visits exactly vkeys.length edges before
      // returning to startKey and breaking.  The +4 margin covers T-junctions or
      // other minor topology irregularities (stray isolated edges, duplicate verts
      // at precision boundaries) where the walk may take one or two extra steps
      // before the startKey break fires.  A corrupt/partial ring of this size still
      // passes the length<6 guard in prepareClusterEdgeSampled and triggers the
      // convex-hull fallback, so the extra steps are safe.
      for(var step=0;step<vkeys.length+4;step++){
        var neighbors=adjCopy[curr];
        if(!neighbors||neighbors.length===0)break;
        var next;
        if(neighbors.length===1){next=neighbors[0];}
        else{
          var cp=pos[curr],pp=prev?pos[prev]:null,bestKey=null,bestAng=Math.PI*3;
          for(var ni=0;ni<neighbors.length;ni++){
            var nk=neighbors[ni];
            if(pp){var v1x=cp[0]-pp[0],v1y=cp[1]-pp[1],np=pos[nk],v2x=np[0]-cp[0],v2y=np[1]-cp[1];
              var a1=Math.atan2(v1y,v1x),a2=Math.atan2(v2y,v2x),dd=(a2-a1+Math.PI)%(2*Math.PI)-Math.PI;
              if(Math.abs(dd)<bestAng){bestAng=Math.abs(dd);bestKey=nk;}}
            else{bestKey=nk;break;}
          }
          next=bestKey||neighbors[0];
        }
        adjCopy[curr]=adjCopy[curr].filter(function(k){return k!==next;});
        if(adjCopy[next])adjCopy[next]=adjCopy[next].filter(function(k){return k!==curr;});
        if(next===startKey)break;
        ring.push(pos[next]);prev=curr;curr=next;
      }
      return ring;
    }

    // Edge-sampling: same union boundary ring, but sample points are
    // placed at equal arc-length intervals instead of using the raw vertices.
    // This removes the bias that arises when small polygons (with many short
    // edges) contribute more vertices than large polygons with fewer vertices.
    function prepareClusterEdgeSampled(cluster, featureMap) {
      var boundary=clusterUnionBoundary(cluster,featureMap);
      if(boundary.length<6){
        var raw=[];
        for(var i=0;i<cluster.length;i++){
          var feat=featureMap[cluster[i][3]]; if(!feat)continue;
          var outer=feat.geometry.coordinates[0];
          for(var j=0;j<outer.length;j++)raw.push([outer[j][1],outer[j][0]]);
        }
        if(raw.length<6)return null;
        boundary=convexHull(raw);
      }
      if(boundary.length<4)return null;

      // Compute total perimeter of the ring
      var n=boundary.length, totalLen=0, segLens=new Array(n);
      for(var i=0;i<n;i++){
        var p1=boundary[i],p2=boundary[(i+1)%n];
        var dx=p2[0]-p1[0],dy=p2[1]-p1[1];
        segLens[i]=Math.sqrt(dx*dx+dy*dy);
        totalLen+=segLens[i];
      }
      if(totalLen<1e-9){var guess0=ellipseInitialGuess(boundary);return{hull:boundary,guess:guess0};}

      // Place n equidistant samples (same count as vertices)
      var step=totalLen/n, samples=[], acc=0, next=0;
      for(var i=0;i<n;i++){
        var p1=boundary[i],p2=boundary[(i+1)%n],segEnd=acc+segLens[i];
        while(next<=segEnd&&samples.length<n){
          var t=(next-acc)/Math.max(segLens[i],1e-12);
          samples.push([p1[0]+t*(p2[0]-p1[0]),p1[1]+t*(p2[1]-p1[1])]);
          next+=step;
        }
        acc=segEnd;
      }
      if(samples.length<4)return null;
      var guess=ellipseInitialGuess(samples);
      return {hull:samples,guess:guess};
    }

    // Build a location→events index from extHistory for O(1) per-location lookup.
    function buildHistoryIndex(extHistory) {
      var idx=Object.create(null);
      for(var i=0;i<extHistory.length;i++){
        var e=extHistory[i];
        if(!idx[e.location])idx[e.location]=[];
        idx[e.location].push(e);
      }
      return idx;
    }

    // Merge fresh locationHistory entries into histIdx.
    // extHistory lags live alerts by several seconds; locationHistory has them
    // immediately, so omitting it can cause the yellow gate to miss a brand-new
    // yellow or anchor lastRedTs on a stale earlier wave at the start of a live event.
    function mergeLocationHistory(histIdx, locationHistory, cutoffTs) {
      for(var name in locationHistory){
        var arr=locationHistory[name]; if(!arr||!arr.length)continue;
        for(var i=0;i<arr.length;i++){
          var e=arr[i]; if(!e)continue;
          var ts=typeof e.alertDate==='number'?e.alertDate:Date.parse(String(e.alertDate).replace(' ','T'));
          if(!ts||isNaN(ts)||ts>cutoffTs)continue;
          if(!histIdx[name])histIdx[name]=[];
          histIdx[name].push({location:name,alertDate:ts,state:e.state,title:e.title});
        }
      }
    }

    // Build name set of cluster members + all polygons that touch any cluster polygon.
    // The yellow early warning can land on a touching polygon that never turns red, so
    // the yellow scan must include adjacent locations, not just the red cluster members.
    function buildAdjacentNameSet(cluster, featureMap) {
      var nameSet=Object.create(null);
      var clusterVerts=[];
      for(var ci=0;ci<cluster.length;ci++){
        nameSet[cluster[ci][3]]=true;
        var feat=featureMap[cluster[ci][3]]; if(!feat)continue;
        var outer=feat.geometry.coordinates[0];
        for(var vi=0;vi<outer.length;vi++)clusterVerts.push([outer[vi][1],outer[vi][0]]);
      }
      for(var locName in featureMap){
        if(nameSet[locName])continue;
        var bf=featureMap[locName]; if(!bf)continue;
        var bo=bf.geometry.coordinates[0]; if(!bo.length)continue;
        var touches=false;
        for(var a=0;a<bo.length&&!touches;a++){
          var bLat=bo[a][1],bLng=bo[a][0];
          for(var b=0;b<clusterVerts.length&&!touches;b++){
            var dl=bLat-clusterVerts[b][0],dg=bLng-clusterVerts[b][1];
            if(dl*dl+dg*dg<CLUSTER_TOL2)touches=true;
          }
        }
        if(touches)nameSet[locName]=true;
      }
      return nameSet;
    }

    // Yellow gate: passes iff at least one cluster polygon (or spatially adjacent polygon)
    // had a yellow alert in YELLOW_GATE_WINDOW_MS (40 min) immediately before the MOST
    // RECENT red event in the cluster.  Using the most recent red (not the earliest)
    // ensures the window is anchored to the current attack wave, not an earlier one.
    //
    // Example bugs this fixes (both share the same root cause):
    //   False-positive  20.3.26 18:22 Lebanon: cluster locations had old Iran reds at
    //     ~10:00 in extHistory; firstRedTs=10:00 window found the 09:50 Iran yellow,
    //     incorrectly passing a direct-red Lebanon cluster.
    //   False-negative  21.3.26 22:33 Iran: cluster had old Lebanon reds at ~09:00;
    //     firstRedTs=09:00 window missed the real yellow at 22:23, rejecting a valid
    //     Iran/Yemen attack cluster.
    //   Fix: lastRedTs=max(reds) anchors the window to the most recent wave.
    // cutoffTs = effective "now": Date.now() in live mode, viewTime in history mode.
    // extHistory covers the full day, so without a cutoff the scan for lastRedTs can
    // pick up reds from later waves (e.g. 03:23 when viewing 01:55), shifting the
    // yellow window to the wrong attack wave.
    // histIdx  = buildHistoryIndex(extHistory) — per-location event list.
    // adjNames = buildAdjacentNameSet(cluster, featureMap) — cluster + touching polygons.
    function hasYellowSequenceInCluster(cluster, histIdx, cutoffTs, adjNames) {
      // Red scan: cluster members only — we anchor on the wave these locations actually experienced.
      var lastRedTs=-Infinity;
      for(var ky=0;ky<cluster.length;ky++){
        var entries=histIdx[cluster[ky][3]]; if(!entries)continue;
        for(var i=0;i<entries.length;i++){
          var e=entries[i];
          if(e.state==='red'&&e.alertDate<=cutoffTs&&e.alertDate>lastRedTs)lastRedTs=e.alertDate;
        }
      }
      if(!isFinite(lastRedTs)) return false;

      // Yellow scan: cluster members + spatially adjacent polygons.
      // Iran/Yemen early warnings can land on a touching polygon that never turns red.
      var windowStart=lastRedTs-YELLOW_GATE_WINDOW_MS;
      for(var loc in adjNames){
        var entries=histIdx[loc]; if(!entries)continue;
        for(var i=0;i<entries.length;i++){
          var e=entries[i];
          if(e.state==='yellow'&&e.alertDate>=windowStart&&e.alertDate<=lastRedTs)return true;
        }
      }
      return false;
    }

    // Fuzzy cache lookup: also matches a cached cluster if the current cluster is
    // a superset of it and fewer than 10% new locations were added.
    function findCompatibleCache(sig, clusterLocs, clusterSize, cache, now) {
      var exact=cache[sig];
      if(exact&&(now-exact.ts)<CACHE_MAX_AGE_MS) return exact;
      for(var k in cache){
        var entry=cache[k]; if((now-entry.ts)>=CACHE_MAX_AGE_MS) continue;
        if(!entry.locs) continue;
        var cachedN=entry.size||0; if(cachedN>clusterSize) continue;
        if((clusterSize-cachedN)/clusterSize>=0.10) continue; // >10% new → refit
        var isSubset=true;
        for(var loc in entry.locs){if(!clusterLocs[loc]){isSubset=false;break;}}
        if(isSubset) return entry;
      }
      return null;
    }

    // ----------------------------------------------------------------
    // Geodesic helpers
    // ----------------------------------------------------------------
    function gcDest(lat, lng, bearingDeg, distDeg) {
      var R=Math.PI/180,D=180/Math.PI;
      var lat1=lat*R,lng1=lng*R,brng=bearingDeg*R,d=distDeg*R;
      var lat2=Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
      var lng2=lng1+Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1),Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
      return [lat2*D,lng2*D];
    }

    // Return eastward direction unit vector and bearing from ellipse theta.
    function eastwardVector(theta) {
      var dLat=Math.cos(theta),dLng=Math.sin(theta);
      if(dLng<0){dLat=-dLat;dLng=-dLng;}
      var bearing=Math.atan2(dLng,dLat)*180/Math.PI;
      if(bearing<0)bearing+=360;
      return {dLat:dLat,dLng:dLng,bearing:bearing};
    }

    // ----------------------------------------------------------------
    // GeoJSON feature builders
    // ----------------------------------------------------------------
    function makeLineFeature(coords, kind) {
      // coords: [[lat,lng],...] — converted to GeoJSON [lng,lat]
      return {type:'Feature',geometry:{type:'LineString',coordinates:coords.map(lngLat)},properties:{kind:kind}};
    }

    function makeEllipseFeature(params, numPts, kind) {
      var pts=ellipsePoints(params,numPts);
      pts.push(pts[0]);
      return makeLineFeature(pts,kind);
    }

    // Major + minor axis cross as a MultiLineString
    function makeAxesFeature(fit) {
      var east=eastwardVector(fit.theta);
      var mj_dLat=east.dLat,mj_dLng=east.dLng;    // major axis direction (eastward)
      var mn_dLat=-mj_dLng,mn_dLng=mj_dLat;        // minor axis (perpendicular, 90° CCW)
      var majP1=[fit.cx+fit.a*mj_dLat,fit.cy+fit.a*mj_dLng];
      var majP2=[fit.cx-fit.a*mj_dLat,fit.cy-fit.a*mj_dLng];
      var minP1=[fit.cx+fit.b*mn_dLat,fit.cy+fit.b*mn_dLng];
      var minP2=[fit.cx-fit.b*mn_dLat,fit.cy-fit.b*mn_dLng];
      return {
        type:'Feature',
        geometry:{type:'MultiLineString',coordinates:[
          [lngLat(majP2),lngLat([fit.cx,fit.cy]),lngLat(majP1)],
          [lngLat(minP2),lngLat([fit.cx,fit.cy]),lngLat(minP1)]
        ]},
        properties:{kind:'axes'}
      };
    }

    // Corridor: starts from eastern major axis tip (not center)
    function makeCorridor(fit) {
      var features=[];
      var east=eastwardVector(fit.theta);
      // Eastern tip of major axis
      var tipLat=fit.cx+fit.a*east.dLat;
      var tipLng=fit.cy+fit.a*east.dLng;
      var bearing=east.bearing,numSeg=24;
      var lineCoords=[];
      for(var i=0;i<=numSeg;i++)lineCoords.push(gcDest(tipLat,tipLng,bearing,(i/numSeg)*CORRIDOR_DIST_DEG));
      features.push(makeLineFeature(lineCoords,'corridor'));

      // Arrowhead
      var tip=lineCoords[lineCoords.length-1],base=lineCoords[lineCoords.length-2];
      var vx=tip[0]-base[0],vy=tip[1]-base[1],vlen=Math.sqrt(vx*vx+vy*vy)||1;
      vx/=vlen;vy/=vlen;
      var as=0.12,px=-vy,py=vx;
      features.push({type:'Feature',geometry:{type:'LineString',coordinates:[
        lngLat([tip[0]+px*as*0.5-vx*as,tip[1]+py*as*0.5-vy*as]),
        lngLat(tip),
        lngLat([tip[0]-px*as*0.5-vx*as,tip[1]-py*as*0.5-vy*as])
      ]},properties:{kind:'arrow'}});

      // Uncertainty band
      if(fit.dTheta>0.005){
        var bHi=eastwardVector(fit.theta+fit.dTheta).bearing;
        var bLo=eastwardVector(fit.theta-fit.dTheta).bearing;
        var hiC=[],loC=[];
        for(var i=0;i<=numSeg;i++){var d=(i/numSeg)*CORRIDOR_DIST_DEG;hiC.push(gcDest(tipLat,tipLng,bHi,d));loC.push(gcDest(tipLat,tipLng,bLo,d));}
        var ring=hiC.concat(loC.slice().reverse());ring.push(ring[0]);
        features.push({type:'Feature',geometry:{type:'Polygon',coordinates:[ring.map(lngLat)]},properties:{kind:'band'}});
      }
      return features;
    }

    function clusterSignature(cluster) {
      return cluster.map(function(p){return p[3];}).sort().join('|');
    }

    // ----------------------------------------------------------------
    // Main update pipeline
    // ----------------------------------------------------------------
    function updatePredictionLines() {
      if (!enabled) return;

      // The yellow gate reads extendedHistory which is populated by an async
      // day-history fetch.  The live alert API fires within ~1s of page load,
      // so prediction can run before extendedHistory has any entries — causing
      // every yellow-gate check to silently fail (empty array → no yellow found).
      // Wait until dayHistoryReady is true, then retry.
      if (!A.dayHistoryReady) {
        setTimeout(function(){if(enabled)sync();}, 3000);
        return; // keep any previous prediction visible; don't clear
      }

      // Monotonic run token: if sync() fires again (e.g. live 1-second poll) while a
      // prior processNext chain is still running, the stale chain detects the mismatch
      // and exits without touching the map — preventing geometry corruption.
      var runId = ++activeRunId;

      var border = getIsraelBorder();
      if (!border) return; // polygons (and thus _border) not loaded yet; next sync() will retry

      A.ensureOrefPoints().then(function(orefPts) {
        if(runId!==activeRunId)return; // superseded by a newer run

        var locationStates=A.locationStates;
        var featureMap=A.featureMap,extHistory=A.extendedHistory,locationHistory=A.locationHistory;
        // In history mode viewTime is the scrubbed timestamp; in live mode use now.
        // This caps extHistory scans to entries ≤ the currently displayed moment,
        // preventing future reds in the full-day extHistory from shifting the
        // yellow-gate window to the wrong wave.
        var cutoffTs=A.isLiveMode?Date.now():A.viewTime;

        // Clear previous render inside the Promise so the old overlay stays visible
        // until we know what to draw — eliminates the blank flash on every poll tick.
        clearAll();

        var locPoints=[];
        for(var name in locationStates){
          var entry=locationStates[name]; if(!entry||entry.state!=='red')continue;
          var pt=orefPts[name];
          if(!pt){var feat=featureMap[name];if(feat)pt=featureCentroid(feat);}
          if(pt)locPoints.push([pt[0],pt[1],1,name]);
        }

        if(locPoints.length<MIN_CLUSTER_RED){return;}

        var clusters=clusterByAdjacency(locPoints,featureMap,locationStates);
        // Index extHistory by location, then overlay fresh locationHistory entries.
        // locationHistory has live alerts immediately; extHistory lags by several
        // seconds, so without the merge the gate can miss a brand-new yellow or
        // anchor lastRedTs on a stale wave right when prediction matters most.
        var histIdx=buildHistoryIndex(extHistory);
        mergeLocationHistory(histIdx,locationHistory,cutoffTs);

        var now=Date.now(),liveSigs=Object.create(null);
        var workItems=[],clusterLabel=0;

        for(var ci=0;ci<clusters.length;ci++){
          var cluster=clusters[ci];

          if(cluster.length<MIN_CLUSTER_RED){continue;}

          // Yellow gate: at least one cluster (or adjacent) location must have had a yellow
          // alert immediately before its current red wave.
          // Lebanon/Gaza attacks that go directly red (no Iran-style yellow) are rejected.
          var adjNames=buildAdjacentNameSet(cluster,featureMap);
          if(!hasYellowSequenceInCluster(cluster,histIdx,cutoffTs,adjNames)){continue;}

          var sig=clusterSignature(cluster);
          liveSigs[sig]=true;
          var clusterLocs=Object.create(null);
          for(var k=0;k<cluster.length;k++) clusterLocs[cluster[k][3]]=true;
          var prep=prepareClusterEdgeSampled(cluster,featureMap);
          if(!prep){continue;}

          clusterLabel++;
          workItems.push({clLabel:'#'+clusterLabel,sig:sig,prep:prep,clusterLocs:clusterLocs,clusterSize:cluster.length});
        }

        if(workItems.length===0)return;

        function processNext(i){
          // Bail if a newer updatePredictionLines call has superseded this run.
          // Prevents a slow NM chain from overwriting a fresher render.
          if(runId!==activeRunId)return;

          if(i>=workItems.length){
            for(var k in fitCache){if(!liveSigs[k]||(now-fitCache[k].ts)>=CACHE_MAX_AGE_MS)delete fitCache[k];}
            return;
          }
          var w=workItems[i];
          var cached=findCompatibleCache(w.sig,w.clusterLocs,w.clusterSize,fitCache,now);
          if(cached){
            // Only draw if the cached fit meets the aspect threshold; no preview needed.
            if(cached.fit.aspect>=ASPECT_RATIO_MIN)drawFinalResults(cached.fit,w.clLabel);
            setTimeout(function(next){return function(){processNext(next);};}(i+1),0);
            return;
          }
          // Run the multi-start NM fit. Preview geometry is drawn only for clusters
          // that pass the aspect gate, preventing stale dashed ellipses from
          // accumulating on clusters that will ultimately be rejected.
          var fit=computeFullFit(w.prep.hull,border);
          fitCache[w.sig]={fit:fit,ts:now,locs:w.clusterLocs,size:w.clusterSize};
          if(fit.aspect>=ASPECT_RATIO_MIN){
            // Draw boundary sample points and initial-guess ellipse as debug visuals,
            // then immediately overlay the final optimised result.
            for(var hi=0;hi<w.prep.hull.length;hi++){
              pushFeature({type:'Feature',geometry:{type:'Point',coordinates:lngLat(w.prep.hull[hi])},properties:{kind:'point'}});
            }
            pushFeature(makeEllipseFeature(w.prep.guess,60,'guess'));
            drawFinalResults(fit,w.clLabel);
          }
          setTimeout(function(next){return function(){processNext(next);};}(i+1),0);
        }
        setTimeout(function(){processNext(0);},0);

      }).catch(function(err){console.warn('prediction update failed:',err);});
    }

    function drawFinalResults(fit, clLabel) {
      pushFeature(makeEllipseFeature([fit.cx,fit.cy,fit.a,fit.b,fit.theta],80,'ellipse'));
      pushFeature(makeAxesFeature(fit));
      var cf=makeCorridor(fit);
      for(var i=0;i<cf.length;i++)pushFeature(cf[i]);
      flushToMap();
      // HTML marker label at ellipse center — uses Marker to avoid glyph loading
      if(clLabel) addLabelMarker(fit.cx, fit.cy, clLabel);
    }

    // ----------------------------------------------------------------
    // Scheduling and lifecycle
    // ----------------------------------------------------------------
    function schedulePredictionUpdate(){
      if(predictionUpdateScheduled)return;
      predictionUpdateScheduled=true;
      requestAnimationFrame(function(){predictionUpdateScheduled=false;updatePredictionLines();});
    }
    function sync(){if(enabled)schedulePredictionUpdate();}
    function setEnabled(val,opts){
      enabled=!!val;
      // Bump the run token on disable so any in-flight Promise/processNext chain
      // sees a mismatch and stops painting before clearAll() wipes the canvas.
      if(!enabled)activeRunId++;
      localStorage.setItem('oref-predict',enabled);
      if(opts&&opts.showToast)showToast(enabled?'שיערוך מקור שיגור מופעל':'שיערוך מקור שיגור כובה');
      if(enabled)sync();else clearAll();
    }

    function setupAndInit(){
      setupLayers();
      var menuItem=document.getElementById('menu-predict');
      if(menuItem){
        if(enabled)menuItem.classList.add('active');
        menuItem.querySelector('.menu-item-row').addEventListener('click',function(){
          var next=!enabled;setEnabled(next,{showToast:true});menuItem.classList.toggle('active',next);
        });
      }
      document.addEventListener('app:stateChanged',function(){sync();});
      document.addEventListener('app:escape',function(){if(!enabled)clearAll();});
      if(enabled)sync();
    }

    if(map.loaded()){setupAndInit();}
    else{map.once('load',setupAndInit);}
  }

  if(window.AppState)initPrediction();
  else document.addEventListener('app:ready',initPrediction);
})();

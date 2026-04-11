# Ellipse Mode

## Purpose

Ellipse mode is an optional map overlay that groups currently displayed red-alert locations into large contiguous clusters and draws one fitted geometry per cluster.

The feature serves two related goals:

- provide a compact visual summary of a large red-alert region
- provide a user-relative interpretation of the nearest displayed cluster when location access is enabled

The implementation lives in [web/ellipse-mode.js](/home/tomer/projects/oref-map/web/ellipse-mode.js).

## Activation

Ellipse mode is loaded from `web/index.html` and initialized after `AppState` is ready.

User-facing behavior:

- the feature is toggled by the ellipse button in the right-side menu
- enabled state is persisted in `localStorage` under `oref-ellipse-mode`
- when enabled, the menu item receives the `active` class
- if the user has location enabled, the toast explains that the ellipse is shown relative to the current position
- if the user does not have location enabled, the toast explains that the base ellipse overlay is shown and location can be enabled for relative analysis

Programmatic entry points exposed by the controller:

- `setEnabled(nextEnabled, opts)`
- `sync(force, opts)`
- `clear()`
- `refreshExtendedVisual()`
- `clearExtendedVisual()`
- `buildUserEllipseAnalysis(userLatLng)`
- `printEllipsesInfos()`
- `startEllipseEditing()`
- `isEnabled()`

Global debug helper:

- `window.printEllipsesInfos()`
- `window.editEllipse()`

## Input Data

Ellipse mode uses the following app state inputs:

- `locationStates`: current displayed state per location
- `locationHistory`: recent alert history per location
- `featureMap`: GeoJSON Feature objects for each location (keyed by location name)
- `userPosition`: current user geolocation if available

It also lazily loads `oref_points.json`, which maps alert location names to `[lat, lng]` points used for ellipse fitting and marker placement.

Only locations whose current state is `red` participate in ellipse mode.

For each displayed red location, the feature derives:

- `location`
- `title`
- `alertDate`

This is done by `getDisplayedRedAlerts()`.

## What Gets Drawn

Ellipse mode draws up to three categories of map layers:

- point markers for each alert location included in a rendered cluster
- one base geometry overlay per rendered cluster
- one optional user-relative visual for the nearest eligible cluster
- one optional edit overlay plus drag anchors while an edit session is active

The base geometry is:

- a `circle` for a single-point cluster
- an `ellipse` polygon approximation for any cluster with two or more placed points

The user-relative visual is separate from the base cluster geometry and currently consists of:

- a marker at the geometry center
- a dashed line from the cluster center to the user position
- a floating label at the midpoint showing the user's `normalizedDistanceRatio` as a percent

When an edit session is active, the selected ellipse also gets:

- a dashed blue edit overlay
- a draggable center anchor
- four draggable axis-end anchors
- `Reset`, `OK`, and `Cancel` buttons

## Cluster Formation

Red alerts are not grouped by point distance. They are grouped by polygon adjacency.

Two locations belong to the same cluster when their location polygons touch, either directly or through a transitive chain:

- shared vertices count as touching
- intersecting polygon edges count as touching
- containment also counts as touching
- bounding-box rejection is used as an early fast-path

The actual clustering algorithm is breadth-first search over the red-alert locations:

1. start from one unvisited location
2. enqueue every other unvisited location whose polygon touches it
3. continue until the connected component is exhausted
4. repeat for the remaining unvisited locations

Cluster topology is cached by the set of active red-alert location names.

## Cluster Size Threshold

Not every cluster is rendered.

Clusters are skipped when their size is less than `MIN_ELLIPSE_CLUSTER_SIZE`, which is currently `20`.

This threshold applies to:

- drawing base overlays
- inclusion in summary output
- user-relative analysis results

Small red clusters therefore remain visible only through the normal map polygons, not through ellipse mode.

## Geometry Model

### Single-point cluster

If the cluster has exactly one usable point, the geometry becomes:

- `type: "circle"`
- `center`: that point
- `radiusMeters: 700`

### Multi-point cluster

For clusters with two or more usable points:

1. points are projected into Web Mercator (EPSG:3857) using inline math (no map CRS dependency)
2. a major axis is estimated
3. the point spread is measured in the major-axis and minor-axis basis
4. padded semi-axes are produced
5. the final ellipse center is shifted to the midpoint of the extents in that rotated basis

Major-axis selection:

- for two points, use the direction between them
- for three or more points, use a covariance-based orientation estimate

Base extents:

- `semiMajor = max((maxU - minU) / 2, 450)`
- `semiMinor = max((maxV - minV) / 2, 250)`

Padding rules:

- `semiMajor += 350`
- `semiMinor = max(semiMinor + 250, semiMajor * 0.32)`

This means the ellipse is intentionally padded and stabilized. It is not a minimum-area enclosing ellipse and not a probabilistic confidence ellipse.

### Rendered ellipse shape

An ellipse is rendered as a 72-point polygon sampled around the fitted geometry.

## Base Overlay Styling

Each rendered cluster gets:

- a small white-outlined point marker for each placed location
- a red geometry overlay

Current base overlay style:

- stroke color: `#951111`
- stroke width: `2`
- stroke opacity: `0.95`
- fill color: `#951111`
- fill opacity: `0.08`

If a location in a large cluster is missing from `oref_points.json`, the cluster still renders from the remaining points and the missing locations are counted for toast reporting.

## Caching

Ellipse mode uses several in-memory caches to avoid recomputing expensive steps:

- loaded `oref_points.json`
- polygon-touch answers per location pair
- cluster topology per active red-alert location set
- base geometry summaries per active render key
- user-position-aware summaries per active render key plus user position key
- user geometry overrides per cluster key for committed manual edits

The render key includes:

- location name
- alert title
- alert timestamp

This means a change in the active red alerts invalidates the geometry summaries and redraw path.

## User-relative Analysis

When the user position is available, ellipse mode derives per-cluster metrics relative to that position.

The public method `buildUserEllipseAnalysis(userLatLng)` returns:

- whether ellipse mode is enabled
- whether there are active rendered clusters
- cluster count
- total displayed red alerts
- number of clusters containing the user
- nearest cluster distance in meters
- a cluster report array

Each cluster report includes:

- `label`
- `locations`
- `locationCount`
- `latestAlertDate`
- `containsUser`
- `distanceMeters`
- `geometry`
- `sourceGeometry`
- `centerDistanceMeters`
- `normalizedDistanceRatio`
- `directionalRadiusMeters`
- `homeStripeProbability`
- `homeEllipseCircumferenceMeters`
- `homeStripePerCircumferenceProbability`

### Contains-user check

Containment is geometric:

- for circles, geodesic distance to the center is compared against radius
- for ellipses, the point is projected into the ellipse basis and evaluated with the standard ellipse equation

### Normalized distance ratio

`normalizedDistanceRatio` is the user's center-to-position distance expressed relative to the fitted geometry in the direction of the user.

Interpretation:

- `0` means the user is at the cluster center
- `1` means the user is on the geometry boundary in that direction
- `< 1` means inside the geometry
- `> 1` means outside the geometry

For circles:

- `normalizedDistanceRatio = centerDistance / radius`

For ellipses:

- the user position is projected into the rotated ellipse basis
- the normalized radius is computed as `sqrt((u^2 / a^2) + (v^2 / b^2))`

## Probability Window Metric

The nearest eligible cluster also gets a probability-style metric based on a one-dimensional radial model.

The implementation uses:

- `directionalRadiusMeters`
- `homeStripeProbability`
- `homeEllipseCircumferenceMeters`
- `homeStripePerCircumferenceProbability`

### Directional radius

`directionalRadiusMeters` is the geometry boundary distance from the cluster center in the exact direction of the user.

Rules:

- for circles, it is the circle radius
- for ellipses, it is found by intersecting the user ray with the ellipse boundary in projected space, then converting back to meters

### Distribution model

The radial distance is modeled with a half-normal distribution.

Calibration rule:

- the directional boundary radius corresponds to the `99th percentile`

Implementation details:

- `q99 = 2.5758293035489004`
- `sigma = directionalRadiusMeters / q99`
- the probability window is `[max(0, r_user - 100), r_user + 100]`
- `homeStripeProbability = F(upper) - F(lower)`

### Derived circumference metric

The code also derives a scaled version of the selected geometry using `normalizedDistanceRatio` and computes:

- `homeEllipseCircumferenceMeters`
- `homeStripePerCircumferenceProbability`

`homeStripePerCircumferenceProbability` is formatted as a scientific-style fraction string such as `1E-05`.

## Extended Visual Selection

The user-relative visual is not drawn for every cluster.

Selection rules:

1. cluster summaries are sorted by nearest point distance from the user
2. the first eligible cluster is selected

Eligibility currently means:

- the cluster has geometry
- `normalizedDistanceRatio` is finite
- `normalizedDistanceRatio < 1.5`

So the extended visual is biased toward the nearest cluster that is not too far outside the fitted geometry.

## Manual Editing

Manual editing is a developer-facing capability exposed only through DevTools:

- run `window.editEllipse()`

Selection rules:

- ellipse mode must already be enabled
- only currently displayed rendered clusters are considered
- if multiple ellipses are displayed, the largest one by geometric area is selected
- only ellipse geometries are editable; circles are ignored

Editing behavior:

- dragging the center anchor translates the whole ellipse without changing size or angle
- dragging a major-axis end anchor rotates the major axis around the center and changes `semiMajor`
- dragging a minor-axis end anchor rotates the minor axis around the center and changes `semiMinor`
- the opposite end of the edited axis mirrors automatically through the center
- the non-edited axis keeps its current length and remains perpendicular

Session controls:

- `Reset` restores the generated geometry captured when the edit session started and keeps editing active
- `OK` commits the draft geometry as the active override for that cluster and exits editing mode
- `Cancel` discards the draft geometry and exits editing mode

Committed edits are kept in memory as per-cluster overrides and applied to:

- base overlay rendering
- debug info output
- user-relative analysis and extended-visual calculations

## Console Output

When an eligible cluster is selected for the extended visual, ellipse mode logs a line with:

- cluster label
- normalized distance ratio
- center distance in meters
- directional radius in meters
- home stripe probability
- scaled-geometry circumference
- probability-per-circumference value

The debug method `printEllipsesInfos()` logs an array of simplified geometry summaries for the currently rendered clusters:

- `locationCount`
- `center`
- `majorAxisLength`
- `minorAxisLength`
- `majorAxisHorizontalAngle`

## Event Wiring

Ellipse mode reacts to these app events:

- `app:ready`: initialize if loaded after app startup
- `app:stateChanged`: recompute and redraw the base overlay when displayed alert state changes
- `app:locationChanged`: recompute the user-relative visual only
- `app:escape`: cancel ellipse editing if active; otherwise clear the user-relative visual

The base overlay and the user-relative overlay are therefore refreshed on different paths:

- state changes redraw clusters
- location changes redraw only the extended visual

## Error Handling

If `oref_points.json` fails to load:

- all ellipse layers are cleared
- the cached render key is reset
- an error is logged to the console
- a toast can be shown if requested

If user-relative analysis fails during extended-visual refresh:

- only the extended visual is cleared
- the error is logged

## Known Limitations

- only red alerts participate; purple and yellow alerts are ignored
- clusters smaller than 20 locations are skipped entirely
- clustering is based on polygon touching, not geographic distance
- missing `oref_points.json` coordinates reduce geometry quality
- the fitted ellipse is heuristic and padded, not a statistically rigorous fit
- only one cluster gets the user-relative overlay at a time
- only one cluster can be edited at a time
- the visible map label shows `normalizedDistanceRatio` only, not the probability metric
- `getIsLiveMode()` and `getCurrentViewTime()` are wired into the module but currently unused

## Non-goals of the Current Implementation

The current feature does not attempt to:

- infer launch origin
- predict future alert spread
- classify threat type beyond using the current displayed red-alert filter
- replace the underlying alert polygons
- compute a minimum enclosing ellipse
- expose a full ellipse UI panel or per-cluster inspector

## Summary

Ellipse mode is a red-alert clustering and interpretation layer.

At the base level, it compresses large contiguous alert regions into fitted circle or ellipse overlays. When user location is available, it augments the nearest eligible cluster with a relative-position visual and probability-style radial metrics.

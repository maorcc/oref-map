# Ellipse Algorithm C

## Purpose

`alg-C` is now exposed to the web app through a Python HTTP service under:

- [`ellipses-server/server.py`](/home/tomer/projects/oref-map/ellipses-server/server.py#L1)
- [`ellipses-server/ellipse_service.py`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L1)

The current role of `alg-C` is:

- accept a list of alerted location names
- resolve those names through [`web/oref_points.json`](/home/tomer/projects/oref-map/web/oref_points.json)
- fit one ellipse from the dominant cluster
- return the result as JSON to the browser

In the web UI, the feature is triggered from [`web/ellipse-mode.js`](/home/tomer/projects/oref-map/web/ellipse-mode.js#L1811).

## Server API

The Python server exposes:

- `GET /health`
- `POST /ellipse`

The routes are registered in [`create_app()`](/home/tomer/projects/oref-map/ellipses-server/server.py#L71).

### Request

`POST /ellipse` expects JSON of the form:

```json
{
  "locations": ["תל אביב - מרכז העיר", "רמת גן - מערב"]
}
```

Validation behavior from [`ellipse()`](/home/tomer/projects/oref-map/ellipses-server/server.py#L39):

- request body must be valid JSON
- `locations` must be an array
- every item in `locations` must be a string

### Success response

On success the server returns:

```json
{
  "ok": true,
  "ellipse": {
    "center": {
      "lat": 32.06,
      "lng": 34.73
    },
    "axes": {
      "major_full_degrees": 0.77,
      "minor_full_degrees": 0.26,
      "semi_major_degrees": 0.38,
      "semi_minor_degrees": 0.13,
      "semi_major_km": 36.6,
      "semi_minor_km": 14.5
    },
    "angle_deg": 7.3,
    "meta": {
      "input_count": 136,
      "used_count": 136,
      "clustered_count": 136,
      "boundary_count": 56,
      "filtered_boundary_count": 45
    }
  },
  "missing_locations": []
}
```

The browser converts that response into a renderable geometry in `buildAlgCServiceRenderable()` in `web/ellipse-mode.js`, using inline Web Mercator projection math (no Leaflet dependency). The result is pushed to the `algc-overlay` MapLibre GeoJSON source.

### Error responses

The server currently uses:

- `400` for invalid JSON or invalid `locations` payload
- `400` for completely unknown input when no usable coordinates remain
- `422` when too few usable points survive clustering or boundary filtering
- `500` for unexpected server errors

## Input Data

The service resolves locations from:

- [`web/oref_points.json`](/home/tomer/projects/oref-map/web/oref_points.json)

That file maps:

- alert name -> `[lat, lng]`

The service loads it once at startup in [`_load_locations(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L53).

The coastline filter uses:

- [`web/israel_mediterranean_coast_0.5km.csv`](/home/tomer/projects/oref-map/web/israel_mediterranean_coast_0.5km.csv)

It is loaded in [`_load_coast(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L72).

## Algorithm Pipeline

The fitting logic lives in [`fit_from_names(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L126).

The current pipeline is:

1. resolve input names to coordinates
2. keep only the main DBSCAN cluster
3. derive boundary points with `alphashape`
4. drop boundary points too close to the Mediterranean coastline
5. fit an ellipse with OpenCV
6. normalize the result and return JSON-friendly metrics

## 1. Name resolution

[`load_points_from_alert_names(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L77) converts the input location names into `[lng, lat]` pairs.

Current behavior:

- known names are used
- unknown names are collected into `missing_locations`
- the request only fails if no usable points remain at all

This matches the current web integration better than the earlier strict behavior.

## 2. Main-cluster detection

[`_detect_main_cluster(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L92) runs `DBSCAN` after scaling degrees into approximate kilometers for the Israel region.

Current defaults from [`EllipseOptions`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L36):

- `cluster_eps_km: 10.0`
- `cluster_min_samples: 10`

Only the largest non-noise cluster is retained.

If the resulting cluster has fewer than `min_boundary_points`, the server returns `422`.

## 3. Boundary extraction

The service computes an alpha shape from the clustered points with:

- [`alphashape.alphashape(...)`](https://pypi.org/project/alphashape/)

Points are treated as boundary points when their distance to the alpha-shape exterior is below:

- `boundary_threshold: 0.03`

If no polygon exterior can be derived, the request fails with `422`.

Current default:

- `alpha: 0.1`

## 4. Coastline filtering

[`_filter_points_away_from_coast(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L108) rejects boundary points that are too close to the Mediterranean coastline samples.

Distance is approximated by:

- scaling longitude by `94.6 km/degree`
- scaling latitude by `111.2 km/degree`
- taking the nearest sampled coastline point

Current default:

- `coast_min_distance_km: 4.0`

If too few filtered boundary points remain, the request fails with `422`.

## 5. OpenCV ellipse fit

The final fit is performed directly in Python with:

- [`cv2.fitEllipse(...)`](https://docs.opencv.org/)

This happens in [`fit_from_names(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L169).

Unlike the older JS-based offline implementation, the current web-facing path:

- does not spawn a child Node process
- does not import `@techstark/opencv-js`
- does not run OpenCV in the browser

It uses `opencv-python` on the server instead.

## 6. Result normalization

OpenCV returns:

- center
- two axis lengths
- an angle

The service then:

- swaps axes if needed so `major >= minor`
- normalizes the angle to `[0, 180)`
- derives semi-axis lengths in degrees
- estimates semi-axis lengths in kilometers
- returns cluster and boundary counts in `meta`

This logic is implemented near the end of [`fit_from_names(...)`](/home/tomer/projects/oref-map/ellipses-server/ellipse_service.py#L169).

## Web Integration

The browser entry point is:

- [`window.calcEllipseAlgC`](/home/tomer/projects/oref-map/web/ellipse-mode.js#L1893)

That helper now:

- posts to `https://ellipses.oref-map.org/ellipse` by default
- accepts an override via `options.endpoint` or `window.ELLIPSE_SERVICE_URL`
- builds a blue overlay from the returned ellipse

There is also direct UI wiring:

- double-click a red ellipse to request a blue server-fitted ellipse for that cluster at [web/ellipse-mode.js](/home/tomer/projects/oref-map/web/ellipse-mode.js#L661)
- double-click the blue ellipse to remove it at [web/ellipse-mode.js](/home/tomer/projects/oref-map/web/ellipse-mode.js#L1770)

## CORS

Because the web app commonly runs on `http://127.0.0.1:8788` while the Python service runs on `http://127.0.0.1:8080`, the server includes explicit CORS handling in:

- [`build_cors_headers(...)`](/home/tomer/projects/oref-map/ellipses-server/server.py#L15)
- [`options_handler(...)`](/home/tomer/projects/oref-map/ellipses-server/server.py#L31)

Currently allowed origins are:

- `http://127.0.0.1:8788`
- `http://localhost:8788`

## Running The Service

From the repository root:

```bash
.venv/bin/python ellipses-server/server.py
```

The default bind address is:

- `127.0.0.1:8080`

## Limitations

The current Python server is pragmatic, not mathematically exact.

Known limitations:

- the coordinate scaling constants are Israel-specific approximations
- alpha-shape operates in degree space, not in a proper projected meter CRS
- coastline rejection uses nearest sampled coastline points, not point-to-segment distance
- the request can fail when too few points survive clustering or coastline filtering
- the browser currently depends on a separate local Python service process being available

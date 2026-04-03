# Ellipse Mode Probability Window

## Purpose

Define an additional per-cluster metric for ellipse mode, alongside the existing normalized distance ratio shown as a percent.

The new metric answers this question:

Given a 1D probability distribution that extends from the ellipse center outward in the direction of the user, what is the probability that the item lies within `+/- 100 meters` of the user's current radial position?

This document is intended to be sufficient for reimplementing the feature later from scratch.

## Existing Metric

Ellipse mode already computes a user-relative index:

- `normalizedDistanceRatio`

Interpretation:

- `0` means the user is at the cluster center
- `1` means the user is exactly on the boundary of the containing geometry in that direction
- `< 1` means inside the geometry
- `> 1` means outside the geometry

For circles:

- `normalizedDistanceRatio = centerDistance / radius`

For ellipses:

- compute the user's position in the ellipse's rotated local coordinate system
- compute the normalized ellipse radius:

```text
sqrt((u^2 / a^2) + (v^2 / b^2))
```

where:

- `u`, `v` are the user coordinates in the ellipse basis
- `a` is the semi-major axis
- `b` is the semi-minor axis

## New Metric

### Name

Recommended internal name:

- `plusMinus100mProbability`

Related helper value:

- `directionalRadiusMeters`

### Intended Meaning

Model the item's location as a random variable distributed along a single radial line:

- origin at the cluster center
- positive direction points from the center toward the user's location

The metric is the probability mass in the interval:

```text
[r_user - 100m, r_user + 100m]
```

after clamping the lower bound to `0`.

So the actual evaluated interval is:

```text
[max(0, r_user - 100), r_user + 100]
```

where:

- `r_user` is the user's radial distance from the center in meters

## Distribution Model

### Choice

Use a half-normal distribution over radial distance:

- support is `r >= 0`
- the distribution starts at the center and extends outward

This was chosen instead of a plain symmetric normal because the physical quantity is radial distance from the center, not signed distance on an infinite line.

### Calibration Rule

Define the half-normal scale parameter `sigma` so that:

```text
P(r <= R) = 0.99
```

where:

- `R` is the ellipse boundary distance in meters in the direction of the user

Interpretation:

- `99%` of the probability mass lies between the center and the boundary
- `1%` lies outside the boundary

## Geometry Inputs

### 1. User radial distance

`r_user` is the distance from the cluster center to the user in meters.

Use map/geodesic distance between:

- geometry center
- user location

### 2. Directional boundary distance

`R` is not the ellipse semi-major or semi-minor axis directly.

It must be the boundary distance in the specific direction from the center toward the user.

Rules:

- for a circle, `R = radiusMeters`
- for an ellipse:
  - project the user point into the same projected coordinate space used by ellipse geometry
  - compute the unit direction vector from `centerProjected` to the projected user position
  - if the user is exactly at the center and the direction is undefined, use a deterministic fallback direction
  - recommended fallback: the positive major-axis direction
  - solve for the ellipse boundary intersection along that direction
  - convert that boundary point back to lat/lng
  - compute the center-to-boundary distance in meters

The boundary distance must correspond to the same direction as the user ray.

## Probability Computation

### Half-normal CDF

For a half-normal random variable:

```text
F(x) = erf(x / (sigma * sqrt(2)))   for x >= 0
F(x) = 0                            for x < 0
```

### Deriving sigma

Let `q99` be the half-normal quantile such that:

```text
F(q99) = 0.99
```

Then:

```text
sigma = R / q99
```

### Window probability

Let:

- `windowHalfWidthMeters = 100`
- `lower = max(0, r_user - windowHalfWidthMeters)`
- `upper = r_user + windowHalfWidthMeters`

Then:

```text
plusMinus100mProbability = F(upper) - F(lower)
```

## Expected Behavior

### User at center

- `r_user = 0`
- evaluated interval becomes `[0, 100]`
- probability is positive and typically relatively high if the geometry is small

### User near the ellipse boundary

- `r_user` is close to `R`
- the interval straddles the high-percentile tail near the boundary
- probability is usually smaller than near the center

### User outside the ellipse

- `r_user > R`
- probability is still valid
- it represents tail probability mass in a `+/- 100m` window centered on the user's radial distance

## Step 1 Output Requirements

For the initial implementation:

- no UI change is required
- no label needs to be added to the map
- no popup needs to be updated
- the metric only needs to be computed and printed to the browser console

Recommended console payload:

```js
{
  cluster: "<cluster label>",
  normalizedDistanceRatio: <number|null>,
  centerDistanceMeters: <number|null>,
  directionalRadiusMeters: <number|null>,
  plusMinus100mProbability: <number|null>
}
```

## Scope of Logging

For step 1, log the metric for the same cluster currently used by the extended visual.

That means:

- if ellipse mode is disabled, do not log
- if there is no user position, do not log
- if no eligible cluster is chosen for the extended visual, do not log
- if an eligible cluster is chosen, log the probability payload for that cluster

## Non-Goals

The following are explicitly out of scope for the first version:

- showing the probability on the map
- adding the probability to the popup HTML
- changing cluster selection logic
- changing the existing percent label
- introducing a different statistical model such as truncated normal, log-normal, or 2D Gaussian

## Assumptions

- the probability model is one-dimensional
- the model applies only along the radial line from center to user
- the ellipse boundary defines the `99th percentile` radial distance in that direction
- the lower radial bound is `0` because distance cannot be negative
- geodesic distances in meters are good enough for this feature

## Edge Cases

Implementation should return `null` rather than a misleading number when:

- geometry is missing
- user location is missing
- the directional boundary distance cannot be computed
- the derived `sigma` is invalid
- any required numeric input is not finite

Recommended handling:

- compute the metric opportunistically
- if invalid, log `null` for `plusMinus100mProbability`

## Future Extensions

Possible later follow-ups:

- display the probability next to the existing percent label
- expose the value in `buildUserEllipseAnalysis`
- make the window size configurable instead of fixed at `100m`
- compare multiple models, such as half-normal vs truncated normal
- use the probability for ranking clusters instead of only displaying it

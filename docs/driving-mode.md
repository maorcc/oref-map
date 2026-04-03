# Driving Mode Feature

## Overview

The app will support a "driving mode feature" that changes map camera behavior while the user is moving in a car.

This feature is experimental and is disabled by default.

## Feature Gating

- The feature is available only when the user enables `Driving mode feature` in the experimental options menu.
- Default state: disabled.

## Zoom Menu Behavior

When the feature is disabled:

- Keep the existing `זום אוטומטי` behavior unchanged.

When the feature is enabled:

- Rename the `זום אוטומטי` menu item to `זום`.
- Replace the current on/off behavior with 3 states:
  - `ידני`
  - `לאירועים`
  - `עקוב אחרי`
- Default selected state: `לאירועים`.

## Device Location Definition

`Device location` means either:

- Live GPS location from the browser geolocation API.
- A fixed location supplied by the `myPosition=` URL parameter.

## Follow-Me Mode

If the user selects `עקוב אחרי`:

- If device location is not available, show an error popup and do not enable follow-me mode.
- Otherwise, enable follow-me mode.

While follow-me mode is active:

- The map should use zoom level `13`.
- The camera should follow the device location instead of zooming to event locations.
- Alert-driven auto-zoom must not take control of the map.

## Recenter Threshold

In follow-me mode, the map should recenter only when the user marker drifts more than 10% of the current map viewport away from the center.

Interpretation of the 10% threshold:

- Measure drift relative to the current viewport, not by raw latitude/longitude deltas.
- The intended rule is based on visible map position, not geographic percentage.

## Manual Interaction Pause

If the user manually moves the map while follow-me mode is active:

- Treat both panning and zoom gestures as manual interaction.
- Temporarily pause follow-me behavior for 10 seconds.
- After the pause expires, follow-me behavior may resume automatically if the selected zoom mode is still `עקוב אחרי`.

## Historic Mode Behavior

If the user enters historic event viewing mode while follow-me mode is selected:

- Disable follow-me behavior for the duration of historic mode.

When the user exits historic mode:

- Restore the previously selected zoom state.
- If that previously selected state was `עקוב אחרי`, resume follow-me behavior.
- If it was `לאירועים`, return to alert-following behavior.
- If it was `ידני`, remain in manual mode.

## Notes

- `myPosition=` is considered a valid device location source, but it is static unless the URL itself changes.
- In that case, follow-me behaves as centering/following a fixed provided location rather than live GPS tracking.

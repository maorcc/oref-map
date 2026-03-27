# oref-map — מפת העורף

Live map of Israel showing [Pikud HaOref](https://www.oref.org.il) (Home Front Command) alerts as colored area polygons per location.

**Live**: https://oref-map.org

<table>
  <tr>
    <td align="center"><img src="web/og-image.jpg" width="480" alt="Desktop"/><br/>Desktop</td>
    <td align="center"><img src="web/screenshot-mobile.jpg" width="200" alt="Mobile"/><br/>Mobile</td>
  </tr>
</table>

## Features

- Colored Voronoi area polygons per location — adjacent same-colored areas merge into contiguous zones
- Timeline slider to scrub through the last ~1–2 hours of alert history
- Sound alerts — optional audio notifications for new alerts (muted by default, toggle via 🔇)
- Click any area to see its alert history
- About modal — click ⓘ or the title for info and disclaimer

| Color | Meaning |
|-------|---------|
| 🔴 Red | Rocket/missile fire |
| 🟣 Purple | Drone/aircraft infiltration |
| 🟡 Yellow | Early warning / preparedness — go near your shelter, sirens may follow |
| 🟢 Green | Event ended (fades out after 1 minute) |

## Development

```sh
./web-dev        # start dev server at http://localhost:8788
```

Requires [Node.js](https://nodejs.org) and `npx` (comes with npm). Uses [Wrangler](https://developers.cloudflare.com/workers/wrangler/) to serve `web/` and run the API proxy functions locally.

The polygon data file (`locations_polygons.json`) is not in the repo — `./web-dev` downloads it automatically from the live site if missing.

## Deploy

Deployed to [Cloudflare Pages](https://pages.cloudflare.com) (static assets + TLV proxy):

```sh
./deploy
```

The fallback Worker (for non-TLV users) is deployed separately:

```sh
cd worker && npx wrangler deploy
```

## Structure

```
web/
  index.html          # single-file map app (all JS/CSS inline)
  cities_geo.json     # location → [lat, lng] lookup
functions/
  api/
    alerts.js         # proxies live alerts API
    history.js        # proxies history API
    alarms-history.js # proxies extended history API
worker/
  src/index.js        # fallback proxy for non-TLV users (placement: azure:israelcentral)
  wrangler.toml       # Worker config with placement and /api2/* route
```

## Contributing

Contributions are welcome! This is a civic project built for anyone in Israel who wants better situational awareness during alerts.

Ways to help:
- **Bug reports** — open an issue if something looks wrong
- **Location data** — if a polygon is missing or misplaced, open an issue with the location name
- **Features & fixes** — PRs are very welcome! Please keep each PR focused on a single feature or fix. For anything beyond a small bug fix, open an issue first so we can discuss the approach before you invest the effort
- **Feature flags** — beta/experimental features are gated behind `f-` URL params (e.g. `?f-log`). To add a new flag, check `FF.<name>` in JS or use the `f-gated` CSS class for visibility toggling. See `CLAUDE.md` for details.

To run locally, see the [Development](#development) section above.

## Contributors

Thanks to [@uripeer3](https://github.com/uripeer3), [@tomerkon](https://github.com/tomerkon), [@michalrymland](https://github.com/michalrymland), and [@ravitzm21](https://github.com/ravitzm21) for contributing to this project.

## Data

Polls the Oref APIs:

- **Live alerts** (`/api/alerts`) — every 1 second
- **History** (`/api/history`) — every 10 seconds

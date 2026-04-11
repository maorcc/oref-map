# Ellipses Server

Minimal HTTP server for calculating an ellipse from a list of alert location names.

## Run

From the repo root:

```bash
.venv/bin/python ellipses-server/server.py
```

Server endpoints:

- `GET /health`
- `POST /ellipse`

Example request:

```bash
curl -X POST https://ellipses.oref-map.org/ellipse \
  -H 'Content-Type: application/json' \
  -d '{"locations":["אבו גוש","אבו נוור","אבו סנאן","אבו קרינאת","אבו תלול","אבו קרינאת והפזורה","אבו קרינאת","אבו תלול","אבו גוש","אבו נוור"]}'
```

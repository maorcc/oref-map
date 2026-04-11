from __future__ import annotations

from aiohttp import web

from ellipse_service import EllipseError, EllipseService, InsufficientPointsError, UnknownLocationsError


service = EllipseService()
ALLOWED_ORIGINS = {
    "http://127.0.0.1:8788",
    "http://localhost:8788",
    "https://oref-map.org",
    "https://www.oref-map.org",
}


def build_cors_headers(request: web.Request) -> dict[str, str]:
    origin = request.headers.get("Origin", "")
    headers = {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    }
    if origin in ALLOWED_ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
    return headers


def json_response(request: web.Request, payload: dict, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, headers=build_cors_headers(request))


async def options_handler(request: web.Request) -> web.Response:
    return web.Response(status=204, headers=build_cors_headers(request))


async def health(request: web.Request) -> web.Response:
    return json_response(request, {"ok": True})


async def ellipse(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return json_response(request, {"ok": False, "error": "Request body must be valid JSON"}, status=400)

    locations = payload.get("locations")
    if not isinstance(locations, list) or any(not isinstance(item, str) for item in locations):
        return json_response(
            request,
            {"ok": False, "error": "`locations` must be a JSON array of strings"},
            status=400,
        )

    try:
        result = service.fit_from_names(locations)
    except UnknownLocationsError as error:
        return json_response(
            request,
            {"ok": False, "error": "Unknown locations", "missing_locations": error.missing},
            status=400,
        )
    except InsufficientPointsError as error:
        return json_response(request, {"ok": False, "error": str(error)}, status=422)
    except EllipseError as error:
        return json_response(request, {"ok": False, "error": str(error)}, status=500)
    except Exception as error:
        return json_response(request, {"ok": False, "error": f"Unexpected server error: {error}"}, status=500)

    missing_locations = result.pop("missing_locations", [])
    return json_response(request, {"ok": True, "ellipse": result, "missing_locations": missing_locations})


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_options("/health", options_handler)
    app.router.add_get("/health", health)
    app.router.add_options("/ellipse", options_handler)
    app.router.add_post("/ellipse", ellipse)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="127.0.0.1", port=8080)

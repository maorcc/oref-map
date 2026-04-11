#!/usr/bin/env python3
"""
Generate web/israel_border.json — the outer land boundary of Israel,
derived from the Voronoi location polygons in web/locations_polygons.json.

The country boundary is computed by extracting polygon edges that are
referenced by exactly one polygon (interior edges are shared by two
adjacent polygons), stitching those boundary edges into a ring, then
simplifying the ring with Douglas-Peucker.

Run once whenever locations_polygons.json changes:
    python3 tools/generate_israel_border.py
"""

import json
import math
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT = os.path.join(ROOT, 'web', 'locations_polygons.json')
OUTPUT = os.path.join(ROOT, 'web', 'israel_border.json')

# Simplification tolerance in degrees (~0.005° ≈ 500 m).
SIMPLIFY_EPS = 0.005


def iter_rings(poly):
    """Yield each ring (list of [lng, lat]) from a location polygon.

    Handles both flat (`[[lng,lat], ...]`) and nested (`[[[lng,lat], ...], ...]`)
    shapes found in locations_polygons.json.
    """
    if not poly:
        return
    first = poly[0]
    if len(first) == 2 and isinstance(first[0], (int, float)):
        yield poly
    else:
        for ring in poly:
            yield ring


def quantize(v):
    """Round to 5 decimal places (~1 m) so adjacent polygons share exact keys."""
    return (round(v[0], 5), round(v[1], 5))


def walk_ring(start, adj):
    """Walk an Eulerian ring starting at `start`. Mutates `adj`."""
    nbs = adj.get(start, [])
    if not nbs:
        return []
    ring = [start]
    nxt = nbs[0]
    adj[start].remove(nxt)
    adj[nxt].remove(start)
    ring.append(nxt)
    prev, curr = start, nxt
    while curr != start:
        nbs = adj.get(curr, [])
        if not nbs:
            return ring
        if len(nbs) == 1:
            nxt = nbs[0]
        else:
            # At a multi-way junction, choose the neighbor that keeps the path
            # most straight (smallest turning angle).
            best = None
            best_ang = math.pi * 3
            for cand in nbs:
                v1x, v1y = curr[0] - prev[0], curr[1] - prev[1]
                v2x, v2y = cand[0] - curr[0], cand[1] - curr[1]
                a1 = math.atan2(v1y, v1x)
                a2 = math.atan2(v2y, v2x)
                d = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
                if abs(d) < best_ang:
                    best_ang = abs(d)
                    best = cand
            nxt = best
        adj[curr].remove(nxt)
        adj[nxt].remove(curr)
        ring.append(nxt)
        prev, curr = curr, nxt
    if ring[-1] == ring[0]:
        ring.pop()
    return ring


def douglas_peucker(points, eps):
    """Simplify a closed ring with the Douglas-Peucker algorithm."""
    if len(points) < 4:
        return list(points)

    def perp_dist(p, a, b):
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2
        t = max(0.0, min(1.0, t))
        px = a[0] + t * dx
        py = a[1] + t * dy
        return math.hypot(p[0] - px, p[1] - py)

    def dp_rec(pts):
        if len(pts) < 3:
            return list(pts)
        a, b = pts[0], pts[-1]
        dmax, imax = 0.0, 0
        for i in range(1, len(pts) - 1):
            d = perp_dist(pts[i], a, b)
            if d > dmax:
                dmax, imax = d, i
        if dmax > eps:
            left = dp_rec(pts[:imax + 1])
            right = dp_rec(pts[imax:])
            return left[:-1] + right
        return [a, b]

    # Simplify a closed ring by splitting at the vertex farthest from point 0.
    maxd, maxi = 0.0, 0
    p0 = points[0]
    for i in range(1, len(points)):
        d = math.hypot(points[i][0] - p0[0], points[i][1] - p0[1])
        if d > maxd:
            maxd, maxi = d, i
    left = dp_rec(points[:maxi + 1])
    right = dp_rec(points[maxi:] + [p0])
    return left[:-1] + right[:-1]


def main():
    with open(INPUT, 'r', encoding='utf-8') as f:
        data = json.load(f)
    names = [k for k in data.keys() if not k.startswith('_')]

    edge_count = defaultdict(int)
    for n in names:
        for ring in iter_rings(data[n]):
            if len(ring) < 2:
                continue
            for i in range(len(ring)):
                a = ring[i]
                b = ring[(i + 1) % len(ring)]
                ka, kb = quantize(a), quantize(b)
                if ka == kb:
                    continue
                e = (ka, kb) if ka < kb else (kb, ka)
                edge_count[e] += 1

    adj = defaultdict(list)
    for (a, b), c in edge_count.items():
        if c == 1:
            adj[a].append(b)
            adj[b].append(a)

    # The country outline is the connected component containing the westernmost
    # boundary vertex (always on the Mediterranean coast).
    start = min(adj.keys(), key=lambda v: v[0])
    outline = walk_ring(start, adj)
    if not outline:
        raise SystemExit('Failed to stitch a country outline.')

    simplified = douglas_peucker(outline, SIMPLIFY_EPS)
    # Output in [lat, lng] order to match the runtime convention used elsewhere
    # in prediction-mode.js (points are passed around as [lat, lng, ...]).
    points_latlng = [[float(v[1]), float(v[0])] for v in simplified]

    lngs = [v[0] for v in simplified]
    lats = [v[1] for v in simplified]
    bbox = {
        'minLat': min(lats), 'maxLat': max(lats),
        'minLng': min(lngs), 'maxLng': max(lngs),
    }

    payload = {
        '_comment': 'Outer land boundary of Israel (lat,lng pairs). Generated by tools/generate_israel_border.py from locations_polygons.json.',
        'bbox': bbox,
        'points': points_latlng,
    }

    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    print(f'Raw outline: {len(outline)} vertices')
    print(f'Simplified (eps={SIMPLIFY_EPS}): {len(points_latlng)} vertices')
    print(f'bbox: {bbox}')
    print(f'Wrote {OUTPUT}')


if __name__ == '__main__':
    main()

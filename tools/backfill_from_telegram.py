#!/usr/bin/env uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Backfill missing alerts for 2026-02-28 and 2026-03-01 into R2 day-history
files, using a parsed Telegram dump as source.

Background: on the first two days of the war, Oref's per-location alerts
(both rocket fires and releases) were incomplete — many events were posted
only as nationwide ("ברחבי הארץ") notices instead of per-location entries.
The R2 archive therefore shows locations stuck at red on those days.

Yuval Harpaz's parsed Telegram dump at
github.com/yuval-harpaz/alarms (saved locally to
tmp/oref_telegram_alerts_war.json) carries the missing per-location
events. Each entry already matches our schema except for `rid`.

Known data-quality bug in Yuval's dump: 17 of our canonical polygon names
contain ", " and were split into fragments during his parsing
(e.g. "גבים, מכללת ספיר" → two entries "גבים" and "מכללת ספיר").
Those fragments don't match any polygon key on our map. We reverse-map
them back to the canonical name before merging.

This script reads Yuval's dump + the existing R2 snapshots locally,
applies the reverse-mapping, filters to the two target R2 dates, dedupes
against existing R2 entries, and writes merged JSONL files to
tmp/r2_day_history_merged/. The user then eyeball-diffs and uploads to
R2 manually with wrangler.

Usage:
    uv run tools/backfill_from_telegram.py
"""

import json
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

DUMP_PATH = Path("tmp/oref_telegram_alerts_war.json")
POLYGONS_PATH = Path("web/locations_polygons.json")
REMOTE_DIR = Path("tmp/backfill-compare")
OUT_DIR = Path("tmp/r2_day_history_merged")
TARGET_DATES = ["2026-02-28", "2026-03-01"]


def r2_date_key(alert_date: str) -> str:
    """Map alertDate to R2 file date key. 23:xx → next day.
    Mirrors tools/backfill_history.py:50-55."""
    d = date.fromisoformat(alert_date[:10])
    if int(alert_date[11:13]) >= 23:
        d += timedelta(days=1)
    return d.isoformat()


def parse_jsonl(path: Path) -> list[dict]:
    entries = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip().rstrip(",")
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{lineno}: invalid JSONL: {e}") from e
    return entries


def to_jsonl(entries: list[dict]) -> str:
    return "".join(json.dumps(e, ensure_ascii=False) + ",\n" for e in entries)


def build_fragment_map() -> dict[str, str]:
    """Build {fragment → canonical} for polygon keys containing ", "."""
    polys = json.loads(POLYGONS_PATH.read_text(encoding="utf-8"))
    keys = list(polys.keys()) if isinstance(polys, dict) else [
        f["properties"].get("name") for f in polys.get("features", [])
    ]
    key_set = set(keys)
    mapping: dict[str, str] = {}
    for k in keys:
        if k and ", " in k:
            for frag in [p.strip() for p in k.split(",")]:
                if frag in key_set:
                    raise ValueError(
                        f"Fragment {frag!r} of {k!r} collides with a standalone "
                        "polygon key — reverse-mapping would be ambiguous"
                    )
                if frag in mapping and mapping[frag] != k:
                    raise ValueError(
                        f"Fragment {frag!r} maps to both {mapping[frag]!r} and {k!r}"
                    )
                mapping[frag] = k
    return mapping


def load_dump(fragment_map: dict[str, str]) -> dict[str, list[dict]]:
    """Read Yuval's dump, filter to target R2 buckets, apply reverse-mapping,
    dedup by (data, alertDate-to-second, category_desc).
    Returns {date: [entries...]}."""
    raw = json.loads(DUMP_PATH.read_text(encoding="utf-8"))
    by_date: dict[str, list[dict]] = defaultdict(list)
    seen: dict[str, set[tuple]] = defaultdict(set)
    remapped = 0
    skipped_out_of_range = 0

    for e in raw:
        bucket = r2_date_key(e["alertDate"])
        if bucket not in TARGET_DATES:
            skipped_out_of_range += 1
            continue

        data = e["data"]
        if data in fragment_map:
            data = fragment_map[data]
            remapped += 1

        key = (data, e["alertDate"], e["category_desc"])
        if key in seen[bucket]:
            continue
        seen[bucket].add(key)

        by_date[bucket].append({
            "data": data,
            "alertDate": e["alertDate"],
            "category_desc": e["category_desc"],
            "rid": 0,
        })

    print(f"Dump: in-scope {sum(len(v) for v in by_date.values())} entries "
          f"({remapped} fragment→canonical remaps), "
          f"skipped {skipped_out_of_range} out-of-range")
    return by_date


def merge(remote: list[dict], expanded: list[dict]) -> tuple[list[dict], int]:
    """Add expanded entries that don't already exist in remote.
    Dedup key: (data, alertDate-to-minute, category_desc).
    Returns (merged_sorted, num_added)."""
    def key(e: dict) -> tuple:
        return (e["data"], e["alertDate"][:16], e["category_desc"])

    existing = {key(e) for e in remote}
    added = [e for e in expanded if key(e) not in existing]
    merged = remote + added
    merged.sort(key=lambda e: (e["alertDate"], e["data"]))
    return merged, len(added)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fragment_map = build_fragment_map()
    print(f"Fragment map: {len(fragment_map)} fragments → "
          f"{len(set(fragment_map.values()))} canonical names")

    expanded_by_date = load_dump(fragment_map)

    for d in TARGET_DATES:
        remote_path = REMOTE_DIR / f"{d}.remote.jsonl"
        out_path = OUT_DIR / f"{d}.jsonl"

        remote = parse_jsonl(remote_path)
        expanded = expanded_by_date.get(d, [])

        merged, added = merge(remote, expanded)
        out_path.write_text(to_jsonl(merged), encoding="utf-8")

        print(f"{d}: existing {len(remote)}, added {added}, total {len(merged)}"
              f"  → {out_path}")


if __name__ == "__main__":
    main()

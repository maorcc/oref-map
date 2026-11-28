# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Compare the R2 day-history files with Oref's archive. Read-only: writes nothing to R2.

For each R2 day file in the range, matches entries by rid against the archive
(www.oref.org.il/api/v1/AlertHistory) and reports:
  missing    in the archive, not in any R2 file read
  R2 only    in R2, not in the archive
  dup        rid stored more than once in R2
  moved      stored in a different day file than its exact time belongs to
  off >30s   stored time differs from the exact time by more than 30 s (the old API
             rounded to the nearest minute, so up to 30 s is expected)
  fields     same rid, different city or title

Archive days are cached in cache/oref-archive/ (complete past days only), so a rerun
fetches nothing again. Details go to reports/audit-<timestamp>.json.

With --apply, rewrites each R2 day file in the range to match the archive: every entry
gets its exact time and goes to the file that time belongs to, missing entries are added,
and entries the archive lacks are kept as they are. Files outside the range are not
touched, so an entry whose file would be outside the range keeps its stored time. Files
the ingestion cron may still write are refused. Each file is re-read before it is written,
skipped if it changed since the plan was made, and backed up to backups/r2/ first.

Usage:
    uv run tools/audit_history.py --from 2026-02-28                  # report only
    uv run tools/audit_history.py --from 2026-03-01 --to 2026-03-31
    uv run tools/audit_history.py --from 2026-02-28 --apply          # report, plan, confirm
"""

import argparse
import json
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

from backfill_history import (
    BACKUP_DIR,
    check_wrangler,
    cron_cutoff,
    day_range,
    fetch_range,
    israel_now,
    r2_date_key,
    r2_get,
    r2_put,
    to_jsonl,
)

CACHE_DIR = Path("cache/oref-archive")
REPORT_DIR = Path("reports")
R2_READERS = 8
ROUNDING_S = 30
R2_WRITERS = 4


def archive_day(day: date, today: date) -> list[dict]:
    """Archive entries of one calendar day, from the cache when the day is complete."""
    path = CACHE_DIR / f"{day.isoformat()}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    entries = fetch_range(day, day + timedelta(days=1), verbose=False)
    if day < today:
        path.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    return entries


def seconds_between(a: str, b: str) -> int:
    return int((datetime.fromisoformat(a) - datetime.fromisoformat(b)).total_seconds())


def main() -> None:
    now = israel_now()
    today = now.date()
    today_key = r2_date_key(now.strftime("%Y-%m-%dT%H:%M:%S"))
    yesterday_key = (date.fromisoformat(today_key) - timedelta(days=1)).isoformat()
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="first", required=True, help="first R2 day (YYYY-MM-DD)")
    parser.add_argument("--to", dest="last", default=yesterday_key,
                        help=f"last R2 day, inclusive (default: {yesterday_key})")
    parser.add_argument("--apply", action="store_true",
                        help="rewrite the R2 files to match the archive (asks first)")
    parser.add_argument("--yes", action="store_true", help="with --apply: don't ask")
    args = parser.parse_args()
    for d in (args.first, args.last):
        date.fromisoformat(d)
    if args.first > args.last or args.last > today_key:
        sys.exit(f"Error: need --from <= --to <= {today_key}")
    live_from = r2_date_key(cron_cutoff(now))
    if args.apply and args.last >= live_from:
        sys.exit(f"Error: --apply needs --to before {live_from} (the cron may still write it)")
    check_wrangler()

    days = day_range(args.first, args.last)
    # Calendar days that feed these R2 days: R2 day D starts at (D-1)T23:00.
    cal_days = day_range((date.fromisoformat(days[0]) - timedelta(days=1)).isoformat(), days[-1])
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Archive: {len(cal_days)} calendar days ({cal_days[0]} .. {cal_days[-1]})")
    archive: dict = {}
    for i, d in enumerate(cal_days, 1):
        entries = archive_day(date.fromisoformat(d), today)
        for e in entries:
            archive[e["rid"]] = e
        print(f"  {d}: {len(entries)} entries ({i}/{len(cal_days)})", flush=True)

    # Also read the day after the range: it may hold rounded 22:59:3x entries as 23:00.
    next_day = (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat()
    r2_days = days + ([next_day] if next_day <= today_key else [])
    # The archive fetch can outlast wrangler's OAuth access token; refresh it once here, so
    # the parallel reads below don't all try to refresh it at the same time.
    check_wrangler()
    print(f"Reading {len(r2_days)} R2 day files...")
    with ThreadPoolExecutor(R2_READERS) as pool:
        r2 = dict(zip(r2_days, (entries for entries, _ in pool.map(r2_get, r2_days)),
                      strict=True))

    stored: dict = {}            # rid -> list of (file, entry)
    for day, entries in r2.items():
        for e in entries:
            stored.setdefault(e["rid"], []).append((day, e))

    details: dict[str, list] = {k: [] for k in
                                ("missing", "r2_only", "dup", "moved", "off", "fields")}
    rows: dict[str, Counter] = {day: Counter() for day in days}
    diffs: Counter = Counter()
    in_range = set(days)

    for rid, e in archive.items():
        key = r2_date_key(e["alertDate"])
        if key not in in_range:
            continue
        rows[key]["archive"] += 1
        if rid not in stored:
            rows[key]["missing"] += 1
            details["missing"].append(e)

    for rid, copies in stored.items():
        for day, e in copies:
            if day not in in_range:
                continue
            rows[day]["r2"] += 1
            exact = archive.get(rid)
            if exact is None:
                rows[day]["r2_only"] += 1
                details["r2_only"].append({"file": day, **e})
                continue
            diff = seconds_between(e["alertDate"], exact["alertDate"])
            diffs["0" if diff == 0 else f"<={ROUNDING_S}s" if abs(diff) <= ROUNDING_S
                  else f">{ROUNDING_S}s"] += 1
            if abs(diff) > ROUNDING_S:
                rows[day]["off"] += 1
                details["off"].append({"file": day, "stored": e, "exact": exact, "diff_s": diff})
            if r2_date_key(exact["alertDate"]) != day:
                rows[day]["moved"] += 1
                details["moved"].append({"file": day, "stored": e, "exact": exact})
            if e["data"] != exact["data"] or e["category_desc"] != exact["category_desc"]:
                rows[day]["fields"] += 1
                details["fields"].append({"file": day, "stored": e, "exact": exact})
        if len(copies) > 1:
            first_day = copies[0][0]
            if first_day in in_range:
                rows[first_day]["dup"] += len(copies) - 1
                details["dup"].append({"rid": rid, "copies": [{"file": d, **e} for d, e in copies]})

    cols = ["r2", "archive", "missing", "r2_only", "dup", "moved", "off", "fields"]
    flagged = ["missing", "r2_only", "dup", "moved", "off", "fields"]
    print(f"\n{'day':<12}" + "".join(f"{c:>9}" for c in cols))
    for day in days:
        row = rows[day]
        if any(row[c] for c in flagged):
            print(f"{day:<12}" + "".join(f"{row[c]:>9}" for c in cols))
    total = sum(rows.values(), Counter())
    print(f"{'total':<12}" + "".join(f"{total[c]:>9}" for c in cols))
    print("(days with nothing flagged are not listed)")
    print("Stored time vs exact time: "
          + ", ".join(f"{k}: {v}" for k, v in sorted(diffs.items())))

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report = REPORT_DIR / f"audit-{datetime.now():%Y%m%d-%H%M%S}.json"
    report.write_text(json.dumps({"range": [days[0], days[-1]], "totals": dict(total),
                                  "time_diffs": dict(diffs), **details},
                                 ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Details: {report}")

    if args.apply:
        apply(days, r2, archive, args.yes)


def plan_files(days: list[str], r2: dict, archive: dict) -> tuple[dict, Counter]:
    """New contents of each R2 day file in `days`, matched to the archive."""
    new: dict[str, list[dict]] = {day: [] for day in days}
    counts: Counter = Counter()
    seen: set = set()
    for day in days:
        for e in r2[day]:
            if e["rid"] in seen:
                counts["duplicate dropped"] += 1
                continue
            seen.add(e["rid"])
            exact = archive.get(e["rid"])
            target = r2_date_key(exact["alertDate"]) if exact else None
            if target not in new:            # not in the archive, or its file is out of range
                new[day].append(e)
                continue
            fixed = {**e, "alertDate": exact["alertDate"]}
            counts["retimed"] += fixed["alertDate"] != e["alertDate"]
            counts["moved"] += target != day
            new[target].append(fixed)
    seen.update(e["rid"] for day, entries in r2.items() if day not in new for e in entries)
    for rid, e in archive.items():
        key = r2_date_key(e["alertDate"])
        if key in new and rid not in seen:
            new[key].append(e)
            counts["added"] += 1
    for entries in new.values():
        entries.sort(key=lambda e: e["alertDate"])   # stable: ties keep their order
    return new, counts


def apply(days: list[str], r2: dict, archive: dict, auto_yes: bool) -> None:
    new, counts = plan_files(days, r2, archive)
    changed = [day for day in days if new[day] != r2[day]]
    print(f"\nApply plan: rewrite {len(changed)} of {len(days)} files; "
          + ", ".join(f"{k} {v}" for k, v in counts.items()))
    if not changed:
        return
    if not auto_yes and input("Rewrite these files in R2? [y/N] ").strip().lower() != "y":
        print("Nothing written.")
        return

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    def write(day: str) -> str:
        try:
            current, raw = r2_get(day)
            if current != r2[day]:
                return f"  {day}: SKIPPED, changed since the plan was made; rerun"
            (BACKUP_DIR / f"{day}.{stamp}.jsonl").write_text(raw, encoding="utf-8")
            r2_put(day, to_jsonl(new[day]))
        except Exception as e:  # noqa: BLE001 - report every file, then the summary
            return f"  {day}: FAILED, {e}"
        return f"  {day}: {len(current)} -> {len(new[day])} entries"

    check_wrangler()   # refresh the OAuth token once before the parallel writes
    with ThreadPoolExecutor(R2_WRITERS) as pool:
        for line in pool.map(write, changed):
            print(line, flush=True)
    print(f"Backups: {BACKUP_DIR}/<day>.{stamp}.jsonl")


if __name__ == "__main__":
    main()

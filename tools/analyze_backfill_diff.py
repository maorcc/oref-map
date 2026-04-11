#!/usr/bin/env uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Analyze differences between remote (R2) and new (backfill) JSONL files
in tmp/backfill-compare/.

Usage:
    uv run tools/analyze_backfill_diff.py
    uv run tools/analyze_backfill_diff.py --verbose
    uv run tools/analyze_backfill_diff.py --date 2026-03-10
"""

import json
import sys
from collections import Counter
from pathlib import Path

COMPARE_DIR = Path("tmp/backfill-compare")


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


def has_special_chars(name: str) -> bool:
    return "'" in name or "\u05F3" in name or "\u05F4" in name


def analyze_date(day: str, remote: list[dict], new: list[dict], verbose: bool) -> dict:
    remote_rids = {e["rid"] for e in remote}
    new_rids = {e["rid"] for e in new}

    only_remote = [e for e in remote if e["rid"] not in new_rids]
    only_new = [e for e in new if e["rid"] not in remote_rids]

    result = {
        "day": day,
        "remote": len(remote),
        "new": len(new),
        "only_remote": len(only_remote),
        "only_new": len(only_new),
    }

    if not only_remote and not only_new:
        result["status"] = "identical"
        return result

    if not remote and new:
        result["status"] = "missing_from_r2"
        return result

    result["status"] = "differs"

    if only_remote:
        cities = Counter(e["data"] for e in only_remote)
        special = sum(1 for c in cities if has_special_chars(c))
        result["only_remote_cities"] = len(cities)
        result["only_remote_special_char_cities"] = special
        result["only_remote_all_special"] = special == len(cities)

        hour_dist = Counter(e["alertDate"][:13] for e in only_remote)
        result["only_remote_hours"] = dict(sorted(hour_dist.items()))

        if verbose:
            result["only_remote_top_cities"] = cities.most_common(10)
            result["only_remote_samples"] = [
                {"rid": e["rid"], "alertDate": e["alertDate"],
                 "data": e["data"], "category_desc": e["category_desc"]}
                for e in only_remote[:5]
            ]

    if only_new:
        cities = Counter(e["data"] for e in only_new)
        result["only_new_cities"] = len(cities)
        if verbose:
            result["only_new_samples"] = [
                {"rid": e["rid"], "alertDate": e["alertDate"],
                 "data": e["data"], "category_desc": e["category_desc"]}
                for e in only_new[:5]
            ]

    return result


def main() -> None:
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    filter_date = None
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--date" and i + 1 < len(sys.argv):
            filter_date = sys.argv[i + 1]

    days = sorted(
        {f.name.replace(".remote.jsonl", "") for f in COMPARE_DIR.glob("*.remote.jsonl")}
        | {f.name.replace(".new.jsonl", "") for f in COMPARE_DIR.glob("*.new.jsonl")}
    )
    if not days:
        print(f"No files found in {COMPARE_DIR}")
        sys.exit(1)

    if filter_date:
        days = [d for d in days if filter_date in d]

    results = []
    for day in days:
        remote_file = COMPARE_DIR / f"{day}.remote.jsonl"
        new_file = COMPARE_DIR / f"{day}.new.jsonl"
        remote = parse_jsonl(remote_file) if remote_file.exists() else []

        if not new_file.exists():
            results.append({
                "day": day, "remote": len(remote), "new": "MISSING",
                "only_remote": len(remote), "only_new": 0,
                "status": "no_new_file",
            })
            continue

        new = parse_jsonl(new_file)
        results.append(analyze_date(day, remote, new, verbose))

    # Print report
    print(f"\n{'=' * 70}")
    print("  Backfill diff report")
    print(f"{'=' * 70}")
    print(f"  {'Date':<12} {'Remote':>8} {'New':>8} {'Only-R':>7} {'Only-N':>7}  Status")
    print(f"  {'-'*12} {'-'*8} {'-'*8} {'-'*7} {'-'*7}  {'------'}")

    total_only_r = 0
    total_only_n = 0
    status_counts: Counter = Counter()

    for r in results:
        new_str = str(r["new"]) if r["new"] != "MISSING" else "MISSING"
        only_r = r.get("only_remote", 0)
        only_n = r.get("only_new", 0)
        status = r["status"]
        total_only_r += only_r if isinstance(only_r, int) else 0
        total_only_n += only_n if isinstance(only_n, int) else 0
        status_counts[status] += 1

        flag = ""
        if status == "missing_from_r2":
            flag = " *** R2 EMPTY"
        elif status == "no_new_file":
            flag = " --- not compared"
        elif only_r > 0:
            flag = " !! entries lost if overwritten"
            if r.get("only_remote_all_special"):
                flag += " (all apostrophe cities)"

        print(
            f"  {r['day']:<12} {r['remote']:>8} {new_str:>8}"
            f" {only_r:>7} {only_n:>7}  {status}{flag}"
        )

        if verbose and status == "differs":
            if r.get("only_remote_top_cities"):
                print("    Top only-remote cities:")
                for city, cnt in r["only_remote_top_cities"]:
                    marker = " *" if has_special_chars(city) else ""
                    print(f"      {cnt:3d}  {city}{marker}")
            if r.get("only_new_samples"):
                print("    Only-new samples:")
                for e in r["only_new_samples"]:
                    print(f"      rid={e['rid']} {e['alertDate']} {e['data']}")

    print("\n  Status summary:")
    for status, cnt in sorted(status_counts.items()):
        print(f"    {status:<22} {cnt}")
    print(f"\n  Total only-remote (entries that would be lost): {total_only_r}")
    print(f"  Total only-new    (entries to be gained):       {total_only_n}")
    print(f"{'=' * 70}")

    # Root cause analysis
    print("\n  Root cause analysis:")
    differs = [r for r in results if r["status"] == "differs" and r.get("only_remote", 0) > 0]
    if differs:
        print(f"  - {len(differs)} dates have only-remote entries (entries in R2 not returned by API).")
        special_dates = [r for r in differs if r.get("only_remote_all_special")]
        if special_dates:
            print(f"  - {len(special_dates)} of these dates have ONLY apostrophe/geresh cities in only-remote.")
            print("    Root cause: oref API migrated city names from ASCII apostrophes to Hebrew")
            print("    geresh/gershayim (׳/״). Older entries under the ASCII name are no longer")
            print("    returned by mode=3 city-by-city queries, even though they were captured")
            print("    by the ingestion worker (mode=1, no city filter) at the time.")
            print("    => DO NOT overwrite these dates — you will permanently lose these entries.")

    missing_r2 = [r for r in results if r["status"] == "missing_from_r2"]
    if missing_r2:
        days = [r["day"] for r in missing_r2]
        total_entries = sum(r["new"] for r in missing_r2 if isinstance(r["new"], int))
        print(f"  - {len(missing_r2)} dates are missing from R2 entirely ({days[0]}..{days[-1]}).")
        print(f"    These have {total_entries} new entries ready to upload.")
        print("    Root cause: ingestion worker likely had a gap during this period.")
        print("    => Safe to upload — no existing data to lose.")


if __name__ == "__main__":
    main()

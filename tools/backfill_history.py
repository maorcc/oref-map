#!/usr/bin/env uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["aiohttp"]
# ///
"""
Backfill alert history into R2 bucket oref-history.

For each date from WAR_START to yesterday:
- Fetches fresh data from the oref API (city by city, mode=3)
- Downloads the existing remote file from R2 via the public day-history API
- Compares by rid set and shows a diff summary
- Saves both versions in tmp/backfill-compare/ for manual inspection
- Prompts whether to overwrite each date with differences

Identical dates are skipped silently.

Usage:
    uv run tools/backfill_history.py            # WAR_START..yesterday, interactive
    uv run tools/backfill_history.py --today      # merge today first, then interactive
    uv run tools/backfill_history.py --yes        # overwrite all without prompting
    uv run tools/backfill_history.py --today --yes # merge today + overwrite all
    uv run tools/backfill_history.py --dry-run    # compare only, no uploads, no prompts
    uv run tools/backfill_history.py --yes --force # overwrite all including unsafe dates
    uv run tools/backfill_history.py --reuse       # skip oref fetch, reuse tmp/backfill-compare/ files
"""

import asyncio
import json
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import aiohttp

BASE_URL = "https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx"
LOCATIONS_URL = "https://oref-map.org/locations_polygons.json"
DAY_HISTORY_URL = "https://oref-map.org/api/day-history"
HEADERS = {
    "Referer": "https://www.oref.org.il/",
    "X-Requested-With": "XMLHttpRequest",
}
CONCURRENCY = 30


def r2_date_key(alert_date: str) -> str:
    """Map alertDate to R2 file date key. 23:xx → next day."""
    d = date.fromisoformat(alert_date[:10])
    if int(alert_date[11:13]) >= 23:
        d += timedelta(days=1)
    return d.isoformat()


def ascii_to_geresh(name: str) -> str:
    """Convert ASCII apostrophes to Hebrew geresh/gershayim (oref API migration)."""
    return name.replace("''", "\u05F4").replace("'", "\u05F3")


RETRIES = 5
RETRY_DELAYS = [2, 5, 15, 30]
WAR_START = "2026-02-28"
BUCKET = "oref-history"
COMPARE_DIR = Path("tmp/backfill-compare")


async def fetch_city(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    city: str,
) -> list:
    url = f"{BASE_URL}?lang=he&mode=3&city_0={quote(city)}"
    async with semaphore:
        for attempt in range(RETRIES):
            try:
                timeout = aiohttp.ClientTimeout(total=20)
                async with session.get(url, headers=HEADERS, timeout=timeout) as resp:
                    resp.raise_for_status()
                    text = await resp.text(encoding="utf-8-sig")
                    data = json.loads(text) if text.strip() else []
                    print(f"  OK  {city} ({len(data)} entries)")
                    return data
            except Exception as e:
                if attempt < RETRIES - 1:
                    print(f"  RETRY {attempt + 1} {city}: {e!r}")
                    await asyncio.sleep(RETRY_DELAYS[attempt])
                else:
                    raise RuntimeError(f"city {city!r} failed after {RETRIES} attempts: {e!r}") from e


async def fetch_cities(session: aiohttp.ClientSession) -> list[str]:
    async with session.get(LOCATIONS_URL) as resp:
        data = await resp.json(content_type=None)
    return [k for k in data if not k.startswith("_")]


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


async def fetch_remote(
    session: aiohttp.ClientSession,
    day: str,
    dest: Path,
) -> list[dict]:
    """Fetch day-history from the public API. Returns entries or [] if not found.
    Retries on network errors. Raises on unexpected HTTP errors (fail fast)."""
    for attempt in range(RETRIES):
        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with session.get(f"{DAY_HISTORY_URL}?date={day}", timeout=timeout) as resp:
                if resp.status == 404:
                    dest.write_text("", encoding="utf-8")
                    return []
                if resp.status != 200:
                    raise RuntimeError(f"day-history {day}: unexpected HTTP {resp.status}")
                data = await resp.json(content_type=None)
            dest.write_text(to_jsonl(data), encoding="utf-8")
            return data
        except RuntimeError:
            raise  # don't retry explicit HTTP errors
        except Exception as e:
            if attempt < RETRIES - 1:
                print(f"  RETRY {attempt + 1} day-history {day}: {e!r}")
                await asyncio.sleep(RETRY_DELAYS[attempt])
            else:
                raise RuntimeError(f"day-history {day} failed after {RETRIES} attempts: {e!r}") from e


def wrangler_put(key: str, data: bytes, content_type: str) -> bool:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".tmp") as f:
        f.write(data)
        tmp_path = f.name
    try:
        result = subprocess.run(
            ["npx", "--yes", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}",
             "--file", tmp_path, "--content-type", content_type, "--remote"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"  UPLOAD FAIL {key}:\n{result.stderr}", file=sys.stderr)
            return False
        return True
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def merge_entries(backfill: list[dict], remote: list[dict]) -> list[dict]:
    """Union of both entry sets by rid, sorted by alertDate."""
    by_rid = {e["rid"]: e for e in remote}
    for e in backfill:
        by_rid.setdefault(e["rid"], e)
    return sorted(by_rid.values(), key=lambda e: e["alertDate"])


def has_special_chars(name: str) -> bool:
    return "'" in name or "\u05F3" in name or "\u05F4" in name


def classify_diff(
    only_remote: list[dict],
    only_new: list[dict],
) -> tuple[str, str]:
    """Return (verdict, explanation).
    verdict: "safe" | "unsafe" | "caution"
    """
    if not only_remote:
        return "safe", "no entries will be lost"
    cities = {e["data"] for e in only_remote}
    special = sum(1 for c in cities if has_special_chars(c))
    if special == len(cities):
        return "unsafe", (
            f"{len(only_remote)} entries from {len(cities)} apostrophe/geresh cities "
            "will be permanently lost (oref API name migration)"
        )
    return "caution", (
        f"{len(only_remote)} entries from {len(cities)} cities will be lost "
        f"({special} apostrophe, cause unknown for rest)"
    )


async def main() -> None:
    start_time = datetime.now()
    t0 = time.monotonic()
    update_today = "--today" in sys.argv
    auto_yes = "--yes" in sys.argv
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    reuse = "--reuse" in sys.argv

    if reuse and update_today:
        print("Error: --reuse is not compatible with --today", file=sys.stderr)
        sys.exit(1)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    today_str = date.today().isoformat()

    # The oref API only returns ~1 month of history. For dates older than 3 weeks,
    # the remote R2 files are the only copy — do not touch them.
    SAFE_WINDOW_DAYS = 21
    safe_start = max(
        date.fromisoformat(WAR_START),
        date.today() - timedelta(days=SAFE_WINDOW_DAYS),
    )

    all_dates = []
    d = safe_start
    end = date.fromisoformat(yesterday)
    while d <= end:
        all_dates.append(d.isoformat())
        d += timedelta(days=1)

    if not all_dates:
        print("No eligible dates in selected range; exiting.")
        return

    print(f"Date range: {all_dates[0]} .. {all_dates[-1]} ({len(all_dates)} dates)")
    print(f"  (dates before {safe_start} skipped — API retention limit)")
    if update_today:
        print(f"--today: will also merge {today_str} (no prompt)")
    COMPARE_DIR.mkdir(parents=True, exist_ok=True)

    fetch_elapsed: float | None = None

    if reuse:
        print("--reuse: loading from tmp/backfill-compare/ (skipping oref fetch)")
        by_date: dict[str, list] = {}
        for new_file in sorted(COMPARE_DIR.glob("*.new.jsonl")):
            day = new_file.name.replace(".new.jsonl", "")
            by_date[day] = parse_jsonl(new_file)
        remote_by_date: dict[str, list] = {}
        for day in all_dates:
            remote_file = COMPARE_DIR / f"{day}.remote.jsonl"
            if not remote_file.exists():
                print(f"Error: --reuse missing {remote_file}; run without --reuse first", file=sys.stderr)
                sys.exit(1)
            remote_by_date[day] = parse_jsonl(remote_file)
        total = sum(len(v) for v in by_date.values())
        print(f"  Loaded {total} entries across {len(by_date)} dates")
    else:
        async with aiohttp.ClientSession() as session:
            print("Fetching city list...")
            cities = await fetch_cities(session)
            extra = [ascii_to_geresh(c) for c in cities if "'" in c]
            cities = cities + extra
            print(f"  {len(cities)} cities ({len(extra)} geresh variants)")

            print(f"Fetching history for all cities (concurrency={CONCURRENCY})...")
            semaphore = asyncio.Semaphore(CONCURRENCY)
            tasks = [fetch_city(session, semaphore, city) for city in cities]
            t_fetch = time.monotonic()
            results = await asyncio.gather(*tasks)
            fetch_elapsed = time.monotonic() - t_fetch
            print(f"  Oref fetch done in {fetch_elapsed:.1f}s")

            # Fetch all remote files in parallel
            dates_to_fetch = all_dates + ([today_str] if update_today else [])
            print(f"\nFetching {len(dates_to_fetch)} remote files from R2...")
            remote_tasks = [
                fetch_remote(session, day, COMPARE_DIR / f"{day}.remote.jsonl")
                for day in dates_to_fetch
            ]
            remote_results = await asyncio.gather(*remote_tasks)
            remote_by_date = dict(zip(dates_to_fetch, remote_results, strict=True))
            print("  Done.")

        print("Deduplicating and grouping by date...")
        seen_rids: set = set()
        by_date = {}
        for city_entries in results:
            for e in city_entries:
                rid = e.get("rid")
                if rid in seen_rids:
                    continue
                seen_rids.add(rid)
                alert_date = e.get("alertDate", "")
                if not alert_date or alert_date[:10] < WAR_START:
                    continue
                entry = {
                    "data": e["data"],
                    "alertDate": alert_date,
                    "category_desc": e["category_desc"],
                    "rid": rid,
                }
                by_date.setdefault(r2_date_key(alert_date), []).append(entry)

        total = sum(len(v) for v in by_date.values())
        print(f"  {total} unique entries across {len(by_date)} dates")

    # Stats tracking
    today_result = None  # "uploaded", "skipped", "failed", or None (not requested)
    today_added = 0
    skipped_identical = 0
    skipped_declined = 0

    # --today: merge today's data immediately (no prompt)
    if update_today:
        now = datetime.now()
        cutoff_minutes = [0, 15, 30, 45]
        candidates = [
            m for m in cutoff_minutes if m + 3 <= now.minute
        ]
        if candidates:
            cutoff_time = now.replace(
                minute=max(candidates), second=0, microsecond=0,
            )
        else:
            cutoff_time = (now - timedelta(hours=1)).replace(
                minute=45, second=0, microsecond=0,
            )
        cutoff_str = cutoff_time.strftime("%Y-%m-%dT%H:%M:%S")
        print(f"\nCutoff: {cutoff_str} (entries after this left to cron)")

        all_today = sorted(by_date.get(today_str, []), key=lambda e: e["alertDate"])
        backfill_entries = [e for e in all_today if e["alertDate"] < cutoff_str]
        skipped = len(all_today) - len(backfill_entries)
        if skipped:
            print(
                f"  filtered: {len(backfill_entries)} before cutoff,"
                f" {skipped} skipped",
            )

        remote_entries = remote_by_date[today_str]
        print(f"{today_str} (today): remote={len(remote_entries)}, backfill={len(backfill_entries)}")

        merged = merge_entries(backfill_entries, remote_entries)
        remote_rids = {e["rid"] for e in remote_entries}
        backfill_rids = {e["rid"] for e in backfill_entries}
        added = len(backfill_rids - remote_rids)
        kept = len(remote_rids - backfill_rids)
        print(
            f"  merged={len(merged)}"
            f" (added {added} from backfill,"
            f" kept {kept} remote-only)",
        )

        if added > 0 and dry_run:
            print(f"  --dry-run: would upload {today_str}.jsonl ({added} new entries)")
            today_result = "skipped"
        elif added > 0:
            elapsed = time.monotonic() - t0
            print(f"  Uploading {today_str}.jsonl... (elapsed: {elapsed:.0f}s)")
            data = to_jsonl(merged).encode("utf-8")
            if wrangler_put(f"{today_str}.jsonl", data, "application/jsonl"):
                upload_time = datetime.now()
                upload_str = upload_time.strftime("%H:%M:%S")
                cron_minutes = [3, 18, 33, 48]
                next_crons = [m for m in cron_minutes if m > upload_time.minute]
                if next_crons:
                    next_cron = upload_time.replace(
                        minute=next_crons[0], second=0, microsecond=0,
                    )
                else:
                    next_cron = (
                        upload_time + timedelta(hours=1)
                    ).replace(minute=3, second=0, microsecond=0)
                margin = (next_cron - upload_time).total_seconds() / 60

                print("\n  --- Today summary ---")
                print(f"  Cutoff:          {cutoff_str}")
                print(f"  Upload completed: {upload_str}")
                print(f"  Total duration:  {elapsed:.0f}s")
                next_cron_str = next_cron.strftime('%H:%M')
                print(f"  Next cron:       {next_cron_str}")
                ok = "OK" if margin >= 2 else "TIGHT!"
                print(f"  Margin:          {margin:.1f} min {ok}")
                today_result = "uploaded"
                today_added = added
            else:
                print("  FAILED", file=sys.stderr)
                today_result = "failed"
        else:
            print("  no new entries to add, skipping upload")
            today_result = "skipped"

    # Compare each past date against remote
    to_upload: list[tuple[str, list]] = []

    for day in all_dates:
        new_entries = sorted(by_date.get(day, []), key=lambda e: e["alertDate"])
        new_rids = {e["rid"] for e in new_entries}

        remote_entries = remote_by_date[day]
        remote_rids = {e["rid"] for e in remote_entries}

        # Always save .new.jsonl so --reuse can find all dates
        new_path = COMPARE_DIR / f"{day}.new.jsonl"
        new_path.write_text(to_jsonl(new_entries), encoding="utf-8")

        print(f"\n{day}: remote={len(remote_rids)}, new={len(new_rids)}")

        if not remote_entries and not new_entries:
            print("  both empty, skipping")
            skipped_identical += 1
            continue

        only_remote_entries = [e for e in remote_entries if e["rid"] not in new_rids]
        only_new_entries = [e for e in new_entries if e["rid"] not in remote_rids]

        if not only_remote_entries and not only_new_entries:
            print("  identical, skipping")
            skipped_identical += 1
            continue

        verdict, explanation = classify_diff(only_remote_entries, only_new_entries)
        label = {"safe": "SAFE", "unsafe": "UNSAFE", "caution": "CAUTION"}[verdict]
        print(f"  only_in_remote={len(only_remote_entries)}, only_in_new={len(only_new_entries)}")
        print(f"  [{label}] {explanation}")
        print(f"  Saved: {COMPARE_DIR}/{day}.remote.jsonl, {new_path.name}")

        if dry_run:
            print("  --dry-run: skipping upload")
            skipped_declined += 1
        elif verdict == "unsafe" and not force:
            print(f"  Skipping {day} — unsafe (use --force to override)")
            skipped_declined += 1
        elif auto_yes:
            print(f"  --yes: overwriting {day}")
            to_upload.append((day, new_entries))
        else:
            answer = input(f"  Overwrite {day}? [{label}] [y/N] ").strip().lower()
            if answer == "y":
                to_upload.append((day, new_entries))
            else:
                skipped_declined += 1

    success = 0
    failures = []
    if to_upload:
        print(f"\nUploading {len(to_upload)} dates...")
        for day, entries in to_upload:
            print(f"  Uploading {day}.jsonl ({len(entries)} entries)...")
            data = to_jsonl(entries).encode("utf-8")
            if not wrangler_put(f"{day}.jsonl", data, "application/jsonl"):
                failures.append(day)
                continue
            success += 1

    # --- Final summary ---
    end_time = datetime.now()
    elapsed = time.monotonic() - t0
    print(f"\n{'=' * 50}")
    print("  Backfill summary")
    print(f"{'=' * 50}")
    print(f"  Started:          {start_time.strftime('%H:%M:%S')}")
    print(f"  Finished:         {end_time.strftime('%H:%M:%S')}")
    print(f"  Duration:         {elapsed:.0f}s ({elapsed / 60:.1f} min)")
    if fetch_elapsed is not None:
        print(f"  Oref fetch time:  {fetch_elapsed:.1f}s (concurrency={CONCURRENCY})")
    else:
        print("  Oref fetch time:  skipped (--reuse)")
    print(f"  API entries:      {total} across {len(by_date)} dates")
    print(f"  Date range:       {all_dates[0]} .. {all_dates[-1]}")
    if update_today:
        if today_result == "uploaded":
            print(f"  Today ({today_str}): {today_result}"
                  f" ({today_added} entries added)")
        else:
            print(f"  Today ({today_str}): {today_result}")
    print(f"  Past dates:       {len(all_dates)} total")
    print(f"    Identical:      {skipped_identical}")
    print(f"    Uploaded:       {success}")
    if skipped_declined:
        print(f"    Declined:       {skipped_declined}")
    if failures:
        print(f"    Failed:         {len(failures)} — {failures}")
    print(f"{'=' * 50}")

    if failures:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["aiohttp"]
# ///
"""
Backfill alert history into R2 bucket oref-history.

For each date from WAR_START to yesterday:
- Fetches fresh data from the oref API (city by city, mode=3)
- Downloads the existing remote file from R2 (if any)
- Compares by rid set and shows a diff summary
- Saves both versions in tmp/backfill-compare/ for manual inspection
- Prompts whether to overwrite each date with differences

Identical dates are skipped silently.

Usage:
    uv run tools/backfill_history.py            # WAR_START..yesterday, interactive
    uv run tools/backfill_history.py --today      # merge today first, then interactive
    uv run tools/backfill_history.py --yes        # overwrite all without prompting
    uv run tools/backfill_history.py --today --yes # merge today + overwrite all
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
HEADERS = {
    "Referer": "https://www.oref.org.il/",
    "X-Requested-With": "XMLHttpRequest",
}
CONCURRENCY = 10


def r2_date_key(alert_date: str) -> str:
    """Map alertDate to R2 file date key. 23:xx → next day."""
    d = date.fromisoformat(alert_date[:10])
    if int(alert_date[11:13]) >= 23:
        d += timedelta(days=1)
    return d.isoformat()


RETRIES = 3
RETRY_DELAYS = [2, 5, 15]
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
                    print(f"  ERR {city}: {e!r}")
                    return []
    return []


async def fetch_cities(session: aiohttp.ClientSession) -> list[str]:
    async with session.get(LOCATIONS_URL) as resp:
        data = await resp.json(content_type=None)
    return list(data.keys())


def parse_jsonl(path: Path) -> list[dict]:
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip().rstrip(",")
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return entries


def to_jsonl(entries: list[dict]) -> str:
    return "".join(json.dumps(e, ensure_ascii=False) + ",\n" for e in entries)


def download_remote(day: str, dest: Path) -> list[dict]:
    """Download YYYY-MM-DD.jsonl from R2. Returns parsed entries, or [] if not found."""
    result = subprocess.run(
        ["npx", "--yes", "wrangler", "r2", "object", "get", f"{BUCKET}/{day}.jsonl",
         "--file", str(dest), "--remote"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        return []
    return parse_jsonl(dest)


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


async def main() -> None:
    start_time = datetime.now()
    t0 = time.monotonic()
    update_today = "--today" in sys.argv
    auto_yes = "--yes" in sys.argv
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    today_str = date.today().isoformat()

    all_dates = []
    d = date.fromisoformat(WAR_START)
    end = date.fromisoformat(yesterday)
    while d <= end:
        all_dates.append(d.isoformat())
        d += timedelta(days=1)

    print(f"Date range: {all_dates[0]} .. {all_dates[-1]} ({len(all_dates)} dates)")
    if update_today:
        print(f"--today: will also merge {today_str} (no prompt)")
    COMPARE_DIR.mkdir(parents=True, exist_ok=True)

    async with aiohttp.ClientSession() as session:
        print("Fetching city list...")
        cities = await fetch_cities(session)
        print(f"  {len(cities)} cities")

        print(f"Fetching history for all cities (concurrency={CONCURRENCY})...")
        semaphore = asyncio.Semaphore(CONCURRENCY)
        tasks = [fetch_city(session, semaphore, city) for city in cities]
        results = await asyncio.gather(*tasks)

    print("Deduplicating and grouping by date...")
    seen_rids: set = set()
    by_date: dict[str, list] = {}
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
        # Cutoff = last completed cron window end. Cron ingests quarter-hour blocks
        # [XX:00, XX:15), [XX:15, XX:30), etc. — the quarter ending at :00/:15/:30/:45.
        # Cron fires 3 min after each quarter ends,
        # so if now >= :03, the :00 quarter is done.
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

        remote_path = COMPARE_DIR / f"{today_str}.remote.jsonl"
        print(f"{today_str} (today): downloading remote...", end=" ", flush=True)
        remote_entries = download_remote(today_str, remote_path)
        print(f"remote={len(remote_entries)}, backfill={len(backfill_entries)}")

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

        if added > 0:
            elapsed = time.monotonic() - t0
            print(f"  Uploading {today_str}.jsonl... (elapsed: {elapsed:.0f}s)")
            data = to_jsonl(merged).encode("utf-8")
            if wrangler_put(f"{today_str}.jsonl", data, "application/jsonl"):
                upload_time = datetime.now()
                upload_str = upload_time.strftime("%H:%M:%S")
                # Next cron fires at the next :03/:18/:33/:48
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

        remote_path = COMPARE_DIR / f"{day}.remote.jsonl"
        print(f"\n{day}: downloading remote...", end=" ", flush=True)
        remote_entries = download_remote(day, remote_path)
        remote_rids = {e["rid"] for e in remote_entries}
        print(f"remote={len(remote_rids)}, new={len(new_rids)}")

        if not remote_entries and not new_entries:
            print("  both empty, skipping")
            skipped_identical += 1
            continue

        only_in_remote = remote_rids - new_rids
        only_in_new = new_rids - remote_rids

        if not only_in_remote and not only_in_new:
            print("  identical, skipping")
            skipped_identical += 1
            continue

        # Save new version locally for manual inspection
        new_path = COMPARE_DIR / f"{day}.new.jsonl"
        new_path.write_text(to_jsonl(new_entries), encoding="utf-8")

        print(f"  only_in_remote={len(only_in_remote)}, only_in_new={len(only_in_new)}")
        if only_in_remote:
            print(
                f"  WARNING: {len(only_in_remote)} entries"
                " will be lost if overwritten",
            )
        print(f"  Saved: {remote_path.name}, {new_path.name}")

        if auto_yes:
            print(f"  --yes: overwriting {day}")
            to_upload.append((day, new_entries))
        else:
            answer = input(f"  Overwrite {day}? [y/N] ").strip().lower()
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

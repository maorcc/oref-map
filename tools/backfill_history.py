# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Backfill alert history into the R2 bucket oref-history (add-only).

Fetches Oref's archive (www.oref.org.il/api/v1/AlertHistory) for a range of R2 day files,
compares it with R2 by rid, and adds the entries R2 is missing. Existing entries are never
changed or removed. Each file is backed up to backups/r2/ before it is overwritten.

Must run from a residential Israeli connection (CloudFront blocks cloud IPs), with wrangler
logged in and CLOUDFLARE_ACCOUNT_ID set.

R2 day D holds alerts from (D-1)T23:00 to DT22:59:59 (see r2_date_key). Entries in the
15-minute windows the ingestion cron may still process are left to the cron, and files the
cron may write are written only in a quiet slot between its runs.

Usage:
    uv run tools/backfill_history.py --from 2026-10-19 --dry-run   # report only
    uv run tools/backfill_history.py --from 2026-10-19             # report, confirm, write
    uv run tools/backfill_history.py --from 2026-10-19 --to 2026-11-01 --yes
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

API_URL = "https://www.oref.org.il/api/v1/AlertHistory/heb"
HEADERS = {
    "Referer": "https://www.oref.org.il/",
    "X-Requested-With": "XMLHttpRequest",
    # CloudFront blocks /api/v1 without a full browser User-Agent.
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/131.0 Safari/537.36",
}
PAGE_SIZE = 200          # fixed by the API
REQUEST_DELAY_S = 1.0    # between API requests, to stay well clear of rate limits
RETRY_DELAYS_S = [2, 5, 15, 30]
BUCKET = "oref-history"
BACKUP_DIR = Path("backups/r2")   # rollback copies of overwritten R2 files
ISRAEL = ZoneInfo("Asia/Jerusalem")

# Ingestion cron (ingestion/src/index.js): the window ending at quarter Q is fetched on odd
# minutes Q+1..Q+11 and alert-checked at Q+13 (no write); :15, :29, :31, :45, :59 are idle.
# Nothing writes day files in these minutes.
QUIET_MINUTES = {0, 12, 13, 14, 15, 16, 26, 27, 28, 29, 30, 31, 32, 42, 43, 44, 45, 46,
                 56, 57, 58, 59}
WINDOW_DONE_MIN = 14     # window ending at Q is finished (processed or abandoned) by Q+14


def r2_date_key(alert_date: str) -> str:
    """Map alertDate to its R2 file date key. 23:xx goes to the next day."""
    d = date.fromisoformat(alert_date[:10])
    if int(alert_date[11:13]) >= 23:
        d += timedelta(days=1)
    return d.isoformat()


def israel_now() -> datetime:
    return datetime.now(ISRAEL).replace(tzinfo=None)


def cron_cutoff(now: datetime) -> str:
    """Start of the oldest window the cron may still process. Entries at or after it are
    left to the cron, which appends without checking rids."""
    q = now.replace(minute=now.minute // 15 * 15, second=0, microsecond=0)
    while q + timedelta(minutes=WINDOW_DONE_MIN) > now:
        q -= timedelta(minutes=15)
    return q.strftime("%Y-%m-%dT%H:%M:%S")


def wait_for_quiet_slot() -> None:
    """Block until a minute in which the cron cannot write, with at least 40s left in it."""
    while True:
        now = israel_now()
        next_quiet = (now.minute + 1) % 60 in QUIET_MINUTES
        if now.minute in QUIET_MINUTES and (next_quiet or now.second < 20):
            return
        print(f"  waiting for a quiet slot between cron runs ({now:%H:%M:%S})...")
        time.sleep(20)


# --- Oref archive ---

def http_get_json(url: str) -> dict:
    for attempt in range(len(RETRY_DELAYS_S) + 1):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8-sig"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == len(RETRY_DELAYS_S):
                raise RuntimeError(f"GET {url} failed: {e!r}") from e
            print(f"  retry {attempt + 1}: {e!r}")
            time.sleep(RETRY_DELAYS_S[attempt])
    raise AssertionError("unreachable")


def to_entry(item: dict) -> dict:
    """API item -> R2 entry. alertDate keeps the exact seconds from `time`."""
    dt, tm = item.get("dateTime", ""), item.get("time", "")
    if len(dt) < 11 or dt[10] != "T" or len(tm) != 8 or tm[2] != ":" or tm[5] != ":":
        raise ValueError(f"unexpected dateTime/time {dt!r}/{tm!r} for rid {item.get('rid')}")
    return {
        "data": item["data"],
        "alertDate": f"{dt[:10]}T{tm}",
        "category_desc": item["category_Desc"],
        "rid": item["rid"],
    }


def fetch_archive(first_day: str, last_day: str) -> dict[str, list[dict]]:
    """All archive entries for R2 days first_day..last_day, grouped by R2 date key."""
    start = date.fromisoformat(first_day) - timedelta(days=1)   # 23:xx of the day before
    end = date.fromisoformat(last_day) + timedelta(days=1)      # `to` is exclusive
    params = {"from": start.isoformat(), "to": end.isoformat(), "cities": ""}
    by_rid: dict = {}
    page = 0
    while True:
        page += 1
        payload = http_get_json(f"{API_URL}?{urlencode(params)}")
        groups = payload.get("alarmsGroupedByDate")
        if not isinstance(groups, list):
            raise TypeError(f"unexpected payload on page {page}: {str(payload)[:200]}")
        items = [item for g in groups for item in g["value"]]
        for item in items:
            by_rid[item["rid"]] = to_entry(item)
        last = payload.get("lastRetrievedAlarm")
        print(f"  page {page}: {len(items)} entries, oldest {to_entry(last)['alertDate'] if last else '-'}")
        if len(items) < PAGE_SIZE or not last:
            break
        params.update(lastCreatedOn=last["dateTime"], lastTitle=last["category_Desc"],
                      lastCityName=last["data"])
        time.sleep(REQUEST_DELAY_S)

    by_day: dict[str, list[dict]] = {}
    for e in by_rid.values():
        key = r2_date_key(e["alertDate"])
        if first_day <= key <= last_day:
            by_day.setdefault(key, []).append(e)
    return by_day


# --- R2 via wrangler ---

def wrangler(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["wrangler", *args], check=False, capture_output=True, text=True,
                          timeout=120)


def r2_get(day: str) -> tuple[list[dict], str]:
    """Return (entries, raw text) of an R2 day file; ([], "") if it doesn't exist."""
    result = wrangler("r2", "object", "get", f"{BUCKET}/{day}.jsonl", "--remote", "--pipe")
    if result.returncode != 0:
        if "specified key does not exist" in result.stdout + result.stderr:
            return [], ""
        raise RuntimeError(f"r2 get {day}: {result.stderr or result.stdout}")
    entries = []
    for lineno, line in enumerate(result.stdout.splitlines(), 1):
        line = line.strip().rstrip(",")
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{day}.jsonl:{lineno}: invalid JSONL: {e}") from e
    return entries, result.stdout


def r2_put(day: str, text: str) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".jsonl", delete=False) as f:
        f.write(text)
        tmp_path = f.name
    try:
        result = wrangler("r2", "object", "put", f"{BUCKET}/{day}.jsonl", "--file", tmp_path,
                          "--content-type", "application/jsonl", "--remote")
        if result.returncode != 0:
            raise RuntimeError(f"r2 put {day}: {result.stderr or result.stdout}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def to_jsonl(entries: list[dict]) -> str:
    return "".join(json.dumps(e, ensure_ascii=False) + ",\n" for e in entries)


def check_wrangler() -> None:
    if not os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        sys.exit("Error: set CLOUDFLARE_ACCOUNT_ID (the wrangler login sees several accounts).")
    result = wrangler("whoami")
    out = (result.stdout + result.stderr).lower()
    if result.returncode != 0 or "not authenticated" in out:
        sys.exit("Error: wrangler is not authenticated. Run 'wrangler login'.")


# --- main ---

def day_range(first: str, last: str) -> list[str]:
    d, end, days = date.fromisoformat(first), date.fromisoformat(last), []
    while d <= end:
        days.append(d.isoformat())
        d += timedelta(days=1)
    return days


def missing_entries(archive: list[dict], r2: list[dict], cutoff: str) -> list[dict]:
    r2_rids = {e["rid"] for e in r2}
    return [e for e in archive if e["rid"] not in r2_rids and e["alertDate"] < cutoff]


def main() -> None:
    now = israel_now()
    today_key = r2_date_key(now.strftime("%Y-%m-%dT%H:%M:%S"))
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="first", required=True, help="first R2 day (YYYY-MM-DD)")
    parser.add_argument("--to", dest="last", default=today_key,
                        help=f"last R2 day, inclusive (default: {today_key})")
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--yes", action="store_true", help="write without asking")
    args = parser.parse_args()
    for d in (args.first, args.last):
        date.fromisoformat(d)
    if args.first > args.last or args.last > today_key:
        sys.exit(f"Error: need --from <= --to <= {today_key}")

    check_wrangler()
    cutoff = cron_cutoff(now)
    live_from = r2_date_key(cutoff)   # files the cron may still append to
    days = day_range(args.first, args.last)
    print(f"R2 days {days[0]} .. {days[-1]} ({len(days)}); "
          f"entries from {cutoff} on are left to the ingestion cron")

    print("Fetching Oref archive...")
    archive = fetch_archive(days[0], days[-1])

    print("Reading R2 day files...")
    r2 = {day: r2_get(day)[0] for day in days}

    print(f"\n{'day':<12}{'R2':>8}{'archive':>9}{'to add':>8}{'R2 only':>9}")
    plan: dict[str, list[dict]] = {}
    for day in days:
        arc, cur = archive.get(day, []), r2[day]
        add = missing_entries(arc, cur, cutoff)
        arc_rids = {e["rid"] for e in arc}
        r2_only = sum(1 for e in cur if e["rid"] not in arc_rids)
        if add:
            plan[day] = add
        if add or r2_only or len(arc) != len(cur):
            print(f"{day:<12}{len(cur):>8}{len(arc):>9}{len(add):>8}{r2_only:>9}")
    total = sum(len(v) for v in plan.values())
    print(f"(days not listed are identical)\nTo add: {total} entries in {len(plan)} files")

    if not plan or args.dry_run:
        return
    if not args.yes and input("Write these to R2? [y/N] ").strip().lower() != "y":
        print("Nothing written.")
        return

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for day, add in plan.items():
        if day >= live_from:
            wait_for_quiet_slot()
        # Re-read right before writing, so nothing the cron appended meanwhile is lost.
        current, raw = r2_get(day)
        add = missing_entries(add, current, cutoff)
        if not add:
            print(f"  {day}: nothing left to add")
            continue
        backup = BACKUP_DIR / f"{day}.{stamp}.jsonl"
        backup.write_text(raw, encoding="utf-8")
        merged = sorted(current + add, key=lambda e: e["alertDate"])   # stable: ties keep order
        r2_put(day, to_jsonl(merged))
        print(f"  {day}: added {len(add)} (now {len(merged)}), backup {backup}")


if __name__ == "__main__":
    main()

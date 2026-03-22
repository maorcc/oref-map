#!/usr/bin/env python3
"""Poll the Oref history API and log time-range statistics.

Checks whether entries older than 50 minutes are consistently returned.
Keeps a set of all seen entries; if a previously-seen entry disappears
while still within the 50-minute window, it flags a "dropped" warning.

Usage:
    uv run python tools/poll_history_range.py [--interval 120] [--log history_range.log]
"""

import argparse
import json
import time
from datetime import datetime, timedelta
from urllib.request import Request, urlopen


API_URL = "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json"
HEADERS = {
    "Referer": "https://www.oref.org.il/",
    "X-Requested-With": "XMLHttpRequest",
}


def fetch_history():
    req = Request(API_URL, headers=HEADERS)
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def entry_key(e):
    return (e.get("data", ""), e.get("alertDate", ""), e.get("title", ""))


def parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=int, default=120, help="Poll interval in seconds (default: 120)")
    parser.add_argument("--log", default="history_range.log", help="Log file path")
    args = parser.parse_args()

    seen = {}  # key -> alertDate string

    print(f"Polling every {args.interval}s, logging to {args.log}")
    print("Press Ctrl+C to stop\n")

    with open(args.log, "a") as log:
        log.write(f"\n--- Session started at {datetime.now().isoformat()} ---\n")
        log.write("poll_time | entries | earliest | latest | span_min | dropped_within_50min\n")
        log.flush()

        while True:
            try:
                now = datetime.now()
                cutoff_50 = now - timedelta(minutes=50)
                data = fetch_history()

                if not data:
                    line = f"{now:%H:%M:%S} | 0 entries | no alerts"
                    print(line)
                    log.write(line + "\n")
                    log.flush()
                    time.sleep(args.interval)
                    continue

                dates = []
                current_keys = set()
                for e in data:
                    d = e.get("alertDate", "")
                    if d:
                        dates.append(d)
                    current_keys.add(entry_key(e))

                dates.sort()
                earliest = dates[0] if dates else "?"
                latest = dates[-1] if dates else "?"

                span_min = 0
                if len(dates) >= 2:
                    t0 = parse_date(dates[0])
                    t1 = parse_date(dates[-1])
                    span_min = (t1 - t0).total_seconds() / 60

                # Check for entries that disappeared while still within 50-min window
                dropped = []
                for key, alert_date in list(seen.items()):
                    if key not in current_keys:
                        try:
                            entry_time = parse_date(alert_date)
                            if entry_time > cutoff_50:
                                dropped.append(f"{key[0]}@{alert_date}")
                        except ValueError:
                            pass

                # Update seen set with current entries
                for e in data:
                    k = entry_key(e)
                    seen[k] = e.get("alertDate", "")

                # Prune seen entries older than 2 hours (no longer relevant)
                prune_cutoff = now - timedelta(hours=2)
                for k in list(seen):
                    try:
                        if parse_date(seen[k]) < prune_cutoff:
                            del seen[k]
                    except ValueError:
                        pass

                drop_str = f" DROPPED: {len(dropped)}" if dropped else ""
                line = f"{now:%H:%M:%S} | {len(data):4d} entries | {earliest} -> {latest} | span {span_min:.0f}min{drop_str}"
                print(line)
                log.write(line + "\n")

                if dropped:
                    for d in dropped[:10]:
                        detail = f"  ! {d}"
                        print(detail)
                        log.write(detail + "\n")
                    if len(dropped) > 10:
                        more = f"  ... and {len(dropped) - 10} more"
                        print(more)
                        log.write(more + "\n")

                log.flush()

            except KeyboardInterrupt:
                print("\nStopped.")
                log.write(f"--- Session ended at {datetime.now().isoformat()} ---\n")
                break
            except Exception as e:
                line = f"{datetime.now():%H:%M:%S} | ERROR: {e}"
                print(line)
                log.write(line + "\n")
                log.flush()

            time.sleep(args.interval)


if __name__ == "__main__":
    main()

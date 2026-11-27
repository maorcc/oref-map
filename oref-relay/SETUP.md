# Oref relay — current production setup

*State as of 2026-11-27.* This document supersedes the "API proxy" parts of
`docs/architecture.md` (TLV direct fetch from Pages Functions, `/api2` Worker
fallback), which no longer describe how production traffic flows.

## Summary

All oref-map.org API traffic (live alerts and history) is served by **one
relay running on a Raspberry Pi (`rpi4metal`) on a home internet connection**.
The Pages Function redirects every client to the Cloudflare Tunnel hostname
`orefproxy5.oref-map.org`, and the tunnel delivers the request to the relay on
the Pi, which polls Oref from a residential Israeli IP.

```
browser
  │  GET https://oref-map.org/api/alerts
  ▼
Pages Function  functions/api/_proxy.js
  │  303 → https://orefproxy5.oref-map.org/api2/alerts   (TLV and non-TLV alike)
  ▼
Cloudflare edge ── Cloudflare Tunnel "orefproxy5" ──►  rpi4metal
                                                        cloudflared  (oref-tunnel.service)
                                                          │ http://localhost:3001
                                                          ▼
                                                        relay        (oref-status.service)
                                                          │ polls every 1 s / 10 s
                                                          ▼
                                                        www.oref.org.il  (AWS CloudFront)
```

## Why a home relay

Around 2026-11-25/26 Oref moved `www.oref.org.il` from Akamai to **AWS
CloudFront**. CloudFront answers requests from datacenter / cloud IP ranges with
`403 "Request blocked"` (a CloudFront WAF page), even when the request
originates inside Israel. Measured on 2026-11-27, same URL and headers:

| Source | Location | Result |
|---|---|---|
| Pages Function (`?debugapi=oref-direct`) | Cloudflare, colo TLV | 403 |
| proxy1 / proxy2 Workers | Cloudflare, placement `azure:israelcentral`, colo TLV | 403 |
| orasrv | Oracle Cloud, Israel (CloudFront POP TLV55) | 403 |
| Home connection (plain `curl`) | Israeli residential ISP | **200** |
| Old Akamai edges (`www.oref.org.il.edgesuite.net`, `--resolve`) | any | 503 (Akamai can no longer reach Oref's origin) |

Placement only controls *where* a Worker runs, not *which IP* it egresses from,
so no Cloudflare Worker configuration avoids the block. A request has to leave
from a non-datacenter Israeli IP.

## Components

### 1. Pages Function redirect — `functions/api/_proxy.js`

- `TLV_PROXY_HOSTS` and `NON_TLV_PROXY_HOSTS` both contain only
  `https://orefproxy5.oref-map.org`. **Every** `/api/*` request — TLV or not —
  gets a `303` to `<proxy>/api2/<endpoint>`. Nothing is fetched from Oref by the
  Pages Function in normal operation.
- `?debugapi=<host>` forces a redirect to a specific relay if it matches
  `PROXY_HOST_PATTERNS` (`orefproxyN.oref-map.org`, `proxyN.oref-proxyN.workers.dev`,
  `oreftest.kon40.com`). The client sets it via the `?f-debugapi=<host>` feature flag.
- `?debugapi=oref-direct` makes the Pages Function fetch Oref itself (currently
  always 403, see above).
- The client (`web/index.html`) follows the redirect and switches its prefix to
  `/api2` for the rest of the session.

### 2. Cloudflare Tunnel — `orefproxy5`

- Named tunnel `orefproxy5`, **tunnel ID `82f5c216-6872-42a9-87a9-a7c840b65f35`**,
  public hostname `orefproxy5.oref-map.org` (proxied CNAME in the oref-map.org
  zone → `82f5c216-6872-42a9-87a9-a7c840b65f35.cfargotunnel.com`; public DNS
  lookups show only Cloudflare IPs).
- Config on the relay host, `~/.cloudflared/config.yml`:
  ```yaml
  tunnel: orefproxy5
  credentials-file: ~/.cloudflared/82f5c216-6872-42a9-87a9-a7c840b65f35.json
  ingress:
    - hostname: orefproxy5.oref-map.org
      service: http://localhost:3001
    - service: http_status:404
  ```
- `~/.cloudflared/` also holds `cert.pem` (account certificate, needed only for
  `cloudflared tunnel create/route/delete`). Both files are secrets — never
  commit or print them.
- **Only one host may run the `orefproxy5` connector.** If two hosts run it,
  Cloudflare splits traffic between them regardless of whether the relay behind
  each one is healthy.

### 3. Relay host — `rpi4metal`

| Item | Value |
|---|---|
| SSH alias | `rpi4metal` (user `tomer`, passwordless sudo) |
| Hardware / OS | Raspberry Pi 4, 4 GB RAM, **32-bit** Raspbian 12 (bookworm), `armv7l` |
| Network | Home connection (residential Israeli IP) |
| Also runs | **OctoPrint** (`/opt/octopi/oprint`, haproxy on :80/:443, `webcamd`) |
| Node.js | v22.23.5 LTS from nodejs.org (`linux-armv7l` tarball, SHA-256 verified) in `/opt/node-v22.23.5`; `/opt/node` → that dir; `/usr/local/bin/{node,npm,npx}` → `/opt/node/bin/*` |
| cloudflared | 2026.11.2 from Cloudflare's apt repo (`pkg.cloudflare.com`), binary `/usr/local/bin/cloudflared` |
| Relay code | `~/oref-status-server/` — `index.js` identical to `oref-relay/index.js` in this repo, plus `package.json` / `package-lock.json` |
| npm deps | express 4.22.3 (`npm audit`: 0 vulnerabilities) |
| Sysctl | `/etc/sysctl.d/30-cloudflared.conf`: `net.core.rmem_max = 16777216`, `net.core.wmem_max = 16777216` (larger UDP buffers for QUIC) |

Node 22 is the newest Node line that still ships 32-bit ARM builds (24+ do not).
Node 22 is supported until April 2027; plan a 64-bit OS or other host before then.

**systemd units** (both `enabled`, so they start on boot):

`/etc/systemd/system/oref-status.service`
```ini
[Unit]
Description=Oref status server (node, port 3001)
After=network-online.target
Wants=network-online.target

[Service]
User=tomer
WorkingDirectory=/home/tomer/oref-status-server
ExecStart=/usr/local/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/oref-tunnel.service`
```ini
[Unit]
Description=Cloudflare tunnel orefproxy5 -> localhost:3001
After=network-online.target oref-status.service
Wants=network-online.target oref-status.service

[Service]
User=tomer
WorkingDirectory=/home/tomer/oref-status-server
ExecStart=/usr/local/bin/cloudflared tunnel run orefproxy5
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 4. Relay app — `oref-relay/index.js`

Express server on port 3001. It polls Oref on its own schedule and serves the
latest cached body to every client, so Oref load is constant no matter how many
users are connected.

| Endpoint | Source | Refresh |
|---|---|---|
| `/api/alerts`, `/api2/alerts` | `www.oref.org.il/warningMessages/alert/Alerts.json` | polled every 1 s |
| `/api/history`, `/api2/history` | `www.oref.org.il/warningMessages/alert/History/AlertsHistory.json` | polled every 10 s |
| `/api/alarms-history`, `/api2/alarms-history` | `alerts-history.oref.org.il/.../GetAlarmsHistory.aspx?mode=1` | fetched on request, cached 60 s — **currently broken (NXDOMAIN)** |
| `/status` | — | JSON with `updatedAt` (ms epoch) of the last *successful* fetch per source |

- Responses: `Content-Type: application/json; charset=utf-8`,
  `Cache-Control: s-maxage=1, max-age=2`.
- CORS: allows `https://oref-map.org` and local dev origins
  (`localhost:8788`, `127.0.0.1:8788`, `dev.local:8788`). Override with the
  `CORS_ALLOWED_ORIGINS` env var (comma-separated).
- **On a failed poll the relay keeps serving the last good body with HTTP 200.**
  Errors go to the journal and `error.log`; the only sign of staleness to the
  outside is `/status` (`updatedAt` stops advancing).
- Logs in `~/oref-status-server/`: `error.log` (one line per failed poll —
  ~1 line/s if Oref starts rejecting us), `usage.log` (request counts per 2 s,
  one line per minute). `--log-history` also appends to `history.jsonl`.
- `--debug` serves a fixed scenario from `interesting-map.json` instead of
  polling Oref (local testing only).

## Operations

**Health check**
```bash
curl -s https://orefproxy5.oref-map.org/status             # updatedAt should be within a few seconds of now
curl -s -o /dev/null -w "%{http_code}\n" https://orefproxy5.oref-map.org/api2/alerts
curl -sL -o /dev/null -w "%{http_code} %{url_effective}\n" https://oref-map.org/api/alerts
ssh rpi4metal 'systemctl is-active oref-status oref-tunnel'
```

**Logs / restart**
```bash
ssh rpi4metal 'journalctl -u oref-status -n 50 --no-pager'
ssh rpi4metal 'journalctl -u oref-tunnel -n 50 --no-pager'
ssh rpi4metal 'sudo systemctl restart oref-status'          # or oref-tunnel
```

**Deploy a new relay version**
```bash
scp oref-relay/index.js rpi4metal:oref-status-server/index.js
ssh rpi4metal 'sudo systemctl restart oref-status && sleep 3 && curl -s localhost:3001/status'
```

**Upgrade Node (stay on 22.x for armv7l)**
```bash
V=v22.x.y; F=node-$V-linux-armv7l.tar.xz
curl -fsSLO https://nodejs.org/dist/$V/$F && curl -fsSLO https://nodejs.org/dist/$V/SHASUMS256.txt
grep " $F\$" SHASUMS256.txt | sha256sum -c -
sudo mkdir -p /opt/node-$V && sudo tar -xJf $F -C /opt/node-$V --strip-components=1
sudo ln -sfn /opt/node-$V /opt/node && sudo systemctl restart oref-status
```

**Upgrade cloudflared / express**
```bash
sudo apt-get install --only-upgrade cloudflared && sudo systemctl restart oref-tunnel
cd ~/oref-status-server && npm update && npm audit && sudo systemctl restart oref-status
```

**Rules for `rpi4metal`** (it is shared with OctoPrint)
- Install or upgrade only the packages this setup needs. Do **not** run a blanket
  `apt upgrade` or `apt autoremove` without checking the impact on OctoPrint first.
- After any apt change, check OctoPrint:
  `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5000/` → `302`.

**Adding a second relay** (recommended — see open issues)
1. On another machine with a residential Israeli IP, install cloudflared and run
   `cloudflared tunnel login`, `cloudflared tunnel create orefproxyN`, and
   `cloudflared tunnel route dns orefproxyN orefproxyN.oref-map.org`.
2. Write `~/.cloudflared/config.yml` as above with `hostname: orefproxyN.oref-map.org`.
3. Install the relay and both systemd units as on `rpi4metal`.
4. Verify: `curl https://orefproxyN.oref-map.org/status`, then test the whole
   path with `https://oref-map.org/?f-debugapi=orefproxyN.oref-map.org`.
5. Add the host to `TLV_PROXY_HOSTS` / `NON_TLV_PROXY_HOSTS` in
   `functions/api/_proxy.js` and deploy Pages.

## Inactive / legacy components

| Component | State |
|---|---|
| orasrv (Oracle Cloud VM) | `oref-status` and `oref-tunnel` stopped and **disabled** since 2026-11-27; files kept in `~/oref-status-server` and `~/.cloudflared`. Switching back is pointless while CloudFront blocks Oracle IPs. Do not re-enable `oref-tunnel` there while the Pi runs it (traffic split). |
| proxy1/2/3 Workers (`worker/`, `/api2/*` route) | Deployed, but Oref returns 403 to them. The ingestion worker still calls proxy1. |
| `orefproxy6`, `orefproxy7` | Commented out of the pools; tunnels return 530 (no connector). |
| Pages Function direct fetch | Only reachable via `?debugapi=oref-direct`; returns 403. |
| Unknown-title Pushover alerts | Run only inside the Pages direct-fetch path, so they are **effectively off**. |
| `history-proxy/` | Not deployed (see `docs/architecture.md`). |
| `~/projects/oref-lali` (lali-virt.com/oref-map backup) | Down: nothing listens on orasrv :8787. |
| `~/projects/oref-status-server` | Older copy of the relay; superseded by `oref-relay/`. |

## Open issues

1. **Extended history / R2 ingestion is broken.** `alerts-history.oref.org.il`
   returns NXDOMAIN since ~2026-11-26 10:40 IST. The ingestion worker cannot
   fill R2 day-history, so the timeline has a gap from then on. The new
   endpoint has not been found; the old path on `www.oref.org.il` returns 403
   even from a home IP. After it is found: point ingestion at a home relay
   (proxy1 is blocked) and backfill the gap.
2. **Single point of failure.** Production depends on one Pi and one home
   connection. Add a second relay on a different connection (see above).
3. **Stale data is silent.** If Oref starts rejecting the Pi, users keep getting
   the last good (possibly empty) response with HTTP 200. Nothing alerts on a
   stale `/status`. Consider an external check on `/status` with notification.
4. **Unknown-title detection is off** (see legacy table); it needs to move into
   the relay or another path that sees real traffic.
5. **Oref may block residential relays too.** If the cloud-IP block is
   deliberate, the durable fix is an allowlist or official feed access from Oref.
6. **Node 22 on 32-bit ARM ends April 2027.** Move the relay host to a 64-bit
   OS (or another machine) before then.

## Incident timeline (Israel time)

| When | Event |
|---|---|
| ~2026-11-25 | Oref DNS for `www.oref.org.il` moves from Akamai to CloudFront. orasrv's long-running relay keeps working (likely an open keep-alive connection to Akamai). |
| 2026-11-26 10:33–10:47 | Ingestion fetches start failing (`alerts-history.oref.org.il` gone); first "missed window" notification at 10:57. |
| 2026-11-26 10:39 | orasrv rebooted. |
| 2026-11-26 12:15 | Relay on orasrv starts again; every Oref poll returns 403. oref-map.org serves no live data (orefproxy5 → 502). |
| 2026-11-26 12:45 | Relay on orasrv stopped. |
| 2026-11-27 ~12:12 | Relay and `orefproxy5` tunnel moved to `rpi4metal`; orasrv services disabled. Live alerts and history restored. |

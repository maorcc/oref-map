# Oref relay — production runbook

*State as of 2026-11-27.* How the production relay is run and operated. For the design
and why it exists, see `docs/architecture.md` § "Access to Oref"; for the Oref endpoints,
see `docs/oref-sources.md`.

This repository is public: keep host names, users, addresses, tunnel IDs and anything
else about the relay host out of it. Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<relay-host>` | The relay's public Cloudflare Tunnel hostname (`orefproxyN.oref-map.org`, as listed in `functions/api/_proxy.js`) |
| `<ssh-host>` | SSH alias of the machine running the relay |
| `<relay-dir>` | Directory holding `index.js`, `package.json` and the logs on that machine |
| `<user>` | Unix user the services run as |

## Summary

All oref-map.org API traffic (live alerts, history, and the ingestion worker's
extended history) is served by **one relay on a machine with a residential Israeli
IP**. The Pages Function redirects every client to the relay's Cloudflare Tunnel
hostname, and the tunnel delivers the request to the relay, which polls Oref.

```
browser
  │  GET https://oref-map.org/api/alerts
  ▼
Pages Function  functions/api/_proxy.js
  │  303 → https://<relay-host>/api2/alerts   (TLV and non-TLV alike)
  ▼
Cloudflare edge ── Cloudflare Tunnel ──►  relay machine
                                          cloudflared  (oref-tunnel.service)
                                            │ http://localhost:3001
                                            ▼
                                          relay        (oref-status.service)
                                            │ polls every 1 s / 10 s; archive on request
                                            ▼
                                          www.oref.org.il  (AWS CloudFront)

ingestion cron Worker ──► https://<relay-host>/api2/alarms-history   (every 2 min)
```

## Why a residential relay

In late November 2026 Oref moved `www.oref.org.il` from Akamai to **AWS CloudFront**.
CloudFront answers requests from datacenter / cloud IP ranges with
`403 "Request blocked"`, even from inside Israel. Measured 2026-11-27, same URL and headers:

| Source | Result |
|---|---|
| Pages Function (`?debugapi=oref-direct`), colo TLV | 403 |
| proxy1 / proxy2 Workers, placement `azure:israelcentral`, colo TLV | 403 |
| Oracle Cloud VM in Israel | 403 |
| Residential Israeli connection (plain `curl`) | **200** |
| Old Akamai edges (`www.oref.org.il.edgesuite.net`, `--resolve`) | 503 (Akamai no longer reaches Oref's origin) |

Placement only controls *where* a Worker runs, not *which IP* it egresses from, so no
Cloudflare Worker configuration avoids the block.

## Components

### 1. Pages Function redirect — `functions/api/_proxy.js`

- `TLV_PROXY_HOSTS` and `NON_TLV_PROXY_HOSTS` both contain only the current relay
  hostname. **Every** `/api/*` request, TLV or not, gets a `303` to
  `<relay-host>/api2/<endpoint>`. The Pages Function fetches nothing from Oref in normal
  operation.
- `?debugapi=<host>` forces a redirect to a specific relay if it matches
  `PROXY_HOST_PATTERNS`. The client sets it via the `?f-debugapi=<host>` feature flag.
- `?debugapi=oref-direct` makes the Pages Function fetch Oref itself (always 403 now).
- The client (`web/index.html`) follows the redirect and switches its prefix to `/api2`
  for the rest of the session.

### 2. Cloudflare Tunnel

- One named tunnel per relay, with public hostname `<relay-host>` (a proxied CNAME in the
  oref-map.org zone pointing at `<tunnel-id>.cfargotunnel.com`).
- `~/.cloudflared/config.yml` on the relay machine:
  ```yaml
  tunnel: <tunnel-name>
  credentials-file: ~/.cloudflared/<tunnel-id>.json
  ingress:
    - hostname: <relay-host>
      service: http://localhost:3001
    - service: http_status:404
  ```
- `~/.cloudflared/` also holds `cert.pem` (account certificate, needed only for
  `cloudflared tunnel create/route/delete`). Both files are secrets: never commit or
  print them.
- **Only one machine may run a given tunnel's connector.** If two machines run it,
  Cloudflare splits traffic between them regardless of whether the relay behind each one
  is healthy.
- Larger UDP buffers for QUIC, in `/etc/sysctl.d/30-cloudflared.conf`:
  `net.core.rmem_max = 16777216`, `net.core.wmem_max = 16777216`.

### 3. Relay machine

Requirements: a residential Israeli IP, Node.js 22 LTS or newer, `cloudflared` from
Cloudflare's apt repo (`pkg.cloudflare.com`), and `express` installed in `<relay-dir>`
next to a copy of `oref-relay/index.js`. The code is an ES module; a `package.json`
with `"type": "module"` avoids relying on Node's syntax detection.

Node 22 is the last Node line with 32-bit ARM builds and is supported until April 2027.
On a 32-bit ARM machine, plan a 64-bit OS or another machine before then.

If the machine also runs other services, install or upgrade only what this setup needs:
no blanket `apt upgrade` / `apt autoremove` without checking those services afterwards.

**systemd units** (both `enabled`, so they start on boot):

`/etc/systemd/system/oref-status.service`
```ini
[Unit]
Description=Oref status server (node, port 3001)
After=network-online.target
Wants=network-online.target

[Service]
User=<user>
WorkingDirectory=<relay-dir>
ExecStart=/usr/local/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/oref-tunnel.service`
```ini
[Unit]
Description=Cloudflare tunnel -> localhost:3001
After=network-online.target oref-status.service
Wants=network-online.target oref-status.service

[Service]
User=<user>
WorkingDirectory=<relay-dir>
ExecStart=/usr/local/bin/cloudflared tunnel run <tunnel-name>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 4. Relay app — `oref-relay/index.js`

Express server on port 3001. It polls Oref on its own schedule and serves the latest
cached body to every client, so Oref load is constant no matter how many users are
connected. Every Oref request sends a full browser `User-Agent`; CloudFront blocks
`/api/v1/*` without one.

| Endpoint | Source | Refresh | On upstream failure |
|---|---|---|---|
| `/api/alerts`, `/api2/alerts` | `www.oref.org.il/warningMessages/alert/Alerts.json` | polled every 1 s | last good body, HTTP 200 |
| `/api/history`, `/api2/history` | `www.oref.org.il/warningMessages/alert/History/AlertsHistory.json` | polled every 10 s | last good body, HTTP 200 |
| `/api/alarms-history`, `/api2/alarms-history` | `www.oref.org.il/api/v1/AlertHistory/heb` (last 30 min, paged), converted to the old `GetAlarmsHistory` shape | fetched on request, cached 60 s | **HTTP 502** |
| `/status` | — | — | `updatedAt` (ms epoch) of the last *successful* fetch per source |

- Responses: `Content-Type: application/json; charset=utf-8`,
  `Cache-Control: s-maxage=1, max-age=2`.
- CORS: allows `https://oref-map.org` and local dev origins (`localhost:8788`,
  `127.0.0.1:8788`, `dev.local:8788`). Override with the `CORS_ALLOWED_ORIGINS` env var
  (comma-separated).
- Logs in `<relay-dir>`: `error.log` (one line per failed fetch, ~1 line/s if Oref starts
  rejecting us), `usage.log` (request counts per 2 s, one line per minute).
  `--log-history` also appends to `history.jsonl`.
- `--debug` serves a fixed scenario from `interesting-map.json` instead of polling Oref
  (local testing only).

## Operations

**Health check**
```bash
curl -s https://<relay-host>/status                  # alerts/history updatedAt within a few seconds of now
curl -s -o /dev/null -w "%{http_code}\n" https://<relay-host>/api2/alerts
curl -s -o /dev/null -w "%{http_code}\n" https://<relay-host>/api2/alarms-history   # 200; 502 = Oref unreachable
curl -sL -o /dev/null -w "%{http_code} %{url_effective}\n" https://oref-map.org/api/alerts
ssh <ssh-host> 'systemctl is-active oref-status oref-tunnel'
```
`extended.updatedAt` in `/status` stays `null` until `/api2/alarms-history` is requested;
the ingestion cron requests it several times every 15 minutes.

**Logs / restart**
```bash
ssh <ssh-host> 'journalctl -u oref-status -n 50 --no-pager'
ssh <ssh-host> 'journalctl -u oref-tunnel -n 50 --no-pager'
ssh <ssh-host> 'sudo systemctl restart oref-status'          # or oref-tunnel
```

**Deploy a new relay version**
```bash
scp oref-relay/index.js <ssh-host>:<relay-dir>/index.js
ssh <ssh-host> 'sudo systemctl restart oref-status && sleep 3 && curl -s localhost:3001/status && curl -s -o /dev/null -w "%{http_code}\n" localhost:3001/api2/alarms-history'
```

**Upgrade cloudflared / express**
```bash
sudo apt-get install --only-upgrade cloudflared && sudo systemctl restart oref-tunnel
cd <relay-dir> && npm update && npm audit && sudo systemctl restart oref-status
```

**Adding a second relay** (recommended, see open issues)
1. On another machine with a residential Israeli IP, install cloudflared and run
   `cloudflared tunnel login`, `cloudflared tunnel create orefproxyN`, and
   `cloudflared tunnel route dns orefproxyN orefproxyN.oref-map.org`.
2. Write `~/.cloudflared/config.yml` as above with `hostname: orefproxyN.oref-map.org`.
3. Install the relay and both systemd units as above.
4. Verify: `curl https://orefproxyN.oref-map.org/status`, then test the whole path with
   `https://oref-map.org/?f-debugapi=orefproxyN.oref-map.org`.
5. Add the host to `TLV_PROXY_HOSTS` / `NON_TLV_PROXY_HOSTS` in `functions/api/_proxy.js`
   and deploy Pages. Note that `orefProxy()` picks a host at random with no health
   check, so a dead member still gets its share of traffic.

## Inactive / legacy components

| Component | State |
|---|---|
| Previous relay host (Oracle Cloud VM) | Services stopped and **disabled** since 2026-11-27; files kept. Pointless to switch back while CloudFront blocks Oracle IPs. Never re-enable its tunnel connector while another machine runs the same tunnel (traffic split). |
| proxy1/2/3 Workers (`worker/`) | Still deployed by CI, carry no traffic, and get 403 from Oref. |
| `orefproxy6`, `orefproxy7` | Commented out of the pools; tunnels return 530 (no connector). |
| Pages Function direct fetch | Only reachable via `?debugapi=oref-direct`; returns 403. |
| Unknown-title Pushover alerts | Run only inside the Pages direct-fetch path, so they are **effectively off**. |
| `history-proxy/` | Not deployed (see `docs/architecture.md`). |

## Open issues

1. **R2 day-history gap.** `alerts-history.oref.org.il` stopped resolving sometime between
   2026-10-19 and 2026-11-08. The relay kept answering `200 []`, so ingestion recorded
   every window as empty without alerting. The relay now uses
   `www.oref.org.il/api/v1/AlertHistory` and answers 502 on failure. Still to do: deploy
   it on the relay machine, then backfill R2 from 2026-10-19. The backfill needs
   `tools/backfill_history.py` moved to the new API first (it still calls the dead host);
   that is a separate change.
2. **Single point of failure.** Production depends on one relay and one home connection.
   Add a second relay on a different connection (see above).
3. **Stale live data is silent.** If Oref starts rejecting the relay, `/api2/alerts` and
   `/api2/history` keep serving the last good (possibly empty) body with HTTP 200, and
   nothing alerts on a stale `/status`.
4. **Unknown-title detection is off** (see legacy table); it needs to move into the relay
   or another path that sees real traffic.
5. **Oref may block residential relays too.** If the cloud-IP block is deliberate, the
   durable fix is an allowlist or official feed access from Oref.
6. **Node 22 on 32-bit ARM ends April 2027** (only relevant on such a host).

## Incident timeline (Israel time)

| When | Event |
|---|---|
| 2026-10-19 | Last R2 day-history entries fetched from `alerts-history.oref.org.il`. |
| between 2026-10-19 and 2026-11-08 | `alerts-history.oref.org.il` stops resolving. The relay serves `200 []` for extended history; ingestion records empty windows, no alert fires. Alerts on 2026-11-08, -11, -13 and -23 never reach R2. |
| ~2026-11-25 | Oref moves `www.oref.org.il` from Akamai to CloudFront. The running relay keeps working (probably an open keep-alive connection to Akamai). |
| 2026-11-26 10:39 | Previous relay host (Oracle VM) rebooted; the relay is down (502), first "missed window" notification at 10:57. |
| 2026-11-26 12:15 | Relay starts again; every Oref poll returns 403. oref-map.org serves no live data. |
| 2026-11-27 ~12:12 | Relay and tunnel moved to a machine with a residential IP. Live alerts and history restored. |
| 2026-11-27 | New archive endpoint found (`/api/v1/AlertHistory`); relay updated to use it. |

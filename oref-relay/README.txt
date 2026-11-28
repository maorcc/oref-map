How to install cloudflare tunnel (cloudflared) on proxy machine
===============================================================
curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update

sudo apt install cloudflared
cloudflared tunnel login
cloudflared tunnel create orefproxy8

mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: orefproxy8
credentials-file: ~/.cloudflared/....json

ingress:
  - hostname: orefproxy8.oref-map.org
    service: http://localhost:3001
  - service: http_status:404

cloudflared tunnel route dns orefproxy8 orefproxy8.oref-map.org
cloudflared tunnel run orefproxy8

sudo vi /etc/sysctl.d/30-cloudflared.conf
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216

Host requirements
=================
Oref (www.oref.org.il, behind AWS CloudFront) returns 403 to datacenter and cloud IPs,
even inside Israel. The relay must run on a residential Israeli connection.
Every Oref request carries a full browser User-Agent (OREF_HEADERS in index.js); without
it /api/v1/* is blocked.

Endpoints and health
====================
- /api2/alerts, /api2/history: served from memory, polled from Oref every 1s / 10s.
- /api2/alarms-history: at least the last 60 minutes of www.oref.org.il/api/v1/AlertHistory, in the old
  GetAlarmsHistory shape, cached 60s. Returns 502 if Oref can't be reached or the list
  would be incomplete.
- /status: updatedAt per cache. alerts/history should be seconds old. extended stays null
  until /api2/alarms-history is requested (the ingestion cron does that every few minutes).

After updating index.js, restart the relay and check /status and /api2/alarms-history.

Relay CORS
==========
The relay allows `https://oref-map.org` plus these dev origins by default:
- `http://localhost:8788`
- `http://127.0.0.1:8788`

To override the allowlist on the VM, set `CORS_ALLOWED_ORIGINS` to a comma-separated list.
Examples:
- `CORS_ALLOWED_ORIGINS=https://oref-map.org,http://localhost:8788`
- `CORS_ALLOWED_ORIGINS=https://oref-map.org,http://127.0.0.1:5173`

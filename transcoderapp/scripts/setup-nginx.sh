#!/usr/bin/env bash
# Usage:
#   npm run setup:nginx -- transcoder.yourname.cab432.com 3000
# or:
#   DOMAIN=transcoder.yourname.cab432.com UPSTREAM_PORT=3000 npm run setup:nginx
set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
UPSTREAM_PORT="${2:-${UPSTREAM_PORT:-3000}}"

if [[ -z "${DOMAIN}" ]]; then
  echo "Usage: $0 <your-subdomain.cab432.com> [upstream_port]"
  echo "Or set DOMAIN and UPSTREAM_PORT env vars."
  exit 1
fi

# Detect package manager
PKG=""
if command -v apt >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
fi

# Install nginx if missing
if ! command -v nginx >/dev/null 2>&1; then
  if [[ "$PKG" == "apt" ]]; then
    echo "[INFO] Installing nginx via apt…"
    sudo apt update
    sudo apt install -y nginx
  elif [[ "$PKG" == "dnf" ]]; then
    echo "[INFO] Installing nginx via dnf…"
    sudo dnf install -y nginx
    sudo systemctl enable nginx
    sudo systemctl start nginx
  elif [[ "$PKG" == "yum" ]]; then
    echo "[INFO] Installing nginx via yum…"
    sudo yum install -y nginx
    sudo systemctl enable nginx
    sudo systemctl start nginx
  else
    echo "[WARN] Could not detect package manager; install nginx manually."
    exit 1
  fi
fi

# Optional: open firewall if ufw is present (Ubuntu)
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 'Nginx Full' || true
fi

# Pick a config location:
# - Debian/Ubuntu typically: /etc/nginx/sites-available + sites-enabled
# - Amazon Linux/RHEL/CentOS: /etc/nginx/conf.d/*.conf
SITE_PATH=""
ENABLE_SYMLINK=""

if [[ -d "/etc/nginx/sites-available" ]]; then
  SITE_PATH="/etc/nginx/sites-available/transcoder"
  ENABLE_SYMLINK="/etc/nginx/sites-enabled/transcoder"
else
  SITE_PATH="/etc/nginx/conf.d/transcoder.conf"
fi

# Write server block (with placeholders)
sudo tee "${SITE_PATH}" >/dev/null <<'CONF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name __SERVER_NAME__;

    # Allow big uploads (videos)
    client_max_body_size 1024m;

    location / {
        proxy_pass         http://127.0.0.1:__UPSTREAM_PORT__;
        proxy_http_version 1.1;

        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;

        # Stream uploads to upstream (don’t buffer huge bodies)
        proxy_request_buffering off;
        proxy_buffering off;

        # Give ffmpeg/long requests time
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
CONF

# Fill placeholders
sudo sed -i \
  -e "s#__SERVER_NAME__#${DOMAIN}#g" \
  -e "s#__UPSTREAM_PORT__#${UPSTREAM_PORT}#g" \
  "${SITE_PATH}"

# Enable site on Debian/Ubuntu
if [[ -n "${ENABLE_SYMLINK}" ]]; then
  sudo ln -sf "${SITE_PATH}" "${ENABLE_SYMLINK}"
fi

# Test and reload nginx
sudo nginx -t
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl reload nginx
else
  sudo service nginx reload
fi

echo
echo "✅ Nginx configured:"
echo "    http://${DOMAIN}  →  http://127.0.0.1:${UPSTREAM_PORT}"

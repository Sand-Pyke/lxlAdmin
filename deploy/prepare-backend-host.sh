#!/usr/bin/env bash
set -euo pipefail

# Prepare independent runtime identity/configuration; never changes the active site.
if ! id lxl-admin >/dev/null 2>&1; then
  useradd --system --home-dir /opt/lxlleague-admin --shell /sbin/nologin lxl-admin
fi
install -d -m 700 /etc/lxl-admin
install -d -m 755 /opt/lxlleague-admin/backend-releases /srv/lxl-assets
install -d -m 700 -o lxl-admin -g lxl-admin /srv/lxl-uploads
if [ ! -e /etc/lxl-admin/backend.env ]; then
  umask 077
  {
    printf '# Fill DATABASE_URL and storage settings before starting the service.\nDATABASE_URL=\nADMIN_SESSION_SECRET='
    openssl rand -hex 48
    printf 'ASSET_DIR=/srv/lxl-assets\nUPLOAD_DIR=/srv/lxl-uploads\n'
    printf 'OSS_REGION=\nOSS_BUCKET=\nOSS_ACCESS_KEY_ID=\nOSS_ACCESS_KEY_SECRET=\nOSS_ENDPOINT=\nOSS_PUBLIC_BASE_URL=\nOSS_PREFIX=\n'
  } > /etc/lxl-admin/backend.env
fi
chmod 600 /etc/lxl-admin/backend.env
printf 'Prepared /etc/lxl-admin/backend.env (root-only). Active site unchanged.\n'

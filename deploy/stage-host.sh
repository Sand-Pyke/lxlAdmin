#!/usr/bin/env bash
set -euo pipefail

# Run as root after uploading the release archive; no database is involved.
archive=${1:?Usage: stage-host.sh /path/to/release.tar.gz}
base=/opt/lxlleague-admin
release="$base/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release" /var/www/acme
tar -xzf "$archive" -C "$release"
chmod -R a+rX "$release"
ln -sfn "$release" "$base/current"

sed \
  -e 's|${BACKEND_ORIGIN}|https://lxlleague.cn|g' \
  -e 's|listen 80;|listen 127.0.0.1:8081;|' \
  -e 's|/usr/share/nginx/html|/opt/lxlleague-admin/current/dist|g' \
  -e 's|/etc/ssl/certs/ca-certificates.crt|/etc/pki/tls/certs/ca-bundle.crt|g' \
  "$release/deploy/default.conf.template" > /etc/nginx/conf.d/lxlleague-admin.conf

if command -v getenforce >/dev/null && [ "$(getenforce)" = Enforcing ]; then
  chcon -R -t httpd_sys_content_t "$base"
  setsebool -P httpd_can_network_connect 1
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx
curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8081/healthz
curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8081/api/current_user
printf '\nRelease: %s\n' "$release"

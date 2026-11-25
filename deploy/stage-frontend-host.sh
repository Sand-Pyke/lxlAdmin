#!/usr/bin/env bash
# For the migrated host: never overwrites API/TLS Nginx configuration.
set -euo pipefail
archive=${1:?Usage: stage-frontend-host.sh /path/to/frontend.tar.gz}
release="/opt/lxlleague-admin/frontend-releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release"
tar -xzf "$archive" -C "$release"
test -f "$release/index.html"
chmod -R a+rX "$release"
current=/opt/lxlleague-admin/frontend-current
ln -s "$release" "$current.next"
mv -Tf "$current.next" "$current"
echo "Frontend activated: $release"

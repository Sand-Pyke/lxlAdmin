#!/usr/bin/env bash
set -euo pipefail
archive=${1:?Usage: stage-backend-host.sh /path/to/backend-source.tar.gz}
release="/opt/lxlleague-admin/backend-releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release"
tar -xzf "$archive" -C "$release"
cd "$release"
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS=--max-old-space-size=1152
npm ci --no-audit --no-fund
npm run build
runtime="$release/.next/standalone"
install -d "$runtime/public" "$runtime/.next/static"
cp -a public/. "$runtime/public/"
cp -a .next/static/. "$runtime/.next/static/"
chmod -R a+rX "$runtime"
printf '\nBackend staged at %s\nActive frontend and proxy unchanged.\n' "$runtime"

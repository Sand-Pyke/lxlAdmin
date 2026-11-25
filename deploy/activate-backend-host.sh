#!/usr/bin/env bash
set -euo pipefail
runtime=$(realpath "${1:?Usage: activate-backend-host.sh /opt/lxlleague-admin/backend-releases/<release>/.next/standalone}")
case "$runtime" in
  /opt/lxlleague-admin/backend-releases/*/.next/standalone) ;;
  *) echo 'Unexpected backend release path' >&2; exit 1 ;;
esac
test -f "$runtime/server.js"
current=/opt/lxlleague-admin/backend-current
previous=$(readlink -f "$current" || true)
ln -s "$runtime" "$current.next"
mv -Tf "$current.next" "$current"
systemctl restart lxl-admin-backend
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3001/api/health >/dev/null; then
    echo "Management backend activated: $runtime"
    exit 0
  fi
  sleep 1
done
if [ -n "$previous" ]; then
  ln -s "$previous" "$current.next"
  mv -Tf "$current.next" "$current"
  systemctl restart lxl-admin-backend
fi
echo 'Backend readiness failed; previous runtime restored' >&2
exit 1

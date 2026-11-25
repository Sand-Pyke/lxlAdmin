#!/usr/bin/env bash
set -euo pipefail
install -d -m 700 -o lxl-admin -g lxl-admin /var/lib/lxl-admin-tunnel
if [ ! -f /var/lib/lxl-admin-tunnel/id_ed25519 ]; then
  ssh-keygen -q -t ed25519 -N '' -C lxl-admin-db-tunnel -f /var/lib/lxl-admin-tunnel/id_ed25519
fi
chown lxl-admin:lxl-admin /var/lib/lxl-admin-tunnel/id_ed25519*
chmod 600 /var/lib/lxl-admin-tunnel/id_ed25519
cat /var/lib/lxl-admin-tunnel/id_ed25519.pub

"""Receive configuration over SSH stdin; do not put secrets in argv or stdout."""
import json
import os
import pathlib
import tempfile
import sys

target = pathlib.Path('/etc/lxl-admin/backend.env')
allowed = {'DATABASE_URL', 'OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID',
           'OSS_ACCESS_KEY_SECRET', 'OSS_ENDPOINT', 'OSS_PUBLIC_BASE_URL', 'OSS_PREFIX',
           'ASSET_DIR', 'UPLOAD_DIR', 'FFMPEG_PATH'}
incoming = json.load(sys.stdin)
if not isinstance(incoming, dict) or set(incoming) - allowed:
    raise RuntimeError('Unsupported backend configuration keys')
if any(not isinstance(value, str) or '\n' in value or '\r' in value for value in incoming.values()):
    raise RuntimeError('Invalid backend configuration values')
values = {}
for line in target.read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key] = json.loads(value) if value.startswith('"') else value
values.update(incoming)
fd, temporary = tempfile.mkstemp(dir=str(target.parent), prefix='.backend-env-')
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        for key, value in values.items():
            output.write(key + '=' + json.dumps(value) + '\n')
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Backend configuration updated; independent session secret retained. No values displayed.')

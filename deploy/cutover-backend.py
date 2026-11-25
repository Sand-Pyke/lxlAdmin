"""Repoint the existing management vhosts to the independent loopback API.

Run only after database/media preflight and the API service have passed.
Keeps a root-only backup and rolls Nginx configuration back on validation failure.
"""
import datetime
import pathlib
import re
import shutil
import subprocess
import urllib.request

with urllib.request.urlopen('http://127.0.0.1:3001/api/health', timeout=10) as response:
    if response.status != 200:
        raise RuntimeError('Independent management API is not database-ready')

targets = [pathlib.Path('/etc/nginx/conf.d/lxladmin.cn.conf'),
           pathlib.Path('/etc/nginx/conf.d/lxlleague-admin.conf')]
backup = pathlib.Path('/etc/lxl-admin/rollback') / datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True, mode=0o700)
changed = []
try:
    for target in targets:
        if not target.exists():
            continue
        text = target.read_text()
        if 'proxy_pass https://lxlleague.cn;' not in text:
            raise RuntimeError('Unexpected proxy configuration: ' + str(target))
        shutil.copy2(target, backup / target.name)
        text = text.replace('proxy_pass https://lxlleague.cn;', 'proxy_pass http://127.0.0.1:3001;')
        text = text.replace('proxy_set_header Host lxlleague.cn;', 'proxy_set_header Host $http_host;')
        text = text.replace('proxy_set_header Host $proxy_host;', 'proxy_set_header Host $http_host;')
        # A prepared frontend-current symlink is optional; existing frontend stays valid.
        if pathlib.Path('/opt/lxlleague-admin/frontend-current/index.html').is_file():
            text = re.sub(r'root\s+(?:/var/www/lxladmin\.cn/dist|/opt/lxlleague-admin/current/dist);',
                          'root /opt/lxlleague-admin/frontend-current;', text)
        target.write_text(text)
        changed.append(target)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    for target in changed:
        shutil.copy2(backup / target.name, target)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
print('Management API proxy switched. Backup: ' + str(backup))

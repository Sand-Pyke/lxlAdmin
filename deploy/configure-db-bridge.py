"""Run on the original Docker host: localhost-only DB bridge, no DB restart or port exposure."""
import json
import subprocess

def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]

database = inspect('lol-champion-db-1')
app = inspect('lol-champion-app-1')
networks = set(database['NetworkSettings']['Networks']) & set(app['NetworkSettings']['Networks'])
if not networks:
    raise RuntimeError('No shared application/database Docker network')
network = sorted(networks)[0]
name = 'lxl-admin-db-bridge'
exists = subprocess.run(['docker', 'container', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
if exists:
    current = inspect(name)
    if current['Config'].get('Labels', {}).get('com.lxl.migration') != 'database-bridge':
        raise RuntimeError('Refusing to alter an unrelated container')
    subprocess.run(['docker', 'start', name], check=True, stdout=subprocess.DEVNULL)
else:
    javascript = "const n=require('net');n.createServer(c=>{const u=n.connect(5432,'lol-champion-db-1');c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.pipe(u);u.pipe(c);}).listen(15432,'0.0.0.0');"
    subprocess.run(['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped',
                    '--label', 'com.lxl.migration=database-bridge', '--read-only',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    '--memory', '96m', '--pids-limit', '64', '--network', network,
                    '-p', '127.0.0.1:15432:15432', '--entrypoint', 'node', app['Image'],
                    '-e', javascript], check=True, stdout=subprocess.DEVNULL)
print('Database bridge ready at 127.0.0.1:15432. Existing database and application were not restarted.')

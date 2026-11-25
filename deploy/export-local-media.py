"""Archive legacy local uploads that are not present in shared OSS, without DB writes."""
import json
import pathlib
import subprocess

container = 'lol-champion-app-1'
script = r'''
const fs = require('fs');
const path = require('path');
const OSS = require('ali-oss');
(async () => {
  const root = process.env.UPLOAD_DIR || '/app/data/uploads';
  const enabled = ['OSS_REGION','OSS_BUCKET','OSS_ACCESS_KEY_ID','OSS_ACCESS_KEY_SECRET'].every(k=>process.env[k]);
  const client = enabled ? new OSS({region:process.env.OSS_REGION,bucket:process.env.OSS_BUCKET,
    accessKeyId:process.env.OSS_ACCESS_KEY_ID,accessKeySecret:process.env.OSS_ACCESS_KEY_SECRET,
    secure:true, timeout:15000, ...(process.env.OSS_ENDPOINT ? {endpoint:process.env.OSS_ENDPOINT} : {})}) : null;
  const files = [];
  for (const kind of ['avatars','user-bg','team-logos','shop-icons','videos']) {
    const directory = path.join(root,kind);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory,name);
      if (!fs.statSync(file).isFile()) continue;
      const key = [process.env.OSS_PREFIX?.replace(/^\/+|\/+$/g,''),kind,name].filter(Boolean).join('/');
      let exists = false;
      if (client) {
        try { await client.head(key); exists = true; }
        catch (error) { if (error.status !== 404 && error.code !== 'NoSuchKey') throw new Error('OSS read check failed'); }
      }
      if (!exists) files.push({file,kind,name});
    }
  }
  process.stdout.write(JSON.stringify({root,files}));
})().catch(()=>{console.error('Legacy media inspection failed');process.exit(1)});
'''
data = json.loads(subprocess.check_output(['docker', 'exec', container, 'node', '-e', script]))
target = pathlib.Path.home() / 'lxl-admin-local-media.tar.gz'
files = [item['file'] for item in data['files']]
# Preserve the directory-relative names for deployment under UPLOAD_DIR.
relative = [str(pathlib.PurePosixPath(name).relative_to(data['root'])) for name in files]
with target.open('wb') as output:
    command = ['docker', 'exec', container, 'tar', '-czf', '-', '-C', data['root']]
    command += relative if relative else ['--files-from=/dev/null']
    subprocess.run(command, stdout=output, check=True)
counts = {}
for item in data['files']:
    counts[item['kind']] = counts.get(item['kind'], 0) + 1
print('Legacy local media exported: ' + json.dumps(counts) + '; archive bytes: ' + str(target.stat().st_size))

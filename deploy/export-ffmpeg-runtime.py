"""Export the already deployed FFmpeg runtime without changing the original container."""
import hashlib
import pathlib
import re
import subprocess

container = 'lol-champion-app-1'
ldd = subprocess.check_output(['docker', 'exec', container, 'ldd', '/usr/bin/ffmpeg'], universal_newlines=True)
if 'not found' in ldd:
    raise RuntimeError('Original FFmpeg has missing dependencies')
files = sorted(set(re.findall(r'(/[^\s()]+)', ldd)) | {'/usr/bin/ffmpeg'})
if not any('ld-linux' in name for name in files):
    raise RuntimeError('Missing dynamic loader')
target = pathlib.Path.home() / 'lxl-admin-ffmpeg-runtime.tar.gz'
with target.open('wb') as output:
    subprocess.run(['docker', 'exec', container, 'tar', '-chzf', '-', *files], stdout=output, check=True)
print('FFmpeg runtime exported, SHA256: ' + hashlib.sha256(target.read_bytes()).hexdigest())

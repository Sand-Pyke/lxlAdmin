"""Append a forwarding-only key for the bridge. Public key arrives on stdin."""
import os
import pathlib
import re
import sys

key = sys.stdin.read().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?', key):
    raise RuntimeError('Invalid public key')
directory = pathlib.Path.home() / '.ssh'
directory.mkdir(mode=0o700, exist_ok=True)
target = directory / 'authorized_keys'
existing = target.read_text() if target.exists() else ''
restricted = 'restrict,port-forwarding,permitopen="127.0.0.1:15432",command="/bin/false" ' + key
if key.split()[1] not in existing:
    with target.open('a') as output:
        output.write(('\n' if existing and not existing.endswith('\n') else '') + restricted + '\n')
os.chmod(target, 0o600)
print('Forwarding-only key installed for the localhost database bridge.')

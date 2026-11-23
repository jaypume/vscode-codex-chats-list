"""Reconcile the inspected VSIX with the public Marketplace version before recording a release."""
import io
import json
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request
from zipfile import ZipFile

GALLERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
PUBLISHER = 'pujie'
EXTENSION = 'codex-chats-list'


class ValidationPending(RuntimeError):
    pass


def has_flag(flags, name, bit):
    if isinstance(flags, str):
        return any(flag.strip().lower() == name for flag in flags.split(','))
    return type(flags) is int and bool(flags & bit)


def compare_payload(local, remote):
    with ZipFile(io.BytesIO(local)) as expected, ZipFile(io.BytesIO(remote)) as actual:
        expected_names = [name for name in expected.namelist() if name.startswith('extension/')]
        actual_names = [name for name in actual.namelist() if name.startswith('extension/')]
        if set(expected_names) != set(actual_names) or len(actual_names) != len(set(actual_names)):
            raise ValueError('Existing Marketplace version contains a different set of extension files')
        for name in expected.namelist():
            # The service may add signature/container metadata; extension payload must match exactly.
            if name.startswith('extension/'):
                if name not in actual.namelist() or expected.read(name) != actual.read(name):
                    raise ValueError('Existing Marketplace version has a different payload: ' + name)


def public_payload(version):
    body = {'filters': [{'criteria': [{'filterType': 7, 'value': f'{PUBLISHER}.{EXTENSION}'}]}], 'flags': 3}
    request = urllib.request.Request(GALLERY, data=json.dumps(body).encode(), headers={
        'Content-Type': 'application/json', 'Accept': 'application/json;api-version=7.2-preview.1',
        'User-Agent': f'{EXTENSION}-release',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    for group in result.get('results', []):
        for extension in group.get('extensions', []):
            if extension['publisher']['publisherName'] != PUBLISHER or extension['extensionName'] != EXTENSION:
                continue
            flags = extension.get('flags')
            public = (
                has_flag(flags, 'public', 256)
                and not has_flag(flags, 'disabled', 1)
                and not has_flag(flags, 'unpublished', 4096)
            )
            for item in extension.get('versions', []):
                if item['version'] != version:
                    continue
                if not public or not has_flag(item.get('flags'), 'validated', 1):
                    raise ValidationPending(f'Marketplace version {version} is not yet available as a validated public release.')
                for asset in item.get('files', []):
                    if asset['assetType'] != 'Microsoft.VisualStudio.Services.VSIXPackage':
                        continue
                    parsed = urllib.parse.urlparse(asset['source'])
                    if parsed.scheme != 'https' or not (parsed.hostname == 'marketplace.visualstudio.com' or (parsed.hostname or '').endswith('.vsassets.io')):
                        raise ValueError('Unexpected Marketplace asset host')
                    with urllib.request.urlopen(asset['source'], timeout=30) as response:
                        payload = response.read(20 * 1024 * 1024 + 1)
                    if len(payload) > 20 * 1024 * 1024:
                        raise ValueError('Unexpectedly large Marketplace asset')
                    return payload
                raise ValidationPending(f'Marketplace version {version} has no downloadable VSIX yet.')
    return None


def reconcile(archive, wait=False):
    local = Path(archive).read_bytes()
    with ZipFile(io.BytesIO(local)) as package:
        manifest = json.loads(package.read('extension/package.json'))
    if manifest['publisher'] != PUBLISHER or manifest['name'] != EXTENSION:
        raise ValueError('Wrong release package identity')
    attempts = 21 if wait else 1
    for attempt in range(attempts):
        try:
            remote = public_payload(manifest['version'])
        except ValidationPending:
            if not wait:
                raise
        else:
            if remote is not None:
                compare_payload(local, remote)
                print('Marketplace version is public, validated, and matches the inspected extension payload.')
                return True
        if attempt + 1 < attempts:
            print('Marketplace version is not public yet; waiting for validation.', flush=True)
            time.sleep(15)
    return False


if __name__ == '__main__':
    try:
        found = reconcile(sys.argv[1], '--wait' in sys.argv[2:])
        # Probe: 10 means absent, all other failures remain errors (never silently publish after a mismatch).
        sys.exit(0 if found else (1 if '--wait' in sys.argv[2:] else 10))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Inspect every saved final-image layer and exported rootfs without extraction."""
import argparse
import hashlib
import json
import posixpath
import tarfile
from pathlib import Path


def safe_path(value):
    if value.startswith('/'):
        raise ValueError('absolute archive member')
    parts = []
    for part in value.split('/'):
        if part == '..':
            if not parts:
                raise ValueError('archive/root escape')
            parts.pop()
        elif part not in ('', '.'):
            parts.append(part)
    return '/'.join(parts)


def destination(name, target, hard=False):
    value = target.lstrip('/') if target.startswith('/') or hard else posixpath.join(posixpath.dirname(name), target)
    return safe_path(value)


def forbidden_package(name):
    name = name.lower()
    return name in ('braces', 'jest', 'ts-jest') or name.startswith(('jest-', '@jest/'))


def inventory(archive, fingerprints):
    rows, packages = [], []
    names = set()
    for member in archive:
        name = safe_path(member.name)
        if name in names:
            raise ValueError('duplicate archive member: ' + name)
        names.add(name)
        row = {'path': name, 'type': member.type.decode('ascii'), 'bytes': member.size}
        if member.issym() or member.islnk():
            row['target'] = destination(name, member.linkname, member.islnk())
            if name.startswith('app/') and not row['target'].startswith('app/'):
                raise ValueError('application link escapes /app: ' + name)
        if member.isfile():
            stream = archive.extractfile(member)
            digest, content = hashlib.sha256(), bytearray()
            for chunk in iter(lambda: stream.read(131072), b''):
                digest.update(chunk)
                if posixpath.basename(name) == 'package.json':
                    if len(content) + len(chunk) > 1048576:
                        raise ValueError('oversized package manifest')
                    content.extend(chunk)
            row['sha256'] = digest.hexdigest()
            if row['sha256'] in fingerprints:
                raise ValueError('affected braces source bytes: ' + name)
            if posixpath.basename(name) == 'package.json':
                package = json.loads(content)
                package_name = package.get('name', '')
                if forbidden_package(package_name):
                    raise ValueError('forbidden installed package: ' + package_name + ' at ' + name)
                packages.append({'path': name, 'name': package_name, 'version': package.get('version')})
        rows.append(row)
    return rows, packages


def check_final_links(rows):
    entries = {row['path']: row for row in rows}
    for original in rows:
        if not original['path'].startswith('app/') or 'target' not in original:
            continue
        current, visited = original['target'], set()
        for _ in range(40):
            if current in visited:
                raise ValueError('application link cycle')
            visited.add(current)
            parts, changed = current.split('/'), False
            for i in range(1, len(parts) + 1):
                prefix = '/'.join(parts[:i])
                target = entries.get(prefix, {}).get('target')
                if target is not None:
                    current = safe_path(posixpath.join(target, *parts[i:]))
                    if not current.startswith('app/'):
                        raise ValueError('application link chain escapes /app')
                    changed = True
                    break
            if not changed:
                if current not in entries and not any(p.startswith(current + '/') for p in entries):
                    raise ValueError('dangling application link: ' + original['path'])
                break
        else:
            raise ValueError('application link chain limit exceeded')


def prove(image, rootfs, fingerprint_file, out):
    fingerprints = set(json.loads(Path(fingerprint_file).read_text())['sha256'])
    if not fingerprints:
        raise ValueError('missing affected-source fingerprints')
    layers = []
    with tarfile.open(image, 'r:*') as saved:
        manifest = json.load(saved.extractfile('manifest.json'))
        if len(manifest) != 1:
            raise ValueError('expected one saved image')
        config = json.load(saved.extractfile(manifest[0]['Config']))
        diff_ids = config['rootfs']['diff_ids']
        if len(diff_ids) != len(manifest[0]['Layers']):
            raise ValueError('incomplete layer inventory')
        for layer_path, expected in zip(manifest[0]['Layers'], diff_ids):
            member = saved.getmember(safe_path(layer_path))
            digest = hashlib.sha256()
            with saved.extractfile(member) as raw:
                for chunk in iter(lambda: raw.read(131072), b''):
                    digest.update(chunk)
            if 'sha256:' + digest.hexdigest() != expected:
                raise ValueError('layer bytes do not match image config')
            with saved.extractfile(member) as raw, tarfile.open(fileobj=raw, mode='r|*') as layer:
                rows, packages = inventory(layer, fingerprints)
            layers.append({'diff_id': expected, 'members': rows, 'packages': packages})
    with tarfile.open(rootfs, 'r:*') as exported:
        rows, packages = inventory(exported, fingerprints)
    check_final_links(rows)
    receipt = {'schema': 'CandidateImageFilesystemProof/v1', 'verdict': 'verified',
               'scope': 'Every saved final-image layer and exported rootfs member; known affected source hashes and installed package identities. Not arbitrary transformed-code absence or whole-org security.',
               'layers': layers, 'rootfs': {'members': rows, 'packages': packages},
               'runtime_authorized': False}
    Path(out).write_text(json.dumps(receipt, sort_keys=True) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for key in ('image', 'rootfs', 'fingerprints', 'out'):
        parser.add_argument('--' + key, required=True)
    args = parser.parse_args()
    prove(args.image, args.rootfs, args.fingerprints, args.out)

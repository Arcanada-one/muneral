#!/usr/bin/env python3
"""Upload task-owned content and verify exact bytes. No legacy pointer fallback."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_BYTES = 1024 * 1024
MAX_RESPONSE = 2 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def upload(task_id, source, name, content_type, credentials, api_url):
    task_id = str(uuid.UUID(task_id))
    url = urllib.parse.urlsplit(api_url)
    if url.username or url.password or url.query or url.fragment:
        raise ValueError('API URL must not contain credentials, query or fragment')
    if not url.hostname or (url.scheme != 'https' and not (
        url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')
    )):
        raise ValueError('HTTPS is required except for a loopback test API')
    if not isinstance(name, str) or not 1 <= len(name) <= 128 or '\x00' in name:
        raise ValueError('Artifact name must contain 1..128 characters')
    if not re.fullmatch(r'[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]+)?', content_type) or len(content_type) > 128:
        raise ValueError('Invalid content type')
    with Path(source).open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Artifact exceeds the server 1 MiB limit')
    with Path(credentials).open('rb') as stream:
        secret_document = stream.read(256 * 1024 + 1)
    if len(secret_document) > 256 * 1024:
        raise ValueError('Credential file exceeds the supported limit')
    keys = set(re.findall(rb'mun_sk_[A-Za-z0-9_-]+', secret_document))
    if len(keys) != 1:
        raise ValueError('Credential file must identify exactly one agent key')
    key = keys.pop().decode('ascii')
    sha = hashlib.sha256(data).hexdigest()
    metadata = {'name': name, 'contentType': content_type, 'sha256': sha}
    boundary = 'muneral-content-' + uuid.uuid4().hex
    while boundary.encode() in data or any(boundary in v for v in metadata.values()):
        boundary = 'muneral-content-' + uuid.uuid4().hex
    parts = []
    for field, value in metadata.items():
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n').encode())
    parts.extend([
        (f'--{boundary}\r\nContent-Disposition: form-data; name="content"; filename="content.bin"\r\nContent-Type: application/octet-stream\r\n\r\n').encode(),
        data,
        (f'\r\n--{boundary}--\r\n').encode(),
    ])
    opener = urllib.request.build_opener(NoRedirect())
    base = api_url.rstrip('/') + '/tasks/' + task_id + '/artifacts'

    def request(path, body=None, media_type=None):
        headers = {'Authorization': 'Bearer ' + key, 'User-Agent': 'aup-orchestrator/1.0'}
        if media_type:
            headers['Content-Type'] = media_type
        req = urllib.request.Request(base + path, data=body, headers=headers, method='POST' if body is not None else 'GET')
        try:
            with opener.open(req, timeout=30) as response:
                raw = response.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as err:
            # Neither an echoed response body nor credential-bearing headers reach output.
            raise ValueError(f'Content API refused the request (HTTP {err.code})') from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError('Content API transport failed') from None
        if len(raw) > MAX_RESPONSE:
            raise ValueError('Content API response exceeds the supported limit')
        return json.loads(raw)

    posted = request('/bytes', b''.join(parts), 'multipart/form-data; boundary=' + boundary)
    artifact_id = str(uuid.UUID(posted['id']))
    if posted.get('taskId') != task_id or posted.get('sha256') != sha or posted.get('sizeBytes') != len(data):
        raise ValueError('Upload response identity, size or server digest mismatch')
    for path in ['/' + artifact_id, '/by-sha/' + sha]:
        row = request(path)
        decoded = base64.b64decode(row['contentBase64'], validate=True)
        if row.get('taskId') != task_id or row.get('sha256') != sha or row.get('sizeBytes') != len(data) or decoded != data:
            raise ValueError('Content readback did not match the uploaded bytes')
        if path == '/' + artifact_id and row.get('id') != artifact_id:
            raise ValueError('ID readback returned another revision')
    return {
        'schema': 'MuneralContentUploadReadback/v1', 'taskId': task_id,
        'artifactId': artifact_id, 'name': name, 'revision': posted['revision'],
        'sha256': sha, 'sizeBytes': len(data), 'contentType': content_type,
        'idempotent': posted.get('idempotent', False),
        'readbackById': 'verified', 'readbackBySha': 'verified',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--file', required=True)
    parser.add_argument('--name')
    parser.add_argument('--content-type', required=True)
    parser.add_argument('--credentials', default=os.environ.get('MUNERAL_AGENT_KEY_FILE'))
    parser.add_argument('--api-url', default='https://api.muneral.com/api/v1')
    args = parser.parse_args()
    if not args.credentials:
        parser.error('Set --credentials or MUNERAL_AGENT_KEY_FILE to a protected key file')
    try:
        receipt = upload(args.task_id, args.file, args.name or Path(args.file).name, args.content_type, args.credentials, args.api_url)
    except (ValueError, KeyError, TypeError, OSError):
        # Untrusted API content is deliberately excluded from diagnostics.
        print('Content upload or exact readback failed; no pointer evidence was attached.', file=sys.stderr)
        return 1
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())

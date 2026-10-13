"""Client red controls against an owned mock HTTP API, never production."""
import base64
from email.parser import BytesParser
from email.policy import default
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).with_name('attach.py')
TASK = '00000000-0000-4000-8000-000000000001'
ARTIFACT = '00000000-0000-4000-8000-000000000002'


class ContentClientControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / 'payload.bin'
        self.source.write_bytes(b'actual binary bytes\x00\xff\x01')
        self.key = 'mun_' + 'sk_local_fixture_only'
        self.credentials = self.root / 'agent-key.txt'
        self.credentials.write_text(self.key)
        self.credentials.chmod(0o600)
        self.mode = 'ok'
        self.paths = []
        self.uploaded = None
        self.target_hits = 0
        owner = self

        class RedirectTarget(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.target_hits += 1
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.target = ThreadingHTTPServer(('127.0.0.1', 0), RedirectTarget)
        self.target_thread = threading.Thread(target=self.target.serve_forever, daemon=True)
        self.target_thread.start()

        class Api(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.paths.append(self.path)
                owner.assertEqual(self.headers['Authorization'], 'Bearer ' + owner.key)
                owner.assertEqual(self.headers['User-Agent'], 'aup-orchestrator/1.0')
                if owner.mode == 'redirect':
                    self.send_response(302)
                    self.send_header('Location', f'http://127.0.0.1:{owner.target.server_port}/sink')
                    self.end_headers()
                    return
                raw = self.rfile.read(int(self.headers['Content-Length']))
                message = BytesParser(policy=default).parsebytes(
                    ('Content-Type: ' + self.headers['Content-Type'] + '\r\n\r\n').encode() + raw)
                fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                          for part in message.iter_parts()}
                owner.uploaded = fields['content']
                owner.assertEqual(fields['sha256'].decode(), hashlib.sha256(owner.uploaded).hexdigest())
                self.reply([] if owner.mode == 'list' else owner.row())

            def do_GET(self):
                owner.paths.append(self.path)
                owner.assertEqual(self.headers['Authorization'], 'Bearer ' + owner.key)
                row = owner.row()
                row['contentBase64'] = (None if owner.mode == 'null' else
                                       base64.b64encode(b'tampered' if owner.mode == 'tamper' else owner.uploaded).decode())
                self.reply(row)

            def reply(self, body):
                raw = json.dumps(body).encode()
                self.send_response(201 if self.command == 'POST' else 200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Api)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/api/v1'

    def tearDown(self):
        for server, thread in [(self.server, self.thread), (self.target, self.target_thread)]:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.directory.cleanup()

    def row(self):
        return {'id': ARTIFACT, 'taskId': TASK, 'revision': 3, 'idempotent': False,
                'sha256': hashlib.sha256(self.uploaded).hexdigest(), 'sizeBytes': len(self.uploaded)}

    def invoke(self, mime=True, url=None):
        argv = [sys.executable, '-I', str(SCRIPT), '--task-id', TASK, '--file', str(self.source),
                '--credentials', str(self.credentials), '--api-url', url or self.url]
        if mime:
            argv += ['--content-type', 'application/octet-stream']
        result = subprocess.run(argv, capture_output=True, text=True, timeout=10)
        self.assertNotIn(self.key, result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertFalse(any('/evidence' in path for path in self.paths))
        return result

    def test_binary_upload_and_exact_id_and_sha_reads(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(self.uploaded, self.source.read_bytes())
        self.assertEqual(receipt['readbackById'], 'verified')
        self.assertEqual(receipt['readbackBySha'], 'verified')
        self.assertEqual(len(self.paths), 3)

    def test_wrong_bytes_are_refused(self):
        self.mode = 'tamper'
        self.assertEqual(self.invoke().returncode, 1)

    def test_redirect_never_forwards_the_key(self):
        self.mode = 'redirect'
        self.assertEqual(self.invoke().returncode, 1)
        self.assertEqual(self.target_hits, 0)

    def test_non_loopback_http_is_refused_before_transport(self):
        self.assertEqual(self.invoke(url='http://example.invalid/api/v1').returncode, 1)
        self.assertEqual(self.paths, [])

    def test_missing_content_type_is_refused_before_transport(self):
        self.assertEqual(self.invoke(mime=False).returncode, 2)
        self.assertEqual(self.paths, [])

    def test_list_response_has_fixed_failure_without_traceback(self):
        self.mode = 'list'
        self.assertEqual(self.invoke().returncode, 1)

    def test_null_content_has_fixed_failure_without_traceback(self):
        self.mode = 'null'
        self.assertEqual(self.invoke().returncode, 1)

    def test_oversize_document_is_not_truncated_or_sent(self):
        self.source.write_bytes(b'x' * (1024 * 1024 + 1))
        self.assertEqual(self.invoke().returncode, 1)
        self.assertEqual(self.paths, [])


if __name__ == '__main__':
    unittest.main()

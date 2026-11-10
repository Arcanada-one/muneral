#!/usr/bin/env python3
"""Offline regression tests for issue-agent-key.sh. Never contacts a service."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(os.environ.get('TEST_ISSUE_AGENT_KEY_SCRIPT',
                            Path(__file__).with_name('issue-agent-key.sh'))).resolve()
SYNTHETIC_KEY = 'mun_sk_test-fixture-not-a-real-credential'

FAKE_CURL = r'''
import json, os, pathlib, stat, sys, time
args = sys.argv[1:]
urls = [arg for arg in args if arg.startswith('https://')]
assert len(urls) == 1 and urls[0].startswith('https://fixture.invalid/api/v1/')
response = pathlib.Path(args[args.index('-o') + 1])
assert stat.S_IMODE(response.stat().st_mode) == 0o600
with open(os.environ['CALL_LOG'], 'a') as fh:
    fh.write(urls[0] + '\n')
if os.environ.get('FAIL_HTTP'):
    response.write_text('{"error":"synthetic refusal"}')
    print('500', end='')
    sys.exit(0)
if urls[0].endswith('/keys'):
    out = pathlib.Path(os.environ['FIXTURE_OUT'])
    race = os.environ.get('RACE')
    if race == 'file':
        out.write_text('concurrent file, must survive')
        out.chmod(0o644)
    elif race == 'symlink':
        out.symlink_to(os.environ['VICTIM'])
    elif race == 'git':
        (out.parent / '.git').write_text('gitdir: synthetic marker')
    elif race == 'barrier':
        root = pathlib.Path(os.environ['FIXTURE_ROOT'])
        (root / ('barrier-' + str(os.getpid()))).touch()
        deadline = time.monotonic() + 5
        while len(list(root.glob('barrier-*'))) < 2:
            if time.monotonic() > deadline: raise RuntimeError('fixture barrier timeout')
            time.sleep(0.01)
    payload = {'key': 'mun_sk_test-fixture-not-a-real-credential', 'keyId': 'fixture-key'}
    if os.environ.get('INVALID_RESPONSE'):
        payload = {'keyId': 'fixture-key'}
else:
    payload = {'id': 'fixture-agent'}
response.write_text(json.dumps(payload))
print('201', end='')
'''

# Observe mode *at the first plaintext write*, not only after the process exits.
# Failure hooks affect only this subprocess and only synthetic fixture files.
PYTHON_DRIVER = r'''
import os, pathlib, stat, sys
source = sys.stdin.read()
# Some managed executors place an empty, protected .git marker above every
# writable directory. In explicit fixture-isolation mode only, virtualize the
# ancestors outside this disposable fixture; never modify those real markers.
if os.environ.get('ISOLATE_ANCESTORS'):
    ancestors = set()
    p = pathlib.Path(os.environ['FIXTURE_ROOT']).parent
    while True:
        s = p.stat()
        ancestors.add((s.st_dev, s.st_ino))
        if p.parent == p: break
        p = p.parent
    real_stat = os.stat
    def fixture_stat(path, *args, **kwargs):
        directory_fd = kwargs.get('dir_fd')
        if path == '.git' and directory_fd is not None:
            s = os.fstat(directory_fd)
            if (s.st_dev, s.st_ino) in ancestors: raise FileNotFoundError(path)
        return real_stat(path, *args, **kwargs)
    os.stat = fixture_stat
real_fdopen = os.fdopen
class ObservedFile:
    def __init__(self, wrapped): self.wrapped = wrapped
    def __enter__(self):
        self.wrapped.__enter__()
        return self
    def __exit__(self, *args): return self.wrapped.__exit__(*args)
    def __getattr__(self, name): return getattr(self.wrapped, name)
    def write(self, body):
        mode = stat.S_IMODE(os.fstat(self.wrapped.fileno()).st_mode)
        out = pathlib.Path(os.environ['FIXTURE_OUT'])
        with open(os.environ['WRITE_LOG'], 'a') as log:
            log.write(str(mode) + ' ' + str(out.exists()) + '\n')
        if os.environ.get('FAIL_WRITE'):
            self.wrapped.write(body[:10])
            self.wrapped.flush()
            raise OSError('synthetic write failure')
        return self.wrapped.write(body)
def fdopen(*args, **kwargs): return ObservedFile(real_fdopen(*args, **kwargs))
os.fdopen = fdopen
real_fsync = os.fsync
def fsync(fd):
    if os.environ.get('FAIL_FSYNC') and stat.S_ISREG(os.fstat(fd).st_mode):
        raise OSError('synthetic fsync failure')
    if os.environ.get('FAIL_DIR_FSYNC') and stat.S_ISDIR(os.fstat(fd).st_mode):
        raise OSError('synthetic directory fsync failure')
    return real_fsync(fd)
os.fsync = fsync
real_link = os.link
def link(*args, **kwargs):
    if os.environ.get('FAIL_LINK'): raise OSError('synthetic link failure')
    return real_link(*args, **kwargs)
os.link = link
sys.argv = ['-'] + sys.argv[2:]
exec(compile(source, '<issue-agent-key fixture>', 'exec'))
'''


class IssueAgentKeySafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='muneral-key-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.responses = self.root / 'responses'
        self.responses.mkdir()
        self.out = self.root / 'private' / 'runtime.key'
        self.calls = self.root / 'calls'
        self.writes = self.root / 'writes'
        self.victim = self.root / 'victim'
        self.victim.write_text('original, must survive')
        self.victim.chmod(0o644)
        curl = self.bin / 'curl'
        curl.write_text('#!' + sys.executable + '\n' + FAKE_CURL)
        curl.chmod(0o700)
        driver = self.root / 'driver.py'
        driver.write_text(PYTHON_DRIVER)
        python = self.bin / 'python3'
        python.write_text('#!/bin/sh\nexec "' + sys.executable + '" "' +
                          str(driver) + '" "$@"\n')
        python.chmod(0o700)
        # Deliberately do not inherit credentials, curl options, Python hooks,
        # or other user environment variables. curl is always a local stub.
        self.env = {
            'PATH': str(self.bin) + ':/usr/bin:/bin',
            'HOME': str(self.root), 'TMPDIR': str(self.responses),
            'MUNERAL_JWT': 'synthetic-human-jwt-not-a-token',
            'CALL_LOG': str(self.calls), 'WRITE_LOG': str(self.writes),
            'VICTIM': str(self.victim),
            'FIXTURE_ROOT': str(self.root),
        }
        if os.environ.get('ISSUE_KEY_TEST_ISOLATE_ANCESTORS') == '1':
            self.env['ISOLATE_ANCESTORS'] = '1'
            dirname = self.bin / 'dirname'
            dirname.write_text(
                '#!/bin/sh\nif [ "$1" = -- ]; then shift; fi\n'
                'if [ "$1" = "$FIXTURE_ROOT" ]; then printf "/\\n"; '
                'else exec /usr/bin/dirname -- "$1"; fi\n')
            dirname.chmod(0o700)

    def run_helper(self, extra_env=None):
        env = dict(self.env, FIXTURE_OUT=str(self.out))
        env.update(extra_env or {})
        result = subprocess.run(
            ['/bin/bash', str(SCRIPT), '--workspace-id', 'fixture-workspace',
             '--name', 'fixture-runtime', '--base', 'https://fixture.invalid/api/v1',
             '--out', str(self.out)], env=env, cwd=self.root,
            capture_output=True, text=True, timeout=20, umask=0)
        self.assertNotIn(SYNTHETIC_KEY, result.stdout + result.stderr)
        self.assertEqual(list(self.responses.iterdir()), [])
        self.assertEqual(list(self.root.rglob('.muneral-key-*')), [])
        return result

    def assert_preflight_refusal(self, env=None):
        result = self.run_helper(env)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(self.calls.exists(), 'unsafe path reached the API stub')

    def test_new_file_is_private_before_first_byte_and_atomic(self):
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.out.parent.stat().st_mode), 0o700)
        self.assertEqual(self.writes.read_text(), '384 False\n')
        self.assertIn('mun_sk=' + SYNTHETIC_KEY, self.out.read_text())
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_existing_public_file_is_unchanged(self):
        self.out = self.victim
        self.assert_preflight_refusal()
        self.assertEqual(self.victim.read_text(), 'original, must survive')
        self.assertEqual(stat.S_IMODE(self.victim.stat().st_mode), 0o644)

    def test_existing_directory_is_refused(self):
        self.out.mkdir(parents=True)
        self.assert_preflight_refusal()

    def test_final_symlink_is_not_followed(self):
        self.out.parent.mkdir()
        self.out.symlink_to(self.victim)
        self.assert_preflight_refusal()
        self.assertEqual(self.victim.read_text(), 'original, must survive')
        self.assertEqual(stat.S_IMODE(self.victim.stat().st_mode), 0o644)

    def test_dangling_final_symlink_is_refused(self):
        self.out.parent.mkdir()
        missing = self.root / 'missing'
        self.out.symlink_to(missing)
        self.assert_preflight_refusal()
        self.assertFalse(missing.exists())

    def test_git_directory_is_refused(self):
        (self.root / '.git').mkdir()
        self.assert_preflight_refusal()

    def test_git_file_is_refused(self):
        (self.root / '.git').write_text('gitdir: /synthetic/worktree')
        self.assert_preflight_refusal()

    def test_dangling_git_marker_is_refused(self):
        (self.root / '.git').symlink_to(self.root / 'missing-gitdir')
        self.assert_preflight_refusal()

    def test_actual_linked_worktree_is_refused(self):
        git = shutil.which('git')
        if not git:
            self.skipTest('git is unavailable')
        repo, worktree = self.root / 'repo', self.root / 'worktree'
        for args in [['init', '-q', str(repo)],
                     ['-C', str(repo), '-c', 'user.name=Fixture', '-c',
                      'user.email=fixture@example.invalid', 'commit', '-qm',
                      'synthetic fixture', '--allow-empty'],
                     ['-C', str(repo), 'worktree', 'add', '--detach', '-q', str(worktree)]]:
            subprocess.run([git, *args], env=self.env, check=True, capture_output=True)
        self.assertTrue((worktree / '.git').is_file())
        self.out = worktree / 'nested' / 'runtime.key'
        self.assert_preflight_refusal()

    def test_parent_symlink_into_git_is_refused(self):
        repo = self.root / 'repo'
        (repo / '.git').mkdir(parents=True)
        alias = self.root / 'alias'
        alias.symlink_to(repo, target_is_directory=True)
        self.out = alias / 'nested' / 'runtime.key'
        self.assert_preflight_refusal()

    def test_relative_path_is_refused(self):
        self.out = Path('relative.key')
        self.assert_preflight_refusal()

    def test_missing_jwt_is_refused(self):
        self.assert_preflight_refusal({'MUNERAL_JWT': ''})

    def test_destination_file_created_during_api_is_not_overwritten(self):
        result = self.run_helper({'RACE': 'file'})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.out.read_text(), 'concurrent file, must survive')
        self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o644)

    def test_destination_symlink_created_during_api_is_not_followed(self):
        result = self.run_helper({'RACE': 'symlink'})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.out.is_symlink())
        self.assertEqual(self.victim.read_text(), 'original, must survive')
        self.assertEqual(stat.S_IMODE(self.victim.stat().st_mode), 0o644)

    def test_git_marker_created_during_api_is_rechecked(self):
        result = self.run_helper({'RACE': 'git'})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.out.exists())

    def test_failures_never_publish_partial_output(self):
        for failure in ['FAIL_HTTP', 'INVALID_RESPONSE', 'FAIL_WRITE', 'FAIL_FSYNC', 'FAIL_LINK']:
            with self.subTest(failure=failure):
                result = self.run_helper({failure: '1'})
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.out.exists())

    def test_directory_sync_failure_preserves_published_file_and_reports_it(self):
        result = self.run_helper({'FAIL_DIR_FSYNC': '1'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('file published with mode 0600', result.stderr)
        self.assertIn('agentId=fixture-agent', result.stderr)
        self.assertIn('keyId=fixture-key', result.stderr)
        self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o600)
        self.assertIn('mun_sk=' + SYNTHETIC_KEY, self.out.read_text())

    def test_two_concurrent_issuances_have_one_winner(self):
        env = dict(self.env, FIXTURE_OUT=str(self.out), RACE='barrier')
        command = ['/bin/bash', str(SCRIPT), '--workspace-id', 'fixture-workspace',
                   '--name', 'fixture-runtime', '--base', 'https://fixture.invalid/api/v1',
                   '--out', str(self.out)]
        processes = [subprocess.Popen(command, env=env, cwd=self.root,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, umask=0) for _ in range(2)]
        try:
            outputs = [p.communicate(timeout=20) for p in processes]
        finally:
            for p in processes:
                if p.poll() is None:
                    p.kill()
                    p.communicate()
        self.assertEqual(sorted(p.returncode for p in processes), [0, 1], outputs)
        for stdout, stderr in outputs:
            self.assertNotIn(SYNTHETIC_KEY, stdout + stderr)
        self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o600)
        self.assertIn('mun_sk=' + SYNTHETIC_KEY, self.out.read_text())
        self.assertEqual(len(self.calls.read_text().splitlines()), 4)
        self.assertEqual(list(self.responses.iterdir()), [])
        self.assertEqual(list(self.root.rglob('.muneral-key-*')), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)

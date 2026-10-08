import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('proof', Path(__file__).with_name('image-filesystem-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


def archive(files, links=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
        for name, target in (links or {}).items():
            member = tarfile.TarInfo(name)
            member.type, member.linkname = tarfile.SYMTYPE, target
            tar.addfile(member)
    return output.getvalue()


class ImageProofTest(unittest.TestCase):
    def inventory(self, files, links=None, fingerprints=None):
        with tarfile.open(fileobj=io.BytesIO(archive(files, links))) as tar:
            return proof.inventory(tar, fingerprints or set())

    def test_clean_manifest_and_internal_link(self):
        rows, packages = self.inventory({'app/store/package.json': b'{"name":"pg","version":"8"}'},
                                        {'app/link': 'store'})
        proof.check_final_links(rows)
        self.assertEqual(packages[0]['name'], 'pg')
        self.assertIn('sha256', rows[0])

    def test_renamed_affected_source_is_rejected(self):
        payload = b'actual affected source fixture'
        with self.assertRaisesRegex(ValueError, 'affected braces source'):
            self.inventory({'app/unrelated-name': payload}, fingerprints={hashlib.sha256(payload).hexdigest()})

    def test_archive_path_escape_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'escape'):
            self.inventory({'../../outside': b'data'})

    def test_link_escape_and_chain_escape_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'escape'):
            self.inventory({}, {'app/link': '../../outside'})
        with self.assertRaisesRegex(ValueError, 'escapes /app'):
            self.inventory({}, {'app/link': '/usr/private'})

    def test_dangling_and_cyclic_links_are_rejected(self):
        for links in ({'app/link': 'missing'}, {'app/a': 'b', 'app/b': 'a'}):
            rows, _ = self.inventory({}, links)
            with self.assertRaises(ValueError):
                proof.check_final_links(rows)

    def test_test_packages_are_not_hidden_by_path(self):
        for name in ('braces', '@jest/core', 'jest-worker', 'ts-jest'):
            with self.assertRaisesRegex(ValueError, 'forbidden installed package'):
                self.inventory({'app/renamed/package.json': json.dumps({'name': name}).encode()})

    def test_lower_layer_deleted_package_still_fails(self):
        bad = archive({'app/old/package.json': b'{"name":"braces","version":"3.0.3"}'})
        clean = archive({'app/.wh.old': b''})
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            image = archive({'manifest.json': json.dumps([{'Config': 'config.json', 'Layers': ['old.tar', 'new.tar']}]).encode(),
                             'config.json': json.dumps({'rootfs': {'diff_ids': ['sha256:' + hashlib.sha256(x).hexdigest() for x in (bad, clean)]}}).encode(),
                             'old.tar': bad, 'new.tar': clean})
            (root / 'image.tar').write_bytes(image)
            (root / 'root.tar').write_bytes(archive({'app/clean': b'ok'}))
            (root / 'fingerprints.json').write_text('{"sha256":["unused-control"]}')
            with self.assertRaisesRegex(ValueError, 'forbidden installed package'):
                proof.prove(root / 'image.tar', root / 'root.tar', root / 'fingerprints.json', root / 'receipt.json')

    def test_wrong_layer_digest_is_rejected(self):
        layer = archive({'app/clean': b'ok'})
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            image = archive({'manifest.json': b'[{"Config":"config.json","Layers":["one.tar"]}]',
                             'config.json': b'{"rootfs":{"diff_ids":["sha256:wrong"]}}', 'one.tar': layer})
            (root / 'image.tar').write_bytes(image)
            (root / 'root.tar').write_bytes(layer)
            (root / 'fingerprints.json').write_text('{"sha256":["unused-control"]}')
            with self.assertRaisesRegex(ValueError, 'layer bytes'):
                proof.prove(root / 'image.tar', root / 'root.tar', root / 'fingerprints.json', root / 'receipt.json')


if __name__ == '__main__':
    unittest.main()

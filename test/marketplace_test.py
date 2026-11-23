"""Release recovery must reject an existing version with different extension content."""
import importlib.util
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('marketplace', Path(__file__).resolve().parents[1] / 'scripts/marketplace.py')
marketplace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(marketplace)


def archive(content, signing=False):
    result = io.BytesIO()
    with ZipFile(result, 'w') as package:
        for name, value in content.items():
            package.writestr(name, value)
        if signing:
            package.writestr('Signature.p7s', 'server signature')
    return result.getvalue()


def gallery(extension_flags, version_flags):
    return io.BytesIO(json.dumps({'results': [{'extensions': [{
        'extensionName': marketplace.EXTENSION,
        'publisher': {'publisherName': marketplace.PUBLISHER},
        'flags': extension_flags,
        'versions': [{
            'version': '1.1.4',
            'flags': version_flags,
            'files': [{
                'assetType': 'Microsoft.VisualStudio.Services.VSIXPackage',
                'source': 'https://fixture.vsassets.io/codex-chats-list.vsix',
            }],
        }],
    }]}]}).encode())


class PayloadVerification(unittest.TestCase):
    def test_rejects_extra_extension_files(self):
        data = {'extension/package.json': '{}'}
        with self.assertRaises(ValueError):
            marketplace.compare_payload(archive(data), archive({**data, 'extension/extra.js': 'unexpected'}))

    def test_allows_only_container_signature_additions(self):
        data = {'extension/package.json': '{"version":"0.1.2"}', 'extension/dist/extension/extension.js': 'trusted code', 'extension/readme.md': 'public docs'}
        marketplace.compare_payload(archive(data), archive(data, signing=True))

    def test_rejects_changed_runtime_or_documentation_and_missing_files(self):
        data = {'extension/package.json': '{}', 'extension/dist/extension/extension.js': 'trusted code', 'extension/readme.md': 'public docs'}
        for name in data:
            changed = dict(data)
            changed[name] = 'different'
            with self.assertRaises(ValueError):
                marketplace.compare_payload(archive(data), archive(changed))
            del changed[name]
            with self.assertRaises(ValueError):
                marketplace.compare_payload(archive(data), archive(changed))


class MarketplaceValidation(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.package = Path(directory.name, 'candidate.vsix')
        self.payload = archive({'extension/package.json': json.dumps({
            'publisher': marketplace.PUBLISHER, 'name': marketplace.EXTENSION, 'version': '1.1.4',
        })})
        self.package.write_bytes(self.payload)

    def test_rejects_pending_or_unavailable_versions_before_downloading(self):
        for extension_flags, version_flags in [
            ('validated, public', 'none'),
            ('validated', 'validated'),
            ('public, unpublished', 'validated'),
            (261, 1),
        ]:
            response = gallery(extension_flags, version_flags)
            with self.subTest(extension_flags=extension_flags, version_flags=version_flags), \
                 patch.object(marketplace.urllib.request, 'urlopen', return_value=response) as fetch:
                with self.assertRaises(marketplace.ValidationPending):
                    marketplace.reconcile(self.package)
                fetch.assert_called_once()

    def test_waits_for_validation_then_compares_the_download(self):
        with patch.object(marketplace.urllib.request, 'urlopen', side_effect=[
            gallery('public', 'none'), gallery(260, 1), io.BytesIO(self.payload),
        ]) as fetch, patch.object(marketplace.time, 'sleep') as sleep:
            self.assertTrue(marketplace.reconcile(self.package, wait=True))
        sleep.assert_called_once_with(15)
        self.assertEqual(fetch.call_count, 3)


if __name__ == '__main__':
    unittest.main()

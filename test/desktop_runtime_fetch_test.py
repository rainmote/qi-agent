"""Pure/mock download tests. No sockets, installs, subprocesses or native actions."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("runtime_fetch", ROOT / "scripts/desktop/runtime-fetch.py")
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)
CATALOG = json.loads(fetch.CATALOG.read_text())
DATA = b"inert test archive bytes"


def source(kind="npm", data=DATA):
    value = {"name": "fixture-1.0.0", "kind": kind, "limit": 4096,
             "url": "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
             "integrity": "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()}
    if kind == "wheel":
        value.pop("integrity")
        value.update(name="some_pkg-1.0.0-cp312-cp312-macosx_11_0_arm64.whl",
                     sha256=hashlib.sha256(data).hexdigest())
        value["url"] = "https://files.pythonhosted.org/packages/fixture/" + value["name"]
    return value


class Response(io.BytesIO):
    def __init__(self, url, data):
        super().__init__(data)
        self.url, self.status = url, 200


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(socket, "socket", side_effect=AssertionError("real socket forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_real_lock_plan_keeps_37_original_pins_and_python_official(self):
        raw = fetch.LOCK.read_bytes(); lock = json.loads(raw)
        fetch.validate(lock, CATALOG)
        plans = [fetch.source_plan(item, "cn", CATALOG) for item in lock["sources"]]
        self.assertEqual(len(plans), 37)
        self.assertEqual(sum(item["mode"] == "candidate_archive" for item in plans), 23)
        self.assertEqual(sum(item["mode"] == "candidate_index" for item in plans), 13)
        self.assertEqual(plans[0]["url"], lock["sources"][0]["url"])
        for item, planned in zip(lock["sources"], plans):
            self.assertEqual(planned["pin"], item.get("sha256", item.get("integrity")))
        self.assertEqual(fetch.LOCK.read_bytes(), raw)

    def test_scoped_npm_path_and_normalized_wheel_index_are_exact(self):
        item = {**source(), "url": "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz"}
        self.assertEqual(fetch.source_plan(item, "cn", CATALOG)["url"],
                         "https://registry.npmmirror.com/@scope/pkg/-/pkg-1.0.0.tgz")
        self.assertEqual(fetch.source_plan(source("wheel"), "cn", CATALOG)["url"],
                         "https://pypi.tuna.tsinghua.edu.cn/simple/some-pkg/")

    def test_malformed_lock_and_unreviewed_mirror_fail_closed(self):
        for change in [{"limit": True}, {"name": "../outside"}, {"integrity": "sha512-YQ=="},
                       {"url": "https://mirror.invalid/a"}, {"sha256": "a" * 64}]:
            with self.assertRaises(fetch.PolicyError):
                fetch.validate({"schema": 1, "sources": [{**source(), **change}]}, CATALOG)
        changed = json.loads(json.dumps(CATALOG))
        changed["profiles"]["cn"]["npm_registry"] = "https://mirror.invalid"
        with self.assertRaises(fetch.PolicyError):
            fetch.validate({"schema": 1, "sources": [source()]}, changed)

    def test_https_origin_credentials_ports_and_signed_query_policy(self):
        for url in ["http://registry.npmmirror.com/a", "https://user:secret@registry.npmmirror.com/a",
                    "https://registry.npmmirror.com.evil/a", "https://registry.npmmirror.com:444/a",
                    "https://registry.npmmirror.com/a#hash", "https://registry.npmmirror.com/a\n"]:
            with self.assertRaises(fetch.PolicyError): fetch.safe_url(url, {"registry.npmmirror.com"})
        fetch.safe_url("https://release-assets.githubusercontent.com/a?signed=value", fetch.GITHUB)

    def test_redirect_strips_credentials_and_refuses_unknown_cdn(self):
        handler = fetch.Redirect({"registry.npmmirror.com"})
        request = urllib.request.Request("https://registry.npmmirror.com/a", headers={
            "Authorization": "fixture-secret", "Cookie": "fixture-cookie", "Referer": "https://origin.invalid"})
        result = handler.redirect_request(request, None, 302, "Found", {}, "https://registry.npmmirror.com/b")
        headers = {key.lower(): value for key, value in result.header_items()}
        for name in ("authorization", "cookie", "referer"): self.assertNotIn(name, headers)
        with self.assertRaises(fetch.PolicyError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://unknown-cdn.invalid/a")

    def index(self, item, url=None, digest=None):
        url = url or "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/packages/fixture/" + item["name"]
        return ('<a href="' + url + '#sha256=' + (digest or item["sha256"]) + '">wheel</a>').encode()

    def test_wheel_requires_exact_filename_abi_architecture_and_original_hash(self):
        item = source("wheel"); address = fetch.source_plan(item, "cn", CATALOG)["url"]
        self.assertTrue(fetch.wheel_url(self.index(item), address, item).endswith(item["name"]))
        for body in [self.index(item).replace(b"cp312", b"cp311"),
                     self.index(item).replace(b"arm64", b"x86_64"), self.index(item, digest="0" * 64),
                     self.index(item, url="https://files.pythonhosted.org/" + item["name"]),
                     self.index(item) + self.index(item, url="https://pypi.tuna.tsinghua.edu.cn/other/" + item["name"])]:
            with self.assertRaises(fetch.PolicyError): fetch.wheel_url(body, address, item)

    def download(self, root, item=None, payload=DATA, factory=None):
        item = item or source(); planned = fetch.source_plan(item, "cn", CATALOG)
        run = {"phase": "cache-validation", "bytes": 0}
        class Opener:
            def open(self, request, timeout): return Response(request.full_url, payload)
        result = fetch.fetch_one(item, planned, "cn", root, run,
                                 {"bytes": 0, "started": fetch.time.monotonic()},
                                 opener_factory=factory or (lambda handler: Opener()))
        return result, run

    def test_original_sha512_and_sha256_publish_without_extraction_or_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            wheel = source("wheel")
            # A SHA256 GitHub archive avoids the wheel-index branch in this test.
            archive = {**wheel, "kind": "python", "url": "https://github.com/fixture/inert.tgz"}
            for item in [source(), archive]:
                result, run = self.download(root, item)
                self.assertEqual(result["status"], "DOWNLOADED_VERIFIED")
                self.assertTrue(run["published"])
                self.assertEqual((root / item["name"]).read_bytes(), DATA)
                self.assertFalse((root / (item["name"] + ".partial")).exists())
                result, _ = self.download(root, item, factory=lambda handler: self.fail("cached must not connect"))
                self.assertEqual(result["status"], "CACHED_VERIFIED")

    def test_wrong_pin_partial_is_retained_and_never_promoted_or_replayed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with self.assertRaisesRegex(fetch.PolicyError, "original integrity"):
                self.download(root, payload=b"wrong content")
            self.assertFalse((root / source()["name"]).exists())
            self.assertEqual((root / (source()["name"] + ".partial")).read_bytes(), b"wrong content")
            with self.assertRaisesRegex(fetch.PolicyError, "reconcile"):
                self.download(root, factory=lambda handler: self.fail("must not replay"))

    def test_existing_corrupt_or_symlink_cache_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); target = root / source()["name"]
            target.write_bytes(b"existing")
            with self.assertRaises(fetch.PolicyError): self.download(root)
            self.assertEqual(target.read_bytes(), b"existing")
            target.unlink(); original = root / "original"; original.write_bytes(DATA); target.symlink_to(original)
            with self.assertRaises(OSError): self.download(root)
            self.assertTrue(target.is_symlink())

    def test_uncertain_publication_partial_requires_reconciliation_even_with_valid_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); target = root / source()["name"]
            target.write_bytes(DATA)
            (root / (source()["name"] + ".partial")).write_bytes(DATA)
            with self.assertRaisesRegex(fetch.PolicyError, "reconcile"):
                self.download(root, factory=lambda handler: self.fail("do not connect"))

    def test_directory_symlinks_and_foreign_writable_cache_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); linked = root / "linked"; linked.symlink_to(root, target_is_directory=True)
            with self.assertRaises(fetch.PolicyError): fetch.private_directory(linked / "new")
            self.assertFalse((root / "new").exists())
            shared = root / "shared"; shared.mkdir(mode=0o777); shared.chmod(0o777)
            with self.assertRaises(fetch.PolicyError): fetch.private_directory(shared)

    def test_oversize_download_stays_inert_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with self.assertRaisesRegex(fetch.PolicyError, "byte limit"):
                self.download(root, item={**source(), "limit": 4})
            self.assertFalse((root / source()["name"]).exists())

    def test_wheel_index_and_archive_both_verify_without_real_http(self):
        item = source("wheel"); fixture = self; calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request.full_url)
                return Response(request.full_url, fixture.index(item) if len(calls) == 1 else DATA)
        with tempfile.TemporaryDirectory() as temporary:
            result, _ = self.download(Path(temporary).resolve(), item, factory=lambda handler: Opener())
            self.assertEqual(result["status"], "DOWNLOADED_VERIFIED")
        self.assertEqual(len(calls), 2)
        self.assertIn("/simple/some-pkg/", calls[0]); self.assertTrue(calls[1].endswith(item["name"]))

    def test_realistic_tuna_index_above_1mb_accepts_only_the_exact_pinned_wheel(self):
        item = source("wheel"); calls = []; fixture = self
        body = b"<!--" + b"x" * 1_700_000 + b"-->" + self.index(item)
        class Opener:
            def open(self, request, timeout):
                calls.append(request.full_url)
                return Response(request.full_url, body if len(calls) == 1 else DATA)
        with tempfile.TemporaryDirectory() as temporary:
            outcome = None
            try:
                result, _ = self.download(Path(temporary).resolve(), item, factory=lambda handler: Opener())
                outcome = result["status"]
            except fetch.PolicyError as error:
                outcome = str(error)
            self.assertEqual(outcome, "DOWNLOADED_VERIFIED",
                             "TUNA's measured Pillow/lxml indexes exceed1MB but remain below2MB")
            self.assertEqual(len(calls), 2)

    def test_index_above_2mb_refuses_before_archive_request_or_cache_publication(self):
        item = source("wheel"); calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request.full_url)
                return Response(request.full_url, b"x" * 2_000_001)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with self.assertRaisesRegex(fetch.PolicyError, "index too large"):
                self.download(root, item, factory=lambda handler: Opener())
            self.assertFalse((root / item["name"]).exists())
            self.assertFalse((root / (item["name"] + ".partial")).exists())
            self.assertEqual(len(calls), 1)

    def test_permission_denial_differs_from_dns_ssl_and_unknown_io(self):
        for error, phase, status, scope in [
            (urllib.error.URLError(socket.gaierror(8, "fixture")), "HTTPS-connect", "TRANSPORT_ERROR_STOPPED", "origin"),
            (urllib.error.URLError(fetch.ssl.SSLError(1, "fixture")), "HTTPS-connect", "TRANSPORT_ERROR_STOPPED", "origin"),
            (PermissionError(1, "fixture"), "HTTPS-connect", "PERMISSION_DENIED_STOPPED", "all"),
            (OSError(5, "fixture"), "local-exclusive-publish", "LOCAL_OR_OUTCOME_UNKNOWN_STOPPED", "all"),
            (urllib.error.HTTPError("https://registry.npmmirror.com/a", 403, "fixture", {}, None),
             "HTTPS-connect", "HTTP_ERROR_STOPPED", "all")]:
            result, stop = fetch.error_result(error, phase)
            self.assertEqual((result["status"], stop), (status, scope))

    def test_receipt_exclusive_and_unknown_change_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / "receipt.json"
            report = {"status": "RUNNING"}; receipt = fetch.Receipt(path, report)
            with self.assertRaises(FileExistsError): fetch.Receipt(path, report)
            report["status"] = "VERIFIED"; receipt.save()
            self.assertEqual(json.loads(path.read_text())["status"], "VERIFIED")
            path.write_text("external change")
            with self.assertRaises(fetch.PolicyError): receipt.save()
            self.assertEqual(path.read_text(), "external change")

    def test_offline_plan_does_not_create_paths_or_connect(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); output = io.StringIO()
            with patch.object(fetch.sys, "stdout", output), patch.object(fetch, "private_directory", side_effect=AssertionError("no mkdir")):
                self.assertEqual(fetch.main(["plan", "--profile", "cn", "--cache", str(root / "absent")]), 0)
            plan = json.loads(output.getvalue())
            self.assertEqual((plan["default_profile"], plan["activated_registries"]), ("official", 0))
            self.assertFalse((root / "absent").exists())

    def test_dns_stops_same_origin_without_fallback_and_records_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); path = root / "receipt.json"
            args = ["fetch", "--profile", "cn", "--cache", str(root / "cache"), "--receipt", str(path),
                    "--only", "pnpm-11.28.5", "--only", "npm-xterm-xterm-6.0.0"]
            def fail(source, planned, profile, cache, run, budget):
                run["phase"] = "HTTPS-connect"
                raise urllib.error.URLError(socket.gaierror(8, "fixture secret must not be serialized"))
            with patch.object(fetch, "fetch_one", side_effect=fail) as download, patch.object(fetch.sys, "stdout", io.StringIO()):
                self.assertEqual(fetch.main(args), 1)
            self.assertEqual(download.call_count, 1)
            result = json.loads(path.read_text())
            self.assertEqual(result["status"], "INCOMPLETE_STOPPED")
            self.assertEqual([item["status"] for item in result["results"]], ["TRANSPORT_ERROR_STOPPED", "NOT_RUN_STOPPED"])
            self.assertNotIn("fixture secret", path.read_text())

    def test_publish_uncertainty_and_receipt_failure_cannot_be_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(fetch.os, "link", side_effect=OSError(5, "fixture")):
                with self.assertRaises(OSError): self.download(root)
            self.assertTrue((root / (source()["name"] + ".partial")).exists())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); path = root / "receipt.json"
            original = fetch.Receipt.save; count = 0
            def fail_second(receipt):
                nonlocal count
                count += 1
                if count == 2: raise OSError(5, "fixture")
                original(receipt)
            with patch.object(fetch.Receipt, "save", fail_second), patch.object(fetch, "fetch_one", side_effect=AssertionError("do not fetch")), \
                 patch.object(fetch.sys, "stderr", io.StringIO()):
                self.assertEqual(fetch.main(["fetch", "--only", "pnpm-11.28.5", "--cache", str(root / "cache"), "--receipt", str(path)]), 2)
            self.assertEqual(json.loads(path.read_text())["status"], "RUNNING")


if __name__ == "__main__":
    unittest.main()

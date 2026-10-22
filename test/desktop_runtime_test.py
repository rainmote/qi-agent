"""Pure protocol/archive fixtures. Never calls PTY/fork, ps, sandbox or Office."""
import importlib.util
import errno
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import uuid
import zipfile
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


terminal = module("terminal_protocol", "src/qi/terminal_helper.py")
runtime = module("runtime_archive", "scripts/desktop/workspace-runtime.py")
receipts = module("pty_receipts", "test/pty_receipt.py")


class ProtocolTests(unittest.TestCase):
    def test_guardian_restores_waitable_child_policy_before_constructing_terminal(self):
        events = []; owned = Mock()
        owned.parent_alive.return_value = False
        owned.cleanup = True
        owned.state.return_value = {"status": "closed"}
        def construct(*_):
            events.append("constructed")
            return owned
        def disposition(sig, handler):
            if sig == terminal.signal.SIGCHLD and handler == terminal.signal.SIG_DFL:
                events.append("SIGCHLD-default")
        with patch.object(terminal, "Terminal", side_effect=construct), \
             patch.object(terminal.os, "getppid", return_value=12345), \
             patch.object(terminal.os.path, "realpath", side_effect=lambda value: value), \
             patch.object(terminal.os, "setsid"), patch.object(terminal.os, "set_blocking"), \
             patch.object(terminal.os, "forkpty") as fork, \
             patch.object(terminal.signal, "signal", side_effect=disposition), patch.object(terminal, "emit"):
            terminal.main("/fixture", 12345, "native-process-group", "fixture profile", "/runtime")
            self.assertEqual(events[:2], ["SIGCHLD-default", "constructed"], "an ignored SIGCHLD must not permit automatic reaping and PID reuse")
            fork.assert_not_called()

    def test_allocator_rejects_changed_profile_before_any_native_operation(self):
        configure = getattr(terminal, "native_config", None)
        self.assertTrue(callable(configure), "native allocator must validate fixed policy before allocating")
        with patch.object(terminal.os, "forkpty") as fork:
            with self.assertRaisesRegex(ValueError, "profile"):
                configure("/fixture", "/runtime", "(allow default)")
            fork.assert_not_called()

    def test_allocator_exec_is_fixed_to_original_child_sandbox_and_bootstrap(self):
        command = getattr(terminal, "sandbox_shell_command", None)
        self.assertTrue(callable(command), "allocator must retain the original sandbox on the command child")
        config = {"root": "/fixture", "runtime": "/runtime", "profile": "fixture verified policy",
                  "python": "/runtime/python", "helper": "/runtime/src/qi/terminal_helper.py"}
        nonce = str(uuid.uuid4())
        args = command(config, 12345, 9, nonce)
        self.assertEqual(args[:7], ["/usr/bin/sandbox-exec", "-D", "WORKSPACE=/fixture", "-D", "RUNTIME=/runtime", "-p", config["profile"]])
        self.assertEqual(args[7:12], [config["python"], "-I", "-B", config["helper"], "--sandbox-shell"])
        self.assertEqual(args[12:], ["--parent", "12345", "--ack-fd", "9", "--ack-nonce", nonce])

    def test_allocator_readiness_rejects_trailing_errors_and_other_session_identity(self):
        check = getattr(terminal, "validate_ready", None)
        self.assertTrue(callable(check), "readiness must validate the whole private channel through EOF")
        expected = {"pid": 12346, "parent": 12345, "nonce": str(uuid.uuid4())}
        value = {**expected, "ready": True, "session": 12346, "group": 12346}
        raw = (json.dumps(value) + "\n").encode()
        self.assertEqual(check(raw, expected), value)
        for payload in [b"", raw + b'{"ready":false}\n', b"x" * 4097,
                        (json.dumps({**value, "nonce": str(uuid.uuid4())}) + "\n").encode(),
                        (json.dumps({**value, "pid": 12347}) + "\n").encode(),
                        (json.dumps({**value, "session": 12345}) + "\n").encode()]:
            with self.assertRaises((ValueError, RuntimeError)):
                check(payload, expected)

    def test_allocator_closes_all_unrelated_inherited_descriptors(self):
        close = getattr(terminal, "close_unrelated_fds", None)
        self.assertTrue(callable(close), "shell must not inherit control or sibling-session descriptors")
        with patch.object(terminal.os, "listdir", return_value=["0", "1", "2", "3", "4", "9", "9999"]), \
             patch.object(terminal.os, "close") as closed:
            close({4, 9})
            self.assertEqual([args.args[0] for args in closed.call_args_list], [3, 9999])

    def test_real_harness_requires_final_matching_cleanup_receipt_even_after_exit(self):
        expected = {"generation": "fixture-generation", "child_pid": 12345, "guardian_pid": 12344}
        result = {**expected, "status": "closed", "cleanup_confirmed": True, "cleanup_observed": True,
                  "shell_exit_observed": True, "cleanup_scope": "registered-process-groups", "descendant_containment": False,
                  "cleanup_mode": "native-process-group", "registered_groups": [12345],
                  "command_sandbox": "seatbelt", "sandbox_ready": True}
        self.assertTrue(receipts.cleanup_receipt_matches(result, expected, 0))
        for mutation in [{"generation": "old"}, {"child_pid": 12346}, {"guardian_pid": 12343},
                         {"cleanup_observed": False}, {"cleanup_confirmed": False}, {"shell_exit_observed": False},
                         {"registered_groups": []}, {"registered_groups": [12346]}, {"registered_groups": [12345, 12345]},
                         {"sandbox_ready": False}, {"command_sandbox": "none"}]:
            self.assertFalse(receipts.cleanup_receipt_matches({**result, **mutation}, expected, 0))
        for code in [None, -9, 71]: self.assertFalse(receipts.cleanup_receipt_matches(result, expected, code))
        self.assertFalse(receipts.cleanup_receipt_matches(None, expected, 0))

    def test_finite_input_geometry_and_request_identity(self):
        request = {"id": str(uuid.uuid4()), "op": "open", "cols": 90, "rows": 24}
        self.assertEqual(terminal.validate(request), request)
        for change in [{"cols": True}, {"rows": 301}, {"command": "ignored"}, {"id": "invalid"}]:
            with self.assertRaises(ValueError):
                terminal.validate({**request, **change})
        with self.assertRaises(ValueError):
            terminal.validate({"id": str(uuid.uuid4()), "op": "input", "text": "界" * 6000})

    def test_bounded_output_cursor_preserves_partial_utf8_and_reports_truncation(self):
        output = terminal.Output()
        output.append("界".encode()[:2])
        self.assertEqual(output.read(0)["cursor"], 0)
        output.append("界".encode()[2:])
        self.assertEqual(output.read(0)["output"], "界")
        self.assertEqual(output.read(0)["cursor"], 3)
        output.append(b"a" * (terminal.MAX_BUFFER + 10))
        self.assertTrue(output.read(0)["truncated"])
        self.assertLessEqual(len(output.buffer), terminal.MAX_BUFFER)
        with self.assertRaises(ValueError): output.read(10 ** 10)

    def test_final_output_larger_than_one_read_retains_an_explicit_drain_hint(self):
        output = terminal.Output()
        output.append(b"a" * 200000)
        first = output.read(0)
        self.assertTrue(first.get("has_more", False), "closed terminals must drain more than one 64KiB chunk")
        self.assertEqual(first.get("end"), 200000)
        chunks = [first["output"]]
        while first["has_more"]:
            first = output.read(first["cursor"], final=True)
            chunks.append(first["output"])
        self.assertEqual("".join(chunks), "a" * 200000)
        output = terminal.Output(); output.append(b"\xe7\x95")
        final = output.read(0, final=True)
        self.assertFalse(final["has_more"])
        self.assertEqual(final["cursor"], 2)

    def test_unknown_cleanup_never_retries_native_observations(self):
        instance = terminal.Terminal("/fixture", 12345)
        instance.pid = 98765; instance.reason = "cleanup_unknown"
        with patch.object(terminal, "census", side_effect=AssertionError("must not invoke ps")):
            self.assertFalse(instance.close()["cleanup_confirmed"])

    def test_expired_cleanup_is_sticky_and_cannot_repeat_signals(self):
        instance = terminal.Terminal("/fixture", 12345)
        instance.pid = 98765; instance.known = {98765: "fixture-start"}
        rows = {98765: (12345, 98765, "fixture-start")}
        with patch.object(instance, "remember", return_value=rows) as remember, \
             patch.object(terminal.os, "kill") as kill, \
             patch.object(terminal.os, "waitpid", return_value=(0, 0)), \
             patch.object(terminal.time, "sleep"), \
             patch.object(terminal.time, "monotonic", side_effect=[0, 0.5, 2]):
            self.assertEqual(instance.close()["reason"], "cleanup_unknown")
            observations, signals = remember.call_count, kill.call_count
            self.assertFalse(instance.close()["cleanup_confirmed"])
            self.assertEqual((remember.call_count, kill.call_count), (observations, signals))

    def test_unproven_descendant_containment_rejects_before_fork_or_census(self):
        instance = terminal.Terminal("/fixture", 12345)
        with patch.object(instance, "parent_alive", return_value=True), \
             patch.object(terminal, "census", side_effect=AssertionError("must not invoke ps")), \
             patch.object(terminal.pty, "fork", side_effect=AssertionError("must not fork")), \
             patch.object(terminal.os, "forkpty", side_effect=AssertionError("must not fork")):
            with self.assertRaisesRegex(RuntimeError, "descendant_containment_unavailable"):
                instance.start(90, 24)

    def test_explicit_native_mode_reaches_only_the_mocked_fork_boundary(self):
        instance = terminal.Terminal("/fixture", 12345)
        instance.cleanup_mode = "native-process-group"
        with patch.object(instance, "parent_alive", return_value=True), \
             patch.object(terminal, "native_config", return_value={"root": "/fixture"}), \
             patch.object(terminal, "census", return_value={}), \
             patch.object(terminal.os, "forkpty", side_effect=RuntimeError("fixture-fork-boundary")):
            with self.assertRaisesRegex(RuntimeError, "fixture-fork-boundary"):
                instance.start(90, 24)

    def test_native_allocation_preserves_first_errno_without_implicit_fallback(self):
        instance = terminal.Terminal("/fixture", 12345, "native-process-group")
        # Both boundaries are mocked: this is never a real PTY probe. The
        # stdlib fallback would otherwise discard the first permission error.
        with patch.object(instance, "parent_alive", return_value=True), \
             patch.object(terminal, "native_config", return_value={"root": "/fixture"}), \
             patch.object(terminal, "census", return_value={}), \
             patch.object(terminal.os, "pipe", return_value=(31, 32)), \
             patch.object(terminal.os, "close"), \
             patch.object(terminal.os, "forkpty", side_effect=OSError(errno.EACCES, "fixture first error")) as first, \
             patch.object(terminal.pty, "fork", side_effect=OSError(errno.ENOSYS, "fixture forbidden fallback")) as fallback:
            try:
                instance.start(90, 24)
            except OSError as error:
                observed = error.errno
            else:
                observed = None
            self.assertEqual(observed, errno.EACCES, "retain the first syscall error, never silently try another allocator")
            self.assertEqual(first.call_count, 1)
            fallback.assert_not_called()
            self.assertEqual(getattr(instance, "operation_stage", None), "pty-allocate")

    def test_native_preflight_failure_identifies_stage_before_any_allocation(self):
        instance = terminal.Terminal("/fixture", 12345, "native-process-group")
        with patch.object(instance, "parent_alive", return_value=True), \
             patch.object(terminal, "native_config", return_value={"root": "/fixture"}), \
             patch.object(terminal, "census", side_effect=OSError("fixture library unavailable")), \
             patch.object(terminal.os, "pipe") as pipe, \
             patch.object(terminal.os, "forkpty") as first, \
             patch.object(terminal.pty, "fork") as fallback:
            with self.assertRaises(OSError):
                instance.start(90, 24)
            self.assertEqual(getattr(instance, "operation_stage", None), "ownership-preflight")
            pipe.assert_not_called(); first.assert_not_called(); fallback.assert_not_called()

    def test_failure_receipt_retains_first_stage_and_errno_when_cleanup_also_fails(self):
        instance = terminal.Terminal("/fixture", 12345, "native-process-group")
        instance.record_failure(OSError(errno.EACCES, "fixture first error"), "pty-allocate")
        instance.record_failure(RuntimeError("fixture cleanup also failed"), "registered-group-cleanup")
        state = instance.state()
        self.assertEqual((state["failure_code"], state["failure_errno"], state["failure_stage"]),
                         ("PermissionError", errno.EACCES, "pty-allocate"))

    def native_fixture(self):
        instance = terminal.Terminal("/fixture", 12345, "native-process-group")
        instance.pid = 98765
        instance.shell_identity = (501, 100, 123456)
        instance.known = {98765: instance.shell_identity}
        instance.groups = {98765}
        info = {"pid": 98765, "parent": 12345, "group": 98765, "session": 98765,
                "identity": instance.shell_identity, "zombie": False}
        return instance, info

    def test_unreleased_owned_child_is_reaped_without_repeating_failed_identity_lookup(self):
        instance = terminal.Terminal("/fixture", 12345, "native-process-group")
        instance.pid = 98765; instance.fork_owned = True; instance.gate_release_attempted = False
        instance.record_failure(PermissionError(errno.EACCES, "fixture registration denied"), "shell-registration")
        with patch.object(instance, "remember_groups", side_effect=PermissionError("must not repeat denied lookup")) as lookup, \
             patch.object(terminal.os, "waitpid", return_value=(98765, 0)) as wait, \
             patch.object(terminal.os, "kill") as kill, patch.object(terminal.os, "killpg") as killpg:
            state = instance.close()
            self.assertTrue(state["cleanup_observed"], "a waitable pre-release child must not leak behind missing metadata")
            self.assertTrue(state["shell_exit_observed"])
            self.assertFalse(state["sandbox_ready"])
            self.assertEqual(state["failure_stage"], "shell-registration")
            wait.assert_called_once_with(98765, terminal.os.WNOHANG)
            lookup.assert_not_called(); kill.assert_not_called(); killpg.assert_not_called()

    def test_unreleased_child_that_is_not_waitable_stays_unknown_and_never_signals(self):
        instance = terminal.Terminal("/fixture", 12345, "native-process-group")
        instance.pid = 98765; instance.fork_owned = True; instance.gate_release_attempted = False
        with patch.object(instance, "remember_groups", side_effect=PermissionError("fixture denied")) as lookup, \
             patch.object(terminal.os, "waitpid", side_effect=ChildProcessError()) as wait, \
             patch.object(terminal.os, "kill") as kill, patch.object(terminal.os, "killpg") as killpg:
            self.assertFalse(instance.close()["cleanup_observed"])
            count = wait.call_count
            self.assertFalse(instance.close()["cleanup_observed"])
            self.assertEqual(wait.call_count, count)
            wait.assert_called_once_with(98765, terminal.os.WNOHANG)
            lookup.assert_not_called()
            kill.assert_not_called(); killpg.assert_not_called()

    def test_group_signal_rechecks_birth_identity_and_never_signals_a_reused_pid(self):
        instance, info = self.native_fixture()
        with patch.object(instance, "group_members", return_value=[info]), \
             patch.object(terminal, "process_info", return_value={**info, "identity": (501, 200, 123456)}), \
             patch.object(terminal.os, "killpg") as kill:
            with self.assertRaisesRegex(RuntimeError, "identity_changed"):
                instance.signal_group(98765, terminal.signal.SIGTERM)
            kill.assert_not_called()

    def test_group_signal_does_not_use_a_disappeared_anchor_or_claim_cleanup(self):
        instance, info = self.native_fixture()
        with patch.object(instance, "group_members", return_value=[info]), \
             patch.object(terminal, "process_info", return_value=None), \
             patch.object(terminal.os, "killpg") as kill:
            self.assertFalse(instance.signal_group(98765, terminal.signal.SIGTERM))
            kill.assert_not_called()
        with patch.object(instance, "group_members", return_value=[info]), \
             patch.object(terminal, "process_info", return_value=info), \
             patch.object(terminal.os, "killpg"):
            self.assertTrue(instance.signal_group(98765, terminal.signal.SIGTERM))
            self.assertFalse(instance.state()["cleanup_confirmed"])
            self.assertFalse(instance.state()["descendant_containment"])

    def test_native_observation_permission_error_stays_unknown_without_retry(self):
        instance, _ = self.native_fixture()
        with patch.object(instance, "remember_groups", side_effect=PermissionError("fixture denied")) as observe, \
             patch.object(terminal.os, "killpg") as kill:
            self.assertEqual(instance.close()["reason"], "cleanup_unknown")
            self.assertEqual(instance.close()["reason"], "cleanup_unknown")
            self.assertEqual(observe.call_count, 1)
            kill.assert_not_called()

    def test_native_group_refuses_members_in_another_session(self):
        instance, info = self.native_fixture()
        with patch.object(terminal, "process_ids", return_value=[98765]), \
             patch.object(terminal, "process_info", return_value={**info, "session": 55555}), \
             patch.object(terminal.os, "getpgrp", return_value=11111):
            with self.assertRaisesRegex(RuntimeError, "group_identity_changed"):
                instance.group_members(98765)


class ArchiveTests(unittest.TestCase):
    def missing_notice_fixture(self, root, mutation=None, origin="repository"):
        sources = []
        def tar_source(name, kind, entries, **metadata):
            path = root / name
            with tarfile.open(path, "w:gz") as archive:
                for entry, data in entries.items():
                    info = tarfile.TarInfo(("python" if kind == "python" else "package") + "/" + entry)
                    info.size = len(data); archive.addfile(info, io.BytesIO(data))
            sources.append({"name": name, "kind": kind, "limit": 100000,
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **metadata})
            if kind == "npm": sources[-1]["url"] = "https://registry.npmjs.org/" + metadata["package"] + "/-/fixture.tgz"
        tar_source("python.tgz", "python", {"bin/python3.12": b"inert", "LICENSE": b"fixture"})
        for index, package in enumerate(["pnpm", "@deepseek-ai/libreoffice-kit", "@deepseek-ai/libreoffice-kit-darwin-arm64", "@koromix/koffi-darwin-arm64"]):
            metadata = {"name": package, "version": "1.0.0", "license": "MIT"}
            if origin == "parent" and package == "@deepseek-ai/libreoffice-kit":
                metadata["optionalDependencies"] = {"pnpm": "1.0.0"}
            entries = {"package.json": json.dumps(metadata).encode()}
            if package == "pnpm": entries["bin/pnpm.cjs"] = b"inert"
            else: entries["LICENSE"] = b"fixture"
            tar_source(f"npm-{index}.tgz", "npm", entries, package=package, version="1.0.0", dependencies=[])
        notice = b"fixture" if origin == "parent" else b"publisher fixture copyright and permission text"
        digest = hashlib.sha256(notice).hexdigest(); notice_root = root / "notices"; notice_root.mkdir()
        (notice_root / (digest + ".txt")).write_bytes(notice)
        item = {"package": "pnpm@1.0.0", "file": digest + ".txt", "sha256": digest,
                "license_identifier": "MIT", "source_kind": "frozen_repository_license",
                "source_commit": "1" * 40,
                "git_blob_sha1": hashlib.sha1(b"blob " + str(len(notice)).encode() + b"\0" + notice).hexdigest(),
                "source": "https://raw.githubusercontent.com/fixture/runtime/" + "1" * 40 + "/LICENSE"}
        if origin == "parent":
            parent = next(source for source in sources if source.get("package") == "@deepseek-ai/libreoffice-kit")
            item = {key: value for key, value in item.items() if key not in ("source_commit", "git_blob_sha1")}
            item.update(source_kind="same_version_parent_archive_notice", source=parent["url"],
                        source_package="@deepseek-ai/libreoffice-kit@1.0.0", source_archive_pin=parent["sha256"],
                        source_archive_entry="package/LICENSE")
        if mutation: item.update(mutation)
        (notice_root / "sources.json").write_text(json.dumps({"notices": [item]}))
        lock = {"sources": sources, "python_packages": {}, "target": "fixture", "python_version": "fixture"}
        target = root / "output"; outcome = "ACCEPTED"
        with patch.object(runtime, "NOTICES", notice_root, create=True):
            try: runtime.prepare(lock, root, target)
            except ValueError: outcome = "REJECTED"
        return outcome, target, notice, digest

    def test_missing_package_notice_requires_exact_version_hash_and_copies_real_text(self):
        with tempfile.TemporaryDirectory(prefix="qi-notice-unit-") as temporary:
            outcome, target, notice, digest = self.missing_notice_fixture(Path(temporary))
            self.assertEqual(outcome, "ACCEPTED", "a package-bound original notice must satisfy the mandatory text gate")
            record = json.loads((target / "licenses.json").read_text())
            supplied = record["supplemental_notices"]
            self.assertEqual(len(supplied), 1)
            self.assertEqual(supplied[0]["package"], "pnpm@1.0.0")
            copied = target / supplied[0]["path"]
            self.assertEqual(copied.read_bytes(), notice)
            self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(), digest)
            self.assertEqual(copied.stat().st_mode & 0o111, 0)
            self.assertIn(supplied[0]["path"], record["notices"])

    def test_missing_package_notice_rejects_wrong_version_hash_license_or_unsafe_name(self):
        for mutation in [{"package": "pnpm@9.9.9"}, {"sha256": "0" * 64},
                         {"license_identifier": "ISC"}, {"file": "../../outside.txt"}]:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(prefix="qi-notice-unit-") as temporary:
                outcome, target, _, _ = self.missing_notice_fixture(Path(temporary), mutation)
                self.assertEqual(outcome, "REJECTED")
                self.assertFalse((target / "workspace-manifest.json").exists())

    def test_supplemental_notice_rejects_assembled_templates_and_unbound_repository_bytes(self):
        for mutation in [{"source_kind": "assembled-attribution"}, {"source_commit": None},
                         {"source": "https://example.invalid/LICENSE"}, {"git_blob_sha1": "0" * 40}]:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(prefix="qi-notice-unit-") as temporary:
                outcome, target, _, _ = self.missing_notice_fixture(Path(temporary), mutation)
                self.assertEqual(outcome, "REJECTED", "template or unbound bytes cannot satisfy publisher-text gate")
                self.assertFalse((target / "workspace-manifest.json").exists())

    def test_parent_notice_requires_same_version_exact_archive_and_original_text_path(self):
        with tempfile.TemporaryDirectory(prefix="qi-notice-unit-") as temporary:
            outcome, target, notice, _ = self.missing_notice_fixture(Path(temporary), origin="parent")
            self.assertEqual(outcome, "ACCEPTED")
            supplied = json.loads((target / "licenses.json").read_text())["supplemental_notices"][0]
            self.assertEqual((target / supplied["path"]).read_bytes(), notice)
        for mutation in [{"source_package": "@deepseek-ai/libreoffice-kit@9.9.9"},
                         {"source_archive_pin": "0" * 64}, {"source_archive_entry": "package/../../outside"}]:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(prefix="qi-notice-unit-") as temporary:
                outcome, target, _, _ = self.missing_notice_fixture(Path(temporary), mutation, origin="parent")
                self.assertEqual(outcome, "REJECTED")
                self.assertFalse((target / "workspace-manifest.json").exists())

    def wheel_data_fixture(self, root, data_path, data=b"inert-auxiliary-script"):
        wheel = root / "xlsxwriter.whl"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr("xlsxwriter-3.2.9.dist-info/METADATA", "Metadata-Version: 2.4\nName: XlsxWriter\nVersion: 3.2.9\n")
            archive.writestr("xlsxwriter-3.2.9.dist-info/licenses/LICENSE.txt", "fixture")
            archive.writestr(data_path, data)
        target = root / "output"; target.mkdir()
        outcome = "ACCEPTED"
        try:
            runtime.wheel_entries(wheel, runtime.Writer(target))
        except ValueError:
            outcome = "REJECTED"
        return outcome, target

    def test_wheel_auxiliary_script_is_retained_as_inert_data_outside_python_bin_and_imports(self):
        with tempfile.TemporaryDirectory(prefix="qi-wheel-data-unit-") as temporary:
            outcome, target = self.wheel_data_fixture(Path(temporary), "xlsxwriter-3.2.9.data/scripts/vba_extract.py")
            self.assertEqual(outcome, "ACCEPTED", "locked XlsxWriter auxiliary script must be retained without executing or installing it")
            auxiliary = target / "python/share/qi-wheel-data/xlsxwriter-3.2.9/scripts/vba_extract.py"
            self.assertEqual(auxiliary.read_bytes(), b"inert-auxiliary-script")
            self.assertEqual(auxiliary.stat().st_mode & 0o111, 0)
            self.assertFalse((target / "python/bin/vba_extract.py").exists())
            self.assertFalse((target / "python/lib/python3.12/site-packages/vba_extract.py").exists())

    def test_wheel_data_root_must_match_its_distribution_identity(self):
        with tempfile.TemporaryDirectory(prefix="qi-wheel-data-unit-") as temporary:
            outcome, target = self.wheel_data_fixture(Path(temporary), "foreign-9.9.data/purelib/injected.py")
            self.assertEqual(outcome, "REJECTED", "foreign distribution data must not be installed as this wheel's code")
            self.assertFalse((target / "python/lib/python3.12/site-packages/injected.py").exists())

    def test_wheel_auxiliary_script_escape_and_unknown_scheme_are_rejected(self):
        for data_path in ["xlsxwriter-3.2.9.data/scripts/../../outside.py", "xlsxwriter-3.2.9.data/headers/injected.h"]:
            with self.subTest(data_path=data_path), tempfile.TemporaryDirectory(prefix="qi-wheel-data-unit-") as temporary:
                outcome, target = self.wheel_data_fixture(Path(temporary), data_path)
                self.assertEqual(outcome, "REJECTED")
                self.assertFalse((target.parent / "outside.py").exists())

    def test_locked_wheel_identity_and_license_are_accepted_without_install_or_execution(self):
        with tempfile.TemporaryDirectory(prefix="qi-runtime-unit-") as temporary:
            root = Path(temporary)
            sources = []

            def tar_source(name, kind, prefix, entries, **metadata):
                path = root / name
                with tarfile.open(path, "w:gz") as archive:
                    for entry, data in entries.items():
                        info = tarfile.TarInfo(prefix + "/" + entry); info.size = len(data)
                        archive.addfile(info, io.BytesIO(data))
                sources.append({"name": name, "kind": kind, "limit": 100000,
                                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **metadata})

            tar_source("python.tgz", "python", "python", {"bin/python3.12": b"inert-fixture", "LICENSE": b"fixture"})
            for index, package in enumerate(["pnpm", "@deepseek-ai/libreoffice-kit", "@deepseek-ai/libreoffice-kit-darwin-arm64", "@koromix/koffi-darwin-arm64"]):
                entries = {"package.json": json.dumps({"name": package, "version": "1.0.0"}).encode(), "LICENSE": b"fixture"}
                if package == "pnpm": entries["bin/pnpm.cjs"] = b"inert-fixture"
                tar_source(f"npm-{index}.tgz", "npm", "package", entries, package=package, version="1.0.0", dependencies=[])
            wheel = root / "numpy.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("numpy-2.3.5.dist-info/METADATA", "Metadata-Version: 2.4\nName: numpy\nVersion: 2.3.5\n")
                archive.writestr("numpy-2.3.5.dist-info/licenses/LICENSE.txt", "fixture")
            sources.append({"name": wheel.name, "kind": "wheel", "limit": 100000,
                            "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()})
            lock = {"sources": sources, "python_packages": {"numpy": "2.3.5"}, "target": "fixture", "python_version": "fixture"}
            runtime.prepare(lock, root, root / "accepted")
            manifest = json.loads((root / "accepted/workspace-manifest.json").read_text())
            self.assertIn("python/lib/python3.12/site-packages/numpy-2.3.5.dist-info/METADATA", manifest["files"])
            with self.assertRaises(ValueError):
                runtime.prepare({**lock, "python_packages": {"numpy": "9.9.9"}}, root, root / "wrong-version")

    def test_links_are_resolved_inside_the_archive_and_materialized_as_regular_files(self):
        with tempfile.TemporaryDirectory(prefix="qi-runtime-unit-") as temporary:
            root = Path(temporary); archive = root / "source.tgz"
            with tarfile.open(archive, "w:gz") as tar:
                info = tarfile.TarInfo("python/bin/python3.12"); info.size = 7; info.mode = 0o755
                tar.addfile(info, io.BytesIO(b"fixture"))
                alias = tarfile.TarInfo("python/bin/python3"); alias.type = tarfile.SYMTYPE; alias.linkname = "python3.12"
                tar.addfile(alias)
            target = root / "output"; target.mkdir()
            runtime.tar_entries(archive, "python", "python", runtime.Writer(target))
            result = target / "python/bin/python3"
            self.assertEqual(result.read_bytes(), b"fixture"); self.assertFalse(result.is_symlink())

    def test_archive_escape_is_rejected_and_missing_inputs_cannot_build(self):
        with tempfile.TemporaryDirectory(prefix="qi-runtime-unit-") as temporary:
            root = Path(temporary); archive = root / "source.tgz"
            with tarfile.open(archive, "w:gz") as tar:
                info = tarfile.TarInfo("python/../../outside"); info.size = 1
                tar.addfile(info, io.BytesIO(b"x"))
            target = root / "output"; target.mkdir()
            with self.assertRaises(ValueError): runtime.tar_entries(archive, "python", "python", runtime.Writer(target))
            self.assertFalse((root / "outside").exists())
            with self.assertRaises(ValueError): runtime.prepare({"sources": [{"name": "missing", "limit": 100}]}, root, root / "new")
            self.assertFalse((root / "new").exists())


class PnpmPlatformTests(unittest.TestCase):
    def fixture(self, root, mutation=None, omit_target=False):
        package = "@reflink/reflink"
        target_name = package + "-darwin-arm64"
        foreign_name = package + "-darwin-x64"
        parent = {"name": package, "version": "0.1.19", "optionalDependencies": {target_name:"0.1.19", foreign_name:"0.1.19"}}
        children = {target_name:{"name":target_name,"version":"0.1.19","os":["darwin"],"cpu":["arm64"]},
                    foreign_name:{"name":foreign_name,"version":"0.1.19","os":["darwin"],"cpu":["x64"]}}
        if mutation: mutation(parent,children)
        if omit_target: del children[target_name]
        entries = {"package/package.json":json.dumps({"name":"pnpm","version":"11.28.5"}).encode(),
                   "package/LICENSE":b"publisher fixture", "package/bin/pnpm.cjs":b"inert fixture",
                   "package/dist/node_modules/"+package+"/package.json":json.dumps(parent).encode()}
        for name, metadata in children.items():
            prefix = "package/dist/node_modules/" + name
            entries[prefix+"/package.json"] = json.dumps(metadata).encode()
            entries[prefix+"/binding.node"] = b"inert target" if name == target_name else b"inert foreign"
            entries[prefix+"/LICENSE"] = b"publisher fixture"
        path = root / "pnpm.tgz"
        with tarfile.open(path,"w:gz") as archive:
            for name,data in entries.items():
                info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))
        output=root/"output";output.mkdir()
        outcome="ACCEPTED";omitted=[]
        try:
            if hasattr(runtime,"pnpm_entries"):
                omitted=runtime.pnpm_entries(path,runtime.Writer(output),"11.28.5")
            else:
                runtime.tar_entries(path,"package","node_modules/pnpm",runtime.Writer(output))
        except ValueError: outcome="REJECTED"
        return outcome,output,omitted,target_name,foreign_name

    def test_foreign_bundled_optional_native_package_is_not_shipped_but_arm64_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix="qi-pnpm-platform-unit-") as temporary:
            outcome,output,omitted,target,foreign=self.fixture(Path(temporary))
            self.assertEqual(outcome,"ACCEPTED")
            nested=output/"node_modules/pnpm/dist/node_modules"
            self.assertFalse((nested/foreign).exists(),"x64 optional package must not enter an arm64 app")
            self.assertEqual((nested/target/"binding.node").read_bytes(),b"inert target")
            self.assertTrue((nested/target/"LICENSE").is_file())
            self.assertEqual([row["package"] for row in omitted],[foreign])

    def test_omission_requires_parent_exact_optional_dependency_and_valid_child_identity(self):
        changes=[lambda parent,children:parent.update(optionalDependencies={}),
                 lambda parent,children:children["@reflink/reflink-darwin-x64"].update(version="9.9.9"),
                 lambda parent,children:children["@reflink/reflink-darwin-x64"].update(name="foreign"),
                 lambda parent,children:children["@reflink/reflink-darwin-x64"].update(cpu=["!arm64"])]
        for mutation in changes:
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory(prefix="qi-pnpm-platform-unit-") as temporary:
                outcome,_,_,_,_=self.fixture(Path(temporary),mutation)
                self.assertEqual(outcome,"REJECTED","unbound metadata must not authorize pruning")

    def test_required_arm64_optional_package_cannot_be_missing(self):
        with tempfile.TemporaryDirectory(prefix="qi-pnpm-platform-unit-") as temporary:
            outcome,_,_,_,_=self.fixture(Path(temporary),omit_target=True)
            self.assertEqual(outcome,"REJECTED","a foreign-only archive is not a complete arm64 runtime")


if __name__ == "__main__": unittest.main()

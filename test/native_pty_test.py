"""Opt-in REAL macOS PTY component tests, never part of the ordinary unit suite.

Uses the pinned portable Python component and unchanged production Seatbelt
profile. No fake desktop manifest or host-Python product fallback. Only fixed
synthetic commands in new private fixtures; fail fast on any failure/denial.
Detached fixture descendants release themselves or expire after six seconds.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import subprocess
import tempfile
import time
import unittest
import uuid
from pty_receipt import cleanup_receipt_matches

REPO = Path(__file__).resolve().parents[1]
PYTHON_PIN = "2d96eb826dc74db4fcd5da6dde045a6fa145e292e07e69d1bdd1a19fa90ffc22"
PYTHON = Path(os.environ["QI_PTY_TEST_PYTHON"])
FIXTURES = Path(os.environ["QI_PTY_TEST_ROOT"])
BB = Path(os.environ["QI_PTY_TEST_BB"])
assert PYTHON.resolve() == PYTHON and hashlib.sha256(PYTHON.read_bytes()).hexdigest() == PYTHON_PIN
assert not FIXTURES.exists() and FIXTURES.is_absolute()
FIXTURES.mkdir(mode=0o700)
spec = importlib.util.spec_from_file_location("native_pty_component", REPO / "src/qi/terminal_helper.py")
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
profile_source = (REPO / "src/qi/plugins/execution_world.clj").read_text()
block = profile_source.split("(def ^:private seatbelt-profile", 1)[1].split("(defn- real-path", 1)[0]
PROFILE = "".join(json.loads(s) for s in re.findall(r'"(?:[^"\\]|\\.)*"', block))
PROFILE += '\n(allow file-read* (subpath (param "RUNTIME")))\n'
EVIDENCE = {"scope": "real PTY/guardian with portable Python and unchanged Seatbelt; component only, not full App/resolver/model/LCU",
            "python": str(PYTHON), "python_sha256": PYTHON_PIN,
            "profile_sha256": hashlib.sha256(PROFILE.encode()).hexdigest(), "sessions": [], "accepted_limitations": []}


class Session:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="session-", dir=FIXTURES))
        self.buffer = bytearray(); self.cursor = 0; self.output = ""; self.final = None; self.unknown = False
        self.identity = None; self.finished = False; self.finish_attempted = False
        script = self.root / "terminal_helper.py"; script.write_bytes((REPO / "src/qi/terminal_helper.py").read_bytes())
        for name in ["home", "tmp"]: (self.root / name).mkdir(mode=0o700)
        self.record = {"root": str(self.root), "helper_sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "events": []}
        command = ["/usr/bin/sandbox-exec", "-D", f"WORKSPACE={self.root}", "-D", f"RUNTIME={PYTHON.parents[1]}",
                   "-p", PROFILE, str(PYTHON), "-I", "-B", str(script), "--parent", str(os.getpid()),
                   "--root", str(self.root), "--cleanup-mode", "native-process-group"]
        env = {"HOME": str(self.root / "home"), "TMPDIR": str(self.root / "tmp"), "LANG": "en_US.UTF-8",
               "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "xterm-256color", "HISTFILE": "/dev/null",
               "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        self.record["command"] = command
        self.record["environment"] = env
        self.stderr = (self.root / "guardian.stderr").open("xb")
        self.process = subprocess.Popen(command, cwd=self.root, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.stderr)
        self.record["guardian_pid"] = self.process.pid; EVIDENCE["sessions"].append(self.record)

    def line(self):
        end = time.monotonic() + 5
        while b"\n" not in self.buffer:
            with selectors.DefaultSelector() as poll:
                poll.register(self.process.stdout, selectors.EVENT_READ)
                if not poll.select(max(0, end - time.monotonic())):
                    self.unknown = True; raise RuntimeError("native_pty_response_timeout_UNKNOWN")
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                self.unknown = True
                raise RuntimeError(f"native_pty_channel_closed_exit_{self.process.poll()}; see {self.root / 'guardian.stderr'}")
            self.buffer.extend(data)
            if len(self.buffer) > 524288: raise RuntimeError("native_response_limit")
        raw, _, self.buffer = self.buffer.partition(b"\n")
        return json.loads(raw)

    def call(self, op, **args):
        request = {"id": str(uuid.uuid4()), "op": op, **args}
        try:
            self.process.stdin.write((json.dumps(request) + "\n").encode()); self.process.stdin.flush()
        except OSError:
            self.unknown = True
            raise
        while True:
            value = self.line()
            if value.get("event") == "terminal.closed":
                self.final = value["result"]; continue
            if value.get("id") != request["id"]: raise RuntimeError("response_identity_changed")
            result = value["result"]
            if op == "open" and value["ok"]:
                self.identity = {k: result[k] for k in ("generation", "child_pid", "guardian_pid")}
                if result["guardian_pid"] != self.process.pid:
                    self.unknown = True
                    raise RuntimeError("guardian_identity_changed")
            self.record["events"].append({"op": op, **{k: v for k, v in result.items() if k != "output"},
                                           "output_chars": len(result.get("output", ""))})
            if not value["ok"] or result["status"] == "unknown":
                self.unknown = True; raise RuntimeError("native_operation_failed_" + str(result))
            return result

    def read_until(self, predicate, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.call("read", since=self.cursor)
            self.cursor = value["cursor"]; self.output += value["output"]
            if predicate(value): return value
            time.sleep(0.025)
        raise AssertionError("fixture observation deadline; no input was replayed")

    def finish(self):
        # Every path, including an already exited guardian, must verify the
        # final same-generation receipt and exit, never silently pass cleanup.
        if self.finish_attempted: raise RuntimeError("finalization_UNKNOWN_no_retry")
        self.finish_attempted = True
        tail = self.process.stdout.read(524289)
        if len(tail) + len(self.buffer) > 524288:
            raise RuntimeError("final_receipt_limit")
        self.buffer.extend(tail)
        for raw in self.buffer.splitlines():
            value = json.loads(raw)
            if value.get("event") == "terminal.closed": self.final = value["result"]
        self.buffer.clear(); self.stderr.close()
        raw = (self.root / "guardian.stderr").read_bytes()
        self.record.update(guardian_exit=self.process.returncode, stderr_bytes=len(raw), stderr_sha256=hashlib.sha256(raw).hexdigest())
        if not cleanup_receipt_matches(self.final, self.identity, self.process.returncode):
            self.unknown = True; self.record["outcome"] = "CLEANUP_RECEIPT_UNKNOWN"
            raise RuntimeError("cleanup_receipt_or_exit_UNKNOWN")
        for group in self.final["registered_groups"]:
            try: os.killpg(group, 0)
            except ProcessLookupError: continue
            except OSError:
                self.unknown = True; self.record["outcome"] = "INDEPENDENT_GROUP_OBSERVATION_UNKNOWN"
                raise
            self.unknown = True
            raise RuntimeError("independent_group_absence_not_observed")
        self.finished = True; self.record["outcome"] = "CLEANUP_OBSERVED_COMPONENT_ONLY"
        return self.final

    def stop(self):
        if self.finished: return self.final
        if self.process.poll() is None:
            try:
                if not self.unknown: self.final = self.call("close")
            finally:
                self.process.stdin.close()  # EOF never repeats input or signals.
            try: self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.unknown = True; self.record["outcome"] = "UNKNOWN_RETAINED"
                raise RuntimeError("owned_guardian_exit_UNKNOWN_no_force_kill")
        return self.finish()


class NativePTY(unittest.TestCase):
    def session(self):
        session = Session(); self.addCleanup(session.stop)
        value = session.call("open", cols=90, rows=24)
        self.assertEqual(value["cleanup_scope"], "registered-process-groups")
        self.assertFalse(value["descendant_containment"])
        self.assertEqual(value["registered_groups"], [value["child_pid"]])
        return session

    def test_00_real_input_output_and_resize(self):
        session = self.session()
        session.call("resize", cols=101, rows=31)
        session.call("input", text="stty size; printf '\\161\\151-\\345\\256\\236\\346\\265\\213\\n'\n")
        session.read_until(lambda _: "31 101" in session.output and "qi-实测" in session.output)
        result = session.stop()
        self.assertTrue(result["cleanup_confirmed"]); self.assertTrue(result["shell_exit_observed"])
        self.assertEqual(session.stop(), result)

    def test_01_interrupt_targets_foreground_job_group(self):
        session = self.session()
        session.call("input", text="/bin/sleep 8\n")
        state = session.read_until(lambda v: len(v["registered_groups"]) >= 2)
        result = session.call("interrupt")
        self.assertTrue(result["last_interrupt"]["delivered"])
        self.assertNotEqual(result["last_interrupt"]["group"], state["child_pid"])
        session.call("input", text="printf '\\161\\151-interrupt-ok\\n'\n")
        session.read_until(lambda _: "qi-interrupt-ok" in session.output)

    def test_02_close_background_job_and_preserve_other_session(self):
        first, second = self.session(), self.session()
        first.call("input", text="/bin/sleep 8 &\n")
        first.read_until(lambda v: len(v["registered_groups"]) >= 2)
        self.assertTrue(first.stop()["cleanup_observed"])
        second.call("input", text="printf '\\161\\151-other-session-alive\\n'\n")
        second.read_until(lambda _: "qi-other-session-alive" in second.output)
        self.assertNotEqual(first.record["guardian_pid"], second.record["guardian_pid"])

    def test_03_natural_abnormal_exit_preserves_more_than_64k_final_output(self):
        session = self.session()
        session.call("input", text="printf '%0200000d' 0; exit 7\n")
        time.sleep(0.4)
        value = session.read_until(lambda v: v["status"] == "closed" and not v["has_more"])
        self.assertEqual(value["exit_code"], 7)
        self.assertIn("0" * 200000, session.output)
        self.assertTrue(value["cleanup_observed"])
        self.assertTrue(any(e.get("has_more") for e in session.record["events"]))

    def test_04_killed_shell_is_observed_without_mistaking_signal_delivery_for_cleanup(self):
        session = self.session()
        session.call("input", text="kill -KILL $$\n")
        value = session.read_until(lambda v: v["status"] == "closed")
        self.assertEqual(value["exit_code"], -9)
        self.assertTrue(value["shell_exit_observed"]); self.assertTrue(value["cleanup_observed"])

    def test_05_original_file_and_network_sandbox_is_preserved(self):
        session = self.session()
        outside = FIXTURES / ("outside-" + uuid.uuid4().hex); outside.write_text("outside-fixture-secret")
        outside_write = FIXTURES / ("write-" + uuid.uuid4().hex)
        code = "import socket\ns=socket.socket();s.settimeout(.2)\ntry:s.connect(('127.0.0.1',9));print('NETWORK_ALLOWED')\nexcept PermissionError:print('NETWORK_DENIED')\nexcept OSError:print('NETWORK_NOT_PROVEN_DENIED')"
        session.call("input", text=f"cat {shlex.quote(str(outside))}; echo denied > {shlex.quote(str(outside_write))}; {shlex.quote(str(PYTHON))} -I -c {shlex.quote(code)}\n")
        session.read_until(lambda _: "NETWORK_DENIED\r\n" in session.output or "NETWORK_NOT_PROVEN_DENIED\r\n" in session.output)
        self.assertNotIn("outside-fixture-secret", session.output)
        self.assertFalse(outside_write.exists())
        self.assertNotIn("NETWORK_NOT_PROVEN_DENIED\r\n", session.output)

    def test_06_detached_descendant_is_an_explicitly_accepted_limitation(self):
        session = self.session()
        code = """import os,signal,time,json
pid=os.fork()
if pid==0:
 os.setsid()
 if os.fork()==0:
  signal.alarm(6)
  for fd in (0,1,2): os.close(fd)
  with open('escape.json.tmp','x') as f:
   json.dump({'pid':os.getpid()},f);f.flush();os.fsync(f.fileno())
  os.rename('escape.json.tmp','escape.json')
  while not os.path.exists('release-escape'): time.sleep(.02)
  os._exit(0)
 os._exit(0)
os.waitpid(pid,0)
"""
        script = session.root / "detached.py"; script.write_text(code)
        session.call("input", text=f"{shlex.quote(str(PYTHON))} -I -B detached.py\n")
        deadline = time.monotonic() + 2
        while not (session.root / "escape.json").exists() and time.monotonic() < deadline: time.sleep(.02)
        escaped = json.loads((session.root / "escape.json").read_text())["pid"]
        before = helper.process_info(escaped); self.assertIsNotNone(before)
        result = session.stop()
        try:
            after = helper.process_info(escaped)
            self.assertIsNotNone(after); self.assertEqual(after["identity"], before["identity"])
            self.assertNotEqual(after["session"], result["child_pid"])
            self.assertTrue(result["cleanup_confirmed"]); self.assertFalse(result["descendant_containment"])
            EVIDENCE["accepted_limitations"].append({"kind": "double-fork-setsid", "escaped_pid": escaped,
                                                     "survived_registered_group_cleanup": True})
        finally: (session.root / "release-escape").write_text("release")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            info = helper.process_info(escaped)
            if info is None or info["zombie"]: break
            time.sleep(.025)
        else: self.fail("owned detached fixture did not self-release; six-second alarm remains")

    def test_07_real_transport_rpc_cancel_before_admission(self):
        root = Path(tempfile.mkdtemp(prefix="rpc-", dir=FIXTURES))
        script = root / "terminal_helper.py"; script.write_bytes((REPO / "src/qi/terminal_helper.py").read_bytes())
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root), "TMPDIR": str(root),
               "QI_PTY_COMPONENT_ROOT": str(root), "QI_PTY_TEST_PYTHON": str(PYTHON),
               "LANG": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
        with (root / "rpc.stdout").open("xb") as stdout, (root / "rpc.stderr").open("xb") as stderr:
            child = subprocess.Popen([str(BB), "-cp", "src:test", "test/qi/native_terminal_fixture.clj"],
                                     cwd=REPO, env=env, stdout=stdout, stderr=stderr)
            EVIDENCE["rpc_process"] = {"pid": child.pid, "root": str(root), "status": "RUNNING"}
            try: code = child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                EVIDENCE["rpc_process"]["status"] = "UNKNOWN_RETAINED"
                raise
            EVIDENCE["rpc_process"].update(status="EXITED", exit_code=code)
        self.assertEqual(code, 0, f"real RPC fixture failed: {root}")
        receipt = json.loads((root / "result.json").read_text())
        self.assertEqual(receipt["status"], "REAL_COMPONENT_RPC_PASS")
        self.assertEqual(receipt["cancelled_before_admission"], True)
        EVIDENCE["rpc"] = receipt


if __name__ == "__main__":
    try: unittest.main(failfast=True)
    finally: (FIXTURES / "evidence.json").write_text(json.dumps(EVIDENCE, indent=2) + "\n")

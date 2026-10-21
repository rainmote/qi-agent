"""Private JSON-lines PTY guardian; invoked only by ExecutionWorld.

No socket, credential discovery, login files or arbitrary executable argument.
The guardian owns a separate session so worker-group shutdown leaves it alive
long enough to observe parent death and close the terminal's owned processes.
"""
import collections
import codecs
import errno
import fcntl
import hashlib
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time
import uuid

MAX_BUFFER = 262144
MAX_INPUT = 16384
MAX_REQUEST = 131072


def descendant_containment_available():
    # A session/process group and periodic ps snapshots miss a double-forked
    # setsid descendant. macOS NOTE_TRACK has been unsupported since 10.5.
    # Until an independently reviewed containment adapter can prove ownership
    # and teardown, never start a shell or claim all its descendants exited.
    # No environment variable or user/model argument can override this gate.
    return False


def validate(request):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        raise ValueError("invalid request identity")
    uuid.UUID(request["id"])
    op = request.get("op")
    fields = {"open": {"cols", "rows"}, "read": {"since"}, "input": {"text"},
              "resize": {"cols", "rows"}, "interrupt": set(), "close": set()}
    if op not in fields or set(request) != fields[op] | {"id", "op"}:
        raise ValueError("invalid terminal request")
    if op in ("open", "resize"):
        if not all(type(request[key]) is int and 2 <= request[key] <= 300 for key in ("cols", "rows")):
            raise ValueError("invalid terminal geometry")
    if op == "input" and (not isinstance(request["text"], str) or len(request["text"].encode()) > MAX_INPUT):
        raise ValueError("terminal input limit")
    if op == "read" and (type(request["since"]) is not int or not 0 <= request["since"] <= 2 ** 53):
        raise ValueError("invalid output cursor")
    return request


class Output:
    def __init__(self):
        self.buffer = bytearray()
        self.base = 0

    def append(self, data):
        self.buffer.extend(data)
        extra = max(0, len(self.buffer) - MAX_BUFFER)
        if extra:
            del self.buffer[:extra]
            self.base += extra

    def read(self, since):
        end = self.base + len(self.buffer)
        if since > end:
            raise ValueError("output cursor is ahead of terminal")
        start = max(since, self.base)
        chunk = self.buffer[start - self.base:start - self.base + 65536]
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        text = decoder.decode(bytes(chunk), final=False)
        pending, _ = decoder.getstate()
        return {"output": text, "cursor": start + len(chunk) - len(pending),
                "truncated": since < self.base}


def census():
    # Numeric identities/start times only; never command lines or environments.
    result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,lstart="],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=0.5)
    if result.returncode or len(result.stdout) > 4000000:
        raise RuntimeError("process_census_unavailable")
    rows = {}
    for line in result.stdout.decode("ascii", "strict").splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5 or not all(value.isdigit() for value in fields[:4]):
            raise RuntimeError("process_census_invalid")
        if int(fields[3]) == os.getuid():
            rows[int(fields[0])] = (int(fields[1]), int(fields[2]), fields[4])
    if len(rows) > 100000:
        raise RuntimeError("process_census_limit")
    return rows


class Terminal:
    def __init__(self, root, parent):
        self.root, self.parent = root, parent
        self.pid = None
        self.master = None
        self.output = Output()
        self.known = {}
        self.started = self.last_input = time.monotonic()
        self.closed = False
        self.cleanup = False
        self.exit_code = None
        self.reason = None

    def parent_alive(self):
        return os.getppid() == self.parent

    def start(self, cols, rows):
        if not descendant_containment_available():
            raise RuntimeError("terminal_descendant_containment_unavailable")
        if not self.parent_alive():
            raise RuntimeError("parent_changed")
        census()  # Fail before forking any shell when ownership cannot be read.
        read_exec, write_exec = os.pipe()
        try:
            self.pid, self.master = pty.fork()
            if self.pid == 0:
                os.close(read_exec)
                try:
                    os.chdir(self.root)
                    os.execve("/bin/bash", ["/bin/bash", "--noprofile", "--norc", "-i"], dict(os.environ))
                except BaseException:
                    os.write(write_exec, b"exec_failed")
                    os._exit(126)
            os.close(write_exec)
            write_exec = None
            os.set_blocking(self.master, False)
            self.resize(cols, rows)
            with selectors.DefaultSelector() as poll:
                poll.register(read_exec, selectors.EVENT_READ)
                if not poll.select(2) or os.read(read_exec, 128):
                    raise RuntimeError("terminal_exec_unconfirmed")
            if not self.parent_alive():
                raise RuntimeError("parent_changed")
            self.remember()
        finally:
            os.close(read_exec)
            if write_exec is not None:
                os.close(write_exec)

    def remember(self):
        rows = census()
        selected = {self.pid}
        changed = True
        while changed:
            changed = False
            for pid, (parent, _, identity) in rows.items():
                if parent in selected and pid not in selected:
                    selected.add(pid)
                    changed = True
                if pid in self.known and self.known[pid] == identity:
                    selected.add(pid)
        for pid, (_, _, identity) in rows.items():
            try:
                owned = pid in selected or os.getsid(pid) == self.pid
            except ProcessLookupError:
                owned = pid in selected
            if owned and pid != os.getpid():
                self.known[pid] = identity
        return rows

    def resize(self, cols, rows):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def drain(self):
        if self.master is None:
            return False
        for _ in range(32):
            try:
                data = os.read(self.master, 8192)
                if not data:
                    return False
                self.output.append(data)
            except BlockingIOError:
                return True
            except OSError as error:
                if error.errno == errno.EIO:
                    return False
                raise
        return True

    def close(self, reason="closed"):
        if self.cleanup or self.reason == "cleanup_unknown":
            return self.state()
        self.reason = reason
        if self.pid is None:
            self.closed = self.cleanup = True
            return self.state()
        try:
            # Keep the shell PID reserved until after signals/ownership checks;
            # never infer disappearance from permission errors or a timeout.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                rows = self.remember()
                for pid, identity in list(self.known.items()):
                    if pid in rows and rows[pid][2] == identity:
                        try:
                            os.kill(pid, sig)
                        except ProcessLookupError:
                            pass
                time.sleep(0.1)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                self.drain()
                if self.exit_code is None:
                    waited, status = os.waitpid(self.pid, os.WNOHANG)
                    if waited:
                        self.exit_code = os.waitstatus_to_exitcode(status)
                rows = self.remember()
                remaining = [pid for pid, identity in self.known.items() if pid in rows and rows[pid][2] == identity]
                if not remaining:
                    if descendant_containment_available():
                        self.cleanup = self.closed = True
                    break
                time.sleep(0.05)
        except (OSError, RuntimeError, subprocess.SubprocessError):
            self.reason = "cleanup_unknown"
        if not self.cleanup:
            self.reason = "cleanup_unknown"
        if self.master is not None:
            os.close(self.master)
            self.master = None
        return self.state()

    def state(self):
        return {"status": "closed" if self.cleanup else "unknown" if self.reason else "running",
                "cleanup_confirmed": self.cleanup, "child_pid": self.pid, "guardian_pid": os.getpid(),
                "exit_code": self.exit_code, "reason": self.reason}

    def request(self, request):
        op = request["op"]
        if op == "close":
            return self.close()
        if self.reason or self.closed:
            raise RuntimeError("terminal_closed_or_unknown")
        if op == "open":
            if self.pid is not None:
                raise RuntimeError("terminal_already_started")
            self.start(request["cols"], request["rows"])
        elif self.pid is None:
            raise RuntimeError("terminal_not_started")
        elif op == "input":
            data = request["text"].encode()
            # A partial write is an unknown input outcome; never retry it.
            if os.write(self.master, data) != len(data):
                raise RuntimeError("terminal_input_unknown")
            self.last_input = time.monotonic()
        elif op == "resize":
            self.resize(request["cols"], request["rows"])
        elif op == "interrupt":
            group = os.tcgetpgrp(self.master)
            if os.getsid(group) != self.pid:
                raise RuntimeError("foreground_identity_unknown")
            os.killpg(group, signal.SIGINT)
        self.drain()
        return {**self.state(), **(self.output.read(request["since"]) if op == "read" else {})}


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main(root, parent):
    if not os.path.isabs(root) or os.path.realpath(root) != root or os.getppid() != parent:
        raise RuntimeError("invalid_terminal_owner")
    os.setsid()
    terminal = Terminal(root, parent)
    stopping = [False]
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.__setitem__(0, True))
    requests = bytearray()
    ledger = collections.OrderedDict()
    os.set_blocking(0, False)
    try:
        while terminal.parent_alive() and not stopping[0]:
            if time.monotonic() - terminal.started > 3600 or time.monotonic() - terminal.last_input > 900:
                terminal.close("terminal_deadline")
                break
            with selectors.DefaultSelector() as poll:
                poll.register(0, selectors.EVENT_READ)
                if terminal.master is not None:
                    poll.register(terminal.master, selectors.EVENT_READ)
                for key, _ in poll.select(0.05):
                    if key.fd == 0:
                        data = os.read(0, MAX_REQUEST + 1)
                        if not data:
                            stopping[0] = True
                            break
                        requests.extend(data)
                        if len(requests) > MAX_REQUEST:
                            raise ValueError("terminal_protocol_limit")
                    else:
                        if not terminal.drain():
                            terminal.close("terminal_exited")
                            stopping[0] = True
                            break
            while b"\n" in requests:
                raw, _, requests = requests.partition(b"\n")
                request = validate(json.loads(raw))
                fingerprint = hashlib.sha256(raw).hexdigest()
                previous = ledger.get(request["id"])
                if previous:
                    if previous[0] != fingerprint:
                        raise ValueError("terminal_request_id_reused")
                    emit(previous[1])
                    continue
                if len(ledger) >= 4096:
                    raise ValueError("terminal_request_ledger_limit")
                try:
                    value = {"id": request["id"], "ok": True, "result": terminal.request(request)}
                except Exception:
                    terminal.close("terminal_operation_unknown")
                    value = {"id": request["id"], "ok": False, "error": "terminal_operation_failed", "result": terminal.state()}
                if request["op"] != "read":
                    ledger[request["id"]] = (fingerprint, value)
                emit(value)
                if terminal.closed or terminal.reason:
                    stopping[0] = True
                    break
    finally:
        terminal.close("parent_or_control_closed")
        try:
            emit({"event": "terminal.closed", "result": terminal.state()})
        except (OSError, BrokenPipeError):
            pass
        # UNKNOWN never becomes an ordinary successful exit or a new shell.
        if not terminal.cleanup:
            # The registered guardian itself remains as a live quarantine
            # identity after parent death. Do not disappear behind the native
            # cleanup check while owned process observations remain unknown.
            while True:
                time.sleep(1)


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "--parent" or sys.argv[3] != "--root":
        raise SystemExit("invalid terminal invocation")
    main(sys.argv[4], int(sys.argv[2]))

"""Private JSON-lines PTY guardian; invoked only by ExecutionWorld.

No socket, credential discovery, login files or arbitrary executable argument.
The trusted native guardian allocates only its own PTY outside the command
Seatbelt. Its fixed bootstrap and shell retain the original file/network policy
and add only an explicit owned-TTY ioctl rule before ready.
It owns a separate session so worker-group shutdown leaves it alive long enough
to close registered terminal groups. Native mode is best effort:
detached descendants are outside its cleanup promise; strict mode stays closed.
"""
import collections
import codecs
import ctypes
import errno
import fcntl
import functools
import hashlib
import json
import os
import pty
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import termios
import time
import uuid

MAX_BUFFER = 262144
MAX_INPUT = 16384
MAX_REQUEST = 131072
MAX_PROCESSES = 4096
MAX_GROUPS = 256
MAX_READY = 4096
LAUNCH_TIMEOUT = 1.5
# Original ExecutionWorld policy plus its unchanged payload read-only grant.
# A policy change requires explicit source review, never an RPC/env override.
NATIVE_PROFILE_SHA256 = "22c5ff30de2a60a7a27f673c1af67a4aa08a182328c3409a901417c59a82d6c3"
# Darwin arm64 SDK ttycom.h/termios.h. No model/RPC-selected operation or path.
TTY_IOCTL_COMMANDS = (0x40487413, 0x4004741a, 0x40087468, 0x40047477, 0x80047476,
                      0x80487414, 0x80487415, 0x80487416, 0x2000745e)
TTY_IOCTL_PROFILE = ('\n(allow file-ioctl\n  (require-all (literal (param "TTY"))\n    (require-any\n'
                     + ''.join(f'      (ioctl-command #x{command:08x})\n' for command in TTY_IOCTL_COMMANDS)
                     + '    )))\n')
TIOCPTYGNAME = 0x40807453  # _IOC(IOC_OUT, 't', 83, 128), master only.


def owned_tty_identity(fd, master=False):
    opened = os.fstat(fd)
    if master:
        path = fcntl.ioctl(fd, TIOCPTYGNAME, bytes(128)).split(b'\0', 1)[0].decode('ascii')
    else:
        path = os.ttyname(fd)
    if not re.fullmatch(r'/dev/ttys[0-9]{3,6}', path) or os.path.realpath(path) != path:
        raise ValueError('owned_tty_path_changed')
    device = os.lstat(path)
    if (not stat.S_ISCHR(opened.st_mode) or not stat.S_ISCHR(device.st_mode)
            or device.st_uid != os.getuid()
            or (not master and (opened.st_dev, opened.st_ino, opened.st_rdev)
                != (device.st_dev, device.st_ino, device.st_rdev))):
        raise ValueError('owned_tty_device_changed')
    return {'path': path, 'rdev': device.st_rdev}


def native_config(root, runtime_root, profile):
    if not isinstance(profile, str) or hashlib.sha256(profile.encode()).hexdigest() != NATIVE_PROFILE_SHA256:
        raise ValueError("native_profile_changed")
    for path in (root, runtime_root):
        if not isinstance(path, str) or not os.path.isabs(path) or os.path.realpath(path) != path or not os.path.isdir(path):
            raise ValueError("native_runtime_or_root_invalid")
    python, helper = os.path.abspath(sys.executable), os.path.abspath(__file__)
    if (os.path.realpath(python) != python or os.path.realpath(helper) != helper
            or os.path.commonpath((runtime_root, python)) != runtime_root):
        raise ValueError("native_runtime_identity_changed")
    # Production callers supply sealed payload assets. Component tests bind a
    # byte-identical helper copy explicitly; no helper path exists in JSON.
    return {"root": root, "runtime": runtime_root, "profile": profile, "python": python, "helper": helper}


def sandbox_shell_command(config, parent, ack_fd, nonce, tty):
    return ["/usr/bin/sandbox-exec", "-D", "WORKSPACE=" + config["root"],
            "-D", "RUNTIME=" + config["runtime"], "-D", "TTY=" + tty['path'],
            "-p", config["profile"] + TTY_IOCTL_PROFILE,
            config["python"], "-I", "-B", config["helper"], "--sandbox-shell",
            "--parent", str(parent), "--ack-fd", str(ack_fd), "--ack-nonce", nonce]


def close_unrelated_fds(keep):
    for name in os.listdir("/dev/fd"):
        fd = int(name)
        if fd > 2 and fd not in keep:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise


def restore_child_signals():
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGPIPE):
        signal.signal(sig, signal.SIG_DFL)


def child_failure(fd, nonce, stage, error):
    packet = {"ready": False, "error": "sandbox_shell_failed", "pid": os.getpid(),
              "parent": os.getppid(), "nonce": nonce, "stage": stage, "errno": getattr(error, "errno", None)}
    try:
        os.write(fd, (json.dumps(packet) + "\n").encode())
    except OSError:
        pass
    os._exit(126)


def validate_ready(raw, expected):
    if not raw or len(raw) > MAX_READY:
        raise RuntimeError("sandbox_ready_unconfirmed")
    packets = [json.loads(line) for line in raw.splitlines()]
    if packets and isinstance(packets[-1], dict):
        failed = packets[-1]
        if (failed.get("error") == "sandbox_shell_failed"
                and all(failed.get(k) == expected[k] for k in ('pid', 'parent', 'nonce'))
                and failed.get("stage") in ("sandbox-exec", "sandbox-shell-exec")):
            error = OSError(failed.get("errno") or errno.EIO, "sandbox_shell_failed")
            error.qi_failure_stage = failed["stage"]
            raise error
    if len(packets) != 1 or not isinstance(packets[0], dict):
        raise ValueError("sandbox_ready_channel_changed")
    value = packets[0]
    if (set(value) != {"ready", "pid", "parent", "session", "group", "nonce", "tty_path", "tty_rdev"} or value["ready"] is not True
            or not all(value.get(k) == v for k, v in expected.items())
            or any(type(value.get(k)) is not int for k in ("pid", "parent", "session", "group", "tty_rdev"))
            or value["session"] != expected["pid"] or value["group"] != expected["pid"]):
        raise ValueError("sandbox_ready_identity_changed")
    return value


def sandbox_shell(parent, ack_fd, nonce):
    try:
        if (parent <= 1 or os.getppid() != parent or ack_fd < 3
                or str(uuid.UUID(nonce)) != nonce or os.getsid(0) != os.getpid() or os.getpgrp() != os.getpid()
                or not stat.S_ISFIFO(os.fstat(ack_fd).st_mode)
                or fcntl.fcntl(ack_fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_WRONLY):
            raise RuntimeError("sandbox_shell_identity_changed")
        close_unrelated_fds({ack_fd})
        tty = owned_tty_identity(0)
        if any(owned_tty_identity(fd) != tty for fd in (1, 2)):
            raise RuntimeError('terminal_stdio_identity_changed')
        value = {"ready": True, "pid": os.getpid(), "parent": parent,
                 "session": os.getsid(0), "group": os.getpgrp(), "nonce": nonce,
                 "tty_path": tty['path'], "tty_rdev": tty['rdev']}
        raw = (json.dumps(value) + "\n").encode()
        if os.write(ack_fd, raw) != len(raw):
            raise RuntimeError("sandbox_ready_write_unknown")
        os.set_inheritable(ack_fd, False)  # Closed only by successful bash exec.
        restore_child_signals()
        os.execve("/bin/bash", ["/bin/bash", "--noprofile", "--norc", "-i"], dict(os.environ))
    except BaseException as error:
        child_failure(ack_fd, nonce, "sandbox-shell-exec", error)


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

    def read(self, since, final=False):
        end = self.base + len(self.buffer)
        if since > end:
            raise ValueError("output cursor is ahead of terminal")
        start = max(since, self.base)
        chunk = self.buffer[start - self.base:start - self.base + 65536]
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        text = decoder.decode(bytes(chunk), final=final and start + len(chunk) == end)
        pending, _ = decoder.getstate()
        cursor = start + len(chunk) - len(pending)
        return {"output": text, "cursor": cursor, "end": end, "has_more": cursor < end,
                "truncated": since < self.base}


class BsdInfo(ctypes.Structure):
    # macOS SDK sys/proc_info.h PROC_PIDTBSDINFO. Names are never exported.
    _fields_ = [(name, ctypes.c_uint32) for name in
                ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")] + [
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ("nfiles", "pgid", "jobc", "tty", "foreground")] + [
        ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]


@functools.cache
def native_library():
    if sys.platform != "darwin":
        raise RuntimeError("native_process_group_requires_macos")
    try:
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    except OSError as error:
        error.qi_failure_stage = "native-library-load"
        raise
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    for name in ("proc_listchildpids", "proc_listpgrppids"):
        getattr(library, name).argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        getattr(library, name).restype = ctypes.c_int
    return library


def process_info(pid):
    info = BsdInfo()
    ctypes.set_errno(0)
    count = native_library().proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if count != ctypes.sizeof(info):
        error = ctypes.get_errno()
        if error == errno.ESRCH:
            return None
        raise OSError(error or errno.EIO, "process_identity_unavailable")
    try:
        session = os.getsid(pid)
    except ProcessLookupError:
        return None
    return {"pid": info.pid, "parent": info.ppid, "group": info.pgid, "session": session,
            "identity": (info.uid, info.start_sec, info.start_usec), "zombie": info.status == 5}


def process_ids(kind, owner):
    values = (ctypes.c_int * MAX_PROCESSES)()
    ctypes.set_errno(0)
    count = getattr(native_library(), kind)(owner, values, ctypes.sizeof(values))
    error = ctypes.get_errno()
    if count < 0 or (not count and error):
        if error == errno.ESRCH:
            return []
        raise OSError(error or errno.EIO, "process_members_unavailable")
    if count >= MAX_PROCESSES:
        raise RuntimeError("native_registry_limit")
    return [pid for pid in values[:count] if pid > 0]


def census():
    # Preflight reads only the guardian's own identity, not a host-wide ps scan.
    value = process_info(os.getpid())
    if value is None:
        raise RuntimeError("guardian_identity_unavailable")
    return {value["pid"]: (value["parent"], value["group"], value["identity"])}


class Terminal:
    def __init__(self, root, parent, cleanup_mode="strict", profile=None, runtime_root=None):
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
        self.cleanup_mode = cleanup_mode
        self.generation = str(uuid.uuid4())
        self.shell_identity = None
        self.groups = set()
        self.observed = {}
        self.detached = set()
        self.reaped = False
        self.termination = None
        self.last_interrupt = None
        self.failure_code = None
        self.failure_errno = None
        self.failure_stage = None
        self.failure_trace = []
        self.operation_stage = "not-started"
        self.profile, self.runtime_root = profile, runtime_root
        self.sandbox_ready = False
        self.fork_owned = False
        self.gate_release_attempted = False
        self.startup_aborted = False
        self.tty_identity = None
        self.command_profile_sha256 = None

    def record_failure(self, error, stage):
        # Retain the first cause even when subsequent cleanup also fails.
        if self.failure_code is None:
            self.failure_code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            self.failure_errno = getattr(error, "errno", None)
            self.failure_stage = getattr(error, "qi_failure_stage", stage)
            frame = error.__traceback__
            while frame is not None:
                self.failure_trace.append({"function": frame.tb_frame.f_code.co_name, "line": frame.tb_lineno})
                self.failure_trace = self.failure_trace[-8:]
                frame = frame.tb_next

    def parent_alive(self):
        return os.getppid() == self.parent

    def start(self, cols, rows):
        if self.cleanup_mode not in ("strict", "native-process-group"):
            raise RuntimeError("invalid_cleanup_mode")
        if self.cleanup_mode == "strict" and not descendant_containment_available():
            raise RuntimeError("terminal_descendant_containment_unavailable")
        config = None
        if self.cleanup_mode == "native-process-group":
            self.operation_stage = "allocator-config"
            config = native_config(self.root, self.runtime_root, self.profile)
        self.operation_stage = "owner-check"
        if not self.parent_alive():
            raise RuntimeError("parent_changed")
        self.operation_stage = "ownership-preflight"
        census()  # Fail before forking any shell when ownership cannot be read.
        self.operation_stage = "control-pipe"
        read_exec, write_exec = os.pipe()
        gate_read = gate_write = None
        guardian = os.getpid()
        try:
            if config:
                gate_read, gate_write = os.pipe()
            self.operation_stage = "pty-allocate"
            # macOS forkpty already acquires a controlling terminal/session.
            # pty.fork() silently retries openpty/legacy devices after OSError,
            # masking the first refusal and its errno. Native mode never does.
            self.pid, self.master = os.forkpty() if self.cleanup_mode == "native-process-group" else pty.fork()
            if self.pid == 0:
                if config:
                    try:
                        restore_child_signals()
                        # forkpty replaced 0/1/2 with this child's TTY. No JSON
                        # control pipe or other session descriptor may survive.
                        close_unrelated_fds({gate_read, write_exec})
                        with selectors.DefaultSelector() as poll:
                            poll.register(gate_read, selectors.EVENT_READ)
                            if not poll.select(2) or os.read(gate_read, 2) != b"1" or os.getppid() != guardian:
                                raise RuntimeError("terminal_registration_gate_closed")
                        os.close(gate_read)
                        os.chdir(config["root"])
                        tty = owned_tty_identity(0)
                        if any(owned_tty_identity(fd) != tty for fd in (1, 2)):
                            raise RuntimeError('terminal_stdio_identity_changed')
                        # Only ACK crosses sandbox-exec and Python bootstrap.
                        os.set_inheritable(write_exec, True)
                        os.execve("/usr/bin/sandbox-exec", sandbox_shell_command(config, guardian, write_exec, self.generation, tty), dict(os.environ))
                    except BaseException as error:
                        child_failure(write_exec, self.generation, "sandbox-exec", error)
                os.close(read_exec)
                try:
                    os.chdir(self.root)
                    os.execve("/bin/bash", ["/bin/bash", "--noprofile", "--norc", "-i"], dict(os.environ))
                except BaseException:
                    os.write(write_exec, b"exec_failed")
                    os._exit(126)
            self.fork_owned = True  # Only the parent of this unreaped fork PID.
            os.close(write_exec)
            write_exec = None
            if config:
                os.close(gate_read); gate_read = None
                self.operation_stage = "shell-registration"
                self.register_shell()
                self.operation_stage = 'tty-binding'
                self.tty_identity = owned_tty_identity(self.master, master=True)
                self.command_profile_sha256 = hashlib.sha256((config['profile'] + TTY_IOCTL_PROFILE).encode()).hexdigest()
            os.set_blocking(self.master, False)
            self.operation_stage = "pty-configure"
            self.resize(cols, rows)
            self.operation_stage = "shell-exec-confirm"
            if config:
                # A write failure can have an uncertain release outcome; only
                # a gate never attempted is eligible for pre-execution abort.
                self.gate_release_attempted = True
                if os.write(gate_write, b"1") != 1:
                    raise RuntimeError("terminal_registration_gate_unknown")
                os.close(gate_write); gate_write = None
                self.operation_stage = "sandbox-ready"
                self.wait_ready(read_exec)
            else:
                with selectors.DefaultSelector() as poll:
                    poll.register(read_exec, selectors.EVENT_READ)
                    if not poll.select(2) or os.read(read_exec, 128):
                        raise RuntimeError("terminal_exec_unconfirmed")
            if not self.parent_alive():
                raise RuntimeError("parent_changed")
            self.operation_stage = "shell-registration"
            if self.cleanup_mode == "native-process-group":
                info = process_info(self.pid)
                if (info is None or info["zombie"] or info["parent"] != os.getpid() or info["group"] != self.pid
                        or info["session"] != self.pid or info["identity"] != self.shell_identity):
                    raise RuntimeError("shell_registration_unknown")
                self.sandbox_ready = True
            self.operation_stage = "group-registration"
            self.remember()
            self.operation_stage = "running"
        finally:
            os.close(read_exec)
            if write_exec is not None:
                os.close(write_exec)
            for fd in (gate_read, gate_write):
                if fd is not None:
                    os.close(fd)

    def register_shell(self):
        deadline = time.monotonic() + LAUNCH_TIMEOUT
        while time.monotonic() < deadline and self.parent_alive():
            info = process_info(self.pid)
            if info is None or info["zombie"] or info["parent"] != os.getpid() or info["identity"][0] != os.getuid():
                raise RuntimeError("shell_registration_unknown")
            if self.shell_identity is not None and self.shell_identity != info["identity"]:
                raise RuntimeError("shell_identity_changed")
            self.shell_identity = info["identity"]
            self.known[self.pid] = self.shell_identity
            if info["session"] == self.pid and info["group"] == self.pid:
                self.groups.add(self.pid)
                return
            time.sleep(0.005)
        raise RuntimeError("shell_registration_deadline")

    def wait_ready(self, fd):
        raw = bytearray(); deadline = time.monotonic() + LAUNCH_TIMEOUT
        os.set_blocking(fd, False)
        with selectors.DefaultSelector() as poll:
            poll.register(fd, selectors.EVENT_READ)
            while time.monotonic() < deadline and self.parent_alive():
                if not poll.select(min(0.05, max(0, deadline - time.monotonic()))):
                    continue
                value = os.read(fd, MAX_READY + 1)
                if not value:
                    validate_ready(bytes(raw), {"pid": self.pid, "parent": os.getpid(), "nonce": self.generation,
                                               "tty_path": self.tty_identity['path'], "tty_rdev": self.tty_identity['rdev']})
                    return
                raw.extend(value)
                if len(raw) > MAX_READY:
                    raise RuntimeError("sandbox_ready_limit")
        raise RuntimeError("sandbox_ready_deadline")

    def remember(self):
        if self.cleanup_mode == "native-process-group":
            return self.remember_groups()
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

    def remember_groups(self):
        if self.reaped or self.shell_identity is None:
            raise RuntimeError("shell_identity_retired_or_unknown")
        queue = list(self.known.items())
        seen, rows = set(), {}
        while queue:
            pid, identity = queue.pop()
            if pid in seen:
                continue
            seen.add(pid)
            info = process_info(pid)
            if info is None:
                continue
            if identity is not None and info["identity"] != identity:
                raise RuntimeError("process_identity_changed")
            if info["identity"][0] != os.getuid():
                raise RuntimeError("process_owner_changed")
            if info["session"] != self.pid:
                self.detached.add(pid)
                continue
            rows[pid] = info
            self.known[pid] = info["identity"]
            self.groups.add(info["group"])
            if len(self.known) > MAX_PROCESSES or len(self.groups) > MAX_GROUPS:
                raise RuntimeError("native_registry_limit")
            for child in ([] if info["zombie"] else process_ids("proc_listchildpids", pid)):
                child_info = process_info(child)
                if child_info is not None and child_info["parent"] == pid:
                    queue.append((child, child_info["identity"]))
        # A foreground job can have its own PGID. TTY binding plus the pinned
        # shell session constrains discovery; no unrelated process groups scan.
        if self.master is not None:
            try:
                group = os.tcgetpgrp(self.master)
            except OSError as error:
                if not ((self.pid not in rows or rows[self.pid]["zombie"]) and error.errno in (errno.EIO, errno.ENOTTY)):
                    raise
            else:
                # Darwin may report no foreground group after the shell has
                # exited. This is not a group to signal; retain the waitable
                # child until close_groups confirms reap and group absence.
                exited = self.pid not in rows or rows[self.pid]["zombie"]
                members = [] if group == 0 and exited else self.group_members(group)
                for info in members:
                    rows[info["pid"]] = info
                    self.known[info["pid"]] = info["identity"]
                    self.groups.add(group)
        if len(self.known) > MAX_PROCESSES or len(self.groups) > MAX_GROUPS:
            raise RuntimeError("native_registry_limit")
        self.observed = rows
        return {pid: (v["parent"], v["group"], v["identity"]) for pid, v in rows.items()}

    def group_members(self, group):
        if group <= 1 or group == os.getpgrp():
            raise RuntimeError("unsafe_process_group")
        members = []
        for pid in process_ids("proc_listpgrppids", group):
            info = process_info(pid)
            if info is None or info["group"] != group:
                continue
            if info["session"] != self.pid or info["identity"][0] != os.getuid():
                raise RuntimeError("process_group_identity_changed")
            if pid in self.known and self.known[pid] != info["identity"]:
                raise RuntimeError("process_identity_changed")
            members.append(info)
        return members

    def signal_group(self, group, sig):
        members = self.group_members(group)
        anchors = [m for m in members if not m["zombie"] and self.known.get(m["pid"]) == m["identity"]]
        if not anchors:
            return False
        # Fresh birth-time/session checks guard reuse. macOS does not provide
        # an atomic pidfd+killpg operation; this remains a limited best effort.
        live_anchor = False
        for member in anchors:
            current = process_info(member["pid"])
            if current is not None and (current["identity"] != member["identity"] or current["session"] != self.pid
                                        or current["group"] != group):
                raise RuntimeError("process_group_identity_changed")
            if current is not None and not current["zombie"]:
                live_anchor = True
        if not live_anchor:
            return False
        try:
            os.killpg(group, sig)
            return True
        except ProcessLookupError:
            return False

    def close_groups(self, reason):
        if self.cleanup or self.reason == "cleanup_unknown":
            return self.state()
        self.reason = reason
        if self.pid is None:
            self.closed = self.cleanup = True
            return self.state()
        if self.fork_owned and not self.gate_release_attempted:
            return self.abort_unreleased_child()
        observation_error = None
        try:
            # The unreaped direct child reserves the shell PID/session identity
            # until every group signal has finished. Never signal after reap.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                self.remember_groups()
                for group in sorted(self.groups, key=lambda g: (g == self.pid, g)):
                    if self.signal_group(group, sig):
                        self.termination = signal.Signals(sig).name
                child = process_info(self.pid)
                if child is not None:
                    if child["identity"] != self.shell_identity or child["parent"] != os.getpid():
                        raise RuntimeError("direct_child_identity_changed")
                    if not child["zombie"]:
                        try:
                            os.kill(self.pid, sig)
                            self.termination = signal.Signals(sig).name
                        except ProcessLookupError:
                            pass
                time.sleep(0.1)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                self.drain()
                if not self.reaped:
                    waited, status = os.waitpid(self.pid, os.WNOHANG)
                    if waited:
                        self.reaped = True
                        self.exit_code = os.waitstatus_to_exitcode(status)
                groups_alive = False
                for group in self.groups:
                    try:
                        os.killpg(group, 0)  # Observation only; no post-reap signalling.
                        groups_alive = True
                    except ProcessLookupError:
                        pass
                    except PermissionError as error:
                        if error.errno != errno.EPERM:
                            raise
                        # Darwin can report EPERM for a still-existing group
                        # containing only zombies. It proves no absence. Keep
                        # the group pending in this same bounded reap loop;
                        # never repeat termination signals after child reap.
                        groups_alive = True
                        if observation_error is None: observation_error = error
                if self.reaped and not groups_alive:
                    self.cleanup = self.closed = True
                    break
                time.sleep(0.025)
        except (OSError, RuntimeError) as error:
            self.record_failure(error, "registered-group-cleanup")
            self.reason = "cleanup_unknown"
        if not self.cleanup:
            if observation_error is not None:
                self.record_failure(observation_error, "registered-group-observation")
            self.reason = "cleanup_unknown"
        if self.master is not None:
            os.close(self.master)
            self.master = None
        return self.state()

    def abort_unreleased_child(self):
        # The trusted child never received permission to exec. EOF already
        # closed its registration gate. A successful WNOHANG wait proves this
        # is still our waitable direct child; no other code reaps it, so the
        # PID cannot be reused before our wait. Never signal an unknown PGID.
        def reap():
            waited, status = os.waitpid(self.pid, os.WNOHANG)
            if waited == self.pid:
                self.reaped = True
                self.exit_code = os.waitstatus_to_exitcode(status)
                return True
            if waited != 0:
                raise RuntimeError("unreleased_child_wait_identity_changed")
            return False
        try:
            for sig in (None, signal.SIGTERM, signal.SIGKILL):
                if reap():
                    break
                if sig is not None:
                    try:
                        os.kill(self.pid, sig)
                        self.termination = signal.Signals(sig).name
                    except ProcessLookupError:
                        pass  # Still require waitpid, never infer cleanup.
                deadline = time.monotonic() + (0.1 if sig is None else 0.3)
                while time.monotonic() < deadline:
                    if reap():
                        break
                    time.sleep(0.01)
                if self.reaped:
                    break
            if not self.reaped:
                raise RuntimeError("unreleased_child_exit_unconfirmed")
            for group in self.groups:
                try:
                    os.killpg(group, 0)  # Only absence observation after reap.
                except ProcessLookupError:
                    continue
                raise RuntimeError("unreleased_group_absence_unconfirmed")
            self.startup_aborted = self.closed = self.cleanup = True
        except (OSError, RuntimeError) as error:
            self.record_failure(error, "unreleased-child-cleanup")
            self.reason = "cleanup_unknown"
        finally:
            if self.master is not None:
                try:
                    os.close(self.master)
                except OSError as error:
                    self.record_failure(error, "unreleased-master-close")
                    self.reason = "cleanup_unknown"; self.cleanup = False
                self.master = None
        return self.state()

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
        if self.cleanup_mode == "native-process-group":
            return self.close_groups(reason)
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
                "cleanup_observed": self.cleanup, "cleanup_mode": self.cleanup_mode,
                "cleanup_scope": "registered-process-groups" if self.cleanup_mode == "native-process-group" else "all-descendants",
                "descendant_containment": False, "generation": self.generation,
                "registered_groups": sorted(self.groups), "detached_observed": sorted(self.detached),
                "termination": self.termination, "last_interrupt": self.last_interrupt,
                "failure_code": self.failure_code, "failure_errno": self.failure_errno,
                "failure_stage": self.failure_stage, "failure_trace": self.failure_trace,
                "operation_stage": self.operation_stage,
                "command_sandbox": "seatbelt" if self.cleanup_mode == "native-process-group" else None,
                "sandbox_ready": self.sandbox_ready,
                "startup_aborted": self.startup_aborted,
                "tty_path": self.tty_identity['path'] if self.tty_identity else None,
                "tty_rdev": self.tty_identity['rdev'] if self.tty_identity else None,
                "command_profile_sha256": self.command_profile_sha256,
                "startup_error_output": (bytes(self.output.buffer[-4096:]).decode('utf-8', 'replace')
                                         if self.failure_code and not self.sandbox_ready else None),
                "shell_exit_observed": self.reaped,
                "limitations": ["Detached descendants may survive; group absence is not full descendant containment.",
                                "Owned TTY path rules are not permanently revocable object capabilities; a detached process may retain the rule after device-path reuse."] if self.cleanup_mode == "native-process-group" else [],
                "exit_code": self.exit_code, "reason": self.reason}

    def request(self, request):
        op = request["op"]
        self.operation_stage = op
        if op == "close":
            return self.close()
        if op == "read" and self.cleanup and self.pid is not None:
            return {**self.state(), **self.output.read(request["since"], final=True)}
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
            if self.cleanup_mode == "native-process-group":
                self.remember_groups()
                if os.tcgetpgrp(self.master) != group:
                    raise RuntimeError("foreground_identity_changed")
                self.last_interrupt = {"group": group, "signal": "SIGINT", "delivered": self.signal_group(group, signal.SIGINT)}
            else:
                if os.getsid(group) != self.pid:
                    raise RuntimeError("foreground_identity_unknown")
                os.killpg(group, signal.SIGINT)
        self.drain()
        return {**self.state(), **(self.output.read(request["since"]) if op == "read" else {})}


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main(root, parent, cleanup_mode="strict", profile=None, runtime_root=None):
    if not os.path.isabs(root) or os.path.realpath(root) != root or os.getppid() != parent:
        raise RuntimeError("invalid_terminal_owner")
    # This single-threaded guardian is the sole waiter for its direct child.
    # Undo an inherited SIG_IGN so an unreaped child reserves its PID until
    # waitpid consumes it, including failures before identity registration.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    os.setsid()
    terminal = Terminal(root, parent, cleanup_mode, profile, runtime_root)
    stopping = [False]
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.__setitem__(0, True))
    requests = bytearray()
    ledger = collections.OrderedDict()
    os.set_blocking(0, False)
    try:
        while terminal.parent_alive() and not stopping[0]:
            if terminal.pid is not None and not terminal.closed and not terminal.reason and cleanup_mode == "native-process-group":
                try:
                    terminal.remember_groups()
                except (OSError, RuntimeError) as error:
                    terminal.record_failure(error, "registered-group-observation")
                    terminal.reason = "cleanup_unknown"
                    break
                if terminal.pid not in terminal.observed or terminal.observed[terminal.pid]["zombie"]:
                    terminal.close("terminal_exited" if terminal.pid in terminal.observed else "terminal_identity_unobserved")
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
                            if not terminal.cleanup:
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
                except Exception as error:
                    terminal.record_failure(error, terminal.operation_stage)
                    terminal.close("terminal_operation_unknown")
                    value = {"id": request["id"], "ok": False, "error": "terminal_operation_failed", "result": terminal.state()}
                if request["op"] != "read":
                    ledger[request["id"]] = (fingerprint, value)
                emit(value)
                if request["op"] == "close" or (terminal.reason and not terminal.cleanup):
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
    if len(sys.argv) == 8 and sys.argv[1:3] == ["--sandbox-shell", "--parent"] and sys.argv[4] == "--ack-fd" and sys.argv[6] == "--ack-nonce":
        sandbox_shell(int(sys.argv[3]), int(sys.argv[5]), sys.argv[7])
    elif (len(sys.argv) in (7, 11) and sys.argv[1] == "--parent" and sys.argv[3] == "--root" and sys.argv[5] == "--cleanup-mode"
          and ((len(sys.argv) == 7 and sys.argv[6] == "strict")
               or (len(sys.argv) == 11 and sys.argv[6] == "native-process-group" and sys.argv[7] == "--seatbelt-profile" and sys.argv[9] == "--runtime-root"))):
        main(sys.argv[4], int(sys.argv[2]), sys.argv[6], *(sys.argv[8::2] if len(sys.argv) == 11 else ()))
    else:
        raise SystemExit("invalid terminal invocation")

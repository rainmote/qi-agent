"""Explicit inert download of locked workspace archives; never installs or runs them.

The default is official. The cn profile verifies candidates, without activating a
registry or changing the lock. plan is offline. prepare/build never invoke fetch.
Uses normal urllib proxy/TLS settings; reads no npm/pip/netrc credential files.
"""
import argparse
import base64
import datetime
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "apps/desktop/workspace-runtime-sources.json"
CATALOG = ROOT / "apps/desktop/dependency-mirrors.json"
GITHUB = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
          "github-releases.githubusercontent.com"}
TUNA = {"pypi.tuna.tsinghua.edu.cn", "mirrors.tuna.tsinghua.edu.cn"}
HEADERS = {"User-Agent": "qi-agent-pinned-runtime/1", "Accept": "*/*"}
MAX_TOTAL = 1_000_000_000
MAX_METADATA = 1_000_000
SOFT_SECONDS = 600


class PolicyError(ValueError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def safe_url(url, hosts, fragment=False):
    if not isinstance(url, str) or re.search(r"[\x00-\x20\x7f\\]", url):
        raise PolicyError("invalid URL characters")
    try:
        parts = urllib.parse.urlsplit(url)
        valid = (parts.scheme == "https" and parts.hostname in hosts
                 and parts.username is None and parts.password is None
                 and parts.port in (None, 443) and (fragment or not parts.fragment))
    except ValueError as error:
        raise PolicyError("invalid HTTPS URL") from error
    if not valid:
        raise PolicyError("URL outside fixed HTTPS origin policy")
    return parts


def pin(source):
    if "sha256" in source and "integrity" not in source:
        value = source["sha256"]
        if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value):
            return "sha256", bytes.fromhex(value)
    elif "integrity" in source and "sha256" not in source:
        value = source["integrity"]
        if isinstance(value, str) and value.startswith("sha512-"):
            try:
                raw = base64.b64decode(value[7:], validate=True)
                if len(raw) == 64 and base64.b64encode(raw).decode() == value[7:]:
                    return "sha512", raw
            except ValueError:
                pass
    raise PolicyError("missing or unsupported original integrity pin")


def validate(lock, catalog):
    if (lock.get("schema") != 1 or catalog.get("schema") != 1
            or catalog.get("default_profile") != "official"
            or catalog.get("profiles", {}).get("official") != {}):
        raise PolicyError("unsupported lock or default source policy")
    cn = catalog["profiles"].get("cn", {})
    if cn != {"status": "candidate_requires_pinned_verification",
              "npm_registry": "https://registry.npmmirror.com",
              "pypi_simple": "https://pypi.tuna.tsinghua.edu.cn/simple/", "portable_python": None}:
        raise PolicyError("unreviewed mirror configuration")
    names = set()
    if not 1 <= len(lock["sources"]) <= 128:
        raise PolicyError("invalid dependency count")
    for source in lock["sources"]:
        name = source["name"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", name) or name in names:
            raise PolicyError("invalid or duplicate cache identity")
        names.add(name)
        if type(source["limit"]) is not int or not 0 < source["limit"] <= 200_000_000:
            raise PolicyError("invalid archive byte limit")
        hosts = {"python": {"github.com"}, "npm": {"registry.npmjs.org"},
                 "wheel": {"files.pythonhosted.org"}}.get(source["kind"])
        if hosts is None:
            raise PolicyError("unsupported archive kind")
        parts = safe_url(source["url"], hosts)
        pin(source)
        if source["kind"] == "wheel" and urllib.parse.unquote(parts.path.rsplit("/", 1)[-1]) != name:
            raise PolicyError("wheel identity differs from locked URL")


def source_plan(source, profile, catalog):
    result = {"name": source["name"], "kind": source["kind"], "official_url": source["url"],
              "pin": source.get("sha256", source.get("integrity")), "limit": source["limit"],
              "mode": "official", "url": source["url"]}
    if profile == "cn" and source["kind"] == "npm":
        path = safe_url(source["url"], {"registry.npmjs.org"}).path
        result.update(mode="candidate_archive", url=catalog["profiles"]["cn"]["npm_registry"] + path)
    elif profile == "cn" and source["kind"] == "wheel":
        distribution = re.sub(r"[-_.]+", "-", source["name"].split("-", 1)[0]).lower()
        result.update(mode="candidate_index", url=catalog["profiles"]["cn"]["pypi_simple"] + distribution + "/")
    return result


def allowed_hosts(source, profile):
    if profile == "cn" and source["kind"] == "npm":
        return {"registry.npmmirror.com"}
    if profile == "cn" and source["kind"] == "wheel":
        return TUNA
    return {"python": GITHUB, "npm": {"registry.npmjs.org"}, "wheel": {"files.pythonhosted.org"}}[source["kind"]]


class Redirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts):
        super().__init__()
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl, self.hosts)
        request = super().redirect_request(req, fp, code, msg, headers, newurl)
        if request is None:
            return None
        # Rebuild public headers, including on same-origin redirects. Never copy
        # origin Authorization, Cookie or referer from requests/response metadata.
        return urllib.request.Request(request.full_url, headers=HEADERS, method="GET")


class WheelIndex(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            self.links.extend(value for key, value in attrs if key == "href" and value is not None)


def wheel_url(data, index_url, source):
    index = WheelIndex()
    index.feed(data.decode("utf-8"))
    candidates = set()
    for link in index.links:
        full = urllib.parse.urljoin(index_url, link)
        parts = urllib.parse.urlsplit(full)
        if urllib.parse.unquote(parts.path.rsplit("/", 1)[-1]) != source["name"]:
            continue
        safe_url(full, TUNA, fragment=True)
        if parts.fragment != "sha256=" + source["sha256"]:
            raise PolicyError("mirror index disagrees with original wheel pin")
        candidates.add(urllib.parse.urlunsplit(parts._replace(fragment="")))
    if len(candidates) != 1:
        raise PolicyError("exact pinned wheel absent or ambiguous in mirror index")
    return candidates.pop()


def verified(path, source):
    algorithm, expected = pin(source)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= source["limit"]:
            raise PolicyError("cache entry must be a bounded regular file")
        value = hashlib.new(algorithm)
        count = 0
        while chunk := stream.read(1024 * 1024):
            count += len(chunk)
            if count > source["limit"]:
                raise PolicyError("cache file grew beyond archive limit")
            value.update(chunk)
        after = os.fstat(stream.fileno())
    current = path.lstat()
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
    if identity(before) != identity(after) or identity(after) != identity(current) or not stat.S_ISREG(current.st_mode):
        raise PolicyError("cache file changed during verification")
    if value.digest() != expected:
        raise PolicyError("archive differs from original integrity pin")
    return {"bytes": count, "algorithm": algorithm, "digest": value.hexdigest()}


def private_directory(path):
    if path.absolute() != path.resolve():
        raise PolicyError("directory ancestors must not be symbolic links")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir() or path.is_symlink():
        raise PolicyError("expected private build-owned directory")
    metadata = path.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise PolicyError("directory must be owned by this user and not writable by others")


class Receipt:
    def __init__(self, path, report):
        self.path, self.report, self.previous = path, report, None
        self.save()

    def save(self):
        payload = (json.dumps(self.report, indent=2) + "\n").encode()
        target = self.path if self.previous is None else self.path.with_name(self.path.name + ".write.tmp")
        if self.previous is not None:
            if self.path.is_symlink() or hashlib.sha256(self.path.read_bytes()).digest() != self.previous:
                raise PolicyError("receipt changed; reconcile before retry")
        with target.open("xb") as stream:
            os.chmod(target, 0o600)
            if stream.write(payload) != len(payload):
                raise OSError("short receipt write")
            stream.flush()
            os.fsync(stream.fileno())
        if target != self.path:
            target.replace(self.path)
        self.previous = hashlib.sha256(payload).digest()


def fetch_one(source, planned, profile, cache, run, budget, opener_factory=urllib.request.build_opener):
    target = cache / source["name"]
    partial = cache / (source["name"] + ".partial")
    if os.path.lexists(partial):
        raise PolicyError("incomplete archive exists; reconcile before retry")
    if os.path.lexists(target):
        return {"status": "CACHED_VERIFIED", **verified(target, source)}
    hosts = allowed_hosts(source, profile)
    opener = opener_factory(Redirect(hosts))
    url = planned["url"]

    def response(address):
        safe_url(address, hosts)
        run["phase"] = "HTTPS-connect"
        value = opener.open(urllib.request.Request(address, headers=HEADERS), timeout=20)
        try:
            safe_url(value.url, hosts)
            if value.status != 200:
                raise PolicyError("archive/index response is not HTTP 200")
        except BaseException:
            value.close()
            raise
        run["response_host"] = urllib.parse.urlsplit(value.url).hostname
        return value

    def read(stream, count):
        run["phase"] = "HTTPS-read"
        chunk = stream.read(count)
        budget["bytes"] += len(chunk)
        run["bytes"] += len(chunk)
        if budget["bytes"] > MAX_TOTAL or time.monotonic() - budget["started"] > SOFT_SECONDS:
            raise PolicyError("download byte or soft elapsed budget exhausted")
        return chunk

    if planned["mode"] == "candidate_index":
        with response(url) as stream:
            data = bytearray()
            while chunk := read(stream, min(65536, MAX_METADATA + 1 - len(data))):
                data.extend(chunk)
                if len(data) > MAX_METADATA:
                    raise PolicyError("mirror index too large")
            url = wheel_url(bytes(data), stream.url, source)
    with response(url) as stream:
        run["phase"] = "local-partial-create"
        with partial.open("xb") as output:
            os.chmod(partial, 0o600)
            size = 0
            while chunk := read(stream, 1024 * 1024):
                size += len(chunk)
                if size > source["limit"]:
                    raise PolicyError("archive exceeds locked byte limit")
                run["phase"] = "local-partial-write"
                if output.write(chunk) != len(chunk):
                    raise OSError("short archive write")
            run["phase"] = "local-partial-fsync"
            output.flush()
            os.fsync(output.fileno())
    run["phase"] = "local-checksum-verify"
    proof = verified(partial, source)
    run["phase"] = "local-exclusive-publish"
    os.link(partial, target)  # no replace; uncertain outcomes retain their partial
    run["published"] = True
    proof_after = verified(target, source)
    if proof_after != proof or partial.stat().st_ino != target.stat().st_ino:
        raise PolicyError("published archive changed; reconcile before retry")
    partial.unlink()
    return {"status": "DOWNLOADED_VERIFIED", **proof_after}


def error_result(error, phase):
    reason = getattr(error, "reason", error)
    result = {"error_category": type(error).__name__, "reason_category": type(reason).__name__,
              "errno": getattr(reason, "errno", None), "phase": phase}
    if isinstance(error, urllib.error.HTTPError):
        result["http_status"] = error.code
        return {**result, "status": "HTTP_ERROR_STOPPED"}, "all"
    if isinstance(reason, PermissionError):
        return {**result, "status": "PERMISSION_DENIED_STOPPED"}, "all"
    if isinstance(error, PolicyError):
        return {**result, "status": "POLICY_OR_CHECKSUM_STOPPED", "reason": str(error)}, "all"
    if phase in ("HTTPS-connect", "HTTPS-read") and isinstance(reason, (socket.gaierror, TimeoutError, ConnectionError, ssl.SSLError)):
        return {**result, "status": "TRANSPORT_ERROR_STOPPED"}, "origin"
    return {**result, "status": "LOCAL_OR_OUTCOME_UNKNOWN_STOPPED"}, "all"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "fetch"))
    parser.add_argument("--profile", choices=("official", "cn"), default="official")
    parser.add_argument("--only", action="append", default=[], help="exact locked cache name; repeatable")
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache/desktop/workspace")
    parser.add_argument("--receipt", type=Path, help="new private JSON receipt, required for fetch")
    args = parser.parse_args(argv)
    lock_bytes, catalog_bytes = LOCK.read_bytes(), CATALOG.read_bytes()
    lock, catalog = json.loads(lock_bytes), json.loads(catalog_bytes)
    validate(lock, catalog)
    sources = [source for source in lock["sources"] if not args.only or source["name"] in args.only]
    if set(args.only) - {source["name"] for source in sources}:
        raise PolicyError("--only contains an unlocked cache identity")
    plan = [source_plan(source, args.profile, catalog) for source in sources]
    report = {"schema": 1, "profile": args.profile, "default_profile": "official",
              "lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
              "catalog_sha256": hashlib.sha256(catalog_bytes).hexdigest(),
              "controller_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "plan": plan, "automatic_fallback": False, "activated_registries": 0}
    if args.action == "plan":
        print(json.dumps(report, indent=2))
        return 0
    if args.receipt is None:
        parser.error("fetch requires --receipt (a new path; never reuse an uncertain run)")
    cache, receipt_path = args.cache.absolute(), args.receipt.absolute()
    private_directory(cache)
    private_directory(receipt_path.parent)
    report.update(status="RUNNING", started_at=now(), results=[], cache=str(cache),
                  scope="inert public bytes only; no extraction, install, execution or security settings changes",
                  proxy_TLS="urllib defaults unchanged; no origin credential files or cookies",
                  socket_timeout_seconds=20, soft_elapsed_budget_seconds=SOFT_SECONDS,
                  elapsed_limitation="budget checked between blocking calls; DNS/open/read may exceed it",
                  max_total_bytes=MAX_TOTAL)
    try:
        receipt = Receipt(receipt_path, report)
    except Exception as error:
        print(json.dumps({"status": "INITIAL_RECEIPT_NOT_CONFIRMED", "error_category": type(error).__name__,
                          "receipt": str(receipt_path)}), file=sys.stderr)
        return 2
    budget = {"bytes": 0, "started": time.monotonic()}
    stopped, failed_hosts = False, set()
    try:
        for source, planned in zip(sources, plan):
            host = urllib.parse.urlsplit(planned["url"]).hostname
            run = {"name": source["name"], "request_host": host, "phase": "cache-validation", "bytes": 0}
            report["results"].append(run)
            if stopped or host in failed_hosts or time.monotonic() - budget["started"] > SOFT_SECONDS:
                run["status"] = "NOT_RUN_STOPPED"
            else:
                # Persist intent before public HTTPS or local publication.
                run["status"] = "RUNNING"
                receipt.save()
                try:
                    run.update(fetch_one(source, planned, args.profile, cache, run, budget))
                except Exception as error:
                    failure, stop = error_result(error, run["phase"])
                    run.update(failure)
                    stopped = stop == "all"
                    failed_hosts.add(host)
            receipt.save()
        report["status"] = ("VERIFIED" if all(item["status"] in ("CACHED_VERIFIED", "DOWNLOADED_VERIFIED")
                                            for item in report["results"]) else "INCOMPLETE_STOPPED")
        report["ended_at"] = now()
        receipt.save()
    except BaseException:
        # Initial RUNNING intent/partial files remain for reconciliation. Never
        # hide an interrupted or unrecorded publication behind a success code.
        print(json.dumps({"status": "RECEIPT_OR_OUTCOME_UNKNOWN", "receipt": str(receipt_path)}), file=sys.stderr)
        return 2
    print(json.dumps({"status": report["status"], "receipt": str(receipt_path)}))
    return 0 if report["status"] == "VERIFIED" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "NOT_COMPLETED", "error_category": type(error).__name__}), file=sys.stderr)
        raise SystemExit(2)

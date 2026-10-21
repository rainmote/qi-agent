"""Prepare pinned workspace runtimes from inert local archives, without installs.

No network, shell, subprocess, pip, npm scripts or third-party imports. Every
output is a regular file below the new build-owned destination. Archive links
are resolved against archive entries only and copied as regular files.
"""
import base64
from email.parser import Parser
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import zipfile

MAX_BYTES = 2_000_000_000
MAX_FILES = 100_000
MAX_FILE = 500_000_000
NOTICES = Path(__file__).resolve().parents[2] / "apps/desktop/notices"


def relative(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name or "\0" in name:
        raise ValueError("unsafe archive path")
    return str(path)


def supplemental_notice(package, metadata, writer, npm):
    catalog = NOTICES / "sources.json"
    if catalog.is_symlink() or not catalog.is_file() or catalog.stat().st_size > 1_000_000:
        raise ValueError("missing or invalid supplemental notice catalog")
    entries = json.loads(catalog.read_text())["notices"]
    matching = [entry for entry in entries if entry.get("package") == package + "@" + metadata["version"]]
    if len(matching) != 1:
        raise ValueError("missing or ambiguous exact-version supplemental notice")
    notice = matching[0]
    digest = notice.get("sha256", "")
    if (not isinstance(metadata.get("license"), str) or not metadata["license"].strip()
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or notice.get("file") != digest + ".txt"
            or notice.get("license_identifier") != metadata.get("license")):
        raise ValueError("supplemental notice identity or license mismatch")
    source = NOTICES / notice["file"]
    if source.is_symlink() or not source.is_file() or not 0 < source.stat().st_size <= 1_000_000:
        raise ValueError("missing or invalid supplemental notice text")
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("supplemental notice checksum mismatch")
    kind = notice.get("source_kind")
    if kind == "frozen_repository_license":
        commit, url = notice.get("source_commit"), notice.get("source")
        if (not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit)
                or not isinstance(url, str)
                or not re.fullmatch(r"https://raw\.githubusercontent\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/" + commit + r"/[^?#\s\\]+", url)
                or ".." in url.split("/")
                or hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() != notice.get("git_blob_sha1")):
            raise ValueError("unbound frozen publisher notice")
    elif kind == "same_version_parent_archive_notice":
        parent_identity = notice.get("source_package", "")
        if not isinstance(parent_identity, str) or "@" not in parent_identity:
            raise ValueError("missing parent notice identity")
        parent_name, version = parent_identity.rsplit("@", 1)
        parent = npm.get(parent_name)
        if parent is None:
            raise ValueError("unlocked parent notice archive")
        locked, parent_metadata = parent
        declared = {**parent_metadata.get("dependencies", {}), **parent_metadata.get("optionalDependencies", {})}
        if (version != metadata["version"] or version != parent_metadata["version"]
                or declared.get(package) != metadata["version"] or parent_metadata.get("license") != metadata["license"]
                or notice.get("source_archive_pin") != locked.get("integrity", locked.get("sha256"))
                or notice.get("source") != locked.get("url")):
            raise ValueError("parent notice version, dependency or archive mismatch")
        entry = relative(notice.get("source_archive_entry", ""))
        if not entry.startswith("package/") or not re.match(r"(?i)^(license|licence|copying|notice|copyright)([.-]|$)", Path(entry).name):
            raise ValueError("invalid parent notice path")
        original = writer.root / "node_modules" / parent_name / entry.removeprefix("package/")
        if (original.is_symlink() or not original.is_file() or original.stat().st_size > 1_000_000
                or original.read_bytes() != raw):
            raise ValueError("parent notice differs from verified archive bytes")
    else:
        raise ValueError("assembled or unreviewed notice origin cannot satisfy publisher-text gate")
    path = "node_modules/" + package + "/licenses/qi-supplemental-" + notice["file"]
    writer.put(path, raw)
    return {**notice, "path": path}


class Writer:
    def __init__(self, root):
        self.root = root
        self.bytes = 0
        self.count = 0

    def put(self, name, data, executable=False):
        name = relative(name)
        if len(data) > MAX_FILE:
            raise ValueError("oversized extracted file")
        self.bytes += len(data)
        self.count += 1
        if self.bytes > MAX_BYTES or self.count > MAX_FILES:
            raise ValueError("workspace runtime archive limits exceeded")
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
                raise ValueError("conflicting runtime entries")
            return
        with path.open("xb") as output:
            output.write(data)
        path.chmod(0o755 if executable else 0o644)


def verify(source, cache):
    name = source["name"]
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ValueError("invalid cache identity")
    path = cache / name
    if path.is_symlink() or not path.is_file() or path.stat().st_size > source["limit"]:
        raise ValueError("missing or invalid pinned workspace archive: " + name)
    data = path.read_bytes()
    if "sha256" in source:
        valid = hashlib.sha256(data).hexdigest() == source["sha256"]
    else:
        valid = source["integrity"] == "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if not valid:
        raise ValueError("workspace archive checksum mismatch: " + name)
    return path


def tar_entries(path, expected_prefix, destination, writer):
    with tarfile.open(path, "r:gz") as archive:
        members = {}
        total = 0
        for member in archive:
            name = relative(member.name)
            if name == expected_prefix and member.isdir():
                continue
            if not name.startswith(expected_prefix + "/"):
                raise ValueError("unexpected archive root")
            if name in members or len(members) >= MAX_FILES:
                raise ValueError("duplicate or excess archive entries")
            if member.size < 0 or member.size > MAX_FILE:
                raise ValueError("oversized archive entry")
            total += member.size
            if total > MAX_BYTES:
                raise ValueError("archive decompression limit")
            if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
                raise ValueError("special archive entries are forbidden")
            members[name] = member

        def resolve_entry(name, seen=()):
            if name in seen or len(seen) >= 32:
                raise ValueError("cyclic archive link")
            member = members.get(name)
            if member is None:
                raise ValueError("unresolved archive link")
            if member.issym() or member.islnk():
                if member.islnk():
                    target = member.linkname
                else:
                    if PurePosixPath(member.linkname).is_absolute():
                        raise ValueError("absolute archive link")
                    # Normalize inside the archive, never through the host FS.
                    target = os.path.normpath(str(PurePosixPath(name).parent / member.linkname))
                target = relative(target)
                if not target.startswith(expected_prefix + "/"):
                    raise ValueError("archive link escapes runtime")
                return resolve_entry(target, seen + (name,))
            if not member.isfile():
                raise ValueError("directory links require explicit expansion; not accepted")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("archive file unreadable")
            with stream:
                data = stream.read(MAX_FILE + 1)
            if len(data) != member.size:
                raise ValueError("truncated archive file")
            return data, bool(member.mode & 0o111)

        for name, member in members.items():
            if member.isdir():
                continue
            data, executable = resolve_entry(name)
            writer.put(destination + "/" + name[len(expected_prefix) + 1:], data, executable)


def distribution_name(name):
    return re.sub(r"[-_.]+", "_", name).lower()


def pnpm_entries(path, writer, version):
    """Retain arm64 pnpm, omit only its bound foreign optional reflink packages.

    Both passes use the same inert archive parser and limits. Neither metadata
    nor a foreign suffix alone authorizes omission: the parent must declare the
    exact child identity/version and that child must declare its exact target.
    """
    prefix = "node_modules/pnpm"
    family = prefix + "/dist/node_modules/@reflink/"
    metadata = {}
    class Metadata:
        def put(self, name, data, executable=False):
            if name == prefix + "/package.json" or (name.startswith(family) and name.endswith("/package.json")):
                if len(data) > 1_000_000:
                    raise ValueError("oversized bundled pnpm metadata")
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise ValueError("invalid bundled pnpm package metadata")
                metadata[name] = value
    tar_entries(path, "package", prefix, Metadata())
    package = metadata.get(prefix + "/package.json", {})
    parent = metadata.get(family + "reflink/package.json", {})
    if (package.get("name") != "pnpm" or package.get("version") != version
            or parent.get("name") != "@reflink/reflink" or not isinstance(parent.get("version"), str)
            or not isinstance(parent.get("optionalDependencies"), dict)):
        raise ValueError("unbound bundled pnpm native parent")
    targets = {
        "reflink-darwin-arm64": (["darwin"], ["arm64"]),
        "reflink-darwin-x64": (["darwin"], ["x64"]),
        "reflink-win32-arm64-msvc": (["win32"], ["arm64"]),
        "reflink-win32-x64-msvc": (["win32"], ["x64"]),
    }
    children = {name: value for name, value in metadata.items() if name != family + "reflink/package.json" and name.startswith(family)}
    target = family + "reflink-darwin-arm64/package.json"
    if target not in children:
        raise ValueError("missing bundled pnpm arm64 native package")
    omitted = []
    for name, child in sorted(children.items()):
        folder = name[len(family):].removesuffix("/package.json")
        identity = "@reflink/" + folder
        flags = targets.get(folder)
        if (flags is None or child.get("name") != identity or child.get("version") != parent["version"]
                or parent.get("optionalDependencies", {}).get(identity) != child.get("version")
                or child.get("os") != flags[0] or child.get("cpu") != flags[1]):
            raise ValueError("unbound bundled pnpm optional native package")
        if name != target:
            omitted.append({"package":identity,"version":child["version"],"os":child["os"],"cpu":child["cpu"],
                            "path":name.removesuffix("/package.json")})
    class TargetWriter:
        def put(self, name, data, executable=False):
            if not any(name.startswith(item["path"] + "/") for item in omitted):
                writer.put(name, data, executable)
    tar_entries(path, "package", prefix, TargetWriter())
    return omitted


def wheel_entries(path, writer):
    with zipfile.ZipFile(path) as archive:
        metadata_paths = [name for name in archive.namelist()
                          if re.fullmatch(r"[^/]+\.dist-info/METADATA", name)]
        if len(metadata_paths) != 1:
            raise ValueError("wheel must contain one distribution identity")
        metadata_path = metadata_paths[0]
        info = archive.getinfo(metadata_path)
        if info.file_size > 1000000:
            raise ValueError("oversized wheel metadata")
        metadata = Parser().parsestr(archive.read(info).decode("utf-8"))
        if len(metadata.get_all("Name", [])) != 1 or len(metadata.get_all("Version", [])) != 1:
            raise ValueError("invalid wheel metadata identity")
        name, version = metadata["Name"], metadata["Version"]
        if not re.fullmatch(r"[A-Za-z0-9._-]+", name) or not re.fullmatch(r"[A-Za-z0-9.+!_-]+", version):
            raise ValueError("invalid wheel distribution name or version")
        identity = metadata_path.split("/", 1)[0]
        folder_name, separator, folder_version = identity.removesuffix(".dist-info").rpartition("-")
        if not separator or distribution_name(folder_name) != distribution_name(name) or folder_version != version:
            raise ValueError("wheel metadata and directory identity disagree")
        seen = set()
        for member in archive.infolist():
            name = relative(member.filename)
            if member.is_dir():
                continue
            if name in seen or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("duplicate or symbolic wheel entry")
            seen.add(name)
            if len(seen) > MAX_FILES or member.file_size > MAX_FILE:
                raise ValueError("wheel archive limit")
            parts = PurePosixPath(name).parts
            if parts[0].endswith(".dist-info") and parts[0] != identity:
                raise ValueError("foreign distribution metadata in wheel")
            destination = "python/lib/python3.12/site-packages/"
            if parts[0].endswith(".data"):
                if parts[0] != identity.removesuffix(".dist-info") + ".data":
                    raise ValueError("foreign distribution data in wheel")
                if len(parts) < 3 or parts[1] not in ("purelib", "platlib", "scripts"):
                    raise ValueError("unsupported wheel data installation")
                if parts[1] == "scripts":
                    # Preserve auxiliary wheel scripts as inert source data.
                    # No shebang rewriting, executable bit or PATH entry.
                    destination = "python/share/qi-wheel-data/" + parts[0].removesuffix(".data") + "/scripts/"
                name = "/".join(parts[2:])
            with archive.open(member) as stream:
                data = stream.read(MAX_FILE + 1)
            if len(data) != member.file_size:
                raise ValueError("truncated wheel file")
            writer.put(destination + name, data)
        return {"name": metadata["Name"], "version": metadata["Version"], "directory": identity}


def prepare(lock, cache, target):
    if target.exists() or target.is_symlink():
        raise ValueError("workspace runtime destination must be new")
    # Admit and verify the entire closure before creating any build output.
    archives = [(source, verify(source, cache)) for source in lock["sources"]]
    target.mkdir(mode=0o700)
    writer = Writer(target)
    npm = {}
    wheels = {}
    platform_omissions = []
    python_locked = {distribution_name(name): version for name, version in lock.get("python_packages", {}).items()}
    if len(python_locked) != len(lock.get("python_packages", {})):
        raise ValueError("duplicate normalized Python package identity")
    for source, path in archives:
        kind = source["kind"]
        if kind == "python":
            tar_entries(path, "python", "python", writer)
        elif kind == "wheel":
            identity = wheel_entries(path, writer)
            name = distribution_name(identity["name"])
            if name in wheels or python_locked.get(name) != identity["version"]:
                raise ValueError("unlocked, duplicate or wrong-version Python wheel")
            wheels[name] = identity
        elif kind == "npm":
            package = source["package"]
            if not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", package):
                raise ValueError("invalid npm package path")
            if package == "pnpm" and lock.get("target") == "aarch64-apple-darwin":
                platform_omissions.extend(pnpm_entries(path, writer, source["version"]))
            else:
                tar_entries(path, "package", "node_modules/" + package, writer)
            metadata = json.loads((target / "node_modules" / package / "package.json").read_text())
            if metadata["name"] != package or metadata["version"] != source["version"]:
                raise ValueError("npm package identity mismatch")
            npm[package] = (source, metadata)
        else:
            raise ValueError("unsupported workspace runtime source")
    for package, (source, metadata) in npm.items():
        declared = {item.rsplit("@", 1)[0]: item.rsplit("@", 1)[1] for item in source["dependencies"]}
        required = set(metadata.get("dependencies", {})) | {name for name in metadata.get("peerDependencies", {}) if not metadata.get("peerDependenciesMeta", {}).get(name, {}).get("optional")}
        if not required.issubset(declared):
            raise ValueError("unlocked npm runtime dependency: " + package)
        for name, version in declared.items():
            if name not in npm or npm[name][1]["version"] != version:
                raise ValueError("missing exact npm runtime dependency")
    for required in ["python/bin/python3.12", "node_modules/pnpm/bin/pnpm.cjs", "node_modules/@deepseek-ai/libreoffice-kit/package.json", "node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json", "node_modules/@koromix/koffi-darwin-arm64/package.json"]:
        if not (target / required).is_file():
            raise ValueError("missing required workspace runtime entry")
    wrappers = {
        "python3": 'exec "$qi_root/python/bin/python3.12" "$@"',
        "python": 'exec "$qi_root/python/bin/python3.12" "$@"',
        "pnpm": 'exec "$qi_root/../bin/node" "$qi_root/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    }
    for name, command in wrappers.items():
        writer.put("bin/" + name, ('#!/bin/sh\nset -eu\nqi_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\n' + command + '\n').encode(), True)
    notices = []
    for path in sorted(target.rglob("*")):
        if path.is_file() and (re.match(r"(?i)^(license|licence|copying|notice|copyright)([.-]|$)", path.name) or "licenses" in path.parts):
            notices.append(str(path.relative_to(target)))
    # Package metadata without an actual license/notice file is insufficient.
    supplemental = []
    for package, (_, metadata) in npm.items():
        prefix = "node_modules/" + package + "/"
        if not any(name.startswith(prefix) for name in notices):
            notice = supplemental_notice(package, metadata, writer, npm)
            supplemental.append(notice)
            notices.append(notice["path"])
    if not any(name.startswith("python/") and "site-packages" not in name for name in notices):
        raise ValueError("missing standalone Python license text")
    if set(wheels) != set(python_locked):
        raise ValueError("incomplete pinned Python wheel closure")
    for package in lock["python_packages"]:
        identity = wheels[distribution_name(package)]
        prefix = "python/lib/python3.12/site-packages/" + identity["directory"] + "/"
        if not any(name.startswith(prefix) for name in notices):
            raise ValueError("missing Python package license text: " + package)
    writer.put("runtime-inputs.json", (json.dumps(lock, indent=2) + "\n").encode())
    writer.put("licenses.json", (json.dumps({"notice_paths_relative_to": "workspace", "notices": notices,
                                            "supplemental_notices": supplemental}, indent=2) + "\n").encode())
    hashes = {str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(target.rglob("*")) if path.is_file()}
    writer.put("workspace-manifest.json", (json.dumps({"schema": 1, "target": lock["target"], "python_version": lock["python_version"],
                                                     "platform_omissions":platform_omissions,"files": hashes}, indent=2) + "\n").encode())


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: workspace-runtime.py LOCK CACHE NEW-DESTINATION")
    prepare(json.loads(Path(sys.argv[1]).read_text()), Path(sys.argv[2]), Path(sys.argv[3]))

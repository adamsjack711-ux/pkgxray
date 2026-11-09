#!/usr/bin/env python3
"""Read bounded archived npm source, without extract-all or executing code."""
import json
import gzip
import hashlib
import os
import re
import stat
import sys
import unicodedata
import zipfile

MAX_ENTRIES = 512
MAX_EXPANDED = 16 * 1024 * 1024
MAX_TARBALL_EXPANDED = 64 * 1024 * 1024


def unwrap(source, destination):
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES:
            raise ValueError("ZIP entry limit exceeded")
        size = 0
        candidates = []
        seen = set()
        path_spellings = {}
        for member in members:
            name = member.filename
            parts = name.rstrip("/").split("/")
            if (not name or name.startswith("/") or "\\" in name or ":" in name
                    or any(p in ("", ".", "..") for p in parts)
                    or re.search(r"[\x00-\x1f\x7f]", name)):
                raise ValueError("Unsafe ZIP member path")
            normalized = unicodedata.normalize("NFC", name.rstrip("/")).casefold()
            if normalized in seen:
                raise ValueError("Duplicate ZIP member")
            seen.add(normalized)
            for depth in range(1, len(parts) + 1):
                spelling = "/".join(parts[:depth])
                key = unicodedata.normalize("NFC", spelling).casefold()
                if key in path_spellings and path_spellings[key] != spelling:
                    raise ValueError("ZIP path case/normalization collision")
                path_spellings[key] = spelling
            kind = stat.S_IFMT(member.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("ZIP links/special files refused")
            size += member.file_size
            if size > MAX_EXPANDED:
                raise ValueError("ZIP expanded-byte limit exceeded")
            if not member.is_dir() and name.endswith((".tgz", ".tar.gz")):
                candidates.append(member)
        if not candidates:
            # Dataset ZIPs often retain extracted source rather than a TGZ.
            # Select exactly one outer package/ subtree, ignoring metadata.
            roots = set()
            for member in members:
                parts = member.filename.rstrip("/").split("/")
                if "package" in parts:
                    roots.add("/".join(parts[:parts.index("package") + 1]) + "/")
            if len(roots) != 1:
                raise ValueError("Expected one unambiguous package subtree")
            prefix = roots.pop()
            selected = [member for member in members if member.filename.startswith(prefix) and member.filename != prefix]
            if not any(member.filename == prefix + "package.json" for member in selected):
                raise ValueError("Package subtree has no package.json")
            os.mkdir(destination, 0o700)
            tree_hash = hashlib.sha256()
            total = 0
            files = 0
            try:
                for member in sorted(selected, key=lambda value: value.filename):
                    relative = member.filename[len(prefix):].rstrip("/")
                    full = os.path.join(destination, *relative.split("/"))
                    if os.path.commonpath([os.path.abspath(full), os.path.abspath(destination)]) != os.path.abspath(destination):
                        raise ValueError("Package member escapes destination")
                    if member.is_dir():
                        os.makedirs(full, mode=0o700, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(full), mode=0o700, exist_ok=True)
                    descriptor = os.open(full, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    count = 0
                    file_hash = hashlib.sha256()
                    with os.fdopen(descriptor, "wb") as target:
                        with archive.open(member, pwd=b"infected") as data:
                            while True:
                                chunk = data.read(65536)
                                if not chunk:
                                    break
                                count += len(chunk)
                                total += len(chunk)
                                if count > member.file_size or total > MAX_EXPANDED:
                                    raise ValueError("ZIP actual-byte limit exceeded")
                                file_hash.update(chunk)
                                target.write(chunk)
                    if count != member.file_size:
                        raise ValueError("Truncated package member")
                    files += 1
                    tree_hash.update(relative.encode("utf-8") + b"\0" + str(count).encode("ascii") + b"\0" + file_hash.digest())
                return {"mode": "derived-package-tree", "bytes": total, "files": files, "treeSha256": tree_hash.hexdigest()}
            except Exception:
                import shutil
                shutil.rmtree(destination)
                raise
        if len(candidates) != 1:
            raise ValueError("Expected exactly one package tarball in ZIP")
        candidate = candidates[0]
        # The destination is caller-controlled, not taken from the ZIP member.
        # O_EXCL/O_NOFOLLOW prevent replacement or following a destination link.
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            count = 0
            with os.fdopen(descriptor, "wb") as target:
                with archive.open(candidate, pwd=b"infected") as data:
                    while True:
                        chunk = data.read(65536)
                        if not chunk:
                            break
                        count += len(chunk)
                        if count > MAX_EXPANDED or count > candidate.file_size:
                            raise ValueError("ZIP member expanded-byte limit exceeded")
                        target.write(chunk)
            if count != candidate.file_size:
                raise ValueError("Truncated ZIP member")
            # Bound actual gzip expansion before the static scanner's tar
            # listing/extraction pass. Archive metadata alone cannot bound it.
            expanded = 0
            with gzip.open(destination, "rb") as tarball:
                while True:
                    chunk = tarball.read(65536)
                    if not chunk:
                        break
                    expanded += len(chunk)
                    if expanded > MAX_TARBALL_EXPANDED:
                        raise ValueError("Tarball expanded-byte limit exceeded")
        except Exception:
            os.unlink(destination)
            raise
        return {"mode": "original-tarball", "member": candidate.filename, "bytes": count}


if __name__ == "__main__":
    try:
        print(json.dumps(unwrap(sys.argv[1], sys.argv[2])))
    except Exception as error:
        # Do not print untrusted payload contents or archive member strings.
        reason = str(error) if type(error) is ValueError else "ZIP decode or filesystem operation failed"
        print(type(error).__name__ + ": " + reason, file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Manage OpenAsar beside the Vencord loader with fail-closed transactions."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import NoReturn

MAX_HEADER_BYTES = 16 * 1024 * 1024
MAX_TEXT_ENTRY_BYTES = 4 * 1024 * 1024
BROKEN_OPENASAR_MODULE_SETUP = (
    b"fs.rmSync(downloadPath,{recursive:true,force:true});mkdir(downloadPath);"
)
PATCHED_OPENASAR_MODULE_SETUP = (
    b"skipModule||[fs.rmSync(downloadPath,{recursive:true,force:true}),mkdir(downloadPath)];"
)


def fail(message: str) -> NoReturn:
    raise SystemExit(f"manage-openasar.py: {message}")


class Asar:
    def __init__(self, path: Path):
        self.path = path
        if not path.is_file() or path.is_symlink():
            fail(f"ASAR is not a regular file: {path}")
        self.size = path.stat().st_size
        try:
            with path.open("rb") as stream:
                framing = stream.read(16)
                if len(framing) != 16:
                    fail(f"invalid ASAR framing: {path}")
                pickle_size, header_size, header_object_size, json_size = struct.unpack("<IIII", framing)
                if pickle_size != 4 or header_size < 8 or header_object_size < 4:
                    fail(f"invalid ASAR framing: {path}")
                if json_size == 0 or json_size > MAX_HEADER_BYTES or json_size > self.size - 16:
                    fail(f"invalid ASAR header size: {path}")
                raw_header = stream.read(json_size)
            self.header = json.loads(raw_header)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, struct.error) as exc:
            fail(f"cannot parse ASAR {path}: {exc}")
        if not isinstance(self.header, dict) or not isinstance(self.header.get("files"), dict):
            fail(f"invalid ASAR file tree: {path}")
        self.data_offset = 8 + header_size
        if self.data_offset > self.size:
            fail(f"ASAR data offset is outside file: {path}")

    def entry(self, name: str) -> dict[str, object]:
        parts = PurePosixPath(name).parts
        if not parts or any(part in ("", ".", "..") for part in parts):
            fail(f"invalid ASAR entry path: {name}")
        files = self.header["files"]
        node: object = None
        for index, part in enumerate(parts):
            if not isinstance(files, dict) or part not in files:
                fail(f"missing ASAR entry {name} in {self.path}")
            node = files[part]
            if index != len(parts) - 1:
                if not isinstance(node, dict):
                    fail(f"invalid ASAR directory {part} in {self.path}")
                files = node.get("files")
        if not isinstance(node, dict) or "size" not in node:
            fail(f"ASAR entry is not a file: {name} in {self.path}")
        return node

    def read(self, name: str, limit: int = MAX_TEXT_ENTRY_BYTES) -> bytes:
        node = self.entry(name)
        try:
            size = int(node["size"])
            offset = int(node.get("offset", "0"))
        except (TypeError, ValueError):
            fail(f"invalid ASAR entry metadata: {name} in {self.path}")
        if size < 0 or size > limit or offset < 0:
            fail(f"unsafe ASAR entry size or offset: {name} in {self.path}")
        start = self.data_offset + offset
        if start > self.size or size > self.size - start:
            fail(f"ASAR entry is outside file: {name} in {self.path}")
        try:
            with self.path.open("rb") as stream:
                stream.seek(start)
                data = stream.read(size)
        except OSError as exc:
            fail(f"cannot read ASAR entry {name} in {self.path}: {exc}")
        if len(data) != size:
            fail(f"short ASAR entry read: {name} in {self.path}")
        return data

    def package(self) -> dict[str, object]:
        try:
            package = json.loads(self.read("package.json"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            fail(f"invalid package.json in {self.path}: {exc}")
        if not isinstance(package, dict):
            fail(f"package.json is not an object in {self.path}")
        return package
def rewrite_asar_entry(archive: Asar, target: str, replacement: bytes) -> None:
    entries: list[tuple[str, dict[str, object], bytes]] = []

    def collect(files: dict[str, object], prefix: PurePosixPath = PurePosixPath()) -> None:
        for name, value in files.items():
            if not isinstance(value, dict):
                fail(f"invalid ASAR node {prefix / name} in {archive.path}")
            path = prefix / name
            children = value.get("files")
            if children is not None:
                if not isinstance(children, dict):
                    fail(f"invalid ASAR directory {path} in {archive.path}")
                collect(children, path)
            elif "size" in value:
                if value.get("unpacked") or "link" in value:
                    fail(f"unsupported ASAR entry {path} in {archive.path}")
                entries.append(
                    (path.as_posix(), value, archive.read(path.as_posix(), archive.size))
                )
            else:
                fail(f"invalid ASAR node {path} in {archive.path}")

    collect(archive.header["files"])
    matches = [entry for entry in entries if entry[0] == target]
    if len(matches) != 1:
        fail(f"expected one ASAR entry {target} in {archive.path}")

    entries.sort(key=lambda entry: int(entry[1].get("offset", "0")))
    offset = 0
    data_parts: list[bytes] = []
    for name, node, data in entries:
        if name == target:
            data = replacement
        node["size"] = len(data)
        node["offset"] = str(offset)
        integrity = node.get("integrity")
        if integrity is not None:
            if not isinstance(integrity, dict) or integrity.get("algorithm") != "SHA256":
                fail(f"unsupported ASAR integrity metadata for {name} in {archive.path}")
            block_size = integrity.get("blockSize")
            if not isinstance(block_size, int) or block_size <= 0:
                fail(f"invalid ASAR integrity block size for {name} in {archive.path}")
            integrity["hash"] = hashlib.sha256(data).hexdigest()
            integrity["blocks"] = [
                hashlib.sha256(data[index : index + block_size]).hexdigest()
                for index in range(0, len(data), block_size)
            ]
        data_parts.append(data)
        offset += len(data)

    header_json = json.dumps(
        archive.header, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    if len(header_json) > MAX_HEADER_BYTES:
        fail(f"rewritten ASAR header is too large: {archive.path}")
    header = struct.pack(
        "<IIII", 4, 8 + len(header_json), 4 + len(header_json), len(header_json)
    )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{archive.path.name}.", suffix=".tmp", dir=archive.path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(header)
            stream.write(header_json)
            for data in data_parts:
                stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, archive.path.stat().st_mode & 0o777)
        os.replace(temporary, archive.path)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        fail(f"cannot rewrite ASAR {archive.path}: {exc}")


def prepare_openasar(candidate: Path) -> None:
    validate_openasar(candidate)
    archive = Asar(candidate)
    source = archive.read("updater/moduleUpdater.js")
    if source.count(PATCHED_OPENASAR_MODULE_SETUP) == 1:
        if BROKEN_OPENASAR_MODULE_SETUP in source:
            fail(f"ambiguous OpenAsar module updater in {candidate}")
        print("OpenAsar Flatpak module-update fix already applied")
        return
    if source.count(BROKEN_OPENASAR_MODULE_SETUP) != 1:
        fail(f"unsupported OpenAsar module updater in {candidate}")

    rewrite_asar_entry(
        archive,
        "updater/moduleUpdater.js",
        source.replace(BROKEN_OPENASAR_MODULE_SETUP, PATCHED_OPENASAR_MODULE_SETUP),
    )
    validate_openasar(candidate)
    patched = Asar(candidate).read("updater/moduleUpdater.js")
    if patched.count(PATCHED_OPENASAR_MODULE_SETUP) != 1:
        fail(f"OpenAsar module-update fix verification failed: {candidate}")
    print("OpenAsar Flatpak module-update fix applied")


def classify_discord_asar(path: Path) -> str:
    archive = Asar(path)
    package = archive.package()
    main = package.get("main")
    if package.get("name") != "discord" or not isinstance(main, str) or not main:
        fail(f"ASAR is not a Discord bootstrap: {path}")
    source = archive.read(main)
    if b"OpenAsar" in source and b"oaVersion" in source:
        return "openasar"
    if b"require(" in source and (b".asar/patcher.js" in source or b".asar\\patcher.js" in source):
        return "vencord-loader"
    return "original"


def classify_active_bootstrap(path: Path) -> str:
    kind = classify_discord_asar(path)
    if kind == "vencord-loader":
        fail(f"Vencord loader cannot be used as the Discord bootstrap: {path}")
    return kind


def validate_runtime(path: Path) -> None:
    archive = Asar(path)
    package = archive.package()
    main = package.get("main")
    if main != "patcher.js":
        fail(f"Vencord runtime has unexpected main entry: {path}")
    archive.read("patcher.js")
    archive.entry("renderer.js")


def validate_chain(resources: Path, runtime: Path, expected: str) -> str:
    if expected not in {"auto", "openasar", "original"}:
        fail(f"invalid expected bootstrap type: {expected}")
    active = resources / "_app.asar"
    backup = resources / "app.asar.backup"
    actual = classify_active_bootstrap(active)
    if expected != "auto" and actual != expected:
        fail(f"expected {expected} bootstrap, found {actual}: {active}")
    if actual == "openasar":
        if classify_discord_asar(backup) != "original":
            fail(f"OpenAsar original backup invalid: {backup}")
    elif backup.exists():
        fail(f"unexpected original backup while OpenAsar is inactive: {backup}")

    validate_runtime(runtime)
    loader = Asar(resources / "app.asar")
    package = loader.package()
    main = package.get("main")
    if main != "patcher.js":
        fail(f"Vencord loader has unexpected main entry: {resources / 'app.asar'}")
    loader_source = loader.read("patcher.js")
    runtime_bytes = os.fsencode(str(runtime.resolve()))
    if runtime_bytes not in loader_source:
        fail(f"Vencord loader does not target runtime {runtime}")
    return actual


def require_resources(path: Path) -> Path:
    if not path.is_dir() or path.is_symlink():
        fail(f"resources path is not a real directory: {path}")
    return path


def staged_copy(source: Path, destination: Path) -> Path:
    if not source.is_file() or source.is_symlink():
        fail(f"source is not a regular file: {source}")
    mode = destination.stat().st_mode & 0o777 if destination.exists() else source.stat().st_mode & 0o777
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_stream:
            shutil.copyfileobj(input_stream, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode or 0o644)
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def replace_from(source: Path, destination: Path) -> None:
    temporary = staged_copy(source, destination)
    try:
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def validate_openasar(candidate: Path) -> None:
    if classify_discord_asar(candidate) != "openasar":
        fail(f"candidate is not OpenAsar: {candidate}")


def prepare_loader(resources: Path) -> None:
    active = resources / "_app.asar"
    loader = resources / "app.asar"
    backup = resources / "app.asar.backup"
    if active.exists():
        current = classify_active_bootstrap(active)
        if current == "openasar":
            if classify_discord_asar(backup) != "original":
                fail(f"OpenAsar is active without a valid original backup: {backup}")
        elif backup.exists():
            fail(f"unexpected original backup while OpenAsar is inactive: {backup}")
        print(f"Discord bootstrap already prepared ({current})")
        return

    if backup.exists():
        fail(f"cannot prepare loader with orphaned backup: {backup}")
    if classify_discord_asar(loader) != "original":
        fail(f"existing app.asar is not an original Discord bootstrap: {loader}")
    replace_from(loader, active)
    if classify_active_bootstrap(active) != "original":
        fail(f"prepared Discord bootstrap validation failed: {active}")
    print("Discord bootstrap prepared for Vencord loader")


def install(resources: Path, candidate: Path) -> None:
    validate_openasar(candidate)
    active = resources / "_app.asar"
    backup = resources / "app.asar.backup"
    current = classify_active_bootstrap(active)

    if current == "openasar":
        if classify_discord_asar(backup) != "original":
            fail(f"cannot update OpenAsar without a valid original backup: {backup}")
        rollback = staged_copy(active, active)
        try:
            replace_from(candidate, active)
            if classify_discord_asar(active) != "openasar":
                fail(f"installed OpenAsar validation failed: {active}")
        except BaseException:
            os.replace(rollback, active)
            raise
        finally:
            rollback.unlink(missing_ok=True)
        print("OpenAsar updated; original Discord bootstrap preserved")
        return

    if backup.exists():
        fail(f"refusing to overwrite existing backup: {backup}")
    backup_stage = staged_copy(active, backup)
    candidate_stage = staged_copy(candidate, active)
    backup_created = False
    try:
        if classify_discord_asar(backup_stage) != "original":
            fail(f"active Discord bootstrap is not a valid original: {active}")
        os.replace(backup_stage, backup)
        backup_created = True
        os.replace(candidate_stage, active)
        if classify_discord_asar(active) != "openasar" or classify_discord_asar(backup) != "original":
            fail("OpenAsar installation validation failed")
    except BaseException:
        if backup_created and backup.exists():
            replace_from(backup, active)
            backup.unlink(missing_ok=True)
        raise
    finally:
        backup_stage.unlink(missing_ok=True)
        candidate_stage.unlink(missing_ok=True)
    print("OpenAsar installed; original Discord bootstrap backed up")


def keep(resources: Path) -> None:
    active = resources / "_app.asar"
    backup = resources / "app.asar.backup"
    current = classify_active_bootstrap(active)
    if current == "openasar":
        if classify_discord_asar(backup) != "original":
            fail(f"OpenAsar is active without a valid original backup: {backup}")
    elif backup.exists():
        fail(f"unexpected original backup while OpenAsar is inactive: {backup}")
    print(f"OpenAsar state kept ({current})")


def remove(resources: Path) -> None:
    active = resources / "_app.asar"
    backup = resources / "app.asar.backup"
    current = classify_active_bootstrap(active)
    if current == "original":
        if backup.exists():
            fail(f"unexpected original backup while OpenAsar is inactive: {backup}")
        print("OpenAsar already inactive")
        return
    if classify_discord_asar(backup) != "original":
        fail(f"cannot remove OpenAsar without a valid original backup: {backup}")
    rollback = staged_copy(active, active)
    try:
        replace_from(backup, active)
        if classify_discord_asar(active) != "original":
            fail(f"restored Discord bootstrap validation failed: {active}")
        backup.unlink()
    except BaseException:
        os.replace(rollback, active)
        raise
    finally:
        rollback.unlink(missing_ok=True)
    print("OpenAsar removed; original Discord bootstrap restored")


def main(argv: list[str]) -> None:
    if len(argv) < 3:
        fail(
            f"       {argv[0]} prepare-openasar <candidate>\n"
            f"usage: {argv[0]} <validate-openasar|validate-runtime> <candidate>\n"
            f"       {argv[0]} <prepare-loader|install|keep|remove> <resources> [candidate]\n"
            f"       {argv[0]} verify-chain <resources> <runtime> <auto|openasar|original>"
        )
    action = argv[1]
    if action == "prepare-openasar" and len(argv) == 3:
        prepare_openasar(Path(argv[2]))
        return
    if action == "validate-openasar" and len(argv) == 3:
        validate_openasar(Path(argv[2]))
        print("OpenAsar candidate verified")
        return
    if action == "validate-runtime" and len(argv) == 3:
        validate_runtime(Path(argv[2]))
        print("Vencord runtime candidate verified")
        return

    resources = require_resources(Path(argv[2]))
    if action == "prepare-loader" and len(argv) == 3:
        prepare_loader(resources)
    elif action == "install" and len(argv) == 4:
        install(resources, Path(argv[3]))
    elif action == "keep" and len(argv) == 3:
        keep(resources)
    elif action == "remove" and len(argv) == 3:
        remove(resources)
    elif action == "verify-chain" and len(argv) == 5:
        actual = validate_chain(resources, Path(argv[3]), argv[4])
        print(f"OpenAsar/Vencord chain verified ({actual})")
    else:
        fail(f"invalid arguments for action: {action}")


if __name__ == "__main__":
    main(sys.argv)

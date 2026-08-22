#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
python3 - "$ROOT/patches/update.patch" <<'PY'
from pathlib import Path
import subprocess
import sys
import tempfile

patch = Path(sys.argv[1]).read_text(encoding="utf-8")

index_diff = patch.split(
    "diff --git a/src/main/updater/index.ts b/src/main/updater/index.ts\n", 1
)[1]
index_diff = index_diff.split("\ndiff --git ", 1)[0]
added_index_lines = [
    line[1:] for line in index_diff.splitlines()
    if line.startswith("+") and not line.startswith("+++")
]
index_source = "\n".join(added_index_lines) + "\n"

git_diff = patch.split(
    "diff --git a/src/main/updater/git.ts b/src/main/updater/git.ts\n", 1
)[1]
git_diff = git_diff.split("\ndiff --git ", 1)[0]

# The packaged app is standalone. Execute the patched dispatcher with tiny
# updater modules so this catches routing regressions instead of merely
# matching the require expression as text.
def selected_updater(dispatcher: str, standalone: bool) -> str:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "index.js").write_text(dispatcher, encoding="utf-8")
        (root / "git.js").write_text(
            'process.stdout.write("git")\n', encoding="utf-8"
        )
        (root / "http.js").write_text(
            'process.stdout.write("http")\n', encoding="utf-8"
        )
        program = (
            "global.IS_UPDATER_DISABLED=false;"
            f"global.IS_STANDALONE={str(standalone).lower()};"
            "require('./index.js')"
        )
        return subprocess.check_output(
            ["node", "-e", program], cwd=root, text=True
        )

assert selected_updater(index_source, True) == "git"
assert selected_updater(index_source, False) == "git"

# Demonstrate that the former upstream dispatcher violates the packaged
# custom-updater contract: standalone checks and updates select ./http.
legacy_dispatcher = index_source.replace(
    'require("./git");',
    'require(IS_STANDALONE ? "./http" : "./git");',
)
assert selected_updater(legacy_dispatcher, True) == "http"

# Both check and update IPC operations are implemented by the selected module.
# GET_UPDATES resolves remote refs without a checkout; UPDATE intentionally
# defers mutation to BUILD, whose disposable checkout applies every overlay.
for handler in ("GET_REPO", "GET_UPDATES", "UPDATE"):
    assert f"IpcEvents.{handler}" in git_diff
assert "+    return CUSTOM_REPO;" in git_diff
assert '+    const { buildHash, overlayHash } = await resolveBuildInputs();' in git_diff
assert "+    // The actual update is performed by build() in a disposable workspace." in git_diff
assert '+const CUSTOM_OVERLAY_PATCHES = ["translate.patch", "update.patch", "userplugin-manager.patch", "runtime-noise.patch"]' in git_diff
assert "+        await applyOverlay(source);" in git_diff
assert "+ipcMain.handle(IpcEvents.BUILD, serializeErrors(() => build()));" in git_diff
assert "VENCORD_SRC_DIR" not in "\n".join(
    line[1:] for line in git_diff.splitlines() if line.startswith("+")
)

print("custom updater check/update routing checks passed")
PY

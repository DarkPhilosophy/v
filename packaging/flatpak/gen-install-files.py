#!/usr/bin/env python3
"""Write the .flatpakrepo and .flatpakref files for the self-hosted repository.

Usage: gen-install-files.py <output-dir>
The signing key is the public key committed next to this script (repo.gpg).
"""
import base64
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
key = base64.b64encode((here / "repo.gpg").read_bytes()).decode()
url = "https://darkphilosophy.github.io/v/flatpak/"
(out / "vencord-forge.flatpakrepo").write_text(f"""[Flatpak Repo]
Title=Vencord Forge
Url={url}
Homepage=https://darkphilosophy.github.io/v/
Comment=Vencord Forge, built and signed by the vencord custom project
Icon=https://darkphilosophy.github.io/v/brand/v-icon.svg
GPGKey={key}
""")
(out / "vencord-forge.flatpakref").write_text(f"""[Flatpak Ref]
Name=io.github.DarkPhilosophy.v
Branch=stable
Title=Vencord Forge
Url={url}
SuggestRemoteName=vencord-forge
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
GPGKey={key}
""")
print("wrote", out / "vencord-forge.flatpakrepo", out / "vencord-forge.flatpakref")

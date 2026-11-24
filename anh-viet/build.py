#!/usr/bin/env python3
"""Assemble Anh → Việt en un seul fichier anh-viet/index.html (CSS, JS et icônes intégrés).

La politique de sécurité (CSP) n'autorise que ce script et ce style précis (empreintes SHA-256)
et les appels vers Model Studio (…aliyuncs.com), ou vers un relais Cloudflare (….workers.dev).
L'AudioWorklet du micro est chargé depuis un blob : script-src l'autorise.

Usage : python3 anh-viet/build.py   (Python 3 et Pillow)
"""
import base64
import hashlib
import io
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"


def icon(size: int) -> str:
    img = Image.open(ROOT / "icon.png").convert("RGB").resize((size, size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()


def sha256(text: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode() + "'"


def main() -> None:
    js = "\n".join((SRC / f).read_text(encoding="utf-8") for f in ("dsp.js", "app.js"))
    css = (SRC / "style.css").read_text(encoding="utf-8")
    assert "</script" not in js.lower() and "</style" not in css.lower()

    csp = "; ".join([
        "default-src 'none'",
        f"script-src {sha256(js)} blob:",
        f"style-src {sha256(css)}",
        "img-src data:",
        "connect-src https://*.aliyuncs.com https://*.workers.dev",
        "base-uri 'none'",
        "form-action 'none'",
    ])
    html = (SRC / "index.html").read_text(encoding="utf-8")
    for key, value in {"__CSP__": csp, "__ICON180__": icon(180), "__ICON64__": icon(64)}.items():
        html = html.replace(key, value)
    # CSS et JS en dernier : ils ne doivent plus être modifiés après le calcul des empreintes.
    html = html.replace("<style>__CSS__</style>", "<style>" + css + "</style>")
    html = html.replace("<script>__JS__</script>", "<script>" + js + "</script>")
    (ROOT / "index.html").write_text(html, encoding="utf-8")
    print(f"anh-viet/index.html : {len(html.encode()) / 1024:.0f} Ko")


if __name__ == "__main__":
    main()

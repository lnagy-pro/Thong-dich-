#!/usr/bin/env python3
"""Assemble la web app en un seul fichier index.html (CSS, JS, icônes et prompt intégrés).

Le prompt est repris tel quel de l'app iPhone (ios/ThongDich/TranslationPrompt.swift) pour que
les deux versions traduisent exactement de la même façon. La politique de sécurité (CSP)
n'autorise que ce script et ce style précis (empreintes SHA-256) et les appels vers l'API Gemini.

Usage : python3 build.py   (Python 3 et Pillow)
"""
import base64
import hashlib
import io
import json
import pathlib
import re
import shutil

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
# L'app iPhone : dans ce dépôt (ios/), sinon à côté du dossier de la web app.
SWIFT = next(p for p in (ROOT / "ios" / "ThongDich", ROOT.parent / "ThongDich" / "ThongDich") if p.exists())


def swift_prompt() -> str:
    text = (SWIFT / "TranslationPrompt.swift").read_text(encoding="utf-8")
    body = re.search(r'static let system = """\n(.*?)\n\s*"""', text, re.S).group(1)
    return "\n".join(line[4:] if line.startswith("    ") else line for line in body.split("\n"))


def icon(size: int) -> str:
    img = Image.open(SWIFT / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon.png").convert("RGB")
    img = img.resize((size, size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()


def sha256(text: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode() + "'"


def main() -> None:
    prompt = swift_prompt()
    js = "\n".join((SRC / f).read_text(encoding="utf-8") for f in ("dsp.js", "voice.js", "app.js"))
    js = js.replace("__PROMPT__", json.dumps(prompt, ensure_ascii=False))
    css = (SRC / "style.css").read_text(encoding="utf-8")
    assert "</script" not in js.lower() and "</style" not in css.lower()

    csp = "; ".join([
        "default-src 'none'",
        f"script-src {sha256(js)} 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
        f"style-src {sha256(css)}",
        "img-src data:",
        "connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com https://cdn.jsdelivr.net",
        "worker-src blob:",
        "base-uri 'none'",
        "form-action 'none'",
    ])
    html = (SRC / "index.html").read_text(encoding="utf-8")
    for key, value in {
        "__CSP__": csp,
        "__ICON180__": icon(180),
        "__ICON64__": icon(64),
    }.items():
        html = html.replace(key, value)
    # CSS et JS en dernier : ils ne doivent plus être modifiés après le calcul des empreintes.
    html = html.replace("<style>__CSS__</style>", "<style>" + css + "</style>")
    html = html.replace("<script>__JS__</script>", "<script>" + js + "</script>")
    (ROOT / "index.html").write_text(html, encoding="utf-8")
    # Modèle de reconnaissance des voix, publié à côté de la page (déjà en place dans le dépôt).
    model = ROOT / "models" / "voix.onnx"
    if model.exists():
        shutil.copyfile(model, ROOT / "voix.onnx")
    print(f"index.html : {len(html.encode()) / 1024:.0f} Ko, prompt {len(prompt)} caractères")


if __name__ == "__main__":
    main()

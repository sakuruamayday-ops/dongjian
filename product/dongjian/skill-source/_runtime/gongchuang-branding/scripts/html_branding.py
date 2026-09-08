#!/usr/bin/env python3
"""Keep printable HTML free of publisher headers and watermarks."""
from __future__ import annotations
import argparse
import re
from pathlib import Path

def brand_html_text(source: str, *, has_cover: bool | None = None) -> str:
    del has_cover
    source = re.sub(r"""<style\b[^>]*\bid=["']gongchuang-public-brand-style["'][^>]*>.*?</style\s*>""", "", source, flags=re.I | re.S)
    source = re.sub(r"""<div\b[^>]*\bclass=["']gongchuang-(?:document-header|cover-signature)["'][^>]*>.*?</div\s*>""", "", source, flags=re.I | re.S)
    return source

def brand_html_file(path: str | Path, *, has_cover: bool | None = None) -> Path:
    path = Path(path)
    source = path.read_text(encoding="utf-8")
    result = brand_html_text(source, has_cover=has_cover)
    if result != source:
        path.write_text(result, encoding="utf-8")
    from delivery_gate import validate_artifact
    validate_artifact(path)
    return path

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--has-cover", action="store_true")
    print(brand_html_file(parser.parse_args().path))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

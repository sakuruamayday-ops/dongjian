#!/usr/bin/env python3
"""Finalize a neutral Office document without inserting publisher marks."""
from __future__ import annotations
import argparse
from pathlib import Path
from neutral_document import neutralize_office
from delivery_gate import validate_artifact

def apply_office_watermark(path: str | Path) -> Path:
    result = neutralize_office(path)
    validate_artifact(result, check_stamp=False)
    return result

def apply_docx_watermark(path: str | Path) -> Path:
    return apply_office_watermark(path)

def apply_xlsx_watermark(path: str | Path) -> Path:
    return apply_office_watermark(path)

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    print(apply_office_watermark(parser.parse_args().path))

if __name__ == "__main__":
    main()

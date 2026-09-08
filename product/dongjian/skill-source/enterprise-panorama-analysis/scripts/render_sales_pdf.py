#!/usr/bin/env python3
"""Render an unwatermarked white-background sales report."""

import argparse
from pathlib import Path

import pymupdf as fitz

from render_html_report import render_pdf_bytes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--html", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--title", required=True)
    parser.add_argument("--author", default="")
    args = parser.parse_args()

    if not args.html.is_file():
        raise FileNotFoundError(args.html)
    raw_pdf = render_pdf_bytes(args.html)
    document = fitz.open(stream=raw_pdf, filetype="pdf")
    metadata = document.metadata or {}
    metadata.update({
        "title": args.title,
        "author": args.author,
        "creator": args.author,
        "producer": "Document Renderer",
    })
    document.set_metadata(metadata)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    document.save(args.out, garbage=4, deflate=True)
    document.close()
    print(f"WROTE {args.out.resolve()}")


if __name__ == "__main__":
    main()

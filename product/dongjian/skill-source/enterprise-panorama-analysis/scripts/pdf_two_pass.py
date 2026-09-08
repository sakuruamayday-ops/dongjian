#!/usr/bin/env python3
"""Two-pass PDF branding: analyze each page, then place a centered watermark."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pymupdf as fitz

from brand_config import choose_style, load_config, relative_luminance


def _overlap_area(a: fitz.Rect, b: fitz.Rect) -> float:
    inter = a & b
    if inter.is_empty:
        return 0.0
    return max(0.0, inter.width) * max(0.0, inter.height)


def _page_luminance(page: fitz.Page) -> float:
    pix = page.get_pixmap(matrix=fitz.Matrix(0.10, 0.10), alpha=False, colorspace=fitz.csRGB)
    samples = pix.samples
    if not samples:
        return 1.0
    step = max(3, (len(samples) // 4500 // 3) * 3)
    total = [0, 0, 0]
    count = 0
    for i in range(0, len(samples) - 2, step):
        total[0] += samples[i]
        total[1] += samples[i + 1]
        total[2] += samples[i + 2]
        count += 1
    if not count:
        return 1.0
    rgb = tuple(round(value / count) for value in total)
    return relative_luminance(rgb)


def _occupied_rects(page: fitz.Page) -> list[fitz.Rect]:
    page_area = max(1.0, page.rect.width * page.rect.height)
    rects: list[fitz.Rect] = []

    for block in page.get_text("blocks"):
        if len(block) >= 5 and str(block[4]).strip():
            rect = fitz.Rect(block[:4]) & page.rect
            if not rect.is_empty:
                rects.append(rect)

    for drawing in page.get_drawings():
        rect = fitz.Rect(drawing.get("rect", fitz.Rect())) & page.rect
        area = max(0.0, rect.width) * max(0.0, rect.height)
        if not rect.is_empty and area / page_area < 0.82:
            rects.append(rect)

    for image in page.get_images(full=True):
        xref = image[0]
        for rect in page.get_image_rects(xref):
            rect = fitz.Rect(rect) & page.rect
            area = max(0.0, rect.width) * max(0.0, rect.height)
            if not rect.is_empty and area / page_area < 0.82:
                rects.append(rect)

    return rects


def _density(rects: list[fitz.Rect], page_rect: fitz.Rect) -> float:
    page_area = max(1.0, page_rect.width * page_rect.height)
    weighted = sum(min(rect.width * rect.height, page_area * 0.28) for rect in rects)
    return max(0.0, min(1.0, weighted / page_area))


def _centered_rect(page_rect: fitz.Rect, size: float) -> fitz.Rect:
    x0 = page_rect.x0 + (page_rect.width - size) / 2
    y0 = page_rect.y0 + (page_rect.height - size) / 2
    return fitz.Rect(x0, y0, x0 + size, y0 + size)


def brand_pdf_bytes(
    pdf_bytes: bytes,
    output_path: str | Path,
    *,
    variant: str | None = None,
) -> list[dict[str, Any]]:
    """Save the rendered document without inserting publisher marks."""
    del variant
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if document.is_encrypted or not document.page_count:
            raise ValueError("Expected an unencrypted PDF with pages")
        audit = [{"page": number + 1, "watermarks": 0} for number in range(document.page_count)]
    finally:
        document.close()
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("xb") as output:
        output.write(pdf_bytes)
    from validate_report_pdf import validate_pdf
    validate_pdf(output_path)
    return audit


def brand_pdf_file(input_path: str | Path, output_path: str | Path, *, variant: str | None = None):
    return brand_pdf_bytes(Path(input_path).read_bytes(), output_path, variant=variant)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf")
    parser.add_argument("output_pdf")
    parser.add_argument("--audit-json")
    parser.add_argument("--variant", choices=["gold"])
    args = parser.parse_args()
    audit = brand_pdf_file(args.input_pdf, args.output_pdf, variant=args.variant)
    if args.audit_json:
        Path(args.audit_json).write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "ok", "pages": len(audit), "audit": audit}, ensure_ascii=False))


if __name__ == "__main__":
    main()

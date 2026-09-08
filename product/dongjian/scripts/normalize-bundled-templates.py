"""Normalize the product-owned template copies, never user documents."""
from pathlib import Path
import sys

from docx import Document

SOURCE = Path(__file__).resolve().parents[1] / "skill-source"
sys.path.insert(0, str(SOURCE / "_runtime/gongchuang-branding/scripts"))
from neutral_document import neutralize_office
from delivery_gate import validate_artifact


def main():
    templates = sorted((SOURCE / "project-feasibility/assets/report-templates").rglob("*.docx"))
    if not templates:
        raise RuntimeError("Bundled report templates are missing")
    for path in templates:
        document = Document(path)
        # This is the inherited publisher cover title, not report body content.
        for paragraph in document.paragraphs[:6]:
            if paragraph.text.strip() == "共创研究院":
                element = paragraph._element
                element.getparent().remove(element)
        document.save(path)
        neutralize_office(path)
        validate_artifact(path)
        print(path.relative_to(SOURCE))
    print(f"Validated {len(templates)} bundled templates")


if __name__ == "__main__":
    main()

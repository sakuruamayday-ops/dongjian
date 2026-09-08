"""Remove only known publisher marks from generated Office templates."""
from __future__ import annotations

import hashlib
import os
import posixpath
import re
import tempfile
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from lxml import etree

ROOT = Path(__file__).resolve().parent.parent
IDENTITIES = {"共创研究院", "共创知识产权研究院", "共创知识产权"}
MARKERS = ("Gongchuang Institute", "_GONGCHUANG_INSTITUTE_")
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def legacy_asset_hashes() -> set[str]:
    assets = list((ROOT / "assets").glob("brand-*.png"))
    if not assets:
        raise ValueError("Missing document-mark reference assets")
    return {hashlib.sha256(path.read_bytes()).hexdigest() for path in assets}


def office_parts(path: Path) -> dict[str, bytes]:
    with ZipFile(path) as package:
        if len(package.infolist()) > 20000 or sum(row.file_size for row in package.infolist()) > 384 * 1024 * 1024:
            raise ValueError("Office package exceeds the document size limit")
        if len(set(package.namelist())) != len(package.namelist()):
            raise ValueError("Office package has duplicate entries")
        return {name: package.read(name) for name in package.namelist()}


def neutralize_office(path: str | Path) -> Path:
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.suffix.lower() not in {".docx", ".xlsx", ".xlsm", ".pptx"}:
        raise ValueError("Expected a regular Office document")
    parts = office_parts(path)
    hashes = legacy_asset_hashes()
    removed_media = {name for name, value in parts.items() if "/media/" in name and hashlib.sha256(value).hexdigest() in hashes}
    removed_refs: dict[str, set[str]] = {}
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    for name, value in list(parts.items()):
        if not name.endswith(".rels") or "/_rels/" not in name:
            continue
        owner_dir, rel_name = name.rsplit("/_rels/", 1)
        owner = owner_dir + "/" + rel_name[:-5]
        root = etree.fromstring(value, parser)
        changed = False
        for rel in list(root):
            raw_target = rel.get("Target", "")
            target = posixpath.normpath(raw_target.lstrip("/") if raw_target.startswith("/") else posixpath.join(owner_dir, raw_target))
            if target in removed_media and rel.get("TargetMode") != "External":
                removed_refs.setdefault(owner, set()).add(rel.get("Id", ""))
                root.remove(rel)
                changed = True
        if changed:
            parts[name] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    for name, value in list(parts.items()):
        if not name.endswith(".xml"):
            continue
        root = etree.fromstring(value, parser)
        changed = False
        refs = removed_refs.get(name, set())
        for node in list(root.iter()):
            if node.getparent() is None:
                continue
            attributes = " ".join(node.attrib.values())
            reference = node.get(f"{{{REL}}}embed") or node.get(f"{{{REL}}}id")
            marked = any(marker in attributes for marker in MARKERS) or reference in refs
            if marked:
                target = node
                for parent in node.iterancestors():
                    if etree.QName(parent).localname in {"drawing", "pict", "pic", "sp", "twoCellAnchor", "oneCellAnchor"}:
                        target = parent
                        if etree.QName(parent).localname in {"drawing", "pict", "twoCellAnchor", "oneCellAnchor"}:
                            break
                parent = target.getparent()
                if parent is not None:
                    parent.remove(target)
                    changed = True
            elif ("header" in name.lower() or "footer" in name.lower()) and any(identity in (node.text or "") for identity in IDENTITIES):
                node.text = ""
                changed = True
            elif name == "docProps/core.xml" and any(identity in (node.text or "") for identity in IDENTITIES):
                node.text = ""
                changed = True
            elif etree.QName(node).localname in {"oddHeader", "evenHeader", "firstHeader", "oddFooter", "evenFooter", "firstFooter"}:
                original = node.text or ""
                replacement = original
                for identity in sorted(IDENTITIES, key=len, reverse=True):
                    replacement = replacement.replace(identity, "")
                if re.fullmatch(r"(?:&[LCR]|&\d+|&K[0-9A-Fa-f]{6})*", replacement):
                    replacement = ""
                if replacement != original:
                    node.text = replacement
                    changed = True
        if changed:
            parts[name] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    for name in removed_media:
        parts.pop(name)
    handle, temporary = tempfile.mkstemp(prefix=".neutral-", suffix=path.suffix, dir=path.parent)
    os.close(handle)
    with ZipFile(temporary, "w", ZIP_DEFLATED) as package:
        for name, value in parts.items():
            package.writestr(name, value)
    os.replace(temporary, path)
    return path

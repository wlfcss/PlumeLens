"""Merge the export rating and keywords into a JPEG's existing XMP packet."""

from __future__ import annotations

import io
from typing import Never
from xml.dom import XMLNS_NAMESPACE, minidom
from xml.parsers import expat
from xml.sax.saxutils import escape, quoteattr

_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_XMP = "http://ns.adobe.com/xap/1.0/"
_XMP_NOTE = "http://ns.adobe.com/xmp/note/"
_KEYWORDS = (
    ("http://purl.org/dc/elements/1.1/", "dc", "subject"),
    ("http://ns.adobe.com/lightroom/1.0/", "lr", "hierarchicalSubject"),
)


class ExistingXmpError(ValueError):
    """The original packet cannot be merged without risking metadata loss."""


def _reject_doctype(*_args: object) -> Never:
    raise ExistingXmpError("XMP document types are unsupported")


def _parse_existing(packet: bytes) -> minidom.Document:
    # Refuse document types before DOM construction and entity expansion. Expat
    # also detects the original encoding, including a UTF-16 byte-order mark.
    parser = expat.ParserCreate()
    parser.StartDoctypeDeclHandler = _reject_doctype
    try:
        parser.Parse(packet, True)
        return minidom.parseString(packet)
    except (expat.ExpatError, LookupError, UnicodeError) as exc:
        raise ExistingXmpError("Could not parse existing XMP") from exc


def _children(parent: minidom.Element) -> list[minidom.Element]:
    return [child for child in parent.childNodes if isinstance(child, minidom.Element)]


def _descriptions(document: minidom.Document) -> list[minidom.Element]:
    root = document.documentElement
    if root is None:
        raise ExistingXmpError("Missing XMP document element")
    candidates = (
        [root] if root.namespaceURI == _RDF and root.localName == "RDF" else _children(root)
    )
    graphs = [node for node in candidates if node.namespaceURI == _RDF and node.localName == "RDF"]
    if len(graphs) != 1:
        raise ExistingXmpError("Expected one RDF graph in XMP")
    descriptions = _children(graphs[0])
    if not descriptions or any(
        node.namespaceURI != _RDF
        or node.localName != "Description"
        or node.hasAttributeNS(_RDF, "nodeID")
        or node.hasAttributeNS(_RDF, "ID")
        for node in descriptions
    ):
        raise ExistingXmpError("Unsupported XMP subject structure")
    if root.getElementsByTagNameNS(_XMP_NOTE, "HasExtendedXMP") or any(
        node.hasAttributeNS(_XMP_NOTE, "HasExtendedXMP") for node in descriptions
    ):
        raise ExistingXmpError("JPEG uses extended XMP")
    subjects = {node.getAttributeNS(_RDF, "about") for node in descriptions}
    if len(subjects) != 1:
        raise ExistingXmpError("Ambiguous XMP subjects")
    return descriptions


def _property(
    descriptions: list[minidom.Element], namespace: str, name: str
) -> minidom.Attr | minidom.Element | None:
    properties: list[minidom.Attr | minidom.Element] = []
    for node in descriptions:
        attr = node.getAttributeNodeNS(namespace, name)
        if attr is not None:
            properties.append(attr)
        properties.extend(
            child
            for child in _children(node)
            if child.namespaceURI == namespace and child.localName == name
        )
    if len(properties) > 1:
        raise ExistingXmpError(f"Duplicate XMP property {name}")
    return properties[0] if properties else None


def _append_property(
    parent: minidom.Element, namespace: str, prefix: str, name: str
) -> minidom.Element:
    document = parent.ownerDocument
    assert document is not None
    element = document.createElementNS(namespace, f"{prefix}:{name}")
    element.setAttributeNS(XMLNS_NAMESPACE, f"xmlns:{prefix}", namespace)
    parent.appendChild(element)
    return element


def _merge_rating(descriptions: list[minidom.Element], value: str) -> None:
    rating = _property(descriptions, _XMP, "Rating")
    if isinstance(rating, minidom.Attr):
        rating.value = value
        return
    if rating is None:
        rating = _append_property(descriptions[0], _XMP, "xmp", "Rating")
    if _children(rating) or rating.hasAttributeNS(_RDF, "resource"):
        raise ExistingXmpError("Unsupported structured XMP rating")
    document = rating.ownerDocument
    assert document is not None
    for child in list(rating.childNodes):
        if isinstance(child, minidom.Text):
            rating.removeChild(child)
    rating.appendChild(document.createTextNode(value))


def _keyword_bag(element: minidom.Attr | minidom.Element | None) -> minidom.Element:
    if isinstance(element, minidom.Element):
        children = _children(element)
        if (
            len(children) == 1
            and children[0].namespaceURI == _RDF
            and children[0].localName == "Bag"
        ):
            return children[0]
    raise ExistingXmpError("Unsupported XMP keyword array")


def _keyword_text(node: minidom.Element) -> str:
    return "".join(child.data for child in node.childNodes if isinstance(child, minidom.Text))


def _merge_keywords(descriptions: list[minidom.Element], template: list[minidom.Element]) -> None:
    for namespace, prefix, name in _KEYWORDS:
        incoming_bag = _keyword_bag(_property(template, namespace, name))
        existing = _property(descriptions, namespace, name)
        if existing is None:
            existing = _append_property(descriptions[0], namespace, prefix, name)
            bag = _append_property(existing, _RDF, "rdf", "Bag")
        else:
            bag = _keyword_bag(existing)
        present = {
            _keyword_text(node)
            for node in _children(bag)
            if node.namespaceURI == _RDF and node.localName == "li" and not _children(node)
        }
        document = bag.ownerDocument
        assert document is not None
        item_name = f"{bag.prefix}:li" if bag.prefix else "li"
        for node in _children(incoming_bag):
            value = _keyword_text(node)
            if value not in present:
                item = document.createElementNS(_RDF, item_name)
                item.appendChild(document.createTextNode(value))
                bag.appendChild(item)
                present.add(value)


def _write_xml(node: minidom.Node, output: io.StringIO) -> None:
    # minidom's serializer in Python 3.11/3.12 emits literal line breaks and
    # tabs in attributes, which a subsequent XML parse normalizes to spaces.
    if isinstance(node, minidom.Element):
        output.write(f"<{node.tagName}")
        for name, value in node.attributes.items():
            output.write(f" {name}={quoteattr(value)}")
        if not node.childNodes:
            output.write("/>")
            return
        output.write(">")
        for child in node.childNodes:
            _write_xml(child, output)
        output.write(f"</{node.tagName}>")
    elif isinstance(node, minidom.Text) and not isinstance(node, minidom.CDATASection):
        output.write(escape(node.data, {"\r": "&#13;"}))
    else:
        output.write(node.toxml())


MAX_SIDECAR_BYTES = 10 * 1024 * 1024


def merge_jpeg_xmp(existing: bytes, generated: str) -> bytes:
    """Replace Rating, append new keywords and retain all unrelated XMP fields."""
    try:
        document = _parse_existing(existing)
        descriptions = _descriptions(document)
        template = _descriptions(minidom.parseString(generated))
        value = template[0].getAttributeNS(_XMP, "Rating")
        _merge_rating(descriptions, value)
        _merge_keywords(descriptions, template)

        # Preserve namespace prefixes, including ones referenced by qualified
        # metadata values. Serialize as UTF-8 with the original packet PIs.
        output = io.StringIO()
        for child in document.childNodes:
            _write_xml(child, output)
        return output.getvalue().encode("utf-8")
    except (expat.ExpatError, RecursionError) as exc:
        raise ExistingXmpError("Could not safely merge XMP") from exc


def merge_xmp_sidecar(existing: bytes, generated: str) -> bytes:
    """Safely merge rating and deduplicated keywords into an existing XMP sidecar file."""
    if not existing or len(existing) > MAX_SIDECAR_BYTES:
        raise ExistingXmpError("Existing XMP sidecar is empty or exceeds safe merge limit")
    # Strip UTF-8 BOM if present so Expat/minidom parses cleanly.
    payload = existing[3:] if existing.startswith(b"\xef\xbb\xbf") else existing
    return merge_jpeg_xmp(payload, generated)

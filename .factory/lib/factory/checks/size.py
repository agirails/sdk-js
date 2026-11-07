"""K13: a file over 800 lines or a function over 120 lines. Only growth against the old version fails.

A function finding's key is its name, and the line in an anonymous TS function's name (`anonimna@<line>`) is not
counted, so a line added above does not change the key. Each head function is matched with one base function of the
same name: the only one with the only one, and when there are several (getter and setter, overload, callbacks of the
same call), with the one that kept most of its lines. Growth without a new line in the function (a deletion joins the
next body) has the same name in the base, so its key also carries the old length and the base match does not absorb
it. An unparsable base has no functions: codecheck reports it with a note and treats all its findings as new."""
from __future__ import annotations

import ast
import difflib
import re
from collections import defaultdict

from ..model import FileView, Finding, MeasureError, line_count, ordered
from .. import pyast, sol_lex, tsfacts
from . import CODE_LANGS, anchor

FILE_LIMIT = 800
FUNCTION_LIMIT = 120
FIX_FILE = "split the file by responsibility before adding to it"
FIX_FUNCTION = "extract parts into separate functions whose names say what they do"
ANONYMOUS = re.compile(r"anonimna@\d+")
Span = tuple[str, int, int]


def _python_spans(path: str, text: str) -> list[tuple[str, int, int]]:
    tree = pyast.parse(path, text)
    out: list[tuple[str, int, int]] = []

    def visit(node: ast.AST, scope: tuple[str, ...]) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = ".".join((*scope, child.name))
                out.append((name, child.lineno, child.end_lineno or child.lineno))
                visit(child, (*scope, child.name))
            elif isinstance(child, ast.ClassDef):
                visit(child, (*scope, child.name))
            else:
                visit(child, scope)

    visit(tree, ())
    return out


def spans(lang: str, path: str, text: str) -> list[tuple[str, int, int]]:
    """Functions as (name, first line, last line) for py, ts and sol; empty for other languages."""
    if lang == "py":
        return _python_spans(path, text)
    if lang == "ts":
        return [(item["name"], item["start"], item["end"]) for item in tsfacts.facts(path, text)["functions"]]
    if lang == "sol":
        return sol_lex.functions(text)
    return []


def _file(view: FileView) -> list[Finding]:
    count = line_count(view.text)
    old = None if view.old_text is None else line_count(view.old_text)
    if count <= FILE_LIMIT or (old is not None and count <= old):
        return []
    if view.added is not None and not view.added:
        return []
    line = FILE_LIMIT + 1 if view.added is None else min(view.added)
    before = "" if old is None else f", before {old}"
    return [Finding("K13", view.path, line, f"file has {count} lines (limit {FILE_LIMIT}{before})", FIX_FILE,
                    "datoteka")]


def _length(span: Span) -> int:
    return span[2] - span[1] + 1


def _identity(name: str) -> str:
    return ANONYMOUS.sub("anonimna", name)


def _base_spans(view: FileView) -> list[Span]:
    if view.old_text is None:
        return []
    try:
        return spans(view.lang, view.path, view.old_text)
    except MeasureError:
        return []


def _kept_lines(blocks: list[difflib.Match], old: Span, new: Span) -> int:
    total = 0
    for a, b, size in blocks:
        low = max(0, old[1] - 1 - a, new[1] - 1 - b)
        high = min(size - 1, old[2] - 1 - a, new[2] - 1 - b)
        total += max(0, high - low + 1)
    return total


def _match_group(heads: list[int], bases: list[int], head: list[Span], base: list[Span], blocks) -> dict[int, int]:
    if len(heads) == 1 and len(bases) == 1:
        return {heads[0]: bases[0]}
    scored = sorted(((-_kept_lines(blocks, base[b], head[h]), h, b) for h in heads for b in bases))
    pairs: dict[int, int] = {}
    for score, h, b in scored:
        if score < 0 and h not in pairs and b not in pairs.values():
            pairs[h] = b
    return pairs


def _base_lengths(view: FileView, head: list[Span]) -> list[int | None]:
    base = _base_spans(view)
    groups: defaultdict[str, tuple[list[int], list[int]]] = defaultdict(lambda: ([], []))
    for at, span in enumerate(head):
        groups[_identity(span[0])][0].append(at)
    for at, span in enumerate(base):
        groups[_identity(span[0])][1].append(at)
    blocks: list[difflib.Match] = []
    if any(len(heads) + len(bases) > 2 and heads and bases for heads, bases in groups.values()):
        matcher = difflib.SequenceMatcher(None, view.old_text.split("\n"), view.text.split("\n"), autojunk=False)
        blocks = matcher.get_matching_blocks()
    out: list[int | None] = [None] * len(head)
    for heads, bases in groups.values():
        for h, b in _match_group(heads, bases, head, base, blocks).items():
            out[h] = _length(base[b])
    return out


def _functions(view: FileView) -> list[Finding]:
    head = spans(view.lang, view.path, view.text)
    if not any(_length(span) > FUNCTION_LIMIT for span in head):
        return []
    out = []
    for (name, start, end), old in zip(head, _base_lengths(view, head)):
        length = end - start + 1
        if length <= FUNCTION_LIMIT or (old is not None and length <= old):
            continue
        line = anchor(view, start, end)
        if line is None:
            continue
        before = "" if old is None else f", before {old}"
        message = f"function {name} (line {start}) has {length} lines (limit {FUNCTION_LIMIT}{before})"
        out.append(Finding("K13", view.path, line, message, FIX_FUNCTION, _key(view, _identity(name), line, old)))
    return out


def _key(view: FileView, name: str, line: int, old: int | None) -> str:
    key = f"funkcija {name}"
    grew_without_new_line = old is not None and not (view.added and line in view.added)
    return f"{key}, narasla s {old}" if grew_without_new_line else key


def check(view: FileView) -> list[Finding]:
    """K13 findings for a code file; documentation and unknown languages are not measured."""
    if view.lang not in CODE_LANGS:
        return []
    return ordered(_file(view) + _functions(view))

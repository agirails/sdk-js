"""K13: datoteka preko 800 redaka ili funkcija preko 120 redaka. Pada samo rast u odnosu na staru verziju.

Ključ nalaza funkcije je njeno ime, a redak u imenu anonimne TS funkcije (`anonimna@<redak>`) se ne broji, pa redak
dodan iznad ne mijenja ključ. Svaka funkcija glave uparuje se s jednom funkcijom baze istog imena: jedina s jedinom, a
kad ih je više (getter i setter, overload, povratne funkcije istog poziva), s onom čiji su redci najvećim dijelom ostali
u njoj. Rast bez novog retka u funkciji (brisanje pripoji tijelo sljedeće) baza ima pod istim imenom, pa ključ takvog
rasta nosi i staru duljinu i uparivanje s bazom ga ne guta. Baza koja se ne može parsirati nema funkcija: codecheck je
javlja napomenom i sve nalaze u njoj drži novima."""
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
FIX_FILE = "podijeli datoteku po odgovornostima prije dodavanja"
FIX_FUNCTION = "izdvoji dijelove u zasebne funkcije čije ime kaže što rade"
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
    """Funkcije kao (ime, prvi redak, zadnji redak) za py, ts i sol; za ostale jezike prazno."""
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
    before = "" if old is None else f", prije {old}"
    return [Finding("K13", view.path, line, f"datoteka ima {count} redaka (granica {FILE_LIMIT}{before})", FIX_FILE,
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
        before = "" if old is None else f", prije {old}"
        message = f"funkcija {name} (redak {start}) ima {length} redaka (granica {FUNCTION_LIMIT}{before})"
        out.append(Finding("K13", view.path, line, message, FIX_FUNCTION, _key(view, _identity(name), line, old)))
    return out


def _key(view: FileView, name: str, line: int, old: int | None) -> str:
    key = f"funkcija {name}"
    grew_without_new_line = old is not None and not (view.added and line in view.added)
    return f"{key}, narasla s {old}" if grew_without_new_line else key


def check(view: FileView) -> list[Finding]:
    """K13 nalazi za datoteku koda; dokumentacija i nepoznati jezici se ne mjere."""
    if view.lang not in CODE_LANGS:
        return []
    return ordered(_file(view) + _functions(view))

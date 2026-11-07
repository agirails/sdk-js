"""K19: dodano isključivanje ili fokusiranje testa pada; manje asercija nego prije je upozorenje.

Pozicije dolaze iz AST-a (Python `pyast`, TypeScript `tsfacts` kroz ts_facts.cjs) i Solidity tokena, pa tekst u stringu
ne broji.
"""
from __future__ import annotations

import ast

from ..model import FileView, Finding, normalize, ordered
from .. import pyast, sol_lex, tsfacts
from . import anchor, is_test_path, line_text

PY_SKIPS = frozenset({
    "pytest.skip", "pytest.xfail", "pytest.mark.skip", "pytest.mark.skipif", "pytest.mark.xfail",
    "unittest.skip", "unittest.skipIf", "unittest.skipUnless", "unittest.expectedFailure", "unittest.SkipTest",
    "unittest.case.skip", "unittest.case.skipIf", "unittest.case.skipUnless", "unittest.case.SkipTest",
})
PY_ASSERT_CALLS = frozenset({"pytest.raises", "pytest.warns", "pytest.approx"})
FIX_SKIP = "pokreni test; ako ne prolazi, popravi kod ili test, a otvoreno pitanje vodi kao issue"
FIX_ASSERT = "vrati aserciju ili je zamijeni jačom; uklanjanje testa traži razlog u commitu"


def _aliases(tree: ast.Module) -> dict[str, str]:
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            for alias in node.names:
                out[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return out


def _dotted(node: ast.expr, aliases: dict[str, str]) -> str | None:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    return ".".join([aliases.get(node.id, node.id), *reversed(parts)])


def _python(path: str, text: str) -> tuple[list[tuple[int, str]], int]:
    tree = pyast.parse(path, text)
    aliases = _aliases(tree)
    inner = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    skips, assertions = [], 0
    for node in ast.walk(tree):
        if isinstance(node, (ast.Name, ast.Attribute)) and id(node) not in inner:
            name = _dotted(node, aliases)
            if name in PY_SKIPS:
                skips.append((node.lineno, name))
            elif isinstance(node, ast.Attribute) and node.attr == "skipTest":
                skips.append((node.lineno, "skipTest"))
        if isinstance(node, ast.Assert):
            assertions += 1
        elif isinstance(node, ast.Call):
            func = node.func
            last = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
            if last.startswith("assert") or _dotted(func, aliases) in PY_ASSERT_CALLS:
                assertions += 1
    return skips, assertions


def _facts(lang: str, path: str, text: str) -> tuple[list[tuple[int, str]], int]:
    if lang == "py":
        return _python(path, text)
    if lang == "ts":
        data = tsfacts.facts(path, text)
        return [(item["line"], item["name"]) for item in data["skips"]], data["assertions"]
    return [(line, "vm.skip") for line in sol_lex.calls(text, "vm", "skip")], sol_lex.assertion_count(text)


def check(view: FileView) -> list[Finding]:
    """K19 nalazi za testnu datoteku (Python, TypeScript/JavaScript, forge `.t.sol`)."""
    if view.lang not in ("py", "ts", "sol") or not is_test_path(view.path):
        return []
    skips, assertions = _facts(view.lang, view.path, view.text)
    out = []
    for line, name in skips:
        if anchor(view, line, line) is None:
            continue
        key = f"{name}: {normalize(line_text(view.text, line))}"
        out.append(Finding("K19", view.path, line, f"isključen ili fokusiran test ({name})", FIX_SKIP, key))
    if view.old_text is not None:
        _, before = _facts(view.lang, view.path, view.old_text)
        if assertions < before:
            out.append(Finding("K19", view.path, 0, f"broj asercija pao s {before} na {assertions}", FIX_ASSERT,
                               "asercije", "warning"))
    return ordered(out)

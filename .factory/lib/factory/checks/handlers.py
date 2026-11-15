"""K4: an error is not swallowed. Python through `pyast`, TypeScript through `tsfacts` (ts_facts.cjs), because eslint
`no-empty` exempts function bodies."""
from __future__ import annotations

import ast

from ..model import FileView, Finding, normalize, ordered
from .. import pyast, tsfacts
from . import anchor, line_text

BROAD = frozenset({"Exception", "BaseException"})
FIX_RAISE = "handle the error or re-raise it; catch an expected error as a specific type"
MESSAGES = {
    "bare": ("bare except without re-raise swallows every error", "catch a specific error and handle or re-raise it"),
    "base": ("except BaseException without re-raise swallows KeyboardInterrupt and SystemExit too",
             "catch a specific error or end the handler with raise"),
    "empty": ("empty except {name} swallows the error", FIX_RAISE),
    "fallback": ("except {name} returns a constant and swallows every error", FIX_RAISE),
    "suppress": ("contextlib.suppress({name}) swallows every error", "name the specific error you expect"),
    "catch": ("catch block without handling (empty or returns a constant) swallows the error",
              "handle the error or rethrow it"),
    "catch-callback": (".catch() handler without handling (empty or returns a constant) swallows the rejected Promise",
                       "handle or log the error, or pass it on"),
    "then-rejection": ("rejection handler in .then() without handling (empty or returns a constant) swallows the error",
                       "handle or log the error, or pass it on"),
}


def _names(node: ast.expr | None) -> list[str]:
    if node is None:
        return []
    if isinstance(node, ast.Tuple):
        return [name for item in node.elts for name in _names(item)]
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        return [node.attr]
    return []


def _constant(node: ast.expr | None) -> bool:
    return (node is None or isinstance(node, ast.Constant)
            or (isinstance(node, (ast.List, ast.Tuple, ast.Set)) and not node.elts)
            or (isinstance(node, ast.Dict) and not node.keys))


def _swallows(body: list[ast.stmt]) -> bool:
    return all(isinstance(stmt, (ast.Pass, ast.Continue))
               or (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant)) for stmt in body)


def _falls_back(body: list[ast.stmt]) -> bool:
    return isinstance(body[-1], ast.Return) and _constant(body[-1].value) and _swallows(body[:-1])


def _reraises(handler: ast.ExceptHandler) -> bool:
    return any(isinstance(node, ast.Raise) for stmt in handler.body for node in ast.walk(stmt))


def _is_suppress(node: ast.Call) -> bool:
    func = node.func
    called = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
    return called == "suppress" and any(name in BROAD for arg in node.args for name in _names(arg))


def _python(view: FileView) -> list[tuple[str, str, int, int]]:
    tree = pyast.parse(view.path, view.text)
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            caught = _names(node.type)
            label = (caught[0] if len(caught) == 1 else f"({', '.join(caught)})") if caught else "without type"
            if node.type is None and not _reraises(node):
                out.append(("bare", label, node.lineno, node.end_lineno or node.lineno))
            elif "BaseException" in caught and not _reraises(node):
                out.append(("base", label, node.lineno, node.end_lineno or node.lineno))
            elif _swallows(node.body):
                out.append(("empty", label, node.lineno, node.end_lineno or node.lineno))
            elif BROAD & set(caught) and _falls_back(node.body):
                out.append(("fallback", label, node.lineno, node.end_lineno or node.lineno))
        elif isinstance(node, ast.Call) and _is_suppress(node):
            label = ", ".join(name for arg in node.args for name in _names(arg))
            out.append(("suppress", label, node.lineno, node.end_lineno or node.lineno))
    return out


def _typescript(view: FileView) -> list[tuple[str, str, int, int]]:
    return [(item["kind"], "", item["start"], item["end"]) for item in tsfacts.facts(view.path, view.text)["handlers"]]


def check(view: FileView) -> list[Finding]:
    """K4 findings for a Python or TypeScript/JavaScript file, one per handler that swallows an error: the line is the
    handler's first new line, else its start. The base comparison in codecheck decides whether a finding is new."""
    if view.lang == "py":
        found = _python(view)
    elif view.lang == "ts":
        found = _typescript(view)
    else:
        return []
    out = []
    for kind, name, start, end in found:
        line = anchor(view, start, end) or start
        message, fix = MESSAGES[kind]
        key = f"{kind}: {normalize(line_text(view.text, start))}"
        out.append(Finding("K4", view.path, line, message.format(name=name), fix, key))
    return ordered(out)

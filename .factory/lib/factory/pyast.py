"""Jedino mjesto gdje code-check parsira Python: `parse` vraća ast.Module ili diže MeasureError s retkom greške."""
from __future__ import annotations

import ast

from .model import MeasureError


def parse(path: str, text: str) -> ast.Module:
    """AST Python datoteke; sintaksna greška ili NUL bajt je MeasureError, nikad prazan rezultat."""
    try:
        return ast.parse(text)
    except SyntaxError as exc:
        raise MeasureError(f"{path}: Python se ne može parsirati: {exc.msg} (redak {exc.lineno})") from exc
    except ValueError as exc:
        raise MeasureError(f"{path}: Python se ne može parsirati: {exc}") from exc

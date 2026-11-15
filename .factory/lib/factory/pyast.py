"""The only place where code-check parses Python: `parse` returns ast.Module or raises MeasureError with the line."""
from __future__ import annotations

import ast

from .model import MeasureError


def parse(path: str, text: str) -> ast.Module:
    """AST of a Python file; a syntax error or NUL byte is a MeasureError, never an empty result."""
    try:
        return ast.parse(text)
    except SyntaxError as exc:
        raise MeasureError(f"{path}: Python cannot be parsed: {exc.msg} (line {exc.lineno})") from exc
    except ValueError as exc:
        raise MeasureError(f"{path}: Python cannot be parsed: {exc}") from exc

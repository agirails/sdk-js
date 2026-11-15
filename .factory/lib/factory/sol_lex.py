"""The only Solidity lexer in code-check: code tokens, comments with curly-brace depth, and string spans.

Used by the comment check (K2/K3) and the function and call checks (K13, K19), so all read strings and comments alike.
"""
from __future__ import annotations

import re
from typing import NamedTuple

from .model import MeasureError

IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
NUMBER = re.compile(r"0[xX][0-9a-fA-F_]*|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE]-?[0-9_]+)?")
STRING_PREFIXES = frozenset({"unicode", "hex"})
CONTAINERS = frozenset({"contract", "library", "interface"})
FUNCTION_WORDS = frozenset({"function", "modifier", "constructor", "fallback", "receive"})


class Token(NamedTuple):
    """Token: kind (`ident`, `number`, `string`, `punct`, `comment`), text (empty for a string), start line,
    character span [start, stop) and curly-brace depth at the start of the token."""
    kind: str
    text: str
    line: int
    start: int = 0
    stop: int = 0
    depth: int = 0


class Lexed(NamedTuple):
    """All tokens with comments, and the first problem (unclosed string or block comment); None when there is none."""
    tokens: list[Token]
    problem: str | None


def _string_end(text: str, start: int) -> tuple[int, bool]:
    quote, index, size = text[start], start + 1, len(text)
    while index < size and text[index] != quote:
        if text[index] == "\n":
            return index, False
        index += 2 if text[index] == "\\" else 1
    return (index + 1, True) if index < size else (size, False)


def _comment_end(text: str, start: int) -> tuple[int, bool]:
    if text.startswith("//", start):
        end = text.find("\n", start)
        return (len(text) if end < 0 else end), True
    end = text.find("*/", start + 2)
    return (len(text), False) if end < 0 else (end + 2, True)


def lex(text: str) -> Lexed:
    """Tokens of the whole text, and comments. An unclosed string runs to line end, a block comment to text end."""
    out: list[Token] = []
    problem: str | None = None
    index, size, line, depth = 0, len(text), 1, 0
    while index < size:
        char = text[index]
        if char.isspace():
            line, index = line + (char == "\n"), index + 1
            continue
        if text.startswith(("//", "/*"), index):
            stop, closed = _comment_end(text, index)
            out.append(Token("comment", text[index:stop], line, index, stop, depth))
            problem = problem or (None if closed else f"unclosed block comment on line {line}")
        elif char in "\"'":
            stop, closed = _string_end(text, index)
            out.append(Token("string", "", line, index, stop, depth))
            problem = problem or (None if closed else f"unclosed string on line {line}")
        elif (match := IDENT.match(text, index)) is not None:
            stop = match.end()
            if not (match.group() in STRING_PREFIXES and stop < size and text[stop] in "\"'"):
                out.append(Token("ident", match.group(), line, index, stop, depth))
        elif (match := NUMBER.match(text, index)) is not None:
            stop = match.end()
            out.append(Token("number", match.group(), line, index, stop, depth))
        else:
            stop = index + 1
            out.append(Token("punct", char, line, index, stop, depth))
            depth += (char == "{") - (char == "}")
        line += text.count("\n", index, stop)
        index = stop
    return Lexed(out, problem)


def tokens(text: str) -> list[Token]:
    """Code tokens without comments. An unclosed string or block comment is a MeasureError."""
    lexed = lex(text)
    if lexed.problem:
        raise MeasureError(f"Solidity: {lexed.problem}")
    return [token for token in lexed.tokens if token.kind != "comment"]


def _is(token: Token, text: str) -> bool:
    return token.kind == "punct" and token.text == text


def _body(toks: list[Token], start: int) -> tuple[int, int] | None:
    depth = 0
    for index in range(start + 1, len(toks)):
        token = toks[index]
        if _is(token, "("):
            depth += 1
        elif _is(token, ")"):
            depth -= 1
            if depth < 0:
                return None
        elif depth == 0 and _is(token, ";"):
            return None
        elif depth == 0 and _is(token, "{"):
            return index, _closing(toks, index)
    return None


def _closing(toks: list[Token], open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(toks)):
        if _is(toks[index], "{"):
            depth += 1
        elif _is(toks[index], "}"):
            depth -= 1
            if depth == 0:
                return index
    raise MeasureError(f"Solidity: unmatched curly brace on line {toks[open_index].line}")


def _name(toks: list[Token], index: int) -> str:
    word = toks[index].text
    if word in ("function", "modifier") and index + 1 < len(toks) and toks[index + 1].kind == "ident":
        return toks[index + 1].text
    return word


def functions(text: str) -> list[tuple[str, int, int]]:
    """Functions with a body as (name, first line, last line); the name is `Contract.function` inside a contract."""
    toks = tokens(text)
    out: list[tuple[str, int, int]] = []
    scopes: list[tuple[str, int]] = []
    pending: str | None = None
    depth = 0
    for index, token in enumerate(toks):
        if token.kind == "ident" and token.text in CONTAINERS and index + 1 < len(toks) and toks[index + 1].kind == "ident":
            pending = toks[index + 1].text
        elif _is(token, "{"):
            depth += 1
            if pending is not None:
                scopes.append((pending, depth))
                pending = None
        elif _is(token, "}"):
            if scopes and scopes[-1][1] == depth:
                scopes.pop()
            depth -= 1
        elif token.kind == "ident" and token.text in FUNCTION_WORDS and not (index and _is(toks[index - 1], ".")):
            span = _body(toks, index)
            if span is not None:
                name = _name(toks, index)
                qualified = f"{scopes[-1][0]}.{name}" if scopes else name
                out.append((qualified, token.line, toks[span[1]].line))
    return out


def calls(text: str, receiver: str, method: str) -> list[int]:
    """Lines of `receiver.method(` calls by tokens, so text in a string or comment does not count."""
    toks = tokens(text)
    return [toks[i].line for i in range(len(toks) - 3)
            if toks[i].kind == "ident" and toks[i].text == receiver and _is(toks[i + 1], ".")
            and toks[i + 2].kind == "ident" and toks[i + 2].text == method and _is(toks[i + 3], "(")]


def assertion_count(text: str) -> int:
    """Count of `assert*(` and `vm.expectRevert(`/`vm.expectEmit(` calls in a forge test."""
    toks = tokens(text)
    count = 0
    for index in range(len(toks) - 1):
        token = toks[index]
        if token.kind != "ident" or not _is(toks[index + 1], "("):
            continue
        if token.text.startswith("assert") or (token.text in ("expectRevert", "expectEmit")
                                                and index and _is(toks[index - 1], ".")):
            count += 1
    return count

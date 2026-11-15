"""YAML lexer for the comment check (K3): spans of `#` comments outside strings and block scalars.

`#` is a comment at line start or after a space, so `url#anchor` is not a comment. In one pass the lexer tracks
whether a node may start here: at line start, after `---`, after `: `, `- ` and `? ` at line start, after a node
property (`&anchor`, `!tag`), and after `[`, `{`, `,` and `:` inside a flow collection. Only there a quote opens a
string, `[` and `{` a flow collection, and `|` or `>` a block scalar; any other character opens a plain scalar, so
`don't` and `a, 'b` are text. A line indented deeper than the parent of an open plain scalar continues that scalar
and is not a node start; a comment, `: `, `,` and the end of a flow collection close the plain scalar. Quotes (`'`
with `''` inside, `"` with `\\` escape) span lines. A block scalar (indentation and chomping indicators in any order)
lasts while a line is empty or indented at least to the content indentation; the first non-empty line with less
indentation closes it; a comment in the block header stays a comment. An unclosed quote is a MeasureError, because
the comments after it would stay unchecked."""
from __future__ import annotations

import re

from .model import MeasureError

BLOCK_HEADER = re.compile(r"[|>](?:([1-9])[+-]?|[+-]([1-9])?)?(?=[ \t]*\r?(?:\n|\Z)|[ \t]+#)")
NODE_PROPERTIES = re.compile(r"(?:(?<=[ \t])[&!][^ \t]*[ \t]+)+\Z")
INDICATORS = re.compile(r"[ \t]*(?:[-?][ \t]+)*")
SPACES = re.compile(r" *")
BLANKS = re.compile(r"[ \t]*")
WORD = re.compile(r"[^ \t\r\n]*")


def comments(text: str) -> list[tuple[int, int]]:
    """Spans [start, stop) of `#` comments, stop is the end of the line; an unclosed quote is a MeasureError."""
    return _Lexer(text).run()


def _blank(text: str, i: int) -> bool:
    return i >= len(text) or text[i] in " \t\r\n"


class _Lexer:
    def __init__(self, text: str) -> None:
        self.text, self.raw = text, []
        self.quote, self.flow, self.node, self.lead = None, 0, True, True
        self.plain: int | None = None
        self.parent: int | None = None

    def run(self) -> list[tuple[int, int]]:
        text, n = self.text, len(self.text)
        i = self._line(0)
        while i < n:
            ch = text[i]
            if self.quote:
                i, self.quote = _quoted(text, i, self.quote)
            elif ch == "\n":
                i = self._line(i + 1)
            elif ch in " \t\r":
                i += 1
            elif ch == "#" and (i == 0 or text[i - 1] in " \t\n"):
                stop = text.find("\n", i)
                stop = n if stop < 0 else stop
                self.raw.append((i, stop))
                self.plain, i = None, stop
            else:
                i = self._token(i, ch)
        if self.quote:
            raise MeasureError(f"YAML string {self.quote} without an end")
        return self.raw

    def _line(self, start: int) -> int:
        self.lead = False
        text = self.text
        first = BLANKS.match(text, start).end()
        if self.flow or first >= len(text) or text[first] in "\r\n#":
            return first
        width = SPACES.match(text, start).end() - start
        if self.plain is not None:
            if self.parent is None:
                self.parent = _parent_indent(text[text.rfind("\n", 0, self.plain) + 1:self.plain])
            if width > self.parent:
                self.node = False
                return first
        self.node, self.lead, self.plain, self.parent = True, True, None, None
        if width == 0 and text.startswith(("---", "..."), start) and _blank(text, start + 3):
            self.lead = False
            return start + 3
        return first

    def _token(self, i: int, ch: str) -> int:
        text, node, lead = self.text, self.node, self.lead
        self.lead = False
        if ch in "]}":
            self.flow, self.node, self.plain = max(self.flow - 1, 0), False, None
        elif ch in "[{" and (self.flow or node):
            self.flow, self.node, self.plain = self.flow + 1, True, None
        elif (self.flow and ch in ",:") or (ch == ":" and _blank(text, i + 1)):
            self.node, self.plain = True, None
        elif not node:
            return i + 1
        elif ch in "-?" and lead and _blank(text, i + 1):
            self.lead = True
        elif ch in "&!":
            return WORD.match(text, i).end()
        elif ch in "'\"":
            self.quote, self.node = ch, False
        elif ch in "|>" and not self.flow and (header := BLOCK_HEADER.match(text, i)):
            self.plain = None
            return _block(text, i, header, self.raw)
        else:
            self.node, self.plain, self.parent = False, i, None
        return i + 1


def _quoted(text: str, i: int, quote: str) -> tuple[int, str | None]:
    if (quote == "'" and text.startswith("''", i)) or (quote == '"' and text[i] == "\\"):
        return i + 2, quote
    return i + 1, None if text[i] == quote else quote


def _parent_indent(line: str) -> int:
    lead = INDICATORS.match(line).end()
    if lead < len(NODE_PROPERTIES.sub("", line)):
        return lead
    marks = [k for k, c in enumerate(line[:lead]) if c in "-?"]
    return marks[-1] if marks else lead - 1


def _block(text: str, i: int, header: re.Match[str], raw: list[tuple[int, int]]) -> int:
    eol = text.find("\n", i)
    eol = len(text) if eol < 0 else eol
    mark = text.find("#", header.end(), eol)
    if mark >= 0:
        raw.append((mark, eol))
    parent = _parent_indent(text[text.rfind("\n", 0, i) + 1:i])
    explicit = header.group(1) or header.group(2)
    return _block_end(text, eol, parent, parent + int(explicit) if explicit else None)


def _block_end(text: str, pos: int, parent: int, indent: int | None) -> int:
    n = len(text)
    while pos < n:
        start = pos + 1
        pos = text.find("\n", start)
        pos = n if pos < 0 else pos
        body = text[start:pos].lstrip(" ")
        if not body.strip():
            continue
        width = pos - start - len(body)
        indent = max(width, parent + 1) if indent is None else indent
        if width < indent:
            return start - 1
    return n

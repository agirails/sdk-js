"""K2/K3 provjera komentara, uz oblik direktiva (K5) i oznaku zastarjelosti bez datuma uklanjanja (K15).

Komentari se nalaze tokenizerom po jeziku, nikad regexom po retku: Python `tokenize` + `ast`, TS/JS kroz
`tsfacts` (pinani TypeScript, jedan node proces po pozivu), Solidity kroz `sol_lex`, YAML kroz `yaml_lex`, a shell
te `#` komentari TOML-a i Makefilea kroz male lexere ovdje. Uzastopni redni komentari su jedan komentar. Dopušteni
su doc komentari na javnom API-ju, dokumentacija modula, direktive s pravilom i razlogom, `factory-allow` i
`EXTERNAL(<ovisnost>): <pravilo> <url>`; sve ostalo je K2. U konfiguraciji (YAML, TOML, Makefile) vrijedi samo K3.
Datoteka koju parser ili lexer ne pročita do kraja je MeasureError, jer bi komentari iza mjesta greške ostali
neprovjereni. Isključenje ispravnosnog pravila (standard/configs/rule-classes.toml; pravilo ili alat kojeg tamo nema
vrijedi kao ispravnosno) traži `factory-allow` (K5). mypy direktivu čita kao mypy: redak koji počinje s `# mypy: `
vrijedi i unutar višerednog stringa, a opcije se dijele zarezom izvan dvostrukih navodnika (jednostruki su obični
znak). K3 fraza se traži preko granica redaka; riječ prelomljena crticom na kraju retka je jedna riječ.
"""
from __future__ import annotations

import ast, bisect, io, re, tokenize, tomllib
from dataclasses import dataclass, replace
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from . import layout, pyast, sol_lex, tsfacts, yaml_lex
from .model import FileView, Finding, MeasureError, normalize, ordered

RULE_CLASSES = layout.RULE_CLASSES
CONFIG_LANGS = frozenset({"yaml", "toml", "make"})

K3 = re.compile(r"""
    \bfor\ now\b
  | (?-i:\b(?:TODO|FIXME|XXX)\b) | \b(?:todo|fixme)\s*[:(]
  | \bhack(?:s|y|ed|ish)?\b | \bklud?ges?\b | \bband-?aids?\b | \bquick[- ]fix(?:es)?\b
  | (?<!\bno\ )(?<!\bwithout\ )\bwork[-\ ]?arounds?\b(?!\ mode)
  | \btemporary\ (?:fix(?:es)?|solutions?|hacks?|patch(?:es)?|workarounds?)\b
  | \btemporarily\ (?:disabled?|skip\w*|hard-?coded|commented\ out|removed|bypass\w*)\b
  | \bprivremen\w*\ rješenj\w* | \bza\ sada\b | \bzasad\b | \bzaobila\w*
""", re.I | re.X)
CONSTRAINT = re.compile(r"""
    (?-i:\bIMPORTANT\b) | \bimportant\s*:
  | \bdo\ not\ (?:remove|change|touch|modify|delete)\b | \bdon'?t\ (?:remove|change|touch|modify|delete)\b
  | \bne\ (?:diraj|dirati|mijenjaj|mijenjati|briši|brisati)\b | \bpazi(?:te)?\b | \bbe\ careful\b
""", re.I | re.X)
DEPRECATED = re.compile(r"^[ \t]*(?:/\*\*|\*|///|//|#)?[ \t]*(@deprecated|@custom:deprecated|\.\. deprecated::)"
                        r"(.*?)(?=\n[ \t]*\*?[ \t]*@|\Z)", re.S | re.M)
ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
EXTERNAL = re.compile(r"EXTERNAL\([^)\s]+\):\s*\S.*?\s(https?://\S+)", re.S)
ALLOW_FIELD = re.compile(r"\b(razlog|do|odobrio)=")
RULE_ID = re.compile(r"[KSP]\d+")

FIX_K3 = "riješi to u kodu ili otvori issue, pa obriši komentar"
FIX_K2 = "izrazi to imenom, strukturom ili testom; pozadinu odluke zapiši u zapis odluke, pa obriši komentar"
FIX_CONSTRAINT = "kodiraj ograničenje (tip, assert, test, lint), pa obriši komentar"
FIX_DOC = "dokumentiraj samo javni API; ovdje namjeru izrazi imenom ili testom, pa obriši komentar"
FIX_ORPHAN = "premjesti ga neposredno iznad javne deklaracije ili ga obriši"
FIX_EXTERNAL = "napiši EXTERNAL(<ovisnost>): <pravilo> <url> ili ograničenje kodiraj tipom, assertom ili testom"
FIX_ALLOW = "napiši factory-allow <PRAVILO> razlog=<zašto> do=YYYY-MM-DD odobrio=<ime>"
FIX_ESLINT = "napiši eslint-disable-next-line <pravilo> -- <razlog>"
FIX_CORRECTNESS = ("popravi kod umjesto isključenja; ako je isključenje nužno, iznad njega napiši "
                   "factory-allow K5 razlog=<zašto> do=YYYY-MM-DD odobrio=<ime>")
FIX_FILE_TYPES = "ispravi tipove i obriši direktivu"
FIX_BIOME = "napiši biome-ignore <kategorija>: <razlog>"
ESLINT_RULES = re.compile(r"\s+([@\w][@\w/-]*(?:\s*,\s*[@\w][@\w/-]*)*)")
ESLINT_ITEM = re.compile(r",\s*(?=[@\w][@\w/-]*\s*:)")
ESLINT_ON = re.compile(r"""(?:"error"|'error'|error|2|\[\s*(?:"error"|'error'|2)\s*\])""")
NOQA_CODES = re.compile(r":\s*([A-Z]+\d+(?:[\s,]+[A-Z]+\d+)*)")
TYPE_CODES = re.compile(r"\[[\w\-, ]+\]")
REASON = re.compile(r"[\s:]*(?:--\s*)?\S", re.S)
BIOME = re.compile(r"\s+([\w/.-]+(?:\([^)]*\))?(?:\s+[\w/.-]+(?:\([^)]*\))?)*)?\s*(:\s*\S)?", re.S)
OPTION_ITEM = re.compile(r"""(?:"[^"]*"|[^,])+""")
OPTION = re.compile(r"""\s*([A-Za-z][\w-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"',=]+)\s*)?""")
ERROR_CODES = re.compile(r"[\w-]+(?:\s*,\s*[\w-]+)*")
MYPY_RAW = "# mypy: "
MYPY_STRICT = re.compile(r"strict(?:-[\w-]+)?|warn-[\w-]+|disallow-[\w-]+|check-untyped-defs"
                         r"|no-implicit-(?:optional|reexport)|extra-checks|local-partial-types")
PYRIGHT_SWITCH = re.compile(r"strict\w+")
PYRIGHT_RULE = re.compile(r"report\w+")


def _problem(message: str, fix: str):
    return lambda rest: [(message, fix)]


def _named(tool: str, pattern: str, message: str, fix: str):
    check = re.compile(pattern, re.S)

    def judge(rest: str):
        names = check.match(rest)
        return _correctness(tool, re.split(r"[\s,]+", names.group(1))) if names else [(message, fix)]
    return judge


@lru_cache(maxsize=1)
def rule_classes(path: Path = RULE_CLASSES) -> dict[str, dict[str, frozenset[str]]]:
    """Stilska i ispravnosna pravila po alatu iz rule-classes.toml; nečitljiva datoteka je MeasureError."""
    try:
        data = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise MeasureError(f"{Path(path).name} nije čitljiv: {exc}") from exc
    out = {}
    for tool in ("eslint", "ruff", "biome"):
        section = data.get(tool)
        if not isinstance(section, dict) or not all(isinstance(section.get(k), list) for k in ("style", "correctness")):
            raise MeasureError(f"{Path(path).name}: [{tool}] mora imati popise style i correctness")
        out[tool] = {k: frozenset(section[k]) for k in ("style", "correctness")}
    return out


def _is_style(tool: str, rule: str) -> bool:
    if tool not in rule_classes():
        return False
    classes = rule_classes()[tool]
    if tool == "eslint":
        return rule in classes["style"] and rule not in classes["correctness"]
    prefixes = sorted((p for kind in ("style", "correctness") for p in classes[kind] if rule.startswith(p)),
                      key=len, reverse=True)
    return bool(prefixes) and prefixes[0] in classes["style"]


def _correctness(tool: str, rules: Iterable[str]) -> list[tuple[str, str]]:
    return [(f"isključenje ispravnosnog pravila {rule} bez factory-allow", FIX_CORRECTNESS)
            for rule in rules if not _is_style(tool, rule)]


def _eslint(rest: str):
    names = ESLINT_RULES.match(rest)
    if not names:
        return [("eslint-disable bez imena pravila", FIX_ESLINT)]
    if not re.search(r"\s--\s*\S", rest):
        return [("eslint-disable bez razloga", FIX_ESLINT)]
    return _correctness("eslint", re.split(r"\s*,\s*", names.group(1)))


def _noqa(rest: str):
    codes = NOQA_CODES.match(rest)
    if not codes:
        return [("noqa bez koda pravila", "napiši # noqa: <KOD>")]
    return _correctness("ruff", re.split(r"[\s,]+", codes.group(1)))


def _eslint_config(rest: str):
    config, _, reason = rest.partition("--")
    if not reason.strip():
        return [("eslint konfiguracija u komentaru bez razloga", FIX_ESLINT)]
    items = [item.split(":", 1) for item in ESLINT_ITEM.split(config.strip())]
    return _correctness("eslint", [name.strip() for name, value in items if not ESLINT_ON.fullmatch(value.strip())])


def _typed(name: str):
    def check(rest: str):
        if not TYPE_CODES.match(rest):
            return [(f"{name} bez koda greške", f"napiši # {name}[<kod>] ili ispravi tip")]
        return [(f"isključenje provjere tipova ({name}) bez factory-allow", FIX_CORRECTNESS)]
    return check


def _expect_error(rest: str):
    if not REASON.match(rest):
        return [("@ts-expect-error bez razloga", "napiši @ts-expect-error <razlog>")]
    return [("isključenje provjere tipova (@ts-expect-error) bez factory-allow", FIX_CORRECTNESS)]


def _mypy_strong(name: str, value: str | None) -> bool:
    plain = None if value is None else value.removeprefix('"').removesuffix('"').strip()
    if name == "enable-error-code":
        return bool(plain and ERROR_CODES.fullmatch(plain))
    return bool(MYPY_STRICT.fullmatch(name)) and (plain is None or plain.lower() == "true")


def _pyright_strong(name: str, value: str | None) -> bool:
    if name == "strict":
        return value is None
    if PYRIGHT_SWITCH.fullmatch(name):
        return value == "true"
    return bool(PYRIGHT_RULE.fullmatch(name)) and value in ("true", "error")


def _whole_file(tool: str, strong, rest: str):
    items = [item.strip() for item in OPTION_ITEM.findall(rest) if item.strip()]
    if not items:
        return [(f"{tool}: direktiva bez opcija", FIX_FILE_TYPES)]
    weak = [item for item, option in ((item, OPTION.fullmatch(item)) for item in items)
            if not option or not strong(option.group(1), option.group(2))]
    if not weak:
        return []
    return [(f"{tool}: {', '.join(weak)} isključuje provjeru tipova za cijelu datoteku", FIX_FILE_TYPES)]


def _mypy(rest: str):
    return _whole_file("mypy", _mypy_strong, rest)


def _pyright(rest: str):
    return _whole_file("pyright", _pyright_strong, rest)


def _biome(rest: str):
    match = BIOME.match(rest)
    if not match or not match.group(1):
        return [("biome-ignore bez imena pravila", FIX_BIOME)]
    if not match.group(2):
        return [("biome-ignore bez razloga", FIX_BIOME)]
    return _correctness("biome", [re.sub(r"\(.*\)$", "", name) for name in match.group(1).split()])


def _ok(rest: str):
    return []


DIRECTIVES = (
    (re.compile(r"eslint-disable(?:-next-line|-line)?\b(.*)", re.S), _eslint),
    (re.compile(r"@ts-ignore\b(.*)", re.S), _problem("@ts-ignore isključuje provjeru tipova bez razloga",
                                                    "ispravi tip ili napiši @ts-expect-error <razlog>")),
    (re.compile(r"@ts-nocheck\b(.*)", re.S), _problem("@ts-nocheck isključuje provjeru tipova za cijelu datoteku",
                                                     "ispravi tipove i obriši direktivu")),
    (re.compile(r"@ts-expect-error\b(.*)", re.S), _expect_error),
    (re.compile(r"eslint\s+([@\w][@\w/-]*\s*:.*)", re.S), _eslint_config),
    (re.compile(r"biome-ignore(?:-all|-start)?(?![\w-])(.*)", re.S), _biome),
    (re.compile(r"(?:flake8:\s*)?noqa\b(.*)", re.S | re.I), _noqa),
    (re.compile(r"type:\s*ignore\b(.*)", re.S), _typed("type: ignore")),
    (re.compile(r"pyright:\s*ignore\b(.*)", re.S), _typed("pyright: ignore")),
    (re.compile(r"mypy:(.*)", re.S), _mypy),
    (re.compile(r"pyright:(.*)", re.S), _pyright),
    (re.compile(r"pylint:\s*disable(?:-next)?\b(.*)", re.S), _named(
        "pylint", r"\s*=\s*([\w-]+(?:\s*,\s*[\w-]+)*)", "pylint: disable bez imena pravila",
        "napiši # pylint: disable=<pravilo>")),
    (re.compile(r"solhint-disable(?:-next-line|-line)?\b(.*)", re.S), _named(
        "solhint", r"\s+([\w-]+(?:\s*,\s*[\w-]+)*)", "solhint-disable bez imena pravila",
        "napiši solhint-disable-next-line <pravilo>")),
    (re.compile(r"slither-disable(?:-next-line|-start|-end)?\b(.*)", re.S), _named(
        "slither", r"\s+([\w-]+(?:\s*,\s*[\w-]+)*)", "slither-disable bez imena detektora",
        "napiši slither-disable-next-line <detektor>")),
    (re.compile(r"shellcheck\s+disable\b(.*)", re.S), _named(
        "shellcheck", r"=(SC\d+(?:\s*,\s*SC\d+)*)", "shellcheck disable bez koda",
        "napiši # shellcheck disable=SC<broj>")),
    (re.compile(r"nosec\b(.*)", re.S), _named(
        "bandit", r"[\s:]+([A-Z]+\d+(?:[\s,]+[A-Z]+\d+)*)", "nosec bez koda pravila", "napiši # nosec <KOD>")),
    (re.compile(r"""(?:eslint-enable|eslint-env\s|@ts-check\b|prettier-ignore|(?:istanbul|c8|v8)\s+ignore
        |@(?:vitest|jest)-environment\s|biome-ignore-end\s|type:\s|pragma:|fmt:\s*(?:off|on|skip)|isort:
        |(?:-\*-\s*)?coding[:=]\s*[-\w.]+(?:\s*-\*-)?\s*$|SPDX-License-Identifier:|solhint-enable|forge-lint:
        |forgefmt:|shellcheck\s
        |webpack[A-Z]\w*:|[@\#]__(?:PURE|NO_SIDE_EFFECTS)__|[\#@]\ sourceMappingURL=|<reference\s|<amd-module
        |@jsx\w*\s|@refresh\s|@(?:type|satisfies|typedef|import)\s*[{\s])""", re.X), _ok),
)


@dataclass(frozen=True)
class FactoryAllow:
    """Iznimka `factory-allow <PRAVILO> razlog=<..> do=YYYY-MM-DD odobrio=<..>`; polje koje fali je None."""
    rule: str | None
    reason: str | None
    until: str | None
    approver: str | None
    line: int = 0
    own_line: bool = False

    def problems(self, today: date) -> list[str]:
        """Što iznimku čini nevaljanom na dan `today`; prazno znači da vrijedi."""
        missing = [name for name, value in (("pravilo", self.rule), ("razlog=", self.reason), ("do=", self.until),
                                            ("odobrio=", self.approver)) if not value]
        if missing:
            return [f"factory-allow bez polja {', '.join(missing)}"]
        until = self._until()
        if until is None:
            return [f"factory-allow s neispravnim datumom do={self.until}"]
        return [f"factory-allow istekao {self.until}"] if until < today else []

    def expired(self, today: date) -> bool:
        """Istekla iznimka je kršenje i na retku koji se nije mijenjao."""
        until = self._until()
        return until is not None and until < today

    def _until(self) -> date | None:
        try:
            return date.fromisoformat(self.until) if self.until and ISO_DATE.fullmatch(self.until) else None
        except ValueError:
            return None


def parse_allow(body: str) -> FactoryAllow | None:
    """Pročitaj tijelo komentara (bez oznake komentara) kao factory-allow; None ako to nije factory-allow."""
    text = body.strip()
    if not text.startswith("factory-allow"):
        return None
    rest = text[len("factory-allow"):].strip()
    head = rest.split(None, 1)[0] if rest else ""
    rule = head if RULE_ID.fullmatch(head) else None
    marks = list(ALLOW_FIELD.finditer(rest))
    fields = {m.group(1): rest[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(rest))].strip() or None
              for i, m in enumerate(marks)}
    until = fields.get("do")
    return FactoryAllow(rule, fields.get("razlog"), until.split()[0] if until else None, fields.get("odobrio"))


@dataclass(frozen=True)
class _Comment:
    line: int
    end: int
    text: str
    marker: str
    own_line: bool
    place: str | None = None
    start: int = 0
    stop: int = 0
    depth: int = 0
    uncertain: bool = False


def _marker(text: str) -> str:
    for marker in ("#!", "///", "//", "/**", "/*!", "/*", "#"):
        if text.startswith(marker) and not (marker == "///" and text.startswith("////")) \
                and not (marker == "/**" and text.startswith("/**/")):
            return marker
    return "#"


def _body(comment: _Comment) -> str:
    text = comment.text
    if comment.marker in ("doc", "str"):
        return text
    if comment.marker.startswith("/*"):
        text = text[2:-2] if text.endswith("*/") else text[2:]
        return re.sub(r"^\s*\*", "", text.lstrip("*!"), flags=re.M).strip()
    return re.sub(r"^\s*(?:///?|#)", "", text, flags=re.M).strip()


def _directive(body: str):
    for pattern, check in DIRECTIVES:
        match = pattern.match(body)
        if match:
            return check(match.group(1) if pattern.groups else "")
    return None


def _standalone(comment: _Comment) -> bool:
    body = _body(comment)
    return (comment.marker not in ("#", "//", "///") or not comment.own_line or _directive(body) is not None
            or body.startswith(("factory-allow", "EXTERNAL(")))


def _group(raw: list[_Comment]) -> list[_Comment]:
    out: list[_Comment] = []
    for comment in sorted(raw, key=lambda c: (c.line, c.start)):
        prev = out[-1] if out else None
        if (prev and prev.marker == comment.marker and comment.line == prev.end + 1 and prev.place == comment.place
                and not _standalone(prev) and not _standalone(comment)):
            out[-1] = replace(prev, end=comment.end, text=prev.text + "\n" + comment.text, stop=comment.stop,
                              uncertain=prev.uncertain or comment.uncertain)
        else:
            out.append(comment)
    return out


class _Lines:
    def __init__(self, text: str):
        self.text = text
        self.starts = [0] + [m.end() for m in re.finditer("\n", text)]

    def line(self, pos: int) -> int:
        return bisect.bisect_right(self.starts, pos)

    def own(self, pos: int) -> bool:
        return not self.text[self.starts[self.line(pos) - 1]:pos].strip()


def _segment(lines: list[str], node: ast.AST) -> str:
    first, last = node.lineno - 1, node.end_lineno - 1
    if first == last:
        return lines[first].encode()[node.col_offset:node.end_col_offset].decode()
    head = lines[first].encode()[node.col_offset:].decode()
    tail = lines[last].encode()[:node.end_col_offset].decode()
    return "\n".join([head, *lines[first + 1:last], tail])


def _is_text(node: ast.AST) -> bool:
    return isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)


def _docstring(node: ast.AST) -> ast.Expr | None:
    body = getattr(node, "body", None)
    return body[0] if body and _is_text(body[0]) else None


def _public_name(name: str) -> bool:
    return not name.startswith("_") or (name.startswith("__") and name.endswith("__"))


STATEMENT_NODES = (ast.stmt, ast.excepthandler, ast.match_case)


def _py_docstrings(tree: ast.Module, text: str) -> list[_Comment]:
    lines = re.split(r"\r\n|\r|\n", text)
    out, docs = [], set()

    def add(expr: ast.Expr, marker: str, place: str | None):
        out.append(_Comment(expr.lineno, expr.end_lineno, _segment(lines, expr), marker, True, place))

    module_doc = _docstring(tree)
    if module_doc:
        docs.add(id(module_doc))
        add(module_doc, "doc", "module")
    stack = [(tree, True, False)]
    while stack:
        node, public, in_function = stack.pop()
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                child_public = public and not in_function and _public_name(child.name)
                doc = _docstring(child)
                if doc:
                    docs.add(id(doc))
                    add(doc, "doc", "public" if child_public else "private")
                stack.append((child, child_public, in_function or not isinstance(child, ast.ClassDef)))
            elif _is_text(child):
                if id(child) not in docs:
                    add(child, "str", None)
            elif isinstance(child, STATEMENT_NODES):
                stack.append((child, public, in_function))
    return out


def _py_comments(view: FileView) -> list[_Comment]:
    tree = pyast.parse(view.path, view.text)
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(view.text).readline))
    except (tokenize.TokenError, SyntaxError) as exc:
        raise MeasureError(f"{view.path}: Python tokenizer nije pročitao datoteku: {exc}") from exc
    raw = [_Comment(tok.start[0], tok.start[0], tok.string, _marker(tok.string) if tok.start == (1, 0) else "#",
                    not tok.line[:tok.start[1]].strip(), start=tok.start[1])
           for tok in tokens if tok.type == tokenize.COMMENT]
    return _group(raw) + _mypy_raw(view.text, {c.line for c in raw if c.start == 0}) + _py_docstrings(tree, view.text)


def _mypy_raw(text: str, comment_lines: set[int]) -> list[_Comment]:
    return [_Comment(n, n, line.removesuffix("\r"), "#", True) for n, line in enumerate(text.split("\n"), 1)
            if line.startswith(MYPY_RAW) and n not in comment_lines]


SOL_DECL = re.compile(r"\s*(?:abstract\s+)?(?:contract|interface|library|function|event|error|modifier|struct|enum"
                      r"|constructor|receive|fallback)\b")
SOL_STATE = re.compile(r"\s*(?:mapping\s*\([^;{}]*?\)|[A-Za-z_][\w.]*(?:\s*\[[^\]]*\])*)"
                       r"(?:\s+(?:public|private|internal|constant|immutable|override|transient))*"
                       r"\s+[A-Za-z_]\w*\s*[;=]")
SOL_HEADER = re.compile(r"\s*(?:(?:pragma|import)\b[^;{}]*;\s*)*")


def _mask(text: str, spans: list[tuple[int, int]]) -> str:
    parts, cursor = [], 0
    for start, stop in spans:
        parts.append(text[cursor:start])
        parts.append(re.sub(r"[^\n]", " ", text[start:stop]))
        cursor = stop
    parts.append(text[cursor:])
    return "".join(parts)


def _sol_place(comment: _Comment, masked: str) -> str:
    if comment.depth == 0 and SOL_HEADER.fullmatch(masked, 0, comment.start):
        return "module"
    if comment.depth <= 1 and SOL_DECL.match(masked, comment.stop):
        return "public"
    if comment.depth == 1 and SOL_STATE.match(masked, comment.stop):
        return "public"
    return "orphan"


def _sol_comments(view: FileView) -> list[_Comment]:
    text = view.text
    lexed = sol_lex.lex(text)
    if lexed.problem:
        raise MeasureError(f"{view.path}: Solidity lexer nije pročitao datoteku: {lexed.problem}")
    raw = [token for token in lexed.tokens if token.kind == "comment"]
    spans = [(token.start, token.stop) for token in lexed.tokens if token.kind in ("comment", "string")]
    lines, masked = _Lines(text), _mask(text, spans)
    comments = _group([_Comment(lines.line(t.start), lines.line(max(t.start, t.stop - 1)), t.text, _marker(t.text),
                                lines.own(t.start), start=t.start, stop=t.stop, depth=t.depth)
                       for t in raw])
    return [replace(c, place=_sol_place(c, masked)) if c.marker in ("///", "/**") else c for c in comments]


SH_WORD_START = frozenset(" \t\n;|&()<>")
SH_HEREDOC = re.compile(r"<<(-?)[ \t]*\\?(['\"]?)([A-Za-z_][\w-]*)\2")


def _sh_close(text: str, i: int, quote: str) -> int:
    n = len(text)
    while i < n and text[i] != quote:
        i += 2 if text[i] == "\\" else 1
    return i if i < n else -1


def _sh_quoted(text: str, i: int) -> int:
    ch = text[i]
    return text.find("'", i + 1) if ch == "'" else _sh_close(text, i + 1, ch)


def _sh_brace(text: str, i: int) -> int:
    level, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "'\"`":
            i = _sh_quoted(text, i)
            if i < 0:
                return -1
            i += 1
            continue
        level += (ch == "{") - (ch == "}")
        if level == 0:
            return i
        i += 1
    return -1


def _sh_arith(text: str, i: int) -> int:
    level, n = 0, len(text)
    while i < n:
        level += (text[i] == "(") - (text[i] == ")")
        if level == 0:
            return i
        i += 1
    return -1


def _sh_heredoc(text: str, i: int, word: str, tabs: bool) -> int:
    for match in re.finditer(r"[^\n]*(?:\n|\Z)", text[i:]):
        line = match.group(0).rstrip("\n")
        if (line.lstrip("\t") if tabs else line) == word:
            return i + match.end()
        if not match.group(0):
            break
    return -1


def _sh_lex(text: str):
    raw, pending, i, n, depth, seen_code = [], [], 0, len(text), 0, False
    while i < n:
        ch = text[i]
        if ch == "\n":
            i += 1
            for tabs, word in pending:
                i = _sh_heredoc(text, i, word, tabs)
                if i < 0:
                    return raw, True
            pending = []
            continue
        if ch == "#" and (i == 0 or text[i - 1] in SH_WORD_START):
            stop = text.find("\n", i)
            stop = n if stop < 0 else stop
            raw.append((i, stop, depth > 0, not seen_code))
            i = stop
            continue
        seen_code = seen_code or not ch.isspace()
        if ch == "\\":
            i += 2
        elif ch == "'" or (ch == "$" and text.startswith("$'", i)):
            start = i + (2 if ch == "$" else 1)
            stop = _sh_close(text, start, "'") if ch == "$" else text.find("'", start)
            if stop < 0:
                return raw, True
            i = stop + 1
        elif ch in "\"`":
            stop = _sh_close(text, i + 1, ch)
            if stop < 0:
                return raw, True
            i = stop + 1
        elif text.startswith("${", i):
            stop = _sh_brace(text, i + 1)
            if stop < 0:
                return raw, True
            i = stop + 1
        elif text.startswith("$#", i):
            i += 2
        elif text.startswith("((", i + (text[i] == "$")) and (ch == "$" or i == 0 or text[i - 1] in SH_WORD_START):
            stop = _sh_arith(text, i + (ch == "$"))
            if stop < 0:
                return raw, True
            i = stop + 1
        elif text.startswith("$(", i):
            depth, i = depth + 1, i + 2
        elif ch == ")" and depth:
            depth, i = depth - 1, i + 1
        elif text.startswith("<<", i) and not text.startswith("<<<", i) and SH_HEREDOC.match(text, i):
            match = SH_HEREDOC.match(text, i)
            pending.append((match.group(1) == "-", match.group(3)))
            i = match.end()
        else:
            i += 1
    return raw, False


def _sh_comments(view: FileView) -> list[_Comment]:
    text = view.text
    raw, broken = _sh_lex(text)
    if broken:
        raise MeasureError(f"{view.path}: shell lexer nije pročitao datoteku (navodnik, heredoc ili zagrada bez kraja)")
    lines = _Lines(text)
    comments = _group([_Comment(lines.line(start), lines.line(start), text[start:stop], _marker(text[start:stop]),
                                lines.own(start), "header" if header else None, start=start, stop=stop,
                                uncertain=nested) for start, stop, nested, header in raw])
    out, header_used = [], False
    for comment in comments:
        if comment.place == "header" and comment.marker == "#" and not _standalone(comment):
            out.append(replace(comment, place=None if header_used else "module"))
            header_used = True
        else:
            out.append(replace(comment, place=None))
    return out


def _ts_extract(views: list[FileView]) -> list[list[_Comment]]:
    tsfacts.prefetch((view.path, view.text) for view in views)
    out = []
    for view in views:
        data = tsfacts.file_facts(view.path, view.text)
        if data["uncertain"]:
            raise MeasureError(f"TypeScript parser nije pročitao datoteku: {data['error']}")
        out.append(_group([_Comment(c["line"], c["end"], c["text"], _marker(c["text"]), c["own"], c["place"])
                           for c in data["comments"]]))
    return out


CONFIG_OPENERS = frozenset(":-[{,?=")


def _config_opens(text: str, i: int, lang: str) -> bool:
    if lang == "make":
        return True
    before = text[text.rfind("\n", 0, i) + 1:i].rstrip()
    return not before or before[-1] in CONFIG_OPENERS


def _config_lex(text: str, lang: str) -> list[tuple[int, int]]:
    if lang == "yaml":
        return yaml_lex.comments(text)
    raw, quote, i, n = [], None, 0, len(text)
    while i < n:
        ch = text[i]
        if quote:
            if text.startswith(quote, i):
                i, quote = i + len(quote), None
            elif ch == "\\" and quote[0] == '"':
                i += 2
            else:
                quote = None if ch == "\n" and len(quote) == 1 else quote
                i += 1
        elif ch == "#" and (i == 0 or text[i - 1] in " \t\n"):
            stop = text.find("\n", i)
            stop = n if stop < 0 else stop
            raw.append((i, stop))
            i = stop
        elif ch in "'\"" and _config_opens(text, i, lang):
            quote = ch * 3 if lang == "toml" and text.startswith(ch * 3, i) else ch
            i += len(quote)
        else:
            i += 1
    if quote and len(quote) == 3:
        raise MeasureError(f"TOML string {quote} bez kraja")
    return raw


def _config_comments(view: FileView) -> list[_Comment]:
    try:
        raw = _config_lex(view.text, view.lang)
    except MeasureError as exc:
        raise MeasureError(f"{view.path}: {exc}") from exc
    lines = _Lines(view.text)
    return _group([_Comment(lines.line(start), lines.line(start), view.text[start:stop], "#", lines.own(start),
                            "config", start=start, stop=stop) for start, stop in raw])


EXTRACTORS = {"py": _py_comments, "sol": _sol_comments, "sh": _sh_comments,
              **{lang: _config_comments for lang in CONFIG_LANGS}}


def _today(view: FileView) -> date:
    value = view.meta.get("today")
    if value is None:
        return date.today()
    return value if isinstance(value, date) else date.fromisoformat(value)


def _kind(comment: _Comment, body: str, today: date) -> tuple[str, list[tuple[str, str, str]], bool]:
    if comment.marker == "#!":
        return "allowed", [], False
    if comment.marker not in ("doc", "str"):
        problems = _directive(body)
        if problems is not None:
            return "allowed", [("K5", message, fix) for message, fix in problems], False
        allow = parse_allow(body)
        if allow is not None:
            return "allowed", [("K5", message, FIX_ALLOW) for message in allow.problems(today)], allow.expired(today)
        if body.startswith("EXTERNAL("):
            return ("allowed" if EXTERNAL.match(body) else "external"), [], False
    if comment.place in ("module", "public"):
        return "allowed", [], False
    return "k2", [], False


def _k2_text(comment: _Comment, kind: str) -> tuple[str, str]:
    if kind == "external":
        return "EXTERNAL komentar bez ovisnosti, pravila ili URL-a", FIX_EXTERNAL
    if comment.marker == "str":
        return "tekst kao naredba izvan docstringa", FIX_K2
    if comment.place == "private":
        return "doc komentar na privatnom ili lokalnom simbolu", FIX_DOC
    if comment.place == "orphan":
        return "doc komentar koji ne stoji neposredno iznad deklaracije", FIX_ORPHAN
    return "objašnjavajući komentar u tijelu koda", FIX_K2


COMMENT_MARK = re.compile(r"^\s*(?:/\*+!?|\*+(?!/)|/{2,}|#+)?")
COMMENT_END = re.compile(r"\*+/\s*$")
HYPHEN_BREAK = re.compile(r"\w-$")


def _flat(text: str) -> tuple[str, list[int]]:
    flat, starts = "", []
    for raw in text.split("\n"):
        words = " ".join(COMMENT_END.sub("", COMMENT_MARK.sub("", raw)).split())
        glue = " " if flat and words and not HYPHEN_BREAK.search(flat) else ""
        starts.append(len(flat) + len(glue))
        flat += glue + words
    return flat, starts


def _per_line(pattern: re.Pattern, flat: str, starts: list[int], first: int, new: set[int],
              everywhere: bool) -> list[tuple[int, str]]:
    found: dict[int, str] = {}
    for match in pattern.finditer(flat):
        spanned = range(first + bisect.bisect_right(starts, match.start()) - 1,
                        first + bisect.bisect_right(starts, match.end() - 1))
        hit = [line for line in spanned if line in new]
        if hit or everywhere:
            found.setdefault(hit[0] if hit else spanned[0], match.group(0))
    return sorted(found.items())


def _judge(view: FileView, comment: _Comment, today: date) -> list[Finding]:
    text, body = comment.text, _body(comment)
    kind, problems, always = _kind(comment, body, today)
    new = {n for n in range(comment.line, comment.end + 1) if view.is_new_line(n)}
    everywhere = view.reports_all()
    if not always and not new and not everywhere:
        return []
    severity = "warning" if comment.uncertain else "error"
    key = normalize(text)

    def finding(rule: str, line: int, message: str, fix: str) -> Finding:
        return Finding(rule, view.path, line, message, fix, key, severity)

    out = [finding(rule, comment.line, message, fix) for rule, message, fix in problems]
    flat, starts = _flat(text)
    k3 = _per_line(K3, flat, starts, comment.line, new, everywhere)
    out += [finding("K3", line, f"komentar o zaobilasku („{term}“)", FIX_K3) for line, term in k3]
    if comment.place == "config":
        return out
    constraint = _per_line(CONSTRAINT, flat, starts, comment.line, new, everywhere)
    if not k3 and constraint:
        line, term = constraint[0]
        out.append(finding("K2", line, f"komentar čuva ograničenje („{term}“)", FIX_CONSTRAINT))
    elif not k3 and kind != "allowed":
        out.append(finding("K2", min(new, default=comment.line), *_k2_text(comment, kind)))
    for match in DEPRECATED.finditer(text):
        if not ISO_DATE.search(match.group(2)):
            out.append(finding("K15", comment.line + text.count("\n", 0, match.start(1)),
                               f"{match.group(1)} bez datuma uklanjanja",
                               f"upiši datum uklanjanja (YYYY-MM-DD) uz {match.group(1)} i otvori issue za brisanje"))
    return out


def _extract_all(views: list[FileView]) -> list[list[_Comment]]:
    ts_index = [i for i, v in enumerate(views) if v.lang == "ts"]
    ts_found = dict(zip(ts_index, _ts_extract([views[i] for i in ts_index]))) if ts_index else {}
    return [ts_found[i] if i in ts_found else EXTRACTORS.get(v.lang, lambda _: [])(v) for i, v in enumerate(views)]


def allowances(view: FileView) -> list[FactoryAllow]:
    """Sve factory-allow iznimke u datoteci, s retkom i oznakom stoji li komentar sam u retku (za druge provjere)."""
    found = []
    for file_comments in _extract_all([view]):
        for comment in file_comments:
            allow = parse_allow(_body(comment)) if comment.marker not in ("doc", "str") else None
            if allow is not None:
                found.append(replace(allow, line=comment.line, own_line=comment.own_line))
    return found


def scan_many(views: Iterable[FileView]) -> list[Finding]:
    """K2/K3/K5/K15 nalazi za sve datoteke; TS/JS ide kroz jedan node proces. Exit 2 put je MeasureError."""
    views = list(views)
    findings = [f for view, comments in zip(views, _extract_all(views)) for c in comments
                for f in _judge(view, c, _today(view))]
    return ordered(findings)


def scan(view: FileView) -> list[Finding]:
    """Nalazi za jednu datoteku. Kad `view.added` nije None, a datoteka nema bazu, javljaju se samo komentari koji
    diraju dodane retke; istekla factory-allow iznimka javlja se uvijek."""
    return scan_many([view])

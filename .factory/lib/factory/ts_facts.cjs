/**
 * Jedini TypeScript pomoćnik code-checka: komentari (K2/K3/K5/K15) i činjenice iz AST-a (K4, K13, K19) za TS/JS.
 *
 * Ulaz na stdin: {"files": [{"path", "text"}]}. Izlaz na stdout: jedan JSON {"ok": true, "files": [...]} ili
 * {"ok": false, "error"} uz exit 2. Svaka datoteka daje {comments, uncertain, error, functions, handlers, skips,
 * assertions}; kad parser javi grešku, `error` je opis prve, a AST činjenice su prazne. Komentare nalazi
 * ts.createScanner samo u razmacima između čvorova AST-a, pa string, template literal, regex i JSX tekst nikad nisu
 * komentar. TypeScript se učitava isključivo s apsolutne putanje iz argv[2] (pinana verzija pozivatelja).
 * Redak se broji po znaku LF, kao u gitu, a ne po TypeScriptu, koji i samostalni CR, U+2028 i U+2029 broji kao kraj retka.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEST_ROOTS = new Set(['it', 'test', 'describe', 'context', 'suite', 'specify', 'bench']);
const SKIP_PROPS = new Set(['only', 'skip', 'todo', 'skipIf', 'fails', 'fixme', 'fail']);
const SKIP_NAMES = new Set(['xit', 'xtest', 'xdescribe', 'xcontext', 'xspecify', 'xsuite', 'fit', 'fdescribe', 'ftest']);
const TEST_CONTAINERS = new Set(['describe', 'context', 'suite']);
const ASSERT_CALLS = new Set(['expect', 'assert', 'expectTypeOf']);

const TEXT_LEAVES = ([
  'StringLiteral', 'NumericLiteral', 'BigIntLiteral', 'RegularExpressionLiteral', 'NoSubstitutionTemplateLiteral',
  'TemplateHead', 'TemplateMiddle', 'TemplateTail', 'JsxText', 'JsxTextAllWhiteSpaces', 'Identifier',
  'PrivateIdentifier',
]);
const TOP_DECLS = ([
  'FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration',
  'VariableStatement', 'ModuleDeclaration', 'ExportAssignment', 'ExportDeclaration',
]);
const MEMBERS = ([
  'MethodDeclaration', 'PropertyDeclaration', 'Constructor', 'GetAccessor', 'SetAccessor', 'PropertySignature',
  'MethodSignature', 'IndexSignature', 'CallSignature', 'ConstructSignature', 'EnumMember',
]);
const CONTAINERS = ['ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'TypeAliasDeclaration'];
const SCOPE_STOPS = ['ClassExpression', 'Block', 'ModuleBlock', 'SourceFile', 'ObjectLiteralExpression'];

function kindSets(ts) {
  const of = names => new Set(names.map(name => {
    const kind = ts.SyntaxKind[name];
    if (typeof kind !== 'number') throw new Error(`TypeScript nema SyntaxKind.${name}`);
    return kind;
  }));
  return {
    text: of(TEXT_LEAVES), top: of(TOP_DECLS), members: of(MEMBERS), containers: of(CONTAINERS), stops: of(SCOPE_STOPS),
  };
}

function hasModifier(ts, node, kinds) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods && mods.some(m => kinds.includes(m.kind)));
}

function isCommonJsExport(ts, node) {
  if (!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression)) return false;
  if (node.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = node.expression.left.getText();
  return left === 'module.exports' || left.startsWith('module.exports.') || left.startsWith('exports.');
}

function isExported(ts, node, sf) {
  if (ts.isExportAssignment(node) || ts.isExportDeclaration(node)) return true;
  if (sf.isDeclarationFile) return true;
  return hasModifier(ts, node, [ts.SyntaxKind.ExportKeyword]);
}

function memberPlace(ts, kinds, node, sf) {
  if (hasModifier(ts, node, [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword])) return 'private';
  if (node.name && ts.isPrivateIdentifier(node.name)) return 'private';
  for (let up = node.parent; up; up = up.parent) {
    if (kinds.containers.has(up.kind)) return isExported(ts, up, sf) ? 'public' : 'private';
    if (kinds.stops.has(up.kind)) return 'private';
  }
  return 'private';
}

function declPlace(ts, kinds, node, sf) {
  if (kinds.top.has(node.kind)) return isExported(ts, node, sf) ? 'public' : 'private';
  if (kinds.members.has(node.kind)) return memberPlace(ts, kinds, node, sf);
  if (sf.scriptKind === ts.ScriptKind.JS && isCommonJsExport(ts, node)) return 'public';
  return null;
}

function lineIndex(text) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const lineOf = pos => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  return { lineOf, startOf: line => starts[line - 1] };
}

function isDoc(body) {
  return (body.startsWith('/**') && !body.startsWith('/**/')) || body.startsWith('/*!');
}

function commentFacts(ts, kinds, sf) {
  const text = sf.text;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sf.languageVariant);
  const found = new Map();
  const docPlace = new Map();

  const collect = (start, end) => {
    const slash = text.indexOf('/', start);
    if (slash < 0 || slash >= end - 1) return;
    scanner.setText(text, start, end - start);
    for (let tok = scanner.scan(); tok !== ts.SyntaxKind.EndOfFileToken; tok = scanner.scan()) {
      if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
        found.set(scanner.getTokenStart(), scanner.getTokenEnd());
      }
    }
  };

  const attach = node => {
    const place = declPlace(ts, kinds, node, sf);
    if (place === null) return;
    const docs = (ts.getLeadingCommentRanges(text, node.pos) || []).filter(r => isDoc(text.slice(r.pos, r.end)));
    if (docs.length && !docPlace.has(docs[docs.length - 1].pos)) docPlace.set(docs[docs.length - 1].pos, place);
  };

  const visit = node => {
    attach(node);
    const kids = [];
    ts.forEachChild(node, kid => { kids.push(kid); });
    if (kids.length === 0) {
      collect(node.pos, kinds.text.has(node.kind) ? node.getStart(sf) : node.end);
      return;
    }
    kids.sort((a, b) => a.pos - b.pos);
    let cursor = node.pos;
    for (const kid of kids) {
      collect(cursor, kid.pos);
      visit(kid);
      cursor = Math.max(cursor, kid.end);
    }
    collect(cursor, node.end);
  };
  visit(sf);

  const codeStart = sf.statements.length ? sf.statements[0].getStart(sf) : sf.endOfFileToken.getStart(sf);
  const starts = [...found.keys()].sort((a, b) => a - b);
  const header = starts.find(pos => found.get(pos) <= codeStart && isDoc(text.slice(pos, found.get(pos))));
  const lines = lineIndex(text);
  const comments = starts.map(pos => {
    const end = found.get(pos);
    const body = text.slice(pos, end);
    const line = lines.lineOf(pos);
    let place = null;
    if (isDoc(body)) place = pos === header ? 'module' : (docPlace.get(pos) || 'orphan');
    return {
      line,
      end: lines.lineOf(Math.max(pos, end - 1)),
      text: body,
      own: text.slice(lines.startOf(line), pos).trim() === '',
      place,
    };
  });
  if (text.startsWith('#!')) {
    const stop = text.indexOf('\n');
    comments.unshift({ line: 1, end: 1, text: text.slice(0, stop < 0 ? text.length : stop), own: true, place: null });
  }
  return { comments, uncertain: sf.parseDiagnostics.length > 0 };
}

function isInert(ts, expr, isConstant) {
  const inert = node => isInert(ts, node, isConstant);
  const kind = ts.SyntaxKind;
  if (ts.isIdentifier(expr) || expr.kind === kind.ThisKeyword || isConstant(expr)) return true;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)
      || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isVoidExpression(expr)
      || ts.isTypeOfExpression(expr) || ts.isPropertyAccessExpression(expr)) return inert(expr.expression);
  if (ts.isPrefixUnaryExpression(expr)) {
    return expr.operator !== kind.PlusPlusToken && expr.operator !== kind.MinusMinusToken && inert(expr.operand);
  }
  if (ts.isElementAccessExpression(expr)) return inert(expr.expression) && inert(expr.argumentExpression);
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    return (op < kind.FirstAssignment || op > kind.LastAssignment) && inert(expr.left) && inert(expr.right);
  }
  if (ts.isConditionalExpression(expr)) return [expr.condition, expr.whenTrue, expr.whenFalse].every(inert);
  return false;
}

function astFacts(ts, sf) {
  const lines = lineIndex(sf.text);
  const line = node => lines.lineOf(node.getStart(sf));
  const endLine = node => lines.lineOf(Math.max(node.getStart(sf), node.getEnd() - 1));

  const chain = expr => {
    if (ts.isIdentifier(expr)) return [expr.text];
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
    if (ts.isPropertyAccessExpression(expr)) {
      const head = chain(expr.expression);
      return head && [...head, expr.name.text];
    }
    return null;
  };
  const calleeRoot = expr => {
    let current = expr;
    while (ts.isCallExpression(current)) current = current.expression;
    const names = chain(current);
    return names ? names[0] : null;
  };
  const constantKinds = new Set([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword]);
  const isConstant = expr => {
    let current = expr;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    if (ts.isIdentifier(current)) return current.text === 'undefined';
    if (ts.isArrayLiteralExpression(current)) return current.elements.length === 0;
    if (ts.isObjectLiteralExpression(current)) return current.properties.length === 0;
    if (ts.isVoidExpression(current)) return isInert(ts, current.expression, isConstant);
    return ts.isLiteralExpression(current) || constantKinds.has(current.kind);
  };
  const swallows = statements => statements.every((statement, at) => ts.isEmptyStatement(statement)
    || ts.isContinueStatement(statement)
    || (ts.isExpressionStatement(statement) && isConstant(statement.expression))
    || (at === statements.length - 1 && ts.isReturnStatement(statement)
      && (!statement.expression || isConstant(statement.expression))));
  const isEmptyHandler = fn => {
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    return ts.isBlock(fn.body) ? swallows(fn.body.statements) : isConstant(fn.body);
  };
  const ownName = node => {
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if (node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      return node.name.text;
    }
    const parent = node.parent;
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
        && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isCallExpression(parent)) {
      const callee = chain(parent.expression);
      const label = parent.arguments.find(arg => ts.isStringLiteralLike(arg));
      return `${callee ? callee.join('.') : 'poziv'}(${label ? JSON.stringify(label.text) : ''})`;
    }
    return `anonimna@${line(node)}`;
  };

  const functions = [];
  const handlers = [];
  const skips = [];
  let assertions = 0;

  const visit = (node, scope) => {
    let inner = scope;
    if (ts.isClassLike(node) && node.name) inner = [...scope, node.name.text];
    if (ts.isFunctionLike(node) && node.body) {
      const container = ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)
        && TEST_CONTAINERS.has(calleeRoot(node.parent.expression));
      if (!container) {
        const name = [...scope, ownName(node)].join('.');
        functions.push({ name, start: line(node), end: endLine(node) });
        inner = [...scope, ownName(node)];
      }
    }
    if (ts.isCatchClause(node) && swallows(node.block.statements)) {
      handlers.push({ kind: 'catch', start: line(node), end: endLine(node) });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === 'catch' && isEmptyHandler(node.arguments[0])) {
          handlers.push({ kind: 'catch-callback', start: line(node), end: endLine(node) });
        } else if (method === 'then' && isEmptyHandler(node.arguments[1])) {
          handlers.push({ kind: 'then-rejection', start: line(node), end: endLine(node) });
        }
      }
      const names = chain(callee);
      if (names) {
        const skipped = (names.length === 1 && SKIP_NAMES.has(names[0]))
          || (TEST_ROOTS.has(names[0]) && names.slice(1).some(name => SKIP_PROPS.has(name)))
          || (names.length === 2 && names[0] === 'this' && names[1] === 'skip');
        if (skipped) skips.push({ line: line(node), name: names.join('.') });
        if (ASSERT_CALLS.has(names[0]) && (names.length === 1 || names[0] === 'assert')) assertions += 1;
      }
    }
    ts.forEachChild(node, child => visit(child, inner));
  };
  visit(sf, []);

  const byLine = (a, b) => (a.start ?? a.line) - (b.start ?? b.line) || (a.name ?? a.kind).localeCompare(b.name ?? b.kind);
  return { functions: functions.sort(byLine), handlers: handlers.sort(byLine), skips: skips.sort(byLine), assertions };
}

function sourceFile(ts, file) {
  const kind = /\.(tsx|jsx)$/i.test(file.path) ? ts.ScriptKind.TSX
    : /\.(js|cjs|mjs)$/i.test(file.path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
  if (!Array.isArray(sf.parseDiagnostics)) throw new Error('TypeScript nema parseDiagnostics');
  return sf;
}

function factsOf(ts, kinds, file) {
  const sf = sourceFile(ts, file);
  const found = commentFacts(ts, kinds, sf);
  if (sf.parseDiagnostics.length === 0) return { ...found, error: null, ...astFacts(ts, sf) };
  const first = sf.parseDiagnostics[0];
  const where = lineIndex(sf.text).lineOf(first.start);
  const error = `${file.path}:${where}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`;
  return { ...found, error, functions: [], handlers: [], skips: [], assertions: 0 };
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 2;
}

function main() {
  const tsDir = process.argv[2];
  if (!tsDir || !path.isAbsolute(tsDir)) {
    fail('putanja do TypeScripta mora biti apsolutna');
    return;
  }
  const ts = require(tsDir);
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!Array.isArray(input.files) || !input.files.every(f => typeof f.path === 'string' && typeof f.text === 'string')) {
    fail('ulaz mora biti {files: [{path, text}]}');
    return;
  }
  const kinds = kindSets(ts);
  process.stdout.write(JSON.stringify({ ok: true, files: input.files.map(file => factsOf(ts, kinds, file)) }));
}

try {
  main();
} catch (err) {
  fail(String((err && err.stack) || err));
}

/** Static scan of the UI sources, used only by the dictionary tests. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export function uiSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const directory of ['app', 'components', 'lib']) walk(join(root, directory));
  return found.sort();
}

// Product names and technical identifiers that are the same in every language.
const UNTRANSLATED = new Set(['Muneral', 'Muneral Arcana', 'URI', 'SHA-256', '&ldquo;', '&rdquo;']);
const TEXT_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'name']);
const LETTERS = /\p{L}{2,}/u;

export interface ScanResult {
  keys: Map<string, string>;
  pluralKeys: Map<string, string>;
  hardCoded: string[];
}

export function scanSource(fileName: string, text: string, result: ScanResult): void {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const at = (node: ts.Node) =>
    `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const flag = (node: ts.Node, value: string) => {
    const trimmed = value.trim();
    if (LETTERS.test(trimmed) && !UNTRANSLATED.has(trimmed)) {
      result.hardCoded.push(`${at(node)} ${JSON.stringify(trimmed)}`);
    }
  };

  // Every string a rendered JSX expression can evaluate to.
  const flagRendered = (node: ts.Expression): void => {
    if (ts.isStringLiteralLike(node)) flag(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      flag(node, node.head.text);
      for (const span of node.templateSpans) {
        flagRendered(span.expression);
        flag(node, span.literal.text);
      }
    } else if (ts.isParenthesizedExpression(node)) flagRendered(node.expression);
    else if (ts.isConditionalExpression(node)) {
      flagRendered(node.whenTrue);
      flagRendered(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken) flagRendered(node.left);
      if (
        operator === ts.SyntaxKind.PlusToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        flagRendered(node.right);
      }
    }
  };

  const collect = (target: Map<string, string>, node: ts.Expression): void => {
    if (ts.isStringLiteralLike(node)) target.set(node.text, at(node));
    else if (ts.isConditionalExpression(node)) {
      collect(target, node.whenTrue);
      collect(target, node.whenFalse);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 't' && node.arguments[0]) collect(result.keys, node.arguments[0]);
      if (name === 'translate' && node.arguments[1]) collect(result.keys, node.arguments[1]);
      if (name === 'tp' && node.arguments[0]) collect(result.pluralKeys, node.arguments[0]);
    }
    if (ts.isJsxText(node)) flag(node, node.text);
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      flagRendered(node.expression);
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const attribute = node.name.getText();
      const value = node.initializer;
      const element = node.parent.parent.tagName.getText();
      if (element === 'T' && attribute === 'k' && ts.isStringLiteral(value)) {
        result.keys.set(value.text, at(value));
      } else if (TEXT_ATTRIBUTES.has(attribute)) {
        if (ts.isStringLiteral(value)) flag(value, value.text);
        else if (ts.isJsxExpression(value) && value.expression) flagRendered(value.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export function scanUiSources(root: string): ScanResult {
  const result: ScanResult = { keys: new Map(), pluralKeys: new Map(), hardCoded: [] };
  for (const file of uiSourceFiles(root)) {
    scanSource(relative(root, file), readFileSync(file, 'utf8'), result);
  }
  return result;
}

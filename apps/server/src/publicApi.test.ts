// The plugin contract, written out: every name `@brainstack/server/plugin`
// exports, with its type as the compiler sees it. Changing what a plugin can
// rely on changes `publicApi.snapshot.txt`, so the change shows up in review
// instead of in somebody's plugin after a release. Update it with
// `pnpm --filter @brainstack/server test -- -u` once the change is meant.

import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./extend.ts', import.meta.url));
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

/**
 * A type as text, with `import("/abs/path/module").Name` cut to `Name`: the
 * path differs on every machine, and the name is what a plugin author sees.
 */
const show = (checker: ts.TypeChecker, type: ts.Type, at?: ts.Node): string =>
  checker
    .typeToString(type, at, FLAGS)
    .replace(/import\("[^"]*"(?:, \{ with: \{[^}]*\} \})?\)\./g, '')
    .replace(/import\("[^"]*\/([^/"]+)"(?:, \{ with: \{[^}]*\} \})?\)/g, 'import("$1")');

/** One export, as a line or a block: its kind, name and shape. */
function describeExport(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const name = symbol.getName();
  if (target.flags & ts.SymbolFlags.Interface) {
    const type = checker.getDeclaredTypeOfSymbol(target);
    const members = checker
      .getPropertiesOfType(type)
      .map((p) => {
        const optional = p.flags & ts.SymbolFlags.Optional ? '?' : '';
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const t = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
        return `  ${p.getName()}${optional}: ${show(checker, t)};`;
      })
      .sort();
    return [`interface ${name} {`, ...members, '}'].join('\n');
  }
  if (target.flags & ts.SymbolFlags.TypeAlias) {
    const type = checker.getDeclaredTypeOfSymbol(target);
    return `type ${name} = ${show(checker, type)};`;
  }
  const decl = target.valueDeclaration ?? target.declarations?.[0];
  const type = decl
    ? checker.getTypeOfSymbolAtLocation(target, decl)
    : checker.getTypeOfSymbol(target);
  const kind = target.flags & ts.SymbolFlags.Function ? 'function' : 'const';
  return `${kind} ${name}: ${show(checker, type)};`;
}

describe('the plugin API', () => {
  it('is what publicApi.snapshot.txt says it is', async () => {
    const program = ts.createProgram([ENTRY], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(ENTRY)!;
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
    const report = exports
      .sort((a, b) => a.getName().localeCompare(b.getName()))
      .map((s) => describeExport(checker, s))
      .join('\n\n');
    await expect(`${report}\n`).toMatchFileSnapshot('./publicApi.snapshot.txt');
  });
});

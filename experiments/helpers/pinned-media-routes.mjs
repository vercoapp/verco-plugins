import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Keep the selected handler unchanged while excluding unrelated endpoint imports.
function selectHandler(path, source, name) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const retained = file.statements.filter((statement) => {
    if (ts.isImportDeclaration(statement)) return false;
    if (!ts.isVariableStatement(statement)) return true;
    return !statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name)
      && ['GET', 'PUT', 'DELETE'].includes(declaration.name.text)
      && declaration.name.text !== name);
  });
  const identifiers = new Set();
  function visit(node) {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  }
  retained.forEach(visit);
  const imports = file.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return [];
    const elements = clause.namedBindings.elements.filter((element) => !element.isTypeOnly && identifiers.has(element.name.text));
    if (!elements.length) return [];
    return [ts.factory.updateImportDeclaration(statement, statement.modifiers,
      ts.factory.updateImportClause(clause, false, undefined, ts.factory.updateNamedImports(clause.namedBindings, elements)),
      statement.moduleSpecifier, statement.attributes)];
  });
  const selected = ts.factory.updateSourceFile(file, [...imports, ...retained]);
  return ts.createPrinter().printFile(selected);
}

export async function loadPinnedMediaRoutes(directory) {
  directory = resolve(directory);
  const target = JSON.parse(await readFile(join(root, 'host/emdash/target.json'), 'utf8'));
  const checkout = join(root, target.checkout);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !== target.commit
      || execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).trim()) {
    throw new Error('Writer qualification requires the clean pinned EmDash checkout.');
  }
  const core = join(checkout, 'packages/core/src');
  const auth = join(checkout, 'packages/auth/src');
  const replacePath = join(core, 'astro/routes/api/media/[id]/replace.ts');
  const deletePath = join(core, 'astro/routes/api/media/[id].ts');
  const authEntry = join(directory, 'auth.ts');
  await writeFile(authEntry, `export { hasPermission, canActOnOwn } from ${JSON.stringify(join(auth, 'rbac.ts'))};\nexport { hasScope } from ${JSON.stringify(join(auth, 'tokens.ts'))};\n`);
  const routes = new Map([[replacePath, 'PUT'], [deletePath, 'DELETE']]);
  const sourceDigests = {};
  const outfile = join(directory, 'pinned-routes.mjs');
  await build({
    stdin: {
      contents: `export { PUT as replace } from ${JSON.stringify(replacePath)};\nexport { DELETE as remove } from ${JSON.stringify(deletePath)};`,
      resolveDir: root, loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    alias: {
      '#api/schemas.js': join(core, 'api/schemas/media.ts'),
      '#api': join(core, 'api'), '#media': join(core, 'media'), '#utils': join(core, 'utils'),
      '@emdash-cms/auth': authEntry,
    },
    plugins: [{
      name: 'select-pinned-handler',
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          const name = routes.get(path);
          if (!name) return;
          const source = await readFile(path, 'utf8');
          sourceDigests[name] = createHash('sha256').update(source).digest('hex');
          return { contents: selectHandler(path, source, name), loader: 'ts' };
        });
      },
    }],
  });
  return { ...(await import(pathToFileURL(outfile).href)), targetCommit: target.commit, sourceDigests };
}

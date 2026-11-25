// One-time, source-only import. Never reads credentials, databases or migration files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const source = path.resolve(process.argv[2] || '../lxlleague');
const destination = path.resolve('backend');
const sourceRoot = path.join(source, 'src');
if (fs.existsSync(path.join(destination, 'src/server'))) {
  throw new Error(
    'Backend already imported; review upstream changes instead of overwriting local logic.',
  );
}
const entries = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name === 'route.ts' && !file.includes(`${path.sep}auction${path.sep}`))
      entries.push(file);
  }
}
walk(path.join(sourceRoot, 'app/api/admin'));
for (const route of [
  'login',
  'logout',
  'current_user',
  'user/change_pwd',
  'match/list',
  'sponsors',
  'health',
]) {
  entries.push(path.join(sourceRoot, 'app/api', route, 'route.ts'));
}
entries.push(path.join(sourceRoot, 'types/ali-oss.d.ts'));
const files = new Map();
function resolve(specifier, from) {
  const base = specifier.startsWith('@/')
    ? path.join(sourceRoot, specifier.slice(2))
    : path.resolve(path.dirname(from), specifier);
  const match = [
    base,
    ...['.ts', '.tsx', '.json', '.mjs'].map((ext) => base + ext),
    path.join(base, 'index.ts'),
  ].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!match) throw new Error(`Unresolved dependency ${specifier} in ${from}`);
  return match;
}
function visit(file) {
  if (files.has(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  files.set(file, content);
  if (file.endsWith('.json')) return;
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  function scan(node) {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier === '@/components/match/match-roster') {
      const original = resolve(specifier, file);
      const roster = ts.createSourceFile(
        original,
        fs.readFileSync(original, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const type = roster.statements.find(
        (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'RosterPlayer',
      );
      write('src/lib/roster-types.ts', type.getText(roster) + '\n');
    } else if (specifier?.startsWith('@/') || specifier?.startsWith('.')) {
      visit(resolve(specifier, file));
    }
    ts.forEachChild(node, scan);
  }
  scan(ast);
}
function write(relative, text) {
  const target = path.join(destination, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text.replaceAll('\r\n', '\n'));
}
entries.forEach(visit);
const manifest = [];
for (const [file, content] of files) {
  const relative = path.relative(source, file).replaceAll('\\', '/');
  if (relative.startsWith('../') || relative.includes('.env'))
    throw new Error(`Unsafe source ${relative}`);
  write(relative, content.replaceAll('@/components/match/match-roster', '@/lib/roster-types'));
  manifest.push({
    path: relative,
    sourceSha256: createHash('sha256').update(content).digest('hex'),
  });
}
write('prisma/schema.prisma', fs.readFileSync(path.join(source, 'prisma/schema.prisma'), 'utf8'));
write(
  'migration-manifest.json',
  JSON.stringify(
    {
      sourceRepository: 'lxlleague',
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
      }).trim(),
      routes: entries
        .filter((file) => file.endsWith('route.ts'))
        .map((file) =>
          path
            .relative(path.join(sourceRoot, 'app'), file)
            .replaceAll('\\', '/')
            .replace('/route.ts', ''),
        ),
      retired: ['/api/admin/auction/**'],
      files: manifest,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Imported ${manifest.length} source files; no environment, migrations, production data or user pages copied.`,
);

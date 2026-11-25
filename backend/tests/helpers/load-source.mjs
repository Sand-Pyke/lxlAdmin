import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../src/', import.meta.url));
export function sourceLoader(prisma) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    if (absolute.endsWith('.json')) return JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const module = { exports: {} };
    cache.set(absolute, module);
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText;
    const resolve = (specifier) => {
      if (specifier === '@/lib/prisma') return { prisma };
      if (specifier.startsWith('@/') || specifier.startsWith('.')) {
        const base = specifier.startsWith('@/')
          ? path.join(root, specifier.slice(2))
          : path.resolve(path.dirname(absolute), specifier);
        const found = [base, base + '.ts', base + '.json'].find(
          (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
        );
        if (!found) throw new Error(`Unresolved ${specifier}`);
        return load(found);
      }
      return require(specifier);
    };
    new Function('require', 'module', 'exports', compiled)(resolve, module, module.exports);
    return module.exports;
  }
  return (file) => load(file);
}

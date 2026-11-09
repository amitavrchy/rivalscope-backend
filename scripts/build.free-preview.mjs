// Bounded per-file emission for the preview image. Run npm run typecheck separately.
// The external-database targets retain the normal full Nest/TypeScript build.
import ts from 'typescript';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const base = JSON.parse(readFileSync('tsconfig.json', 'utf8')).compilerOptions;
const { options, errors } = ts.convertCompilerOptionsFromJson({ ...base, module: 'ES2022', moduleResolution: 'bundler', declaration: false, sourceMap: false, incremental: false }, '.');
if (errors.length) throw new Error('Invalid preview compiler options');
function compile(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) { compile(source); continue; }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
    const result = ts.transpileModule(readFileSync(source, 'utf8'), { fileName: source, compilerOptions: options, reportDiagnostics: true });
    if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error(`Preview emission failed for ${source}`);
    const destination = join('dist', relative('src', source).replace(/\.ts$/, '.js'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, result.outputText);
  }
}
compile('src');
console.log('Preview JavaScript emitted per file; full type checking is a separate required verification.');

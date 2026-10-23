import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function compile(dir: string) {
  const source = join(root, 'src', dir), target = join(root, 'dist', dir);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) compile(join(dir, entry.name));
    else if (entry.name.endsWith('.ts')) {
      const js = stripTypeScriptTypes(readFileSync(join(source, entry.name), 'utf8'));
      // The CLI graph uses static relative imports/re-exports and Node built-ins only.
      const rewritten = js.replace(/(\bfrom\s*['"])(\.[^'"]*)\.ts(['"])/g, '$1$2.js$3');
      writeFileSync(join(target, entry.name.replace(/\.ts$/, '.js')), rewritten);
    }
  }
}
// pi loads the extension's TypeScript entry itself; only compile the CLI graph.
compile('cli'); compile('lib');

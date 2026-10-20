// Native-TS package: syntax-check every source/test file and reject trailing whitespace.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
function check(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (file.endsWith('.ts')) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (/[^\S\n]+$/m.test(readFileSync(file, 'utf8'))) throw new Error(`trailing whitespace: ${file}`);
    }
  }
}
check('src'); check('test'); console.log('Native TypeScript syntax + whitespace: passed');

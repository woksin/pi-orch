import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
// Canonicalize existing ancestors too, so a configured future worktree under a symlink agrees with git.
export function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    const parent = dirname(absolute);
    if (parent === absolute) throw e;
    return resolve(canonical(parent), basename(absolute));
  }
}
export function under(path: string, root: string): boolean {
  const rel = relative(canonical(root), canonical(path));
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}

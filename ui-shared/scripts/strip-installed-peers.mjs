/**
 * npm auto-installs peerDependencies into this package. A local @angular/* copy
 * causes duplicate Angular at runtime (NG0203) when apps compile these sources.
 */
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(packageRoot, 'node_modules');

for (const name of ['@angular', 'rxjs', 'tslib']) {
  const target = join(nodeModules, name);
  if (!existsSync(target)) {
    continue;
  }

  if (lstatSync(target).isSymbolicLink()) {
    rmSync(target);
    console.log(`[ui-shared] removed symlink ${name}`);
  } else {
    rmSync(target, { recursive: true, force: true });
    console.log(`[ui-shared] removed installed peer ${name}`);
  }
}

/**
 * Apps compile ui-shared sources via a TypeScript path alias. Runtime @angular/*,
 * rxjs, and tslib must resolve to the consuming app's node_modules only (never a
 * separate copy under ui-shared) or Vite will bundle duplicate Angular and
 * bootstrap fails with NG0203.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const angularRuntimePackages = [
  'animations',
  'common',
  'core',
  'forms',
  'platform-browser',
  'router',
];

/** True if path exists (file, directory, or symlink — including broken symlinks). */
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

export function linkAppUiDeps(callerUrl) {
  const appRoot = resolve(dirname(fileURLToPath(callerUrl)), '..');
  const libraryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sharedNodeModules = resolve(libraryRoot, 'node_modules');
  const appNodeModules = resolve(appRoot, 'node_modules');

  mkdirSync(appNodeModules, { recursive: true });
  mkdirSync(sharedNodeModules, { recursive: true });

  function linkPackage(name, target, link) {
    if (!existsSync(target)) {
      console.warn(`[link-shared-ui-deps] skip ${name}: ${target} not found`);
      return;
    }

    mkdirSync(dirname(link), { recursive: true });

    // Use lstatSync (not existsSync): broken symlinks exist on disk but existsSync returns false,
    // which previously left stale links in place and caused symlinkSync EEXIST on the next run.
    if (pathEntryExists(link)) {
      const stat = lstatSync(link);
      if (stat.isSymbolicLink()) {
        const current = resolve(dirname(link), readlinkSync(link));
        if (current === target) {
          return;
        }
        rmSync(link);
      } else {
        rmSync(link, { recursive: true, force: true });
      }
    }

    symlinkSync(target, link, 'junction');
    console.log(`[link-shared-ui-deps] linked ${name} -> ${target}`);
  }

  function ensureAppPackage(pkgDirName, scoped = false) {
    const name = scoped ? `@angular/${pkgDirName}` : pkgDirName;
    const appTarget = scoped
      ? join(appNodeModules, '@angular', pkgDirName)
      : join(appNodeModules, pkgDirName);

    if (pathEntryExists(appTarget) && lstatSync(appTarget).isSymbolicLink()) {
      rmSync(appTarget);
      console.log(`[link-shared-ui-deps] removed legacy app symlink for ${name}`);
    }

    if (!existsSync(appTarget)) {
      console.warn(
        `[link-shared-ui-deps] skip ${name}: install app deps first (npm install in ${appRoot})`
      );
      return null;
    }

    return appTarget;
  }

  for (const pkg of angularRuntimePackages) {
    const appTarget = ensureAppPackage(pkg, true);
    if (!appTarget) {
      continue;
    }

    linkPackage(`@angular/${pkg}`, appTarget, join(sharedNodeModules, '@angular', pkg));
  }

  for (const name of ['tslib', 'rxjs']) {
    const appTarget = ensureAppPackage(name, false);
    if (!appTarget) {
      continue;
    }

    linkPackage(name, appTarget, join(sharedNodeModules, name));
  }
}

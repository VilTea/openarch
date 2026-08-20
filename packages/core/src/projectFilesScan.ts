// Path-scan helpers shared by projectFiles.ts. Keeping these in a small module
// isolates symlink/canonical-path traversal from the project source selection
// surface, so the main file stays focused on population/kind policy.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Ordinary project scans cannot widen their source population through ../ or an absolute sibling. */
export const isWithinProjectRoot = (path: string, cwd: string): boolean => {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const relativePath = relative(resolve(cwd), candidate);
  return relativePath.length > 0 && relativePath !== "."
    && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath);
};

/** Real-path key with stable case folding for symlink dedup. */
export const canonicalPathKey = (path: string): string => {
  try { return realpathSync.native(path).toLowerCase(); } catch { return path.toLowerCase(); }
};

/** Returns true when any ancestor directory of `path` is a symbolic link. */
export const hasSymlinkAncestor = (path: string, cwd: string): boolean => {
  let directory = dirname(path);
  while (directory.length > cwd.length) {
    let symlink = false;
    try { symlink = lstatSync(directory).isSymbolicLink(); } catch { /* deleted mid-scan */ }
    if (symlink) return true;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
};

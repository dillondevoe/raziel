import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * Resolve the real (symlink-free) path of `p`. `p` itself need not exist —
 * walk up to the nearest existing ancestor, realpath *that*, then
 * re-append the non-existent remainder lexically (a not-yet-created file
 * can't itself be a symlink).
 */
function realWithFallback(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e;
    const parent = dirname(p);
    if (parent === p) throw e; // reached filesystem root and it's still missing
    const realParent = realWithFallback(parent);
    return realParent + p.slice(parent.length);
  }
}

/**
 * Workspace enforces containment: every path a tool touches must resolve
 * inside the workspace root. This is the R16 security floor for M1b —
 * builtin tools may never read/write/edit/glob/grep outside their root.
 *
 * Containment is real-path based, not just lexical: a symlink living
 * inside the workspace that points outside it must not grant access to
 * whatever it points at (HIGH severity ruling, fix round 1).
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    // Root itself is realpathed so a symlinked ancestor (e.g. macOS's
    // /tmp -> /private/tmp) can never cause a false "escapes" verdict on
    // an otherwise-ordinary contained path.
    this.root = realpathSync(resolve(root));
  }

  /**
   * Resolve `p` against root and verify it stays inside, both lexically
   * and after resolving symlinks. Throws `path escapes workspace: <path>`
   * on any traversal, absolute escape, or symlink pointing outside root.
   */
  contain(p: string): string {
    const lexical = resolve(this.root, p);
    if (lexical !== this.root && !lexical.startsWith(this.root + sep)) {
      throw new Error(`path escapes workspace: ${lexical}`);
    }
    const real = realWithFallback(lexical);
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      throw new Error(`path escapes workspace: ${real}`);
    }
    return real;
  }
}

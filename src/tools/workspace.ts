import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** True iff `p` exists as SOME filesystem node — file, dir, or (crucially)
 * a symlink whose target is missing or otherwise unresolvable. lstat never
 * follows the final path component, so this is true for a dangling symlink
 * even though realpathSync(p) would ENOENT on it. */
function existsAsNode(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the real (symlink-free) path of `p`. `p` itself need not exist —
 * walk up to the nearest existing ancestor, realpath *that*, then
 * re-append the non-existent remainder lexically (a not-yet-created file
 * can't itself be a symlink).
 *
 * Fix round (Critical): realpathSync ENOENTs both when `p` genuinely
 * doesn't exist yet AND when `p` is a symlink whose target is missing or
 * unresolvable (a dangling symlink, or the last hop of a broken chain).
 * Those two cases must NOT be treated the same way — a dangling symlink
 * lexically re-appended as if it were an ordinary not-yet-created path
 * would report an in-workspace path while a later write actually follows
 * the symlink to wherever it points, silently escaping containment. So on
 * ENOENT, check via lstat whether `p` itself exists as a node first: if it
 * does, it's a symlink we can't safely resolve — refuse outright. Only
 * recurse to the parent when `p` truly doesn't exist at all.
 */
function realWithFallback(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e;

    if (existsAsNode(p)) {
      throw new Error(`path escapes workspace: ${p} (dangling or unresolvable symlink)`);
    }

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
   * on any traversal, absolute escape, a symlink pointing outside root, or
   * a dangling/unresolvable symlink (fix round, Critical).
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

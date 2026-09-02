import { resolve, sep } from "node:path";

/**
 * Workspace enforces containment: every path a tool touches must resolve
 * inside the workspace root. This is the R16 security floor for M1b —
 * builtin tools may never read/write/edit/glob/grep outside their root.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve `p` against root and verify it stays inside. Throws on any
   * traversal or absolute path that escapes. Note: resolve(root, absPath)
   * returns absPath as-is when absPath is already absolute, so this also
   * catches absolute paths outside root (e.g. "/etc/passwd").
   */
  contain(p: string): string {
    const r = resolve(this.root, p);
    if (r !== this.root && !r.startsWith(this.root + sep)) {
      throw new Error(`path escapes workspace: ${r}`);
    }
    return r;
  }
}

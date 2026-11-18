import * as fs from "node:fs";
import * as path from "node:path";

export function resolveRepoFile(repo: string, file: string): string {
  const root = fs.realpathSync.native(repo);
  let ancestor = path.resolve(root, file);
  const missing: string[] = [];
  while (true) {
    try {
      ancestor = fs.realpathSync.native(ancestor);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const resolved = path.join(ancestor, ...missing);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path must be inside the configured repository: ${file}`);
  }
  return resolved;
}

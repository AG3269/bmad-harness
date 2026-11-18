import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { minimatch } from "minimatch";

/**
 * Collects what actually changed.
 *
 * The harness takes a git SHA before the dev agent starts and diffs against
 * it afterwards. That's deliberate: it doesn't depend on the agent writing
 * sensible commit messages, committing at all, or using a particular branch
 * name. Whatever the working tree looks like after, the diff is real.
 */

export type FileChange = {
  path: string;
  added: number;
  removed: number;
  /** The patch for this file. Empty for binary files. */
  patch: string;
};

export type Changes = {
  files: FileChange[];
  totalAdded: number;
  totalRemoved: number;
  /** Files that were filtered out as noise, so the report can say so. */
  ignored: string[];
  /** True when the diff was too big to pass whole and needs chunking. */
  oversized: boolean;
};

export type UntrackedFile = {
  data: Buffer;
  symlink: boolean;
  executable: boolean;
};

export type WorktreeSnapshot = {
  ref: string;
  tracked: ReadonlyMap<string, UntrackedFile | null>;
  untracked: ReadonlyMap<string, UntrackedFile>;
};

const MAX_BASELINE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function snapshot(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function snapshotWorktree(
  repo: string,
  options: { ignore?: string[]; maxBytes?: number } = {},
): WorktreeSnapshot {
  const ref = snapshot(repo);
  const maxBytes = options.maxBytes ?? MAX_BASELINE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("The untracked baseline size limit must be a non-negative integer.");
  }

  const tracked = new Map<string, UntrackedFile | null>();
  const untracked = new Map<string, UntrackedFile>();
  let bytes = 0;
  const changed = git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ref])
    .split("\0").filter(Boolean);
  for (const file of changed) {
    if (isIgnored(file, options.ignore ?? [])) continue;
    const contents = readUntracked(repo, file, Math.min(maxBytes - bytes, MAX_FILE_BYTES));
    if (contents) bytes += contents.data.length;
    tracked.set(file, contents);
  }
  for (const file of untrackedFiles(repo)) {
    if (isIgnored(file, options.ignore ?? [])) continue;
    if (tracked.has(file)) continue;
    const contents = readUntracked(repo, file, Math.min(maxBytes - bytes, MAX_FILE_BYTES));
    if (!contents) throw new Error(`Untracked baseline file disappeared: ${file}`);
    bytes += contents.data.length;
    untracked.set(file, contents);
  }
  return { ref, tracked, untracked };
}

export function collect(
  repo: string,
  since: string | WorktreeSnapshot,
  opts: { ignore: string[]; maxChars: number },
): Changes {
  const baseline = typeof since === "string" ? undefined : since;
  const sinceSha = typeof since === "string" ? since : since.ref;
  const stat = git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", sinceSha]);
  const ignored: string[] = [];
  const files: FileChange[] = [];

  for (const line of stat.split("\0").filter(Boolean)) {
    const [addedRaw, removedRaw, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    if (!filePath) continue;

    if (isIgnored(filePath, opts.ignore)) {
      ignored.push(filePath);
      continue;
    }
    if (baseline?.untracked.has(filePath) || baseline?.tracked.has(filePath)) continue;

    // "-" means binary.
    const added = addedRaw === "-" ? 0 : Number(addedRaw) || 0;
    const removed = removedRaw === "-" ? 0 : Number(removedRaw) || 0;
    const binary = addedRaw === "-";

    files.push({
      path: filePath,
      added,
      removed,
      patch: binary ? "" : git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", sinceSha, "--", filePath]),
    });
  }

  for (const untracked of untrackedFiles(repo)) {
    if (isIgnored(untracked, opts.ignore)) { ignored.push(untracked); continue; }
    if (baseline?.untracked.has(untracked) || baseline?.tracked.has(untracked)) continue;
    if (files.some((f) => f.path === untracked)) {
      throw new Error(`The index and working tree disagree about ${untracked}; resolve its staged deletion before validating.`);
    }
    const contents = readUntracked(repo, untracked, MAX_FILE_BYTES);
    if (!contents) throw new Error(`New untracked file disappeared while collecting the diff: ${untracked}`);
    files.push(addedFile(untracked, contents));
  }

  if (baseline) {
    const previous = new Map<string, UntrackedFile | null>([...baseline.tracked, ...baseline.untracked]);
    for (const [file, before] of previous) {
      if (isIgnored(file, opts.ignore)) { ignored.push(file); continue; }
      const after = readUntracked(repo, file, MAX_FILE_BYTES);
      if (!before) {
        if (after) files.push(addedFile(file, after));
        continue;
      }
      if (after && before.symlink === after.symlink &&
          before.executable === after.executable && before.data.equals(after.data)) continue;
      files.push(changedBaselineFile(file, before, after));
    }
  }

  const totalChars = files.reduce((n, f) => n + f.patch.length, 0);

  return {
    files,
    totalAdded: files.reduce((n, f) => n + f.added, 0),
    totalRemoved: files.reduce((n, f) => n + f.removed, 0),
    ignored,
    oversized: totalChars > opts.maxChars,
  };
}

/**
 * The diff as one block, for a model to read.
 *
 * When it's too big, the biggest files are truncated rather than dropped —
 * a missing file would make the reconstruction wrong in a way nothing
 * downstream could detect, whereas a truncated one is visibly truncated.
 */
export function asText(changes: Changes, maxChars: number): string {
  const parts: string[] = [];
  let used = 0;

  // Smallest first, so the budget goes to as many whole files as possible.
  const ordered = [...changes.files].sort((a, b) => a.patch.length - b.patch.length);

  for (const f of ordered) {
    const budgetLeft = maxChars - used;
    if (budgetLeft < 500) {
      parts.push(`\n[${ordered.length - parts.length} more file(s) not shown — diff too large]`);
      break;
    }
    if (f.patch.length === 0) {
      parts.push(`\n### ${f.path}\n[binary file changed]`);
      used += 60;
      continue;
    }
    if (f.patch.length <= budgetLeft) {
      parts.push(`\n### ${f.path}\n${f.patch}`);
      used += f.patch.length;
    } else {
      parts.push(
        `\n### ${f.path}\n${f.patch.slice(0, budgetLeft - 100)}\n` +
        `[... this file's diff was truncated ...]`,
      );
      used = maxChars;
    }
  }

  return parts.join("\n");
}

/** Did anything change at all? */
export function isEmpty(changes: Changes): boolean {
  return changes.files.length === 0;
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr ?? (e as Error).message;
    throw new Error(`git ${args[0]} failed in ${repo}: ${String(msg).trim()}`);
  }
}

function isIgnored(file: string, patterns: string[]): boolean {
  const name = (file.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  return patterns.some((pattern) => minimatch(file, pattern));
}

function untrackedFiles(repo: string): string[] {
  return git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
}

function readUntracked(repo: string, rel: string, maxBytes: number): UntrackedFile | null {
  const full = path.join(repo, rel);
  try {
    const stat = fs.lstatSync(full);
    const symlink = stat.isSymbolicLink();
    if (!symlink && !stat.isFile()) throw new Error("not a regular file or symbolic link");
    if (stat.size > maxBytes) throw new Error(`exceeds the ${maxBytes}-byte available limit`);
    const data = symlink ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
    if (data.length > maxBytes) throw new Error(`exceeds the ${maxBytes}-byte available limit`);
    return { data, symlink, executable: !symlink && (stat.mode & 0o111) !== 0 };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read untracked file ${rel}: ${reason}`);
  }
}

function addedFile(file: string, contents: UntrackedFile): FileChange {
  if (isBinary(contents.data)) return { path: file, added: 0, removed: 0, patch: "" };
  const lines = contents.data.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return {
    path: file,
    added: lines.length,
    removed: 0,
    patch: `--- /dev/null\n+++ b/${file}\n` + lines.map((line) => `+${line}`).join("\n"),
  };
}

function changedBaselineFile(file: string, before: UntrackedFile, after: UntrackedFile | null): FileChange {
  if (isBinary(before.data) || (after && isBinary(after.data))) {
    return { path: file, added: 0, removed: 0, patch: "" };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-diff-"));
  try {
    const oldFile = path.join(dir, "before");
    const newFile = path.join(dir, "after");
    fs.writeFileSync(oldFile, before.data);
    fs.writeFileSync(newFile, after?.data ?? Buffer.alloc(0));
    const result = spawnSync("git", [
      "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--text", "--", oldFile, newFile,
    ], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      const reason = result.error?.message ?? `exit ${result.status}`;
      throw new Error(`Cannot compare baseline file ${file}: ${reason}`);
    }

    const start = result.stdout.indexOf("\n@@ ");
    const hunks = start >= 0 ? result.stdout.slice(start + 1) : "";
    const lines = hunks.split("\n");
    const added = lines.filter((line) => line.startsWith("+")).length;
    const removed = lines.filter((line) => line.startsWith("-")).length;
    const typeChange = after && before.symlink !== after.symlink ? "[file type changed]\n" : "";
    const modeChange = after && before.executable !== after.executable ? "[executable permissions changed]\n" : "";
    const emptyChange = !hunks && !typeChange && !modeChange ? "[empty file deleted]\n" : "";
    return {
      path: file,
      added,
      removed,
      patch: `--- a/${file}\n+++ ${after ? `b/${file}` : "/dev/null"}\n${typeChange}${modeChange}${emptyChange}${hunks}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isBinary(data: Buffer): boolean {
  return data.includes(0) || !isUtf8(data);
}

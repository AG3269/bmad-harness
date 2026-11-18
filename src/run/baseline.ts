import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { UntrackedFile, WorktreeSnapshot } from "../validate/diff.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 400 * 1024 * 1024;
const Entry = z.object({
  file: z.string().min(1),
  content: z.string(),
  symlink: z.boolean(),
  executable: z.boolean(),
}).strict();
const Snapshot = z.discriminatedUnion("version", [
  z.object({
    version: z.literal(1),
    ref: z.string().regex(/^[0-9a-f]{40,64}$/),
    untracked: z.array(Entry),
  }).strict(),
  z.object({
    version: z.literal(2),
    ref: z.string().regex(/^[0-9a-f]{40,64}$/),
    untracked: z.array(Entry),
    tracked: z.array(Entry.extend({ content: z.string().nullable() }).strict()),
  }).strict(),
]);

export function saveBaseline(file: string, snapshot: WorktreeSnapshot): void {
  const contents = {
    version: 2 as const,
    ref: snapshot.ref,
    tracked: [...snapshot.tracked].map(([name, value]) => ({
      file: name,
      content: value?.data.toString("base64") ?? null,
      symlink: value?.symlink ?? false,
      executable: value?.executable ?? false,
    })),
    untracked: [...snapshot.untracked].map(([name, value]) => ({
      file: name,
      content: value.data.toString("base64"),
      symlink: value.symlink,
      executable: value.executable,
    })),
  };
  const compressed = gzipSync(JSON.stringify(contents));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, compressed, { flag: "wx", mode: 0o600 });
    const fd = fs.openSync(temp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temp, file);
    fs.unlinkSync(temp);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (cleanup) {
      if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT")) throw cleanup;
    }
    throw error;
  }
}

export function loadBaseline(file: string): WorktreeSnapshot {
  let value: unknown;
  try {
    const compressed = fs.readFileSync(file);
    const data = gunzipSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
    value = JSON.parse(data.toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the saved story baseline: ${reason}`);
  }
  const result = Snapshot.safeParse(value);
  if (!result.success) throw new Error("The saved story baseline has an invalid format.");
  const tracked = new Map<string, UntrackedFile | null>();
  const untracked = new Map<string, UntrackedFile>();
  let total = 0;
  const trackedEntries = result.data.version === 2 ? result.data.tracked : [];
  for (const [entries, isTracked] of [[trackedEntries, true], [result.data.untracked, false]] as const) {
    for (const entry of entries) {
      if (!safeRelativeFile(entry.file) || untracked.has(entry.file) || tracked.has(entry.file)) {
        throw new Error("The saved story baseline contains an invalid or duplicate path.");
      }
      if (entry.content === null) {
        if (!isTracked) throw new Error("The saved story baseline has invalid content.");
        tracked.set(entry.file, null);
      } else {
        const data = Buffer.from(entry.content, "base64");
        if (data.toString("base64") !== entry.content) throw new Error("The saved story baseline has invalid content.");
        total += data.length;
        if (total > MAX_SNAPSHOT_BYTES) throw new Error("The saved story baseline exceeds the size limit.");
        const file = { data, symlink: entry.symlink, executable: entry.executable };
        if (isTracked) tracked.set(entry.file, file);
        else untracked.set(entry.file, file);
      }
    }
  }
  return { ref: result.data.ref, tracked, untracked };
}

function safeRelativeFile(file: string): boolean {
  if (file.includes("\\") || file.includes("\0") || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false;
  const segments = file.split("/");
  return segments.every((part) => part !== "" && part !== "." && part !== "..");
}

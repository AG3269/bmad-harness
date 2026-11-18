import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { collect, snapshotWorktree } from "../validate/diff.js";
import { loadBaseline, saveBaseline } from "./baseline.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-persist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked"), "tracked\n");
  git("add", "tracked");
  git("commit", "-qm", "base");
  return { root, repo };
}

test("saved baselines survive a restart and still detect later edits", (t) => {
  const { root, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "existing.txt"), "before\n");
  fs.writeFileSync(path.join(repo, "tracked"), "tracked before\n");
  const file = path.join(root, "baseline.gz");
  saveBaseline(file, snapshotWorktree(repo));
  fs.writeFileSync(path.join(repo, "existing.txt"), "after\n");
  fs.writeFileSync(path.join(repo, "tracked"), "tracked after\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
  const changes = collect(repo, loadBaseline(file), { ignore: [], maxChars: 50_000 });
  assert.deepEqual(changes.files.map((entry) => entry.path).sort(), ["existing.txt", "new.txt", "tracked"]);
  assert.match(changes.files.find((entry) => entry.path === "existing.txt")!.patch, /-before/);
  assert.match(changes.files.find((entry) => entry.path === "existing.txt")!.patch, /\+after/);
  assert.match(changes.files.find((entry) => entry.path === "tracked")!.patch, /-tracked before/);
  assert.match(changes.files.find((entry) => entry.path === "tracked")!.patch, /\+tracked after/);
  assert.throws(() => saveBaseline(file, snapshotWorktree(repo)), /EEXIST/);
});

test("corrupt, duplicate and escaping baseline entries are rejected", (t) => {
  const { root } = fixture(t);
  const file = path.join(root, "baseline.gz");
  fs.writeFileSync(file, "bad");
  assert.throws(() => loadBaseline(file), /Could not read/);
  const entry = { file: "safe.txt", content: "", symlink: false, executable: false };
  for (const entries of [[{ ...entry, file: "../outside" }], [entry, entry], [{ ...entry, content: "!!" }]]) {
    fs.writeFileSync(file, gzipSync(JSON.stringify({ version: 1, ref: "a".repeat(40), untracked: entries })));
    assert.throws(() => loadBaseline(file), /invalid|duplicate/);
  }
});

test("version 1 baselines remain readable after adding tracked-file snapshots", (t) => {
  const { root } = fixture(t);
  const file = path.join(root, "legacy.gz");
  fs.writeFileSync(file, gzipSync(JSON.stringify({
    version: 1, ref: "a".repeat(40),
    untracked: [{ file: "old.txt", content: Buffer.from("old").toString("base64"), symlink: false, executable: false }],
  })));
  const baseline = loadBaseline(file);
  assert.equal(baseline.tracked.size, 0);
  assert.equal(baseline.untracked.get("old.txt")?.data.toString(), "old");
});

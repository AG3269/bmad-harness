import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { collect, snapshot, snapshotWorktree } from "./diff.js";

const options = { ignore: [], maxChars: 50_000 };

function fixture(t: TestContext) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "harness-baseline-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", stdio: "pipe",
  });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "base");
  return { repo, git, write: (file: string, data: string | Buffer) => fs.writeFileSync(path.join(repo, file), data) };
}

test("existing untracked files are baseline; newly created files retain their contents", (t) => {
  const { repo, write } = fixture(t);
  write("existing.txt", "old project content\n");
  const base = snapshotWorktree(repo);
  write("new file.txt", "first line\nsecond line\n");
  const changes = collect(repo, base, options);
  assert.deepEqual(changes.files.map((file) => file.path), ["new file.txt"]);
  assert.match(changes.files[0]!.patch, /\+first line\n\+second line/);
  assert.equal(changes.files[0]!.added, 2);
  assert.equal(fs.readFileSync(path.join(repo, "existing.txt"), "utf8"), "old project content\n");
});

test("edits to pre-existing untracked files are compared against their baseline", (t) => {
  const { repo, write } = fixture(t);
  write("existing.txt", "keep\nold\n");
  const base = snapshotWorktree(repo);
  write("existing.txt", "keep\nnew\n");
  const changes = collect(repo, base, options);
  assert.deepEqual(changes.files.map((file) => file.path), ["existing.txt"]);
  assert.match(changes.files[0]!.patch, /-old/);
  assert.match(changes.files[0]!.patch, /\+new/);
  assert.equal(changes.files[0]!.added, 1);
  assert.equal(changes.files[0]!.removed, 1);
});

test("staging or committing an unchanged baseline file does not create a false change", (t) => {
  const { repo, git, write } = fixture(t);
  write("existing.txt", "old\n");
  const base = snapshotWorktree(repo);
  git("add", "existing.txt");
  assert.deepEqual(collect(repo, base, options).files, []);
  git("commit", "-qm", "add baseline file");
  assert.deepEqual(collect(repo, base, options).files, []);
  write("existing.txt", "new\n");
  const changed = collect(repo, base, options).files;
  assert.equal(changed.length, 1);
  assert.match(changed[0]!.patch, /-old/);
  assert.match(changed[0]!.patch, /\+new/);
});

test("new staged and committed files and tracked edits are reported after the snapshot", (t) => {
  const { repo, git, write } = fixture(t);
  const base = snapshotWorktree(repo);
  write("new file.txt", "created\n");
  git("add", "new file.txt");
  write("tracked.txt", "changed\n");
  let changes = collect(repo, base, options);
  assert.deepEqual(changes.files.map((file) => file.path).sort(), ["new file.txt", "tracked.txt"]);
  assert.match(changes.files.find((file) => file.path === "new file.txt")!.patch, /\+created/);
  assert.match(changes.files.find((file) => file.path === "tracked.txt")!.patch, /\+changed/);
  git("add", "tracked.txt");
  git("commit", "-qm", "story changes");
  changes = collect(repo, base, options);
  assert.deepEqual(changes.files.map((file) => file.path).sort(), ["new file.txt", "tracked.txt"]);
});

test("deletion and rename of pre-existing untracked files remain visible", (t) => {
  const { repo, write } = fixture(t);
  write("original.txt", "original\n");
  const base = snapshotWorktree(repo);
  fs.renameSync(path.join(repo, "original.txt"), path.join(repo, "renamed.txt"));
  const changes = collect(repo, base, options);
  assert.deepEqual(changes.files.map((file) => file.path).sort(), ["original.txt", "renamed.txt"]);
  assert.match(changes.files.find((file) => file.path === "original.txt")!.patch, /-original/);
  assert.match(changes.files.find((file) => file.path === "renamed.txt")!.patch, /\+original/);
});

test("binary untracked files are reported without treating bytes as text", (t) => {
  const { repo, write } = fixture(t);
  write("existing.bin", Buffer.from([0, 1, 2]));
  const base = snapshotWorktree(repo);
  write("existing.bin", Buffer.from([0, 1, 3]));
  write("new.bin", Buffer.from([0, 4, 5]));
  const files = collect(repo, base, options).files;
  assert.deepEqual(files.map((file) => file.path).sort(), ["existing.bin", "new.bin"]);
  assert.ok(files.every((file) => file.patch === ""));
});

test("empty deletions and file permission changes are not silently dropped", (t) => {
  const { repo, write } = fixture(t);
  write("empty.txt", "");
  write("mode.txt", "content\n");
  const base = snapshotWorktree(repo);
  fs.unlinkSync(path.join(repo, "empty.txt"));
  if (process.platform !== "win32") fs.chmodSync(path.join(repo, "mode.txt"), 0o755);
  const files = collect(repo, base, options).files;
  assert.match(files.find((file) => file.path === "empty.txt")!.patch, /empty file deleted/);
  if (process.platform !== "win32") {
    assert.match(files.find((file) => file.path === "mode.txt")!.patch, /permissions changed/);
  }
});

test("baseline enforces an explicit memory limit", (t) => {
  const { repo, write } = fixture(t);
  write("existing.txt", "1234");
  assert.throws(() => snapshotWorktree(repo, { maxBytes: 3 }), /available limit/);
  assert.throws(() => snapshotWorktree(repo, { maxBytes: -1 }), /non-negative integer/);
});

for (const staged of [false, true]) {
  test(`pre-existing ${staged ? "staged" : "unstaged"} tracked changes become the next story baseline`, (t) => {
    const { repo, git, write } = fixture(t);
    write("tracked.txt", "previous story\n");
    if (staged) git("add", "tracked.txt");
    const base = snapshotWorktree(repo);
    assert.deepEqual(collect(repo, base, options).files, []);
    git("add", "tracked.txt");
    git("commit", "-qm", "record previous work");
    assert.deepEqual(collect(repo, base, options).files, []);
    write("tracked.txt", "new story\n");
    const files = collect(repo, base, options).files;
    assert.equal(files.length, 1);
    assert.match(files[0]!.patch, /-previous story/);
    assert.match(files[0]!.patch, /\+new story/);
  });
}

test("a previously staged deletion is compared to the new story's work", (t) => {
  const { repo, git, write } = fixture(t);
  git("rm", "-q", "tracked.txt");
  const base = snapshotWorktree(repo);
  assert.deepEqual(collect(repo, base, options).files, []);
  write("tracked.txt", "restored during story\n");
  const files = collect(repo, base, options).files;
  assert.equal(files.length, 1);
  assert.match(files[0]!.patch, /\+restored during story/);
});

test("a staged deletion and untracked replacement after the baseline fails explicitly", (t) => {
  const { repo, git, write } = fixture(t);
  const base = snapshotWorktree(repo);
  git("rm", "-q", "tracked.txt");
  write("tracked.txt", "replacement\n");
  assert.throws(() => collect(repo, base, options), /index and working tree disagree/);
});

test("environment secrets and configured noise remain excluded", (t) => {
  const { repo, write } = fixture(t);
  write(".env", "secret\n");
  write("noise.snap", "noise\n");
  write("keep.txt", "keep\n");
  const base = snapshotWorktree(repo, { ignore: ["**/*.snap"] });
  assert.deepEqual([...base.untracked.keys()], ["keep.txt"]);
  write(".env", "changed secret\n");
  write("noise.snap", "changed noise\n");
  assert.deepEqual(collect(repo, base, { ...options, ignore: ["**/*.snap"] }).files, []);
});

test("SHA-based callers continue to collect untracked files", (t) => {
  const { repo, write } = fixture(t);
  const ref = snapshot(repo);
  write("new.txt", "real contents\n");
  const files = collect(repo, ref, options).files;
  assert.equal(files.length, 1);
  assert.match(files[0]!.patch, /\+real contents/);
});

test("comparisons do not invoke a configured external Git diff tool", (t) => {
  const { repo, git, write } = fixture(t);
  git("config", "diff.external", "harness-nonexistent-external-diff");
  write("existing.txt", "before\n");
  const base = snapshotWorktree(repo);
  write("existing.txt", "after\n");
  write("tracked.txt", "after\n");
  const files = collect(repo, base, options).files;
  assert.deepEqual(files.map((file) => file.path).sort(), ["existing.txt", "tracked.txt"]);
  assert.match(files.find((file) => file.path === "existing.txt")!.patch, /\+after/);
  assert.match(files.find((file) => file.path === "tracked.txt")!.patch, /\+after/);
});

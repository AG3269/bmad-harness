import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { acquireRepoLock, withRecoveryLock } from "./lock.js";

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("recovery refuses a live owner or missing original process identity", async (t) => {
  const root = fixture(t);
  await assert.rejects(withRecoveryLock(root, process.pid, async () => {}), /still running/);
  await assert.rejects(withRecoveryLock(root, undefined, async () => {}), /did not record/);
});

test("recovery lock prevents concurrent recovery and is released on failure", async (t) => {
  const root = fixture(t);
  const deadPid = 2147483647;
  await assert.rejects(withRecoveryLock(root, deadPid, async () => {
    assert.equal(fs.existsSync(path.join(root, "recovery.lock")), true);
    await assert.rejects(withRecoveryLock(root, deadPid, async () => {}), /still owns the lock/);
    throw new Error("test failure");
  }), /test failure/);
  assert.equal(fs.existsSync(path.join(root, "recovery.lock")), false);
  assert.equal(await withRecoveryLock(root, deadPid, async () => "ok"), "ok");
});

test("repository lock rejects live owners and safely clears a dead owner's lock", (t) => {
  const root = fixture(t);
  const repo = path.join(root, "repo");
  const locks = path.join(root, "locks");
  fs.mkdirSync(repo);
  const release = acquireRepoLock(locks, repo);
  assert.throws(() => acquireRepoLock(locks, repo), /still owns the lock/);
  release();
  const real = fs.realpathSync.native(repo);
  const key = createHash("sha256").update(process.platform === "win32" ? real.toLowerCase() : real).digest("hex");
  const dir = path.join(locks, `${key}.lock`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: 2147483647, token: "stale" }));
  const afterRestart = acquireRepoLock(locks, repo);
  afterRestart();
  assert.equal(fs.existsSync(dir), false);
});

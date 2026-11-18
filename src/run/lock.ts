import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export async function withRecoveryLock<T>(directory: string, originalPid: number | undefined, operation: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(originalPid) || !originalPid || originalPid < 1) {
    throw new Error("The original run did not record its process ID; recovery requires manual inspection.");
  }
  try {
    process.kill(originalPid, 0);
    throw new Error(`The original harness process ${originalPid} is still running; do not recover concurrently.`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }

  const release = acquireLock(path.join(directory, "recovery.lock"));
  try {
    return await operation();
  } finally {
    release();
  }
}

export function acquireRepoLock(root: string, repo: string): () => void {
  const real = fs.realpathSync.native(repo);
  const canonical = process.platform === "win32" ? real.toLowerCase() : real;
  const key = createHash("sha256").update(canonical).digest("hex");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return acquireLock(path.join(root, `${key}.lock`));
}

function acquireLock(directory: string): () => void {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      const owner = path.join(directory, "owner.json");
      let ownerCreated = false;
      try {
        const fd = fs.openSync(owner, "wx", 0o600);
        ownerCreated = true;
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }) + "\n");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        if (ownerCreated) fs.unlinkSync(owner);
        fs.rmdirSync(directory);
        throw error;
      }
      return () => {
        const saved = readOwner(directory);
        if (saved.token !== token) throw new Error(`The lock at ${directory} changed unexpectedly; it was not removed.`);
        fs.unlinkSync(owner);
        fs.rmdirSync(directory);
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      clearStaleLock(directory);
    }
  }
  throw new Error(`Could not acquire lock at ${directory}; another harness may be running.`);
}

function clearStaleLock(directory: string): void {
  const gate = `${directory}.recovery`;
  try {
    fs.mkdirSync(gate, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Another process is inspecting the lock at ${directory}.`);
    }
    throw error;
  }
  try {
    const owner = readOwner(directory);
    try {
      process.kill(owner.pid, 0);
      throw new Error(`A harness process ${owner.pid} still owns the lock at ${directory}.`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    fs.unlinkSync(path.join(directory, "owner.json"));
    fs.rmdirSync(directory);
  } finally {
    fs.rmdirSync(gate);
  }
}

function readOwner(directory: string): { pid: number; token: string } {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
  } catch {
    throw new Error(`The lock at ${directory} has no valid owner; inspect it manually.`);
  }
  if (!value || typeof value !== "object" || !("pid" in value) || !("token" in value) ||
      typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.token !== "string" || !value.token) {
    throw new Error(`The lock at ${directory} has no valid owner; inspect it manually.`);
  }
  return { pid: value.pid, token: value.token };
}

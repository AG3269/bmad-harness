import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { matchesSelectedSession } from "./attach.js";
import { parseSessions, selectSession, sessionStatus, type AvailableSession } from "./sessions.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const other = path.join(root, "repo-other");
  fs.mkdirSync(repo);
  fs.mkdirSync(other);
  return { repo, other };
}

function discovery(repo: string, other: string) {
  return JSON.stringify([{
    host: { type: "editor", pid: 12, instanceId: "host-one", address: "secret-host-token" },
    sessions: [
      { resource: "ahp-session:/older", title: "Older", status: 33,
        workingDirectories: [pathToFileURL(repo).href], modifiedAt: "2026-01-01T10:00:00Z" },
      { resource: "ahp-session:/newer", title: "Newer", status: 8,
        workingDirectories: [repo], modifiedAt: "2026-01-02T10:00:00Z" },
      { resource: "ahp-session:/other", title: "Other", status: 33,
        workingDirectories: [pathToFileURL(other).href], modifiedAt: "2026-01-03T10:00:00Z" },
      { resource: "copilotcli:/other?unrelated", title: "Other provider", status: 33,
        workingDirectories: [pathToFileURL(other).href] },
    ],
  }]);
}

function capture() {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { output, text: () => text };
}

test("discovery filters exact working directories and sorts recent sessions first", (t) => {
  const { repo, other } = fixture(t);
  const sessions = parseSessions(discovery(repo, other), repo);
  assert.deepEqual(sessions.map((s) => s.resource), ["ahp-session:/newer", "ahp-session:/older"]);
  assert.equal(JSON.stringify(sessions).includes("secret-host-token"), false);
});

test("the picker displays statuses and accepts a valid answer after invalid input", async (t) => {
  const { repo, other } = fixture(t);
  const sessions = parseSessions(discovery(repo, other), repo);
  const captured = capture();
  const selected = await selectSession(sessions, {
    input: Readable.from(["invalid\n3\n2\n"]),
    output: captured.output,
    allowPipedInput: true,
  });
  assert.equal(selected.resource, "ahp-session:/older");
  assert.match(captured.text(), /Newer \[running\]/);
  assert.match(captured.text(), /Older \[idle\]/);
  assert.match(captured.text(), /may be open or closed/);
  assert.match(captured.text(), /Enter a listed session number/);
  assert.doesNotMatch(captured.text(), /secret-host-token/);
});

test("session IDs and exact unique titles can be selected without a terminal", async (t) => {
  const { repo, other } = fixture(t);
  const sessions = parseSessions(discovery(repo, other), repo);
  assert.equal((await selectSession(sessions, { requested: "ahp-session:/newer" })).title, "Newer");
  assert.equal((await selectSession(sessions, { requested: "Older" })).resource, "ahp-session:/older");
  await assert.rejects(selectSession(sessions, { requested: "New" }), /does not match/);
  await assert.rejects(selectSession(sessions, { requested: "ahp-session:/other" }), /does not match/);
});

test("ambiguous IDs or titles never select a session", async () => {
  const session: AvailableSession = {
    resource: "ahp-session:/same", title: "Same", status: 1,
    host: { type: "editor", pid: 1, instanceId: "one" },
  };
  const duplicate = { ...session, host: { type: "editor", pid: 2, instanceId: "two" } };
  await assert.rejects(selectSession([session, duplicate], { requested: "ahp-session:/same" }), /ambiguous/);
  await assert.rejects(selectSession([session, duplicate], { requested: "Same" }), /ambiguous/);
  await assert.rejects(selectSession([session, duplicate], {
    input: Readable.from(["1\n"]), output: capture().output, allowPipedInput: true,
  }), /multiple hosts/);
});

test("cancellation, EOF, no sessions, and unattended selection fail explicitly", async (t) => {
  const { repo, other } = fixture(t);
  const sessions = parseSessions(discovery(repo, other), repo);
  const options = { output: capture().output, allowPipedInput: true };
  await assert.rejects(selectSession(sessions, { ...options, input: Readable.from(["q\n"]) }), /cancelled/);
  await assert.rejects(selectSession(sessions, { ...options, input: Readable.from([]) }), /without a choice/);
  await assert.rejects(selectSession([], options), /No saved agent sessions/);
  await assert.rejects(selectSession(sessions, { input: Readable.from([]) }), /interactive terminal/);
});

test("malformed discovery fails without exposing its contents", (t) => {
  const { repo } = fixture(t);
  assert.throws(() => parseSessions("secret-host-token", repo), (error: Error) => {
    assert.match(error.message, /not valid JSON/);
    assert.doesNotMatch(error.message, /secret-host-token/);
    return true;
  });
  assert.throws(() => parseSessions(JSON.stringify([{ host: {}, sessions: [] }]), repo), /unexpected format/);
  assert.throws(() => parseSessions(JSON.stringify([{
    host: { type: "editor", pid: 1, instanceId: "one" },
    sessions: [{ resource: "ahp-session:/bad\u001b", title: "x", status: 1, workingDirectories: [repo] }],
  }]), repo), /unsupported or unsafe session ID/);
});

test("status labels distinguish idle, running, input and archived", () => {
  assert.equal(sessionStatus(33), "idle");
  assert.equal(sessionStatus(8), "running");
  assert.equal(sessionStatus(24), "waiting for input");
  assert.equal(sessionStatus(65), "idle, archived");
  assert.equal(sessionStatus(0), "status unknown");
});

test("the legacy driver requires the selected ID and exact workspace", (t) => {
  const { repo, other } = fixture(t);
  const wanted = "ahp-session:/chosen";
  assert.equal(matchesSelectedSession({ id: "chosen", workspace: repo }, wanted, repo), true);
  assert.equal(matchesSelectedSession({ resource: wanted, workingDirectories: [pathToFileURL(repo).href] }, wanted, repo), true);
  assert.equal(matchesSelectedSession({ id: "chosen", workspace: other }, wanted, repo), false);
  assert.equal(matchesSelectedSession({ resource: wanted, workingDirectories: [repo, other] }, wanted, repo), false);
  assert.equal(matchesSelectedSession({ id: "different", workspace: repo }, wanted, repo), false);
  assert.equal(matchesSelectedSession({ id: "chosen" }, wanted, repo), false);
});

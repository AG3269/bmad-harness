import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { Story } from "../bmad/stories.js";
import { StoryBindings } from "./bindings.js";
import { selectSession, type AvailableSession } from "./sessions.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bindings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const file = path.join(repo, "1.1.md");
  fs.writeFileSync(file, "# Story 1.1\n");
  const story: Story = { id: "1.1", title: "Test", status: "Ready", narrative: "", fullText: "", criteria: [], file };
  const session: AvailableSession = {
    resource: "ahp-session:/one", title: "One", status: 1,
    host: { type: "editor", pid: 12, instanceId: "host" },
  };
  return { root, repo, story, session };
}

test("records a selection once per story and reuses it without prompting", async (t) => {
  const { root, repo, story, session } = fixture(t);
  let choices = 0;
  const discover = async () => [session];
  const choose = async () => { choices++; return session; };
  const bindings = new StoryBindings(repo, path.join(root, "state"), discover, choose);
  assert.equal((await bindings.resolve(story)).resource, session.resource);
  assert.equal((await bindings.resolve(story)).resource, session.resource);
  assert.equal(choices, 1);
  const saved = fs.readFileSync(path.join(root, "state", fs.readdirSync(path.join(root, "state"))[0]!), "utf8");
  assert.doesNotMatch(saved, /connectionToken|address|host"/);
  const restarted = new StoryBindings(repo, path.join(root, "state"), discover, choose);
  assert.equal((await restarted.resolve(story)).resource, session.resource);
  assert.equal(choices, 1);

  const otherFile = path.join(repo, "1.2.md");
  fs.writeFileSync(otherFile, "# Story 1.2\n");
  await restarted.resolve({ ...story, id: "1.2", file: otherFile });
  assert.equal(choices, 2);
});

test("a planned story keeps its selected session after its file is created", async (t) => {
  const { root, repo, story, session } = fixture(t);
  const file = path.join(repo, "future", "nested", "1-2-future.md");
  const planned = { ...story, id: "1.2", file, planned: true };
  let choices = 0;
  const state = path.join(root, "bindings");
  const bindings = new StoryBindings(repo, state, async () => [session], async () => { choices++; return session; });
  await bindings.resolve(planned);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Story 1.2: Future\n");
  const reopened = new StoryBindings(repo, state, async () => [session], async () => { throw new Error("Must not prompt again."); });
  assert.equal((await reopened.resolveExisting({ ...planned, planned: false })).resource, session.resource);
  assert.equal(choices, 1);
  await assert.rejects(bindings.resolve({ ...planned, file: path.join(root, "missing", "outside.md") }), /not inside/);
});

test("unavailable saved sessions stop instead of prompting or changing sessions", async (t) => {
  const { root, repo, story, session } = fixture(t);
  const state = path.join(root, "state");
  let available = [session];
  let choices = 0;
  const bindings = new StoryBindings(repo, state, async () => available, async () => { choices++; return session; });
  await bindings.resolve(story);
  available = [];
  await assert.rejects(bindings.resolve(story), /saved session.*unavailable/);
  assert.equal(choices, 1);
});

test("recovery requires an existing binding and never opens a picker", async (t) => {
  const { root, repo, story, session } = fixture(t);
  let choices = 0;
  const bindings = new StoryBindings(repo, path.join(root, "state"), async () => [session], async () => { choices++; return session; });
  await assert.rejects(bindings.resolveExisting(story), /No saved session/);
  assert.equal(choices, 0);
  await bindings.resolve(story);
  assert.equal((await bindings.resolveExisting(story)).resource, session.resource);
  assert.equal(choices, 1);
});

test("explicit replacement is recorded and then reused", async (t) => {
  const { root, repo, story, session } = fixture(t);
  const other = { ...session, resource: "ahp-session:/two", title: "Two" };
  const state = path.join(root, "state");
  const bindings = new StoryBindings(repo, state, async () => [session, other], selectSession);
  await bindings.resolve(story, session.resource);
  await bindings.resolve(story, other.resource);
  assert.equal((await bindings.resolve(story)).resource, other.resource);
});

test("explicit reselection can replace a remembered session", async (t) => {
  const { root, repo, story, session } = fixture(t);
  const other = { ...session, resource: "ahp-session:/two", title: "Two" };
  let choice = session;
  const bindings = new StoryBindings(repo, path.join(root, "state"), async () => [session, other], async () => choice);
  await bindings.resolve(story);
  choice = other;
  await bindings.resolve(story, undefined, true);
  assert.equal((await bindings.resolve(story)).resource, other.resource);
});

test("invalid binding and stories outside the repo fail explicitly", async (t) => {
  const { root, repo, story, session } = fixture(t);
  const state = path.join(root, "state");
  const bindings = new StoryBindings(repo, state, async () => [session], selectSession);
  await bindings.resolve(story, session.resource);
  const file = path.join(state, fs.readdirSync(state)[0]!);
  fs.writeFileSync(file, "bad");
  await assert.rejects(bindings.resolve(story), /not valid JSON/);
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "");
  await assert.rejects(bindings.resolve({ ...story, file: outside }), /not inside/);
});

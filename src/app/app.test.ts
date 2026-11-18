import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import * as YAML from "yaml";
import { HarnessApp } from "./service.js";
import { createAppServer } from "./server.js";
import { Ledger } from "../audit/ledger.js";
import { findConfiguredStories } from "../bmad/stories.js";
import { StoryBindings } from "../vscode/bindings.js";
import type { AvailableSession } from "../vscode/sessions.js";
import { RECOVERY_DECISION_REQUIRED } from "../run/recover.js";
import type { SessionInspection } from "../vscode/attach.js";
import { pendingDecision } from "./decisions.js";
import { Question } from "../decide/engine.js";

const idleWorker = "process.stdout.write('worker ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";

function fixture(t: TestContext, script: (index: number) => string = () => idleWorker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-app-"));
  const template = YAML.parse(fs.readFileSync(new URL("../../harness.config.yaml", import.meta.url), "utf8"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const calls: string[][] = [];
  const statuses = new Map<string, number>();
  const inspections = new Map<string, SessionInspection>();
  const inspectionErrors = new Map<string, Error>();
  const inspectionCalls: string[] = [];
  let inspectionGate: Promise<void> | undefined;
  const host = { type: "editor", pid: 1, instanceId: "test-host" };
  function makeConfig(name: string) {
    const dir = path.join(root, name);
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
    for (const id of ["1.1", "1.2"]) fs.writeFileSync(path.join(repo, "stories", `${id}.md`), `# Story ${id}: Test work\n\n## Status\nReady\n\n## Acceptance Criteria\n1. A tested change exists.\n`);
    const configFile = path.join(dir, "harness.config.yaml");
    fs.writeFileSync(configFile, YAML.stringify({ ...template, repo, stories_dir: "stories", story_creation: { enabled: false }, azure: { ...template.azure, key_env: "HARNESS_APP_TEST_SECRET" } }));
    fs.writeFileSync(path.join(dir, ".env"), `HARNESS_APP_TEST_SECRET=synthetic-${name}-secret\n`);
    return { repo, configFile };
  }
  const first = makeConfig("first");
  const sessions = async (repo: string): Promise<AvailableSession[]> => [{
    resource: `ahp-session:/${path.basename(path.dirname(repo))}`,
    title: "Test session", status: statuses.get(repo) ?? 1, host,
  }];
  const app = new HarnessApp(first.configFile, root, {
    discover: sessions,
    inspect: async (_repo, session) => {
      inspectionCalls.push(session.resource);
      if (inspectionGate) await inspectionGate;
      const error = inspectionErrors.get(session.resource);
      if (error) throw error;
      return inspections.get(session.resource) ?? {
        session: session.resource, chat: "ahp-chat:/test", title: "Test session",
        recentTurns: [], pendingInputs: 0, terminals: [],
      };
    },
    launch: (args, cwd, env) => {
      calls.push(args);
      const child = spawn(process.execPath, ["-e", script(calls.length)], { cwd, env, stdio: "pipe", windowsHide: true });
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
      const closed = once(child, "close"); child.stdin.end(); await closed;
    }));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, app, calls, children, statuses, first, sessions, makeConfig,
    inspections, inspectionErrors, inspectionCalls, setInspectionGate: (gate: Promise<void>) => { inspectionGate = gate; },
  };
}

async function seedRecoveryRun(state: ReturnType<typeof fixture>, paused = false) {
  const { app, root, first, sessions } = state;
  const profile = (await app.snapshot()).workspaces[0]!;
  const cfg = app.config(profile.id).cfg;
  const story = findConfiguredStories(cfg)[0]!;
  const session = "ahp-session:/first";
  await new StoryBindings(cfg.repo, path.join(path.dirname(first.configFile), ".harness-state", "sessions"), sessions).resolve(story, session);
  const ledger = new Ledger(path.join(root, "runs"), "epic-1-original");
  ledger.write({ type: "run_started", epic: "epic-1", mode: "watch", repo: cfg.repo, pid: 2147483647, session: "selected" });
  ledger.write({ type: "story_session", story: story.id, session });
  ledger.write({ type: "turn_started", story: story.id, stage: "develop", turnId: "00000000-0000-4000-8000-000000000001", agent: "dev", model: "model" });
  ledger.write({ type: "run_finished", outcome: "error", summary: "Monitoring detached" });
  if (paused) {
    const turnId = "00000000-0000-4000-8000-000000000002";
    ledger.write({ type: "turn_started", story: story.id, stage: "reconcile", turnId, agent: "dev", model: "model" });
    ledger.keep(`reconcile-${createHash("sha256").update(turnId).digest("hex")}.json`, {
      summary: "Development finished; independent review remains.", next_step: "review", uncertainties: ["Review was not rerun after corrections."],
    });
    ledger.write({ type: "recovery_failed", story: story.id, summary: RECOVERY_DECISION_REQUIRED });
  }
  return { profile, ledger, story };
}

test("the app runs independent workspaces in parallel and queues a shared workspace without duplicate dispatch", async (t) => {
  const { app, calls, makeConfig } = fixture(t);
  const first = (await app.snapshot()).workspaces[0]!;
  await app.start({ profileId: first.id, target: "1.1", session: "ahp-session:/first" });
  const queued = await app.start({ profileId: first.id, target: "1.2", session: "ahp-session:/first" });
  assert.equal(queued.state, "queued");
  await assert.rejects(app.start({ profileId: first.id, target: "1.1", session: "ahp-session:/first" }), /already running or queued/);
  const other = makeConfig("second");
  const second = app.addProfile({ name: "Second", configFile: other.configFile });
  await app.start({ profileId: second.id, target: "epic-1", session: "ahp-session:/second" });
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.includes("--story"));
  assert.ok(calls[1]!.includes("epic-1"));
  const state = await app.snapshot();
  assert.equal(state.tasks.filter((task) => task.state === "running").length, 2);
  assert.equal(state.tasks.filter((task) => task.state === "queued").length, 1);
});

test("an active original agent cannot be started again", async (t) => {
  const { app, statuses, first, calls } = fixture(t);
  const profile = (await app.snapshot()).workspaces[0]!;
  statuses.set(first.repo, 8);
  await assert.rejects(app.start({ profileId: profile.id, target: "1.1", session: "ahp-session:/first" }), /Reconnect its existing run/);
  assert.equal(calls.length, 0);
});

test("the app accepts a decision only for its own waiting harness process", async (t) => {
  const { app, children } = fixture(t, () =>
    "process.stdout.write('Pick [a / b] or \"stop\": ');process.stdin.on('data',data=>{console.log('Selected '+data.toString().trim());process.exit(0)});process.stdin.on('end',()=>process.exit(0));");
  const profile = (await app.snapshot()).workspaces[0]!;
  const task = await app.start({ profileId: profile.id, target: "1.1", session: "ahp-session:/first" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await app.snapshot()).tasks[0]?.state === "decision") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await app.snapshot()).tasks[0]!.state, "decision");
  const decision = (await app.snapshot()).tasks[0]!.decision!;
  await assert.rejects(app.respond({ taskId: task.id, answer: "a", decisionId: "outdated-question" }), /decision changed/);
  await assert.rejects(app.respond({ taskId: task.id, answer: "unknown", decisionId: decision.id }), /listed options/);
  const closed = once(children[0]!, "close");
  await app.respond({ taskId: task.id, answer: "a", decisionId: decision.id });
  await closed;
  assert.match((await app.snapshot()).tasks[0]!.output, /Selected a/);
  await assert.rejects(app.respond({ taskId: task.id, answer: "b" }), /not waiting/);
});

test("the backend polls at startup and every 30 seconds without any browser requests", async (t) => {
  const { app } = fixture(t);
  let polls = 0;
  t.mock.method(app, "pollSessions", async () => { polls++; });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const server = createAppServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(polls, 1);
    t.mock.timers.tick(29_999);
    assert.equal(polls, 1);
    t.mock.timers.tick(1);
    assert.equal(polls, 2);
    t.mock.timers.tick(30_000);
    assert.equal(polls, 3);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  t.mock.timers.tick(30_000);
  assert.equal(polls, 3);
});

test("session polling observes newer responses and terminals while the harness waits for a decision", async (t) => {
  const state = fixture(t, () =>
    "console.log('Options:\\n  fix  Fix findings\\n      Re-run review after corrections.\\n  stop  Stop here');process.stdout.write('Pick [fix / stop] or \"stop\": ');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
  const { profile } = await seedRecoveryRun(state);
  const task = await state.app.start({ profileId: profile.id, target: "1.1", session: "ahp-session:/first" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await state.app.snapshot()).tasks.find((item) => item.id === task.id)?.state === "decision") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const observation: SessionInspection = {
    session: "ahp-session:/first", chat: "ahp-chat:/test", title: "Original session",
    recentTurns: [{ id: "newer-turn", state: "complete", text: "The session progressed outside the waiting harness." }],
    pendingInputs: 0, terminals: [{ title: "Story tests", text: "synthetic-first-secret\nNew test result" }],
  };
  state.inspections.set(observation.session, observation);
  await state.app.pollSessions();
  const snapshot = await state.app.snapshot();
  const run = snapshot.workspaces[0]!.runs[0]!;
  assert.equal(run.sessionAdvanced, true);
  assert.match(run.sessionSync!.inspection!.recentTurns[0]!.text, /progressed outside/);
  assert.match(run.sessionSync!.inspection!.terminals[0]!.text, /\[hidden\]\nNew test result/);
  assert.ok(run.sessionSync!.checkedAt);
  assert.equal(snapshot.tasks.find((item) => item.id === task.id)!.state, "decision");
  assert.deepEqual(snapshot.tasks.find((item) => item.id === task.id)!.decision!.choices.map((choice) => choice.id), ["fix", "stop"]);
  assert.equal(state.inspectionCalls.length, 1);
  assert.equal(state.calls.length, 1);
  assert.equal(run.phase1, undefined);
  assert.notEqual(run.outcome, "finished");
});

test("overlapping polls do not duplicate inspection and failures retain explicitly stale evidence", async (t) => {
  const state = fixture(t);
  await seedRecoveryRun(state);
  let release!: () => void;
  state.setInspectionGate(new Promise<void>((resolve) => { release = resolve; }));
  const first = state.app.pollSessions();
  const second = state.app.pollSessions();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.inspectionCalls.length, 1);
  release();
  await Promise.all([first, second]);
  const successful = (await state.app.snapshot()).workspaces[0]!.runs[0]!.sessionSync!;
  state.inspectionErrors.set("ahp-session:/first", new Error("Inspection unavailable: synthetic-first-secret"));
  await state.app.pollSessions();
  const failed = (await state.app.snapshot()).workspaces[0]!.runs[0]!.sessionSync!;
  assert.equal(failed.checkedAt, successful.checkedAt);
  assert.deepEqual(failed.inspection, successful.inspection);
  assert.match(failed.error!, /Inspection unavailable: \[hidden\]/);
  assert.ok(failed.attemptedAt);
  assert.equal(state.calls.length, 0);
});

test("one session inspection failure does not block another workspace's latest activity", async (t) => {
  const state = fixture(t);
  await seedRecoveryRun(state);
  const other = state.makeConfig("second");
  const profile = state.app.addProfile({ name: "Second", configFile: other.configFile });
  const ledger = new Ledger(path.join(state.root, "runs"), "epic-1-other");
  ledger.write({ type: "run_started", epic: "epic-1", mode: "watch", repo: other.repo, pid: 2147483647, session: "selected" });
  ledger.write({ type: "story_session", story: "1.1", session: "ahp-session:/second" });
  state.inspectionErrors.set("ahp-session:/first", new Error("First session is unavailable."));
  state.inspections.set("ahp-session:/second", {
    session: "ahp-session:/second", chat: "ahp-chat:/second", title: "Second session",
    recentTurns: [{ id: "latest-second", state: "complete", text: "Second workspace advanced." }], pendingInputs: 0, terminals: [],
  });
  await state.app.pollSessions();
  const snapshot = await state.app.snapshot();
  assert.match(snapshot.workspaces[0]!.runs[0]!.sessionSync!.error!, /First session is unavailable/);
  const second = snapshot.workspaces.find((item) => item.id === profile.id)!.runs[0]!;
  assert.equal(second.sessionSync!.error, undefined);
  assert.equal(second.sessionSync!.inspection!.recentTurns[0]!.text, "Second workspace advanced.");
  assert.equal(state.calls.length, 0);
});

test("recorded decisions include their background, complete findings, and actionable choices", async (t) => {
  const state = fixture(t);
  const { ledger } = await seedRecoveryRun(state);
  const finding = { id: "R1", severity: "high" as const, kind: "test_gap", file: "tests.py", what: "A distinct missing assertion.", suggested_fix: "Assert the complete projection.", is_proof_gap: true };
  ledger.write({ type: "review_findings", story: "1.1", findings: [finding] });
  const question = Question.parse({
    kind: "review-findings", asks: "Fix these findings or stop?", context: "The review was completed against the saved story.",
    options: [{ id: "fix", label: "Fix them now", detail: "Correct the proof gap." }, { id: "stop", label: "Stop here" }],
  });
  ledger.write({ type: "decision_requested", story: "1.1", requestId: "question-1", question, why: "Review needs a choice", summary: "Review result" });
  const task = { id: "task-1", state: "decision", updatedAt: new Date().toISOString() };
  const decision = pendingDecision(task, "", ledger.read())!;
  assert.equal(decision.question, question.asks);
  assert.equal(decision.background, question.context);
  assert.deepEqual(decision.findings, [finding]);
  assert.deepEqual(decision.choices.map(({ id, label }) => ({ id, label })), [{ id: "fix", label: "Fix them now" }, { id: "stop", label: "Stop here" }]);
  ledger.write({ type: "answered", story: "1.1", question: question.asks, pick: "fix", by: "human", sureness: null, because: "Explicit decision" });
  assert.equal(pendingDecision(task, "", ledger.read()), undefined);
  ledger.write({ type: "turn", story: "1.1", stage: "review", agent: "reviewer", model: "test", seconds: 1 });
  assert.equal((await state.app.snapshot()).workspaces[0]!.runs[0]!.stage, "review");
});

test("worker errors stay on their task, redact split credentials, and survive an app restart", async (t) => {
  const { app, children, first, root } = fixture(t, () =>
    "process.stderr.write('synthetic-first-');setTimeout(()=>{process.stderr.write('secret\\nConnection lost\\n');process.exit(1)},30);");
  const profile = (await app.snapshot()).workspaces[0]!;
  const task = await app.start({ profileId: profile.id, target: "1.1", session: "ahp-session:/first" });
  await once(children[0]!, "close");
  const state = await app.snapshot();
  assert.equal(state.tasks[0]!.state, "error");
  assert.match(state.tasks[0]!.output, /\[hidden\]/);
  assert.match(state.tasks[0]!.error!, /Connection lost/);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-first-secret/);
  const restarted = new HarnessApp(first.configFile, root, { discover: async () => [] });
  const recovered = (await restarted.snapshot()).tasks.find((item) => item.id === task.id)!;
  assert.equal(recovered.state, "error");
  assert.match(recovered.output, /Connection lost/);
});

test("workspace environments are isolated and inherited configs retain the default credential source", async (t) => {
  const { app, makeConfig } = fixture(t);
  const first = (await app.snapshot()).workspaces[0]!;
  const second = app.addProfile({ name: "Second", configFile: makeConfig("second").configFile });
  assert.equal(app.config(first.id).env.HARNESS_APP_TEST_SECRET, "synthetic-first-secret");
  assert.equal(app.config(second.id).env.HARNESS_APP_TEST_SECRET, "synthetic-second-secret");
  assert.equal(process.env.HARNESS_APP_TEST_SECRET, undefined);
  const third = makeConfig("third");
  const inherited = app.addProfile({ name: "Inherited", repo: third.repo, storiesDir: "stories" });
  assert.equal(app.config(inherited.id).env.HARNESS_APP_TEST_SECRET, "synthetic-first-secret");
});

test("reconnect selects the original session and turn rather than redispatching a story", async (t) => {
  const state = fixture(t);
  const { app, first, calls, statuses } = state;
  const { profile } = await seedRecoveryRun(state);
  statuses.set(first.repo, 8);
  await app.recover({ profileId: profile.id, runId: "epic-1-original", action: "watch" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes("--recover-turn"));
  assert.ok(calls[0]!.includes("epic-1-original"));
  assert.ok(!calls[0]!.includes("--session"));
  assert.ok(!calls[0]!.includes("--continue"));
  await assert.rejects(app.recover({ profileId: profile.id, runId: "epic-1-original", action: "continue" }), /active monitor/);
});

test("paused recovery exposes its saved assessment without silently accepting uncertainty", async (t) => {
  const state = fixture(t);
  const { profile } = await seedRecoveryRun(state, true);
  const run = (await state.app.snapshot()).workspaces[0]!.runs[0]!;
  assert.equal(run.recoveryPaused, true);
  assert.deepEqual(run.recoveryAssessment?.uncertainties, ["Review was not rerun after corrections."]);
  assert.equal(run.recoveryAssessment?.next_step, "review");
  await state.app.recover({ profileId: profile.id, runId: run.id, action: "continue" });
  assert.ok(state.calls[0]!.includes("--continue"));
  assert.ok(!state.calls[0]!.includes("--accept-uncertainty"));
});

test("accepting uncertainty is explicit, assessment-bound, and limited to continuation", async (t) => {
  const state = fixture(t);
  const { profile } = await seedRecoveryRun(state, true);
  const run = (await state.app.snapshot()).workspaces[0]!.runs[0]!;
  const request = { profileId: profile.id, runId: run.id, action: "continue", acceptUncertainty: true };
  await assert.rejects(state.app.recover(request), /changed or was not confirmed/);
  await assert.rejects(state.app.recover({ ...request, assessmentFingerprint: "0".repeat(64) }), /changed or was not confirmed/);
  await assert.rejects(state.app.recover({ ...request, action: "watch", assessmentFingerprint: run.recoveryAssessmentFingerprint }), /only when continuing/);
  assert.equal(state.calls.length, 0);
  await state.app.recover({ ...request, assessmentFingerprint: run.recoveryAssessmentFingerprint });
  assert.ok(state.calls[0]!.includes("--accept-uncertainty"));
  assert.ok(state.calls[0]!.includes("--assessment-fingerprint"));
  assert.ok(state.calls[0]!.includes(run.recoveryAssessmentFingerprint!));
  assert.ok(state.calls[0]!.includes("--recover-turn"));
  assert.ok(!state.calls[0]!.includes("--session"));
});

test("a missing saved assessment remains visible and cannot be accepted", async (t) => {
  const state = fixture(t);
  const { profile, ledger } = await seedRecoveryRun(state, true);
  const saved = fs.readdirSync(ledger.dir).find((file) => file.startsWith("reconcile-") && file.endsWith(".json"))!;
  fs.unlinkSync(path.join(ledger.dir, saved));
  const run = (await state.app.snapshot()).workspaces[0]!.runs[0]!;
  assert.equal(run.recoveryPaused, true);
  assert.match(run.recoveryAssessmentError!, /saved assessment is missing/);
  await assert.rejects(state.app.recover({
    profileId: profile.id, runId: run.id, action: "continue", acceptUncertainty: true, assessmentFingerprint: "0".repeat(64),
  }), /only when continuing a paused run with a saved recovery assessment/);
  assert.equal(state.calls.length, 0);
});

test("the local HTTP app rejects missing tokens, cross-origin requests, and unsafe hosts", async (t) => {
  const { app } = fixture(t);
  const server = createAppServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const html = await (await fetch(origin)).text();
  const token = html.match(/name="app-token" content="([^"]+)"/)![1]!;
  assert.equal((await fetch(origin + "/api/state")).status, 403);
  assert.equal((await fetch(origin + "/api/state", { headers: { "X-Harness-Token": token } })).status, 200);
  assert.equal((await fetch(origin + "/api/state", { headers: { "X-Harness-Token": token, Origin: "https://example.invalid" } })).status, 403);
  const unsafeHost = await new Promise<number | undefined>((resolve, reject) => {
    http.get(origin + "/api/state", { headers: { "X-Harness-Token": token, Host: "attacker.invalid" } }, (response) => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(unsafeHost, 403);
  assert.equal((await fetch(origin + "/api/start", {
    method: "POST", headers: { "X-Harness-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ target: "../bad" }),
  })).status, 400);
});

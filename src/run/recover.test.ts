import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig } from "../config.js";
import { Ledger } from "../audit/ledger.js";
import { snapshotWorktree } from "../validate/diff.js";
import { saveBaseline } from "./baseline.js";
import { askRecoveryAgent, recoverRecordedTurn, withRecoveryAudit, recoveryAssessmentFingerprint, assertRecoveryAssessmentFingerprint } from "./recover.js";
import { assertRecoveryConfig, recoveryConfigFingerprint } from "./config-fingerprint.js";
import { Clock, OutOfTime } from "./epic.js";
import { StubSession } from "../vscode/stub.js";
import type { Reply, Turn } from "../vscode/types.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-recover-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked"), "tracked\n");
  git("add", "tracked");
  git("commit", "-qm", "base");
  const storyFile = path.join(repo, "stories", "1.1.md");
  fs.writeFileSync(storyFile, "# Story 1.1: Test\n");
  const story = { id: "1.1", title: "Test", status: "Ready", narrative: "", fullText: "", file: storyFile, criteria: [] };
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const configFile = path.join(root, "config.yaml");
  fs.writeFileSync(configFile, YAML.stringify({ ...template, repo, stories_dir: "stories", story_creation: { enabled: false } }));
  const cfg = loadConfig(configFile, { requireAzureKey: false });
  const ledger = new Ledger(root, "run");
  const session = "ahp-session:/test";
  const turnId = randomUUID();
  ledger.write({ type: "run_started", epic: "epic-1", mode: "watch", repo, pid: 2147483647, session: "selected" });
  ledger.write({ type: "story_session", story: story.id, session });
  const baselineFile = `baseline-${createHash("sha256").update(story.file).digest("hex")}.json.gz`;
  saveBaseline(path.join(ledger.dir, baselineFile), snapshotWorktree(repo, { ignore: cfg.phase1.ignore }));
  ledger.write({ type: "story_baseline", story: story.id, file: baselineFile, ignore: cfg.phase1.ignore });
  ledger.write({ type: "turn_started", story: story.id, stage: "develop", turnId, agent: "dev", model: "model" });
  return { root, repo, cfg, story, ledger, session, turnId, configFile };
}

test("automatic continuation requires the original safety configuration and Azure mode", (t) => {
  const { cfg } = fixture(t);
  const original = recoveryConfigFingerprint(cfg, false);
  assert.doesNotThrow(() => assertRecoveryConfig(cfg, false, original));
  assert.throws(() => assertRecoveryConfig(cfg, true, original), /fake mode changed/);
  assert.throws(() => assertRecoveryConfig(cfg, false), /no valid configuration fingerprint/);
  assert.throws(() => assertRecoveryConfig(cfg, false, "invalid"), /no valid configuration fingerprint/);
  const changed = structuredClone(cfg);
  changed.phase1.enabled = !changed.phase1.enabled;
  assert.throws(() => assertRecoveryConfig(changed, false, original), /configuration or Azure fake mode changed/);
  changed.phase1.enabled = cfg.phase1.enabled;
  changed.tool_approvals.auto_allow.push({ tool: "list_directory", input_sha256: "0".repeat(64) });
  assert.throws(() => assertRecoveryConfig(changed, false, original), /configuration or Azure fake mode changed/);
  assert.equal(original.length, 64);
});

test("recovery failures before continuation are persisted and redact credentials", async (t) => {
  const { ledger } = fixture(t);
  ledger.hide(["example-private-key"]);
  await assert.rejects(withRecoveryAudit(ledger, "1.1", async () => {
    throw new Error("Refresh failed: example-private-key");
  }), /Refresh failed/);
  const report = fs.readFileSync(path.join(ledger.dir, "report.md"), "utf8");
  assert.match(report, /Recovery errors/);
  assert.match(report, /Refresh failed: \[hidden\]/);
  assert.doesNotMatch(report, /example-private-key/);
  assert.equal(ledger.read().at(-1)?.type, "recovery_failed");
});

test("uncertainty confirmation cannot be reused after the recovery assessment changes", () => {
  const assessment = { summary: "Review remains.", next_step: "review" as const, uncertainties: ["The tree needs inspection."] };
  const confirmed = recoveryAssessmentFingerprint(assessment);
  assert.doesNotThrow(() => assertRecoveryAssessmentFingerprint(assessment, confirmed));
  assert.throws(() => assertRecoveryAssessmentFingerprint({
    ...assessment, uncertainties: [...assessment.uncertainties, "A new prerequisite is unresolved."],
  }, confirmed), /assessment changed since your confirmation/);
});

test("the long-run clock counts agent turns, not story checks, and restores limits", (t) => {
  const { cfg } = fixture(t);
  cfg.limits.max_agent_turns = 1;
  const clock = new Clock(cfg);
  clock.check();
  assert.equal(clock.turns, 0);
  clock.tick();
  clock.check();
  assert.equal(clock.turns, 1);
  assert.throws(() => clock.tick(), OutOfTime);
  assert.equal(clock.turns, 1);
  const resumed = new Clock(cfg, { started: Date.now(), turns: 1 });
  resumed.check();
  assert.throws(() => resumed.tick(), OutOfTime);
  cfg.limits.max_minutes = 1;
  const expired = new Clock(cfg, { started: Date.now() - 120_000, turns: 0 });
  assert.throws(() => expired.check(), /running .* cap/);
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const beforeDeadline = new Clock(cfg, { started: now - 59_999, turns: 0 });
  assert.doesNotThrow(() => beforeDeadline.check());
  const atDeadline = new Clock(cfg, { started: now - 60_000, turns: 0 });
  assert.throws(() => atDeadline.check(), OutOfTime);
});

test("the recovery CLI rejects changed safety settings before connecting to VS Code", (t) => {
  const { root, repo, cfg, configFile } = fixture(t);
  const ledger = new Ledger(path.join(root, "runs"), "cli-run");
  ledger.write({
    type: "run_started", epic: "epic-1", mode: cfg.mode, repo, session: "selected",
    configFingerprint: recoveryConfigFingerprint(cfg, true),
  });
  const changed = YAML.parse(fs.readFileSync(configFile, "utf8"));
  changed.phase1.enabled = !changed.phase1.enabled;
  fs.writeFileSync(configFile, YAML.stringify(changed));
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    path.join(project, "src", "main.ts"),
    "--recover-turn", "cli-run", "--story", "1.1", "--continue", "--config", configFile,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, HARNESS_FAKE_AZURE: "1" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /configuration or Azure fake mode changed/);
  assert.equal(ledger.read().length, 1);
});

test("recovery follows the recorded turn and compares the saved baseline after it finishes", async (t) => {
  const { cfg, story, ledger, session, turnId, repo } = fixture(t);
  let calls = 0;
  const result = await recoverRecordedTurn({
    cfg, story, ledger, session,
    driver: {
      async recoverTurn(id, selection) {
        calls++;
        assert.equal(id, turnId);
        assert.deepEqual(selection, { agent: "dev", model: "model" });
        fs.writeFileSync(path.join(repo, "new.txt"), "work completed\n");
        return { text: "Recovered answer", changed: [], idle: true };
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.filesChanged, 1);
  assert.match(result.recommendation, /Review/);
  assert.equal(JSON.parse(fs.readFileSync(result.artifact, "utf8")).response, "Recovered answer");
  assert.ok(ledger.read().some((event) => event.type === "turn_recovered" && event.turnId === turnId));
});

test("recovery rejects a different session before contacting the driver", async (t) => {
  const { cfg, story, ledger } = fixture(t);
  let contacted = false;
  await assert.rejects(recoverRecordedTurn({
    cfg, story, ledger, session: "ahp-session:/wrong",
    driver: { async recoverTurn() { contacted = true; return { text: "", changed: [], idle: true }; } },
  }), /differs from the original run/);
  assert.equal(contacted, false);
});

test("resuming a ledger preserves monotonic event numbering", (t) => {
  const { root, ledger } = fixture(t);
  const initial = ledger.read().length;
  const reopened = new Ledger(root, "run", { resume: true });
  reopened.write({ type: "note", text: "Recovered" });
  assert.equal(reopened.read()[initial]?.seq, initial);
});

test("the report reflects an active recovery rather than an older failure", (t) => {
  const { ledger } = fixture(t);
  ledger.write({ type: "run_finished", outcome: "error", summary: "Previous failure" });
  assert.match(ledger.report(), /\*\*Result:\*\* error/);
  ledger.write({ type: "run_resumed", story: "1.1" });
  assert.match(ledger.report(), /\*\*Result:\*\* still running/);
  ledger.write({ type: "run_finished", outcome: "finished", summary: "Recovered" });
  assert.match(ledger.report(), /\*\*Result:\*\* finished/);
});

test("recovery can ask the agent for an advisory assessment without accepting invalid output", async (t) => {
  const { cfg, story, ledger, repo } = fixture(t);
  class AssessmentSession extends StubSession {
    valid = true;
    override async send(turn: Turn): Promise<Reply> {
      assert.match(turn.say, /Do not edit files, run commands, call tools/);
      return {
        text: this.valid ? JSON.stringify({ summary: "Review remains.", next_step: "review", uncertainties: [] }) : "{}",
        changed: [], idle: true,
      };
    }
  }
  const vscode = new AssessmentSession(repo);
  const report = await askRecoveryAgent({ cfg, ledger, story, vscode, previousStage: "develop", originalTurnId: randomUUID() });
  assert.equal(report.next_step, "review");
  vscode.valid = false;
  await assert.rejects(askRecoveryAgent({ cfg, ledger, story, vscode, previousStage: "develop", originalTurnId: randomUUID() }), /invalid format/);
  assert.equal(ledger.read().filter((event) => event.type === "turn_started" && event.stage === "reconcile").length, 2);
});

test("recovery restores the original turn after an interrupted reconciliation without resending either turn", async (t) => {
  const { cfg, story, ledger, session, turnId } = fixture(t);
  const original = await recoverRecordedTurn({
    cfg, story, ledger, session,
    driver: { async recoverTurn() { return { text: "Original answer", changed: [], idle: true }; } },
  });
  const reconcileId = randomUUID();
  ledger.write({ type: "reconcile_started", story: story.id, turnId: reconcileId, originalTurnId: turnId });
  ledger.write({ type: "turn_started", story: story.id, stage: "reconcile", turnId: reconcileId, agent: "dev", model: "model" });
  const recovered = await recoverRecordedTurn({
    cfg, story, ledger, session,
    driver: { async recoverTurn(id) {
      assert.equal(id, reconcileId);
      return { text: JSON.stringify({ summary: "Review remains.", next_step: "review", uncertainties: [] }), changed: [], idle: true };
    } },
  });
  assert.equal(recovered.turnId, original.turnId);
  assert.equal(recovered.stage, "develop");
  assert.equal(recovered.reply.text, "Original answer");
  assert.equal(recovered.assessment?.next_step, "review");
});

test("recovery accepts duplicated completion assessments without replaying the original or advisory turn", async (t) => {
  const { cfg, story, ledger, session, turnId } = fixture(t);
  const original = await recoverRecordedTurn({
    cfg, story, ledger, session,
    driver: { async recoverTurn() { return { text: "Original answer", changed: [], idle: true }; } },
  });
  const originalArtifact = fs.readFileSync(original.artifact, "utf8");
  const reconcileId = randomUUID();
  ledger.write({ type: "reconcile_started", story: story.id, turnId: reconcileId, originalTurnId: turnId });
  ledger.write({ type: "turn_started", story: story.id, stage: "reconcile", turnId: reconcileId, agent: "dev", model: "model" });
  const first = { summary: "The story is blocked.", next_step: "human", uncertainties: ["Approval is missing."] };
  const last = { summary: "Implementation was not authorized.", next_step: "human", uncertainties: ["The next human choice is unknown."] };
  const text = `${JSON.stringify(first)}\n\n**Task completed:**\n\n${JSON.stringify(last)}`;
  let calls = 0;
  const recovered = await recoverRecordedTurn({
    cfg, story, ledger, session,
    driver: { async recoverTurn(id, selection) {
      calls++;
      assert.equal(id, reconcileId);
      assert.equal(selection.noTools, true);
      return { text, changed: [], idle: true };
    } },
  });
  assert.equal(calls, 1);
  assert.equal(recovered.turnId, turnId);
  assert.equal(recovered.assessment?.next_step, "human");
  assert.deepEqual(recovered.assessment?.uncertainties, [...first.uncertainties, ...last.uncertainties]);
  assert.equal(fs.readFileSync(original.artifact, "utf8"), originalArtifact);
  const saved = path.join(ledger.dir, `reconcile-${createHash("sha256").update(reconcileId).digest("hex")}.txt`);
  assert.equal(fs.readFileSync(saved, "utf8"), text);
  assert.equal(ledger.read().filter((event) => event.type === "turn_started" && event.stage === "reconcile").length, 1);
});

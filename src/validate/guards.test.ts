import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig } from "../config.js";
import { Azure, type Ask } from "../llm/azure.js";
import { Ledger } from "../audit/ledger.js";
import { Decider } from "../decide/engine.js";
import { runStory } from "../run/story.js";
import { StubSession } from "../vscode/stub.js";
import type { Reply, Turn } from "../vscode/types.js";
import type { Story } from "../bmad/stories.js";
import { snapshotWorktree, type Changes } from "./diff.js";
import { runPhase1 } from "./phase1.js";
import { archivePreviousReview, readReview } from "./review.js";

class ScriptedAzure extends Azure {
  constructor(private answers: unknown[]) {
    super({
      endpoint: "https://example.invalid", api_version: "test", auth: "key", key_env: "TEST_KEY",
      deployments: { reader: "reader", comparer: "comparer", decider: "decider", summarizer: "summarizer" },
    });
  }

  override async askJson<T>(_opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
    const answer = this.answers.shift();
    if (answer instanceof Error) throw answer;
    return shape.parse(answer);
  }
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify({
    ...template, repo, stories_dir: "stories", story_creation: { enabled: false },
    phase1: {
      ...template.phase1,
      blindness: { ...template.phase1.blindness, exclude: ["stories/**"], max_verbatim_overlap: 1 },
    },
  }));
  const cfg = loadConfig(file, { requireAzureKey: false });
  const story: Story = {
    id: "1.1", title: "Test", status: "Ready", narrative: "", fullText: "", file: "story.md",
    criteria: [{ id: "AC1", text: "First distinct requirement" }, { id: "AC2", text: "Second distinct requirement" }],
  };
  const changes: Changes = {
    files: [{ path: "src/app.ts", added: 1, removed: 0, patch: "+ implementation" }],
    totalAdded: 1, totalRemoved: 0, ignored: [], oversized: false,
  };
  return { root, repo, cfg, story, changes };
}

const reader = { summary: "A change to the application.", confidence: 0.9 };
const verdicts = (ids: string[], verdict = "covered") => ({
  criteria: ids.map((id) => ({ id, verdict, evidence: "evidence" })),
  overall: "comparison",
});

for (const [label, ids, expected] of [
  ["missing", ["AC1"], /Missing comparison verdicts: AC2/],
  ["duplicate", ["AC1", "AC2", "AC2"], /Duplicate comparison verdicts: AC2/],
  ["unknown", ["AC1", "AC2", "AC3"], /Unknown comparison criterion IDs: AC3/],
] as const) {
  test(`incomplete ${label} criterion comparisons escalate instead of passing`, async (t) => {
    const { cfg, story, changes } = fixture(t);
    const result = await runPhase1(story, changes, new ScriptedAzure([reader, verdicts([...ids])]), cfg);
    assert.equal(result.outcome, "escalate");
    assert.match(result.reasons.join(" "), expected);
  });
}

test("missing and duplicate story criteria stop validation", async (t) => {
  const { cfg, story, changes } = fixture(t);
  const empty = await runPhase1({ ...story, criteria: [] }, changes, new ScriptedAzure([]), cfg);
  assert.equal(empty.outcome, "escalate");
  assert.match(empty.reasons[0]!, /no parsed acceptance criteria/);
  const duplicate = await runPhase1({ ...story, criteria: [story.criteria[0]!, story.criteria[0]!] }, changes, new ScriptedAzure([]), cfg);
  assert.equal(duplicate.outcome, "escalate");
  assert.match(duplicate.reasons[0]!, /duplicate acceptance criterion/);
});

test("a decoy call failure is unverified and is shown in the report", async (t) => {
  const { root, cfg, story, changes } = fixture(t);
  const azure = new ScriptedAzure([reader, verdicts(["AC1", "AC2"]), new Error("test failure")]);
  const result = await runPhase1(story, changes, azure, cfg);
  assert.equal(result.outcome, "escalate");
  assert.equal(result.integrity?.decoy?.passed, null);
  assert.equal(result.integrity?.decoy?.falsePositiveRate, null);
  assert.match(result.reasons[0]!, /unverified/);
  const ledger = new Ledger(root, "report");
  ledger.write({ type: "phase1", story: story.id, outcome: result.outcome, reasons: result.reasons, unmet: [], integrity: result.integrity });
  assert.match(ledger.report(), /UNVERIFIED/);
});

test("an incomplete decoy comparison is unverified, not passed", async (t) => {
  const { cfg, story, changes } = fixture(t);
  const azure = new ScriptedAzure([reader, verdicts(["AC1", "AC2"]), verdicts(["AC1"], "missing")]);
  const result = await runPhase1(story, changes, azure, cfg);
  assert.equal(result.outcome, "escalate");
  assert.equal(result.integrity?.decoy?.passed, null);
  assert.match(result.reasons[0]!, /Missing comparison verdicts/);
});

test("complete primary and decoy comparisons can pass", async (t) => {
  const { cfg, story, changes } = fixture(t);
  const azure = new ScriptedAzure([reader, verdicts(["AC1", "AC2"]), verdicts(["AC1", "AC2"], "missing")]);
  const result = await runPhase1(story, changes, azure, cfg);
  assert.equal(result.outcome, "pass");
  assert.equal(result.integrity?.decoy?.passed, true);
});

test("stale reviews are preserved and only a fresh valid array is accepted", (t) => {
  const { repo } = fixture(t);
  const dir = path.join(repo, ".harness");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "review.json"), "[]");
  const archived = archivePreviousReview(repo);
  assert.ok(archived);
  assert.equal(fs.readFileSync(path.join(repo, archived), "utf8"), "[]");
  const vscode = new StubSession(repo);
  assert.throws(() => readReview(vscode), /did not produce a fresh/);
  fs.writeFileSync(path.join(dir, "review.json"), "{bad");
  assert.throws(() => readReview(vscode), /not valid JSON/);
  fs.writeFileSync(path.join(dir, "review.json"), "{}");
  assert.throws(() => readReview(vscode), /invalid findings/);
  fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify([{ id: "F1", severity: "low" }]));
  assert.throws(() => readReview(vscode), /invalid findings/);
  fs.writeFileSync(path.join(dir, "review.json"), "[]");
  assert.deepEqual(readReview(vscode), []);
  fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify([{
    id: "F1", severity: "high", kind: "security", file: "src/a.ts",
    what: "Problem", suggested_fix: "Fix", is_proof_gap: false,
  }]));
  assert.equal(readReview(vscode)[0]?.id, "F1");
});

test("a stale clean review cannot satisfy a new review turn", async (t) => {
  const { root, repo, cfg, story } = fixture(t);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked"), "base\n");
  git("add", "tracked");
  git("commit", "-qm", "base");
  fs.mkdirSync(path.join(repo, ".harness"));
  fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
  const azure = new ScriptedAzure([]);
  const ledger = new Ledger(root, "run");
  const vscode = new StubSession(repo);
  const decider = new Decider(cfg, ledger, azure);
  await assert.rejects(runStory(story, {
    cfg, azure, ledger, vscode, decider, allStories: [story], spend() {},
  }), /did not produce a fresh/);
  const backups = fs.readdirSync(path.join(repo, ".harness")).filter((name) => name.startsWith("review-previous-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(repo, ".harness", backups[0]!, "review.json"), "utf8"), "[]");
});

for (const variant of ["stale", "fresh", "invalid-question"] as const) {
  test(`review question handling: ${variant}`, async (t) => {
    const { root, repo, cfg, story } = fixture(t);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
    const storyFile = path.join(repo, "story.md");
    fs.writeFileSync(storyFile, "# Story 1.1: Test\n\n## Status\nReady\n");
    git("add", ".gitignore", "story.md");
    git("commit", "-qm", "base");

    class QuestioningSession extends StubSession {
      reviewTurns = 0;
      override async send(turn: Turn): Promise<Reply> {
        if (turn.agent === cfg.bmad.agents.review) {
          this.reviewTurns++;
          fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
          if (this.reviewTurns === 1) {
            fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
            const question = variant === "invalid-question" ? "{" : JSON.stringify({
              kind: "review", asks: "How should I proceed?",
              options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
            });
            fs.writeFileSync(path.join(repo, ".harness", "question.json"), question);
          } else if (variant === "fresh") {
            assert.match(turn.say, /Write a fresh \.harness\/review\.json/);
            fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
          }

        } else {
          fs.writeFileSync(path.join(repo, "app.ts"), "export const implemented = true;\n");
        }
        return { text: "Done.", changed: [], idle: true };
      }
    }

    const azure = new ScriptedAzure([reader, verdicts(["AC1", "AC2"]), verdicts(["AC1", "AC2"], "missing")]);
    const ledger = new Ledger(root, "run");
    const vscode = new QuestioningSession(repo);
    const decider = new Decider(cfg, ledger, azure);
    t.mock.method(decider, "answer", async () => ({ pick: "a", by: "human" as const, sureness: null, because: "test" }));
    const result = runStory({ ...story, file: storyFile }, {
      cfg, azure, ledger, vscode, decider, allStories: [story], spend() {},
    });

    if (variant === "fresh") {
      assert.equal((await result).outcome, "done");
    } else if (variant === "invalid-question") {
      await assert.rejects(result, /question\.json is invalid/);
    } else {
      await assert.rejects(result, /did not produce a fresh/);
    }
    assert.equal(vscode.reviewTurns, variant === "invalid-question" ? 1 : 2);
    const backups = fs.readdirSync(path.join(repo, ".harness")).filter((name) => name.startsWith("review-previous-"));
    assert.equal(backups.length, variant === "invalid-question" ? 0 : 1);
    if (backups.length) {
      assert.equal(fs.readFileSync(path.join(repo, ".harness", backups[0]!, "review.json"), "utf8"), "[]");
    }
  });
}

for (const stage of ["develop", "review", "rework"] as const) {
  test(`continuing a recovered ${stage} turn does not repeat it`, async (t) => {
    const { root, repo, cfg, story } = fixture(t);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
    const storyFile = path.join(repo, "story.md");
    fs.writeFileSync(storyFile, "# Story 1.1: Test\n\n## Status\nReady\n");
    git("add", ".gitignore", "story.md");
    git("commit", "-qm", "base");
    const baseline = snapshotWorktree(repo, { ignore: cfg.phase1.ignore });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const implemented = true;\n");
    fs.mkdirSync(path.join(repo, ".harness"));
    if (stage === "review") fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");

    class RecoverySession extends StubSession {
      sent: string[] = [];
      override async send(turn: Turn): Promise<Reply> {
        this.sent.push(turn.agent);
        if (turn.agent !== cfg.bmad.agents.review) throw new Error("Developer turn was unexpectedly repeated.");
        fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
        return { text: "Done.", changed: [], idle: true };
      }

    }

    const comparisons = stage === "rework" ? verdicts(["AC1", "AC2"], "missing") : verdicts(["AC1", "AC2"]);
    const azure = new ScriptedAzure([reader, comparisons, verdicts(["AC1", "AC2"], "missing")]);
    const ledger = new Ledger(root, "run");
    const vscode = new RecoverySession(repo);
    const decider = new Decider(cfg, ledger, azure);
    const selection = stage === "review"
      ? { agent: cfg.bmad.agents.review, model: cfg.bmad.models.review }
      : { agent: cfg.bmad.agents.develop, model: cfg.bmad.models.develop };
    const result = await runStory({ ...story, file: storyFile }, {
      cfg, azure, ledger, vscode, decider, allStories: [story], spend() {},
      recovery: { baseline, stage, ...selection, reply: { text: "Done.", changed: [], idle: true },
        priorFixes: 0, alreadyReworked: stage === "rework", alreadyRetested: false },
    });
    assert.equal(result.outcome, stage === "rework" ? "failed" : "done");
    assert.deepEqual(vscode.sent, stage === "review" ? [] : [cfg.bmad.agents.review]);
    const phase1 = ledger.read().find((event) => event.type === "phase1");
    if (stage === "rework" && phase1?.type === "phase1") {
      assert.equal((phase1.integrity as { secondPass: boolean }).secondPass, true);
    }
  });
}

for (const [stage, variant] of [
  ["test", "pass"], ["retest", "pass"], ["test", "missing-output"],
  ["test", "question-fresh"], ["test", "question-stale"],
  ["test", "missing-prerequisite"], ["test", "already-retested"],
] as const) {
  test(`recovering ${stage} Phase 2: ${variant}`, async (t) => {
    const { root, repo, cfg, story } = fixture(t);
    cfg.phase2.enabled = true;
    cfg.phase2.needs = variant === "missing-prerequisite" ? ["HARNESS_TEST_MISSING_PREREQUISITE_38BE03"] : [];
    cfg.phase2.when_missing = "ci";
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
    const storyFile = path.join(repo, "story.md");
    fs.writeFileSync(storyFile, "# Story 1.1: Test\n\n## Status\nReady\n");
    git("add", ".gitignore", "story.md");
    git("commit", "-qm", "base");
    const baseline = snapshotWorktree(repo, { ignore: cfg.phase1.ignore });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const implemented = true;\n");
    fs.mkdirSync(path.join(repo, ".harness"));
    const testOutput = JSON.stringify({
      story_id: story.id, ran_where: "local", against: "offline",
      covers: { "test feature": ["AC1", "AC2"] },
      cases: [{ name: "test feature", outcome: variant === "already-retested" ? "failed" : "passed" }],
    });
    if (variant !== "missing-output") fs.writeFileSync(path.join(repo, ".harness", "test.json"), testOutput);
    if (variant.startsWith("question")) {
      fs.writeFileSync(path.join(repo, ".harness", "question.json"), JSON.stringify({
        kind: "test", asks: "How should testing proceed?",
        options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
      }));
    }

    class RecoverySession extends StubSession {
      sent: string[] = [];
      override async send(turn: Turn): Promise<Reply> {
        this.sent.push(turn.agent);
        if (turn.agent === cfg.bmad.agents.review) fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
        else if (turn.agent === cfg.bmad.agents.test) {
          if (variant.startsWith("question")) assert.match(turn.say, /Write a fresh \.harness\/test\.json/);
          if (variant !== "question-stale") fs.writeFileSync(path.join(repo, ".harness", "test.json"), testOutput);
        }
        else throw new Error("Developer turn was unexpectedly repeated.");
        return { text: "Done.", changed: [], idle: true };
      }
    }

    const azure = new ScriptedAzure([reader, verdicts(["AC1", "AC2"]), verdicts(["AC1", "AC2"], "missing")]);
    const ledger = new Ledger(root, "run");
    const vscode = new RecoverySession(repo);
    const decider = new Decider(cfg, ledger, azure);
    t.mock.method(decider, "answer", async () => ({ pick: "a", by: "human" as const, sureness: null, because: "test" }));
    const selection = stage === "test"
      ? { agent: cfg.bmad.agents.test, model: cfg.bmad.models.test }
      : { agent: cfg.bmad.agents.develop, model: cfg.bmad.models.develop };
    const result = runStory({ ...story, file: storyFile }, {
      cfg, azure, ledger, vscode, decider, allStories: [story], spend() {},
      recovery: { baseline, stage, ...selection, reply: { text: "Done.", changed: [], idle: true },
        priorFixes: 0, alreadyReworked: false,
        alreadyRetested: stage === "retest" || variant === "already-retested" },
    });
    if (variant === "missing-output" || variant === "question-stale") {
      await assert.rejects(result, /did not produce a fresh/);
    } else {
      const expected = variant === "missing-prerequisite" ? "stopped" : variant === "already-retested" ? "failed" : "done";
      assert.equal((await result).outcome, expected);
    }
    const expectedSent = stage === "retest" ? [cfg.bmad.agents.review, cfg.bmad.agents.test]
      : variant.startsWith("question") ? [cfg.bmad.agents.test] : [];
    assert.deepEqual(vscode.sent, expectedSent);
    const archives = fs.readdirSync(path.join(repo, ".harness")).filter((name) => name.startsWith("test-previous-"));
    assert.equal(archives.length, stage === "retest" || variant.startsWith("question") ? 1 : 0);
  });
}

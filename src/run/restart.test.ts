import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig } from "../config.js";
import { Ledger } from "../audit/ledger.js";
import { Decider } from "../decide/engine.js";
import { Azure, type Ask } from "../llm/azure.js";
import { findStories } from "../bmad/stories.js";
import { StubSession } from "../vscode/stub.js";
import type { Reply, Turn } from "../vscode/types.js";
import { recoverRecordedTurn } from "./recover.js";
import { runStory } from "./story.js";

for (const interruptedStage of ["develop", "review"] as const) {
  test(`restart follows an interrupted ${interruptedStage} turn and continues without replaying it`, async (t: TestContext) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-restart-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
    git("add", ".gitignore");
    git("commit", "-qm", "base");
    fs.writeFileSync(path.join(repo, "stories", "1.1.md"), [
      "# Story 1.1: Test story", "", "## Status", "Ready", "",
      "## Acceptance Criteria", "1. A simulated feature works", "",
    ].join("\n"));
    const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
    const file = path.join(root, "config.yaml");
    fs.writeFileSync(file, YAML.stringify({
      ...template, repo, stories_dir: "stories", story_creation: { enabled: false },
      phase1: { ...template.phase1, blindness: { ...template.phase1.blindness, exclude: ["stories/**"], max_verbatim_overlap: 1 } },
    }));
    const cfg = loadConfig(file, { requireAzureKey: false });
    const story = findStories(repo, "stories")[0]!;
    const sessionId = "ahp-session:/test";
    let developCalls = 0;
    let reviewCalls = 0;
    class InterruptedSession extends StubSession {
      override async send(turn: Turn): Promise<Reply> {
        if (turn.agent === cfg.bmad.agents.develop) {
          developCalls++;
          fs.writeFileSync(path.join(repo, "app.ts"), "export const implemented = true;\n");
          if (interruptedStage === "develop") throw new Error("simulated disconnect");
        } else {
          reviewCalls++;
          fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
          fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
          throw new Error("simulated disconnect");
        }
        return { text: "Done.", changed: [], idle: true };
      }
    }
    class ContinuedSession extends StubSession {
      override async send(turn: Turn): Promise<Reply> {
        if (turn.agent === cfg.bmad.agents.develop) throw new Error("Development was repeated.");
        reviewCalls++;
        fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
        fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
        return { text: "Done.", changed: [], idle: true };
      }
    }
    class TestAzure extends Azure {
      calls = 0;
      override async askJson<T>(_opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
        this.calls++;
        return shape.parse(this.calls === 1 ? { summary: "Implements a feature.", confidence: 0.9 }
          : this.calls === 2 ? { criteria: [{ id: "AC1", verdict: "covered", evidence: "implemented" }], overall: "matched" }
            : { criteria: ["AC1", "AC2"].map((id) => ({ id, verdict: "missing", evidence: "unrelated" })), overall: "different" });
      }
    }
    const azure = new TestAzure(cfg.azure);
    const initial = new Ledger(root, "run");
    initial.write({ type: "run_started", epic: "epic-1", mode: "watch", repo, pid: 2147483647, session: sessionId });
    initial.write({ type: "story_session", story: story.id, session: sessionId });
    await assert.rejects(runStory(story, {
      cfg, azure, ledger: initial, vscode: new InterruptedSession(repo),
      decider: new Decider(cfg, initial, azure), allStories: [story], spend() {},
    }), /simulated disconnect/);

    const restarted = new Ledger(root, "run", { resume: true });
    const recovery = await recoverRecordedTurn({
      cfg, ledger: restarted, story, session: sessionId,
      driver: { async recoverTurn() { return { text: "Done.", changed: [], idle: true }; } },
    });
    assert.equal(recovery.stage, interruptedStage);
    const result = await runStory(story, {
      cfg, azure, ledger: restarted, vscode: new ContinuedSession(repo),
      decider: new Decider(cfg, restarted, azure), allStories: [story], spend() {}, recovery,
    });
    assert.equal(result.outcome, "done");
    assert.equal(developCalls, 1);
    assert.equal(reviewCalls, 1);
    assert.equal(restarted.read().filter((event) => event.type === "turn_started" && event.stage === interruptedStage).length, 1);
    assert.ok(restarted.read().some((event) => event.type === "phase1" && event.outcome === "pass"));
  });
}

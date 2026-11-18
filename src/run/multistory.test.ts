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
import { StubSession } from "../vscode/stub.js";
import type { Reply, Turn } from "../vscode/types.js";
import { runEpic } from "./epic.js";

test("successive stories validate against their own uncommitted worktree baseline", async (t: TestContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-multistory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
  fs.writeFileSync(path.join(repo, "app.ts"), "export const version = 0;\n");
  git("add", ".gitignore", "app.ts");
  git("commit", "-qm", "base");
  for (const id of ["1.1", "1.2"]) {
    fs.writeFileSync(path.join(repo, "stories", `${id}.md`), [
      `# Story ${id}: Test story`, "", "## Status", "Ready", "",
      "## Acceptance Criteria", "1. Execute a simulated feature", "",
    ].join("\n"));
  }
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify({
    ...template, repo, stories_dir: "stories", story_creation: { enabled: false },
    phase1: { ...template.phase1, blindness: { ...template.phase1.blindness, exclude: ["stories/**"], max_verbatim_overlap: 1 } },
  }));
  const cfg = loadConfig(file, { requireAzureKey: false });

  class StorySession extends StubSession {
    override async send(turn: Turn): Promise<Reply> {
      if (turn.agent === cfg.bmad.agents.develop) {
        const second = turn.say.includes("story 1.2");
        fs.writeFileSync(path.join(repo, "app.ts"), `export const version = ${second ? 2 : 1};\n`);
        if (!second) fs.writeFileSync(path.join(repo, "first-only.ts"), "export const firstOnly = true;\n");
      } else {
        fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
        fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
      }
      return { text: "Done.", changed: [], idle: true };
    }
  }
  class TestAzure extends Azure {
    calls = 0;
    readers: string[] = [];
    override async askJson<T>(opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
      const step = this.calls++ % 3;
      if (step === 0) {
        this.readers.push(opts.user);
        return shape.parse({ summary: "Updates a simulated feature.", confidence: 0.9 });
      }
      return shape.parse(step === 1
        ? { criteria: [{ id: "AC1", verdict: "covered", evidence: "implemented" }], overall: "matched" }
        : { criteria: ["AC1", "AC2"].map((id) => ({ id, verdict: "missing", evidence: "unrelated" })), overall: "different" });
    }
  }
  const azure = new TestAzure(cfg.azure);
  const ledger = new Ledger(root, "run");
  const vscode = new StorySession(repo);
  const decider = new Decider(cfg, ledger, azure);
  const result = await runEpic("epic-1", { cfg, azure, ledger, vscode, decider });
  assert.equal(result.outcome, "finished");
  assert.equal(azure.readers.length, 2);
  assert.match(azure.readers[0]!, /first-only\.ts/);
  assert.doesNotMatch(azure.readers[1]!, /first-only\.ts/);
  assert.match(azure.readers[1]!, /-export const version = 1/);
  assert.match(azure.readers[1]!, /\+export const version = 2/);
});

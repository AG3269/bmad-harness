import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig } from "../config.js";
import { findConfiguredStories, findPlannedStories, type Story } from "../bmad/stories.js";
import { creationSelection, readPreparedStory } from "../bmad/preparation.js";
import { Azure, type Ask } from "../llm/azure.js";
import { Ledger } from "../audit/ledger.js";
import { Decider, NeedsYou, type Question } from "../decide/engine.js";
import { StubSession } from "../vscode/stub.js";
import type { Reply, Turn } from "../vscode/types.js";
import { runEpic } from "./epic.js";
import { runStory } from "./story.js";
import { recoverRecordedTurn } from "./recover.js";

const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
  fs.writeFileSync(path.join(repo, "app.ts"), "export const version = 0;\n");
  git("add", ".gitignore", "app.ts");
  git("commit", "-qm", "base");
  const epics = [
    "# Plan", "", "## Epic 1: Synthetic work", "",
    ...["1.1", "1.2", "1.3", "1.10"].flatMap((id) => [
      `### Story ${id}: Synthetic ${id}`, "", "As a user, I want synthetic work.", "",
      "**Acceptance Criteria:**", "", "**Given** a synthetic input,",
      "**When** the application runs,", "**Then** the expected output is returned.", "",
    ]),
    "## Epic 2: Separate work", "", "### Story 2.1: Other work", "",
    "### Acceptance Criteria", "1. A separate capability exists.", "",
  ].join("\n");
  fs.writeFileSync(path.join(repo, "epics.md"), epics);
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const configFile = path.join(root, "config.yaml");
  const raw = {
    ...template, repo, stories_dir: "stories",
    story_creation: { enabled: true, epics_file: "epics.md", agent: "planner" },
    bmad: { ...template.bmad, status_done: ["Done"] },
    phase1: {
      ...template.phase1,
      blindness: { ...template.phase1.blindness, exclude: ["stories/**", "epics.md"], max_verbatim_overlap: 1 },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(raw));
  const cfg = loadConfig(configFile, { requireAzureKey: false });
  const planned = findPlannedStories(cfg, "epic-1");

  function writeStory(source: Story, status = "Ready", criteria = source.criteria) {
    fs.mkdirSync(path.dirname(source.file), { recursive: true });
    fs.writeFileSync(source.file, [
      `# Story ${source.id}: ${source.title}`, "", "## Status", status, "",
      "## Story", source.narrative, "", "## Acceptance Criteria",
      ...criteria.map((criterion, index) => `${index + 1}. ${criterion.id}: ${criterion.text}`), "",
    ].join("\n"));
  }
  writeStory(planned[0]!, "Done");
  const ledger = new Ledger(root, "run");

  class TestAzure extends Azure {
    calls = 0;
    readers: string[] = [];
    fail = false;
    override async askJson<T>(opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
      const step = this.calls++ % 3;
      if (step === 0) {
        this.readers.push(opts.user);
        return shape.parse({ summary: "Implements a synthetic capability.", confidence: 0.9 });
      }
      const ids = [...opts.user.matchAll(/^- (AC\d+):/gm)].map((match) => match[1]);
      return shape.parse({
        criteria: ids.map((id) => ({
          id, verdict: step === 1 && !this.fail ? "covered" : "missing", evidence: "synthetic evidence",
        })), overall: "synthetic comparison",
      });
    }
  }
  const azure = new TestAzure(cfg.azure);
  const decider = new Decider(cfg, ledger, azure);

  class StorySession extends StubSession {
    current = "";
    stages: string[] = [];
    override setStory(id: string) { super.setStory(id); this.current = id; }
    override async send(turn: Turn): Promise<Reply> {
      assert.equal(ledger.read().at(-1)?.type, "turn_started");
      if (turn.agent === cfg.story_creation.agent) {
        this.stages.push(`create:${this.current}`);
        const source = planned.find((story) => story.id === this.current)!;
        assert.match(turn.say, /Do not implement it/);
        assert.match(turn.say, /Do not grant yourself architecture approval/);
        writeStory(source);
        fs.writeFileSync(path.join(repo, "planning-change.ts"), `export const story = "${this.current}";\n`);
      } else if (turn.agent === cfg.bmad.agents.develop) {
        this.stages.push(`develop:${this.current}`);
        fs.writeFileSync(path.join(repo, "app.ts"), `export const version = "${this.current}";\n`);
      } else if (turn.agent === cfg.bmad.agents.review) {
        this.stages.push(`review:${this.current}`);
        fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
        fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
      } else throw new Error(`Unexpected agent ${turn.agent}`);
      return { text: "Done.", changed: [], idle: true };
    }
  }
  const vscode = new StorySession(repo);
  return { root, repo, cfg, configFile, raw, planned, ledger, azure, decider, vscode, writeStory };
}

test("discovery merges planned and existing stories, groups bold BDD criteria and sorts numerically", (t) => {
  const { cfg, planned, repo } = fixture(t);
  assert.deepEqual(planned.map((story) => story.id), ["1.1", "1.2", "1.3", "1.10"]);
  assert.equal(planned[1]!.criteria.length, 1);
  assert.equal(planned[1]!.criteria[0]!.text,
    "Given a synthetic input, When the application runs, Then the expected output is returned.");
  assert.deepEqual(findConfiguredStories(cfg, "epic-1").map((story) => story.status), ["Done", "Planned", "Planned", "Planned"]);
  assert.equal(findConfiguredStories(cfg).length, 5);
  assert.equal(fs.readdirSync(path.join(repo, "stories")).length, 1);
});

test("legacy configs keep story creation disabled", (t) => {
  const { cfg, raw, configFile } = fixture(t);
  fs.writeFileSync(configFile, YAML.stringify({ ...raw, story_creation: undefined }));
  const legacy = loadConfig(configFile, { requireAzureKey: false });
  assert.equal(legacy.story_creation.enabled, false);
  assert.equal(findConfiguredStories(legacy, "epic-1").length, 1);
  assert.deepEqual(creationSelection(cfg), { agent: "planner", model: cfg.bmad.models.develop });
});

test("creation can start with no implementation directory and discovery does not create it", (t) => {
  const { raw, repo, configFile } = fixture(t);
  const file = { ...raw, stories_dir: "new-stories" };
  fs.writeFileSync(configFile, YAML.stringify(file));
  const cfg = loadConfig(configFile, { requireAzureKey: false });
  assert.equal(findConfiguredStories(cfg, "epic-1").length, 4);
  assert.equal(fs.existsSync(path.join(repo, "new-stories")), false);
});

test("creation input and output paths cannot escape the configured repository", (t) => {
  const { raw, configFile } = fixture(t);
  fs.writeFileSync(configFile, YAML.stringify({ ...raw, stories_dir: "../outside" }));
  assert.throws(() => loadConfig(configFile, { requireAzureKey: false }), /inside the configured repository/);
  fs.writeFileSync(configFile, YAML.stringify({
    ...raw, story_creation: { ...raw.story_creation, epics_file: "../outside-plan.md" },
  }));
  assert.throws(() => loadConfig(configFile, { requireAzureKey: false }), /inside the configured repository/);
});

test("a future story path behind a repository-escaping junction is rejected", (t) => {
  const { raw, repo, root, configFile } = fixture(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, "linked-stories"), "junction");
  fs.writeFileSync(configFile, YAML.stringify({ ...raw, stories_dir: "linked-stories/future" }));
  assert.throws(() => loadConfig(configFile, { requireAzureKey: false }), /inside the configured repository/);
});

test("a repository-internal story-directory alias keeps the same identity after preparation", (t) => {
  const { cfg, repo, writeStory } = fixture(t);
  fs.symlinkSync(path.join(repo, "stories"), path.join(repo, "story-alias"), "junction");
  cfg.stories_dir = "story-alias";
  const source = findConfiguredStories(cfg, "epic-1").find((story) => story.id === "1.2")!;
  writeStory(source);
  const discovered = findConfiguredStories(cfg, "epic-1").find((story) => story.id === "1.2")!;
  assert.equal(discovered.file, source.file);
  assert.equal(readPreparedStory(cfg, source).file, source.file);
});

test("duplicate plans, duplicate implementation IDs and missing criteria stop discovery", (t) => {
  const { cfg, repo, planned, writeStory } = fixture(t);
  fs.appendFileSync(path.join(repo, "epics.md"), "\n### Story 1.2: Duplicate\n");
  assert.throws(() => findConfiguredStories(cfg), /Duplicate planned story ID/);
  fs.writeFileSync(path.join(repo, "epics.md"), "### Story 1.2: Empty\nNo criteria.\n");
  assert.throws(() => findConfiguredStories(cfg), /no parseable acceptance criteria/);
  writeStory(planned[0]!, "Done");
  fs.copyFileSync(planned[0]!.file, path.join(repo, "stories", "duplicate.md"));
  assert.throws(() => findConfiguredStories(cfg), /Duplicate implementation story ID/);
});

test("listing planned stories works offline without writing stories or needing Azure credentials", (t) => {
  const { root, repo, configFile } = fixture(t);
  const before = fs.readdirSync(path.join(repo, "stories"));
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), path.join(project, "src", "main.ts"),
    "--stories", "--config", configFile,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, HARNESS_FAKE_AZURE: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.2\s+Planned/);
  assert.deepEqual(fs.readdirSync(path.join(repo, "stories")), before);
});

test("each missing story is created, implemented and validated before the next, without rerunning Done stories", async (t) => {
  const { cfg, ledger, azure, decider, vscode } = fixture(t);
  const result = await runEpic("epic-1", { cfg, ledger, azure, decider, vscode });
  assert.equal(result.outcome, "finished");
  assert.deepEqual(vscode.stages, ["1.2", "1.3", "1.10"].flatMap((id) => [`create:${id}`, `develop:${id}`, `review:${id}`]));
  assert.equal(azure.readers.length, 3);
  assert.match(azure.readers[0]!, /planning-change\.ts/);
  const events = ledger.read();
  for (const id of ["1.2", "1.3", "1.10"]) {
    const baseline = events.find((event) => event.type === "story_baseline" && event.story === id)!;
    const turn = events.find((event) => event.type === "turn_started" && event.story === id && event.stage === "create")!;
    assert.ok(baseline.seq < turn.seq);
  }
});

test("creation readiness accepts an optional final period without accepting blocked or qualified statuses", (t) => {
  const { cfg, planned, writeStory } = fixture(t);
  const source = planned[1]!;
  for (const status of ["Ready", "Ready.", "rEaDy."]) {
    writeStory(source, status);
    assert.doesNotThrow(() => readPreparedStory(cfg, source), status);
  }
  for (const status of ["Blocked.", "Ready..", "Ready. Awaiting approval."]) {
    writeStory(source, status);
    assert.throws(() => readPreparedStory(cfg, source), /not Ready/, status);
  }
});

test("a single-story run does not create or dispatch later stories", async (t) => {
  const { cfg, ledger, azure, decider, vscode } = fixture(t);
  const result = await runEpic("epic-1", { cfg, ledger, azure, decider, vscode, onlyStory: "1.2" });
  assert.equal(result.outcome, "finished");
  assert.deepEqual(vscode.stages, ["create:1.2", "develop:1.2", "review:1.2"]);
});

for (const status of ["Ready for Development", "Ready for Development."]) {
  test(`an existing story with status "${status}" passes the development gate`, async (t) => {
    const { cfg, planned, ledger, azure, decider, vscode, writeStory } = fixture(t);
    const source = planned[1]!;
    writeStory(source, status);
    const allStories = findConfiguredStories(cfg, "epic-1");
    const story = allStories.find((candidate) => candidate.id === source.id)!;
    vscode.setStory(story.id);
    const result = await runStory(story, {
      cfg, ledger, azure, decider, vscode, allStories, spend() {},
    });
    assert.equal(result.outcome, "done");
    assert.deepEqual(vscode.stages, ["develop:1.2", "review:1.2"]);
  });
}

for (const variant of ["missing", "blocked", "weakened", "wrong-id", "duplicate", "wrong-path"] as const) {
  test(`invalid creation output stops before implementation: ${variant}`, async (t) => {
    const { cfg, planned, ledger, azure, decider, vscode, repo, writeStory } = fixture(t);
    const source = planned[1]!;
    t.mock.method(vscode, "send", async () => {
      if (variant !== "missing") {
        writeStory(variant === "wrong-id" ? { ...source, id: "9.9" } : source,
          variant === "blocked" ? "Blocked" : "Ready",
          variant === "weakened" ? [{ id: "AC1", text: "A weaker requirement" }] : source.criteria);
        if (variant === "duplicate") fs.copyFileSync(source.file, path.join(repo, "stories", "duplicate.md"));
        if (variant === "wrong-path") fs.renameSync(source.file, path.join(repo, "stories", "wrong.md"));
      }
      return { text: "Done.", changed: [], idle: true };
    });
    await assert.rejects(runEpic("epic-1", { cfg, ledger, azure, decider, vscode }),
      /did not produce|not Ready|preserve all|exactly one/);
    assert.equal(ledger.read().filter((event) => event.type === "turn_started").length, 1);
    assert.equal(azure.calls, 0);
  });
}

test("a failing story stops the epic before creating its successor", async (t) => {
  const { cfg, ledger, azure, decider, vscode } = fixture(t);
  azure.fail = true;
  const result = await runEpic("epic-1", { cfg, ledger, azure, decider, vscode });
  assert.equal(result.outcome, "stopped");
  assert.deepEqual(vscode.stages.filter((stage) => stage.startsWith("create")), ["create:1.2"]);
});

test("a partial existing output is never silently overwritten on a fresh run", async (t) => {
  const { cfg, repo, planned, ledger, azure, decider, vscode } = fixture(t);
  fs.writeFileSync(planned[1]!.file, "partial output without a story header");
  await assert.rejects(runEpic("epic-1", { cfg, ledger, azure, decider, vscode }), /rather than overwriting/);
  assert.equal(vscode.stages.length, 0);
  assert.equal(fs.readFileSync(planned[1]!.file, "utf8"), "partial output without a story header");
  assert.ok(fs.existsSync(path.join(repo, "stories")));
});

for (const variant of ["blocked", "weakened"] as const) {
  test(`a previously ${variant} prepared story cannot bypass creation guards on a fresh run`, async (t) => {
    const { cfg, planned, ledger, azure, decider, vscode, writeStory } = fixture(t);
    const source = planned[1]!;
    writeStory(source, variant === "blocked" ? "Blocked" : "Ready",
      variant === "weakened" ? [{ id: "AC1", text: "A weaker requirement" }] : source.criteria);
    await assert.rejects(runEpic("epic-1", { cfg, ledger, azure, decider, vscode }),
      variant === "blocked" ? /not Ready/ : /preserve all/);
    assert.equal(vscode.stages.length, 0);
  });
}

for (const [stop, array] of [[false, false], [true, false], [false, true], [true, true]] as const) {
  test(`creation questions (${array ? "array" : "string"}) ${stop ? "stop for unresolved human decisions" : "continue preparation before development"}`, async (t) => {
    const { cfg, planned, ledger, azure, decider, vscode, writeStory } = fixture(t);
    const source = planned[1]!;
    const paragraphs = ["The story needs an architecture decision.", "Use only existing approvals."];
    const asks = array ? paragraphs : paragraphs[0]!;
    const expected = array ? paragraphs.join("\n\n") : paragraphs[0]!;
    let turns = 0;
    const original = vscode.send.bind(vscode);
    t.mock.method(vscode, "send", async (turn: Turn) => {
      if (turn.agent === cfg.story_creation.agent) {
        turns++;
        if (turns === 1) {
          fs.mkdirSync(path.join(vscode.folder, ".harness"), { recursive: true });
          fs.writeFileSync(path.join(vscode.folder, ".harness", "question.json"), JSON.stringify({
            kind: "architecture-approval", asks,
            options: [{ id: "recorded", label: "Use the existing approved decision" }, { id: "stop", label: "Stop" }],
          }));
        } else writeStory(source);
        return { text: "Done.", changed: [], idle: true };
      }
      return original(turn);
    });
    t.mock.method(decider, "answer", async (question: Question) => {
      assert.equal(question.asks, expected);
      if (stop) throw new NeedsYou("Architecture needs a human.", question, "No approval recorded.");
      return { pick: "recorded", by: "human" as const, sureness: null, because: "An approved decision is available." };
    });
    vscode.setStory(source.id);
    const result = await runStory(source, {
      cfg, ledger, azure, decider, vscode, allStories: planned, spend() {},
    });
    assert.equal(result.outcome, stop ? "stopped" : "done");
    assert.equal(turns, stop ? 1 : 2);
    assert.deepEqual(vscode.stages, stop ? [] : ["develop:1.2", "review:1.2"]);
    const event = ledger.read().find((entry) => entry.type === "agent_asked");
    assert.ok(event?.type === "agent_asked");
    assert.equal(event.question, expected);
  });
}

test("recovered creation accepts array-form questions and retains the architecture blocker without replaying the turn", async (t) => {
  const { cfg, repo, planned, ledger, azure, decider, vscode, writeStory } = fixture(t);
  const source = planned[1]!;
  const session = "ahp-session:/creation-question-test";
  const paragraphs = ["How should the missing architecture approval be resolved?", "The story remains Blocked."];
  ledger.write({ type: "run_started", epic: "epic-1", mode: cfg.mode, repo, session });
  ledger.write({ type: "story_session", story: source.id, session });
  let sends = 0;
  t.mock.method(vscode, "send", async () => {
    sends++;
    writeStory(source, "Blocked");
    fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".harness", "question.json"), JSON.stringify({
      kind: "architecture-approval", asks: paragraphs,
      options: [{ id: "provide", label: "Provide an approved contract" }, { id: "stop", label: "Remain blocked" }],
    }));
    throw new Error("simulated disconnect");
  });
  await assert.rejects(runStory(source, {
    cfg, ledger, azure, decider, vscode, allStories: planned, spend() {},
  }), /simulated disconnect/);
  const story = findConfiguredStories(cfg, "epic-1").find((candidate) => candidate.id === source.id)!;
  const recovery = await recoverRecordedTurn({
    cfg, ledger, story, session,
    driver: { async recoverTurn() { return { text: "Done.", changed: [], idle: true }; } },
  });
  t.mock.method(decider, "answer", async (question: Question) => {
    assert.equal(question.asks, paragraphs.join("\n\n"));
    throw new NeedsYou("Architecture needs a human.", question, "No approval recorded.");
  });
  const result = await runStory(story, {
    cfg, ledger, azure, decider, vscode, allStories: planned, spend() {}, recovery,
  });
  assert.equal(result.outcome, "stopped");
  assert.equal(sends, 1);
  assert.equal(azure.calls, 0);
  assert.equal(findConfiguredStories(cfg, "epic-1").find((candidate) => candidate.id === source.id)!.status, "Blocked");
  assert.equal(ledger.read().filter((event) => event.type === "turn_started" && event.stage === "create").length, 1);
});

for (const variant of ["completed", "missing-output", "changed-plan"] as const) {
test(`an interrupted creation is recovered without another creation turn: ${variant}`, async (t) => {
  const { cfg, repo, planned, ledger, azure, decider, vscode, writeStory } = fixture(t);
  const source = planned[1]!;
  const session = "ahp-session:/creation-test";
  ledger.write({ type: "run_started", epic: "epic-1", mode: cfg.mode, repo, session });
  ledger.write({ type: "story_session", story: source.id, session });
  const original = vscode.send.bind(vscode);
  vscode.setStory(source.id);
  t.mock.method(vscode, "send", async (turn: Turn) => {
    if (turn.agent === cfg.story_creation.agent) {
      if (variant !== "missing-output") writeStory(source);
      throw new Error("simulated disconnect");
    }
    return original(turn);
  });
  await assert.rejects(runStory(source, {
    cfg, ledger, azure, decider, vscode, allStories: planned, spend() {},
  }), /simulated disconnect/);
  const recovery = await recoverRecordedTurn({
    cfg, ledger, story: source, session,
    driver: { async recoverTurn() {
      if (variant === "missing-output") writeStory(source);
      return { text: "Done.", changed: [], idle: true };
    } },
  });
  if (variant === "changed-plan") fs.appendFileSync(path.join(repo, "epics.md"), "\nChanged plan details.\n");
  if (variant === "changed-plan") {
    const content = fs.readFileSync(path.join(repo, "epics.md"), "utf8").replace("Synthetic 1.2", "Changed 1.2");
    fs.writeFileSync(path.join(repo, "epics.md"), content);
  }
  const result = runStory(readPreparedStory(cfg, source), {
    cfg, ledger, azure, decider, vscode, allStories: planned, spend() {}, recovery,
  });
  if (variant === "changed-plan") await assert.rejects(result, /plan is missing or changed|output path changed/);
  else assert.equal((await result).outcome, "done");
  assert.deepEqual(vscode.stages, variant === "changed-plan" ? [] : ["develop:1.2", "review:1.2"]);
  assert.equal(ledger.read().filter((event) => event.type === "turn_started" && event.stage === "create").length, 1);
});
}

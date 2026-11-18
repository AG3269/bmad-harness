import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig } from "../config.js";
import type { Story } from "../bmad/stories.js";
import { checkPhase2, TestRun } from "./phase2.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-phase2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify({ ...template, repo, stories_dir: "stories", story_creation: { enabled: false } }));
  const cfg = loadConfig(file, { requireAzureKey: false });
  cfg.phase2.enabled = true;
  const story: Story = {
    id: "1.1", title: "Test", status: "Ready", narrative: "", fullText: "", file: "story.md",
    criteria: [{ id: "AC1", text: "Unauthorized users cannot access data" }],
  };
  const run = TestRun.parse({
    story_id: "1.1", ran_where: "local", against: "offline",
    covers: { denial: ["AC1"] }, cases: [{ name: "denial", outcome: "passed", attempted: true }],
  });
  return { cfg, story, run };
}

test("a denial test without a recorded attempt does not pass", (t) => {
  const { cfg, story, run } = fixture(t);
  const result = checkPhase2(story, { ...run, cases: [{ ...run.cases[0]!, attempted: null }] }, cfg);
  assert.equal(result.outcome, "fail");
  assert.deepEqual(result.unproven, ["AC1"]);
  assert.match(result.reasons.join(" "), /doesn't record whether it tried/);
});

test("missing target, wrong story, duplicate tests and no tests cannot pass", (t) => {
  const { cfg, story, run } = fixture(t);
  for (const candidate of [
    { ...run, against: "" },
    { ...run, story_id: "2.1" },
    { ...run, cases: [...run.cases, run.cases[0]!] },
    { ...run, cases: [], covers: {} },
  ]) {
    assert.equal(checkPhase2(story, candidate, cfg).outcome, "fail");
  }
  assert.equal(checkPhase2({ ...story, criteria: [] }, run, cfg).outcome, "fail");
  assert.equal(checkPhase2(story, null, cfg).outcome, "fail");
  assert.equal(checkPhase2(story, {
    ...run, cases: [{ ...run.cases[0]!, outcome: "skipped", skip_reason: "offline" }],
  }, cfg).outcome, "fail");
  assert.equal(checkPhase2(story, run, cfg).outcome, "pass");
});

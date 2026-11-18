import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig } from "../config.js";
import { Ledger } from "../audit/ledger.js";
import { createApprovalHandler, inputFingerprint, isAutomaticallyApproved, type ApprovalRequest } from "./approval.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-approval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "stories"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify({ ...template, repo, stories_dir: "stories", story_creation: { enabled: false } }));
  const cfg = loadConfig(file, { requireAzureKey: false });
  cfg.mode = "normal";
  cfg.decide.shadow = false;
  const input = JSON.stringify({ path: ".", recursive: false });
  cfg.tool_approvals.auto_allow = [{ tool: "list_directory", input_sha256: inputFingerprint(input) }];
  const request: ApprovalRequest = {
    key: "tool:test", turnId: "turn", toolCallId: "test", kind: "tool",
    toolName: "list_directory", message: "List directory", input, hasRiskAssessment: false,
  };
  return { root, repo, cfg, request };
}

test("only an explicitly allowlisted, non-recursive directory listing can be automatic", async (t) => {
  const { root, cfg, request } = fixture(t);
  assert.equal(isAutomaticallyApproved(cfg, request), true);
  const ledger = new Ledger(root, "run");
  const decision = await createApprovalHandler(cfg, ledger, "1.1")(request, new AbortController().signal);
  assert.deepEqual(decision, { approved: true, by: "rule" });
  assert.match(ledger.report(), /Exact-match tool approval/);

  cfg.mode = "watch";
  assert.equal(isAutomaticallyApproved(cfg, request), false);
  cfg.mode = "normal";
  cfg.decide.shadow = true;
  assert.equal(isAutomaticallyApproved(cfg, request), false);
  cfg.decide.shadow = false;
  assert.equal(isAutomaticallyApproved(cfg, { ...request, hasRiskAssessment: true }), false);
  assert.equal(isAutomaticallyApproved(cfg, { ...request, options: [{ id: "yes", label: "Yes", kind: "approve" }] }), false);
  assert.equal(isAutomaticallyApproved(cfg, { ...request, toolName: "run_in_terminal" }), false);
  assert.equal(isAutomaticallyApproved(cfg, { ...request, kind: "result" }), false);
});

test("outside, sensitive, malformed, recursive and altered directory requests need a person", (t) => {
  const { cfg, request } = fixture(t);
  for (const input of [
    JSON.stringify({ path: ".." }),
    JSON.stringify({ path: ".git" }),
    JSON.stringify({ path: ".", recursive: true }),
    JSON.stringify({ path: "." }),
    JSON.stringify({ path: ".", extra: "unexpected" }),
    "{",
  ]) {
    cfg.tool_approvals.auto_allow = [{ tool: "list_directory", input_sha256: inputFingerprint(input) }];
    assert.equal(isAutomaticallyApproved(cfg, { ...request, input }), false);
  }
});

test("solo mode stops rather than asking when a request is not automatically approved", async (t) => {
  const { root, cfg, request } = fixture(t);
  cfg.mode = "solo";
  cfg.tool_approvals.auto_allow = [];
  const ledger = new Ledger(root, "solo");
  await assert.rejects(createApprovalHandler(cfg, ledger, "1.1")(request, new AbortController().signal), /solo mode does not ask/);
});

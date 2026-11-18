import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parseStory, findStories } from "./bmad/stories.js";
import { snapshot, collect } from "./validate/diff.js";
import { runPhase1 } from "./validate/phase1.js";
import { checkPhase2, TestRun } from "./validate/phase2.js";
import { scrubForReader, assertReaderIsBlind, verbatimOverlap, redact, BlindnessBroken } from "./validate/blindness.js";
import { pickDecoy, judgeDecoy, shouldRunDecoy } from "./validate/decoy.js";
import type { Config } from "./config.js";
import type { Azure } from "./llm/azure.js";

/**
 * Checks the parts that must not be wrong, without touching Azure or VS Code.
 *
 * The Phase 1 cases matter most: they're the difference between catching an
 * agent that didn't build what was asked, and rubber-stamping it.
 */

let passed = 0, failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

// --- a fake Azure that returns whatever we hand it ---------------------------
/**
 * A fake Azure.
 *
 * The comparer is asked twice per story: once about the real story, once about
 * a decoy. A fake that answers both the same way would look like exactly the
 * rubber-stamping the decoy check exists to catch — so it answers the decoy
 * honestly (everything missing) and the real story from the fixture.
 */
function fakeAzure(reader: unknown, comparer: unknown): Azure {
  return {
    usage: {},
    async ask() { return "{}"; },
    async askJson(opts: any, shape: any) {
      if (opts.deployment === "reader") return shape.parse(reader);

      const aboutRealStory = String(opts.user ?? "").includes("Check-in photo");
      if (aboutRealStory) return shape.parse(comparer);

      const ids = [...String(opts.user ?? "").matchAll(/^- (AC\d+):/gim)].map((m) => m[1]);
      return shape.parse({
        criteria: ids.map((id) => ({ id, verdict: "missing", evidence: "unrelated to this code" })),
        extra: [], divergences: [], overall: "different story entirely",
      });
    },
  } as unknown as Azure;
}

const cfg = {
  repo: "", stories_dir: "docs/stories", mode: "normal", driver: "stub",
  azure: {
    endpoint: "", api_version: "", auth: "key", key_env: "X",
    deployments: { reader: "reader", comparer: "comparer", decider: "decider", summarizer: "summarizer" },
  },
  bmad: {
    agents: { develop: "d", review: "r", test: "t" },
    models: { develop: "a", review: "b", test: "c" },
    status_field: "Status", status_done: ["Done"],
  },
  phase1: {
    enabled: true, min_confidence: 0.5, ignore: ["**/package-lock.json"],
    max_diff_chars: 100000,
    fail_on: ["missing_criterion", "stub_on_criterion_path"],
    escalate_on: ["extra_in_protected_path", "major_divergence"],
    blindness: {
      exclude: ["docs/stories/**", "docs/epics/**"],
      redact_criterion_text: true,
      assert_no_leak: true,
      max_verbatim_overlap: 0.35,
      decoy: "every",
      decoy_tolerance: 0.34,
    },
  },
  phase2: {
    enabled: true, needs: [], when_missing: "stop", ci_workflow: "e2e.yml",
    rules: {
      every_criterion_needs_a_test: true, skipped_is_not_passed: true,
      all_skipped_is_failure: true, denial_tests_must_attempt: true,
    },
  },
  decide: {
    shadow: false, confidence: 0.8, never: [], fix_quietly: [],
    always_ask: { kinds: [], files: ["**/auth/**", "supabase/migrations/**"] },
    never_touch: [],
  },
  limits: { fix_attempts: 2, questions_per_stage: 3, interruptions: 3, max_agent_turns: 50, max_minutes: 60 },
} as unknown as Config;

const story = {
  id: "10.3",
  title: "Check-in photo",
  status: "Approved",
  narrative: "As a caregiver, I want to attach a photo to a check-in.",
  criteria: [
    { id: "AC1", text: "A caregiver can attach a photo to a check-in" },
    { id: "AC2", text: "A caregiver in another family cannot retrieve that photo" },
  ],
  fullText: "",
  file: "docs/stories/10.3.md",
};

const changes = {
  files: [{ path: "apps/web/src/checkin.ts", added: 40, removed: 2, patch: "+ code" }],
  totalAdded: 40, totalRemoved: 2, ignored: [], oversized: false,
};

async function phase1Tests() {
  console.log("\nPhase 1 — does the code match the story?");

  // 1. Everything present → pass
  {
    const r = await runPhase1(story, changes as any, fakeAzure(
      { summary: "Adds photo upload to check-ins, scoped to the caller's family.",
        capabilities: ["attach a photo", "reads are family-scoped"],
        inferred_criteria: ["photo attaches", "other families denied"],
        surfaces: ["api", "database"], incomplete: [], confidence: 0.9 },
      { criteria: [
          { id: "AC1", verdict: "covered", evidence: "describes attaching a photo" },
          { id: "AC2", verdict: "covered", evidence: "describes family-scoped reads" }],
        extra: [], divergences: [], overall: "matches" },
    ), cfg);
    check("passes when the code does what the story asked", r.outcome === "pass", `got ${r.outcome}`);
  }

  // 2. The real failure: code is right, but half the story isn't there.
  {
    const r = await runPhase1(story, changes as any, fakeAzure(
      { summary: "Adds photo upload to check-ins.",
        capabilities: ["attach a photo"],
        inferred_criteria: ["a caregiver can attach a photo"],
        surfaces: ["api"], incomplete: [], confidence: 0.85 },
      { criteria: [
          { id: "AC1", verdict: "covered", evidence: "upload is described" },
          { id: "AC2", verdict: "missing", evidence: "nothing about other families" }],
        extra: [], divergences: [], overall: "half done" },
    ), cfg);
    check("fails when a criterion isn't in the code", r.outcome === "fail", `got ${r.outcome}`);
    check("  names the missing criterion", r.unmet.includes("AC2"), `unmet: ${r.unmet}`);
  }

  // 3. A stub standing in for the work.
  {
    const r = await runPhase1(story, changes as any, fakeAzure(
      { summary: "Adds photo upload; access check is a placeholder.",
        capabilities: ["attach a photo"], inferred_criteria: [],
        surfaces: ["api"],
        incomplete: [{ file: "apps/web/src/checkin.ts", what: "stub", detail: "canRead() returns true unconditionally" }],
        confidence: 0.8 },
      { criteria: [
          { id: "AC1", verdict: "covered", evidence: "upload works" },
          { id: "AC2", verdict: "covered", evidence: "there is an access check" }],
        extra: [], divergences: [], overall: "looks complete" },
    ), cfg);
    check("fails on a stub even when the comparer says covered", r.outcome === "fail", `got ${r.outcome}`);
  }

  // 4. Built something nobody asked for, somewhere sensitive.
  {
    const r = await runPhase1(story, changes as any, fakeAzure(
      { summary: "Adds photo upload, and rewrites the auth middleware.",
        capabilities: ["attach a photo", "new session handling"],
        inferred_criteria: [], surfaces: ["api", "auth"], incomplete: [], confidence: 0.9 },
      { criteria: [
          { id: "AC1", verdict: "covered", evidence: "upload" },
          { id: "AC2", verdict: "covered", evidence: "scoped reads" }],
        extra: [{ what: "rewrote session handling", files: ["apps/web/src/auth/session.ts"], concern: "serious" }],
        divergences: [], overall: "does more than asked" },
    ), cfg);
    check("escalates scope creep into a protected path", r.outcome === "escalate", `got ${r.outcome}`);
  }

  // 5. Diff unreadable → don't guess either way.
  {
    const r = await runPhase1(story, changes as any, fakeAzure(
      { summary: "Very large mixed change, hard to characterise.",
        capabilities: [], inferred_criteria: [], surfaces: [], incomplete: [], confidence: 0.2 },
      { criteria: [], extra: [], divergences: [], overall: "" },
    ), cfg);
    check("escalates rather than guessing on an unreadable diff", r.outcome === "escalate", `got ${r.outcome}`);
  }

  // 6. Agent said done, changed nothing.
  {
    const r = await runPhase1(story, { files: [], totalAdded: 0, totalRemoved: 0, ignored: [], oversized: false } as any,
      fakeAzure({}, {}), cfg);
    check("fails when nothing changed at all", r.outcome === "fail", `got ${r.outcome}`);
  }

  // 7. Solved a different problem.
  {
    const r = await runPhase1(story, changes as any, fakeAzure(
      { summary: "Adds video upload to check-ins.", capabilities: ["attach a video"],
        inferred_criteria: [], surfaces: ["api"], incomplete: [], confidence: 0.9 },
      { criteria: [
          { id: "AC1", verdict: "covered", evidence: "media upload exists" },
          { id: "AC2", verdict: "covered", evidence: "scoped" }],
        extra: [],
        divergences: [{ what: "story asked for photos, the code does video", severity: "major" }],
        overall: "wrong medium" },
    ), cfg);
    check("escalates when the code solves a different problem", r.outcome === "escalate", `got ${r.outcome}`);
  }
}

function phase2Tests() {
  console.log("\nPhase 2 — did it actually work?");

  const base = { story_id: "10.3", ran_where: "local" as const, against: "https://e2e.example" };

  // The screenshot case: green, but never tried.
  {
    const run = TestRun.parse({
      ...base,
      covers: { "attaches a photo": ["AC1"], "other family is denied": ["AC2"] },
      cases: [
        { name: "attaches a photo", outcome: "passed" },
        { name: "other family is denied", outcome: "passed", attempted: false },
      ],
    });
    const r = checkPhase2(story, run, cfg);
    check("fails a passing test that never attempted the thing",
      r.outcome === "fail" && r.unproven.includes("AC2"), `got ${r.outcome}, unproven ${r.unproven}`);
  }

  // Actually tried.
  {
    const run = TestRun.parse({
      ...base,
      covers: { "attaches a photo": ["AC1"], "other family is denied": ["AC2"] },
      cases: [
        { name: "attaches a photo", outcome: "passed" },
        { name: "other family is denied", outcome: "passed", attempted: true },
      ],
    });
    check("passes when the denial test really tried", checkPhase2(story, run, cfg).outcome === "pass");
  }

  // Everything skipped.
  {
    const run = TestRun.parse({
      ...base,
      covers: {},
      cases: [{ name: "a", outcome: "skipped", skip_reason: "TEST_SEED_SECRET unset" }],
    });
    const r = checkPhase2(story, run, cfg);
    check("fails when every test skipped", r.outcome === "fail");
    check("  says why they skipped", r.reasons.some((x) => x.includes("TEST_SEED_SECRET")));
  }

  // No tests at all.
  check("fails when no tests ran", checkPhase2(story, null, cfg).outcome === "fail");
}

function storyTests() {
  console.log("\nReading BMAD story files");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  const storiesDir = path.join(dir, "docs", "stories");
  fs.mkdirSync(storiesDir, { recursive: true });

  fs.writeFileSync(path.join(storiesDir, "10.3.md"), [
    "# Story 10.3: Check-in photo",
    "",
    "## Status",
    "Approved",
    "",
    "## Story",
    "As a caregiver, I want to attach a photo to a check-in.",
    "",
    "## Acceptance Criteria",
    "1. A caregiver can attach a photo to a check-in",
    "2. **AC9**: A caregiver in another family cannot retrieve that photo",
    "",
    "## Tasks",
    "- [ ] something",
  ].join("\n"));

  fs.writeFileSync(path.join(storiesDir, "10.10.md"),
    "# Story 10.10: Later\n\n## Status\nDone\n\n## Acceptance Criteria\n- only one\n");

  const s = parseStory(path.join(storiesDir, "10.3.md"))!;
  check("pulls out id and title", s.id === "10.3" && s.title === "Check-in photo", `${s.id} / ${s.title}`);
  check("pulls out status", s.status === "Approved", s.status);
  check("finds both criteria", s.criteria.length === 2, `${s.criteria.length}`);
  check("keeps a labelled criterion's own id", s.criteria[1]?.id === "AC9", s.criteria[1]?.id);
  check("numbers an unlabelled one", s.criteria[0]?.id === "AC1", s.criteria[0]?.id);

  const all = findStories(dir, "docs/stories", "epic-10");
  check("finds stories by epic", all.length === 2, `${all.length}`);
  check("sorts 10.3 before 10.10", all[0]?.id === "10.3", `${all.map((x) => x.id)}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

function diffTests() {
  console.log("\nCollecting the diff");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-git-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" });

  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");

  const base = snapshot(dir);

  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(dir, "b.ts"), "export const b = 1;\n");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");

  const c = collect(dir, base, { ignore: ["**/package-lock.json"], maxChars: 50000 });

  check("sees a modified file", c.files.some((f) => f.path === "a.ts"));
  check("sees a new untracked file", c.files.some((f) => f.path === "b.ts"), `saw ${c.files.map((f) => f.path)}`);
  check("filters out lockfile noise", !c.files.some((f) => f.path.includes("package-lock")));
  check("records what it filtered", c.ignored.some((f) => f.includes("package-lock")));

  fs.rmSync(dir, { recursive: true, force: true });
}

function blindnessTests() {
  console.log("\nBlindness guardrails");

  // The leak that happens by default: BMAD edits the story file while working,
  // so it turns up in the diff and hands the reader the whole story.
  {
    const changes = {
      files: [
        { path: "docs/stories/10.3.md", added: 12, removed: 1,
          patch: "+ ## Acceptance Criteria\n+ 2. A caregiver in another family cannot retrieve that photo" },
        { path: "apps/web/src/checkin.ts", added: 30, removed: 2, patch: "+ export async function attachPhoto() {}" },
      ],
      totalAdded: 42, totalRemoved: 3, ignored: [], oversized: false,
    };
    const s = scrubForReader(changes as any, story as any, {
      exclude: ["docs/stories/**"], redact: true, maxChars: 50000,
    });
    check("keeps the story file away from the reader",
      !s.text.includes("another family cannot retrieve"), s.text.slice(0, 120));
    check("  records that it excluded it", s.excluded.includes("docs/stories/10.3.md"));
    check("  keeps the actual code", s.text.includes("attachPhoto"));
  }

  // The smaller, more pervasive leak: BMAD agents quote criteria in comments
  // and test names.
  {
    const patch = [
      "+ // AC9: A caregiver in another family cannot retrieve that photo",
      "+ test('a caregiver in another family cannot retrieve that photo', async () => {",
      "+   const x = await load();",
    ].join("\n");
    const r = redact(patch, story.criteria);
    check("redacts a criterion quoted in a comment",
      !r.text.includes("another family cannot retrieve that photo"), r.text);
    check("  counts the redaction", r.textSpans >= 1, `${r.textSpans}`);
    check("  leaves surrounding code intact", r.text.includes("await load()"));
  }
  {
    // A bare label with no criterion text. It doesn't say WHAT the criterion
    // requires, but it tells the reader this code exists to satisfy one — and
    // the comparer would then treat a label as evidence of implementation.
    const r = redact("+ // AC9 handled below\n+ if (familyId !== ctx.familyId) return null;", story.criteria);
    check("  strips a bare AC label", !/AC9/.test(r.text) && r.labels >= 1, r.text);
    check("  keeps the logic around it", r.text.includes("ctx.familyId"));
  }

  // Ordinary code must survive untouched, or the reader can't read anything.
  {
    const patch = "+ // fetch the photo for this check-in\n+ const photo = await getPhoto(id);";
    const r = redact(patch, story.criteria);
    check("leaves ordinary comments alone", r.text.includes("fetch the photo for this check-in"), r.text);
    check("  redacts nothing", r.textSpans === 0);
  }

  // The latent one: someone edits phase1.ts and passes the story in.
  {
    let threw = false;
    try {
      assertReaderIsBlind(
        "Describe this change.\n\nA caregiver in another family cannot retrieve that photo",
        story as any,
      );
    } catch (e) { threw = e instanceof BlindnessBroken; }
    check("throws if criterion text reaches the reader's prompt", threw);
  }
  {
    let ok = true;
    try { assertReaderIsBlind("Describe this change.\n\n+ const photo = await getPhoto(id);", story as any); }
    catch { ok = false; }
    check("  allows a clean prompt through", ok);
  }

  // Overlap detection.
  {
    const leaked = verbatimOverlap(
      "A caregiver can attach a photo to a check-in. A caregiver in another family cannot retrieve that photo.",
      story as any);
    const clean = verbatimOverlap(
      "Adds an upload path and scopes reads by the caller's tenant id.", story as any);
    check("spots a reconstruction that quotes the story", leaked > 0.35, `${leaked.toFixed(2)}`);
    check("  doesn't flag an independent one", clean < 0.35, `${clean.toFixed(2)}`);
  }
}

function decoyTests() {
  console.log("\nDecoy check (does the comparer discriminate?)");

  const others = [
    { ...story, id: "11.1", title: "Billing export", criteria: [{ id: "AC1", text: "export billing as CSV" }] },
  ];

  {
    const { story: d, kind } = pickDecoy(story as any, others as any);
    check("prefers a real story from another epic", kind === "other-epic" && d.id === "11.1", `${kind}/${d.id}`);
  }
  {
    const { kind } = pickDecoy(story as any, []);
    check("falls back to a synthetic decoy", kind === "synthetic");
  }
  {
    const { story: a } = pickDecoy(story as any, []);
    const { story: b } = pickDecoy(story as any, []);
    check("  picks the same decoy on a rerun", a.title === b.title);
  }

  const decoy = { ...story, title: "Billing export",
    criteria: [{ id: "AC1", text: "a" }, { id: "AC2", text: "b" }, { id: "AC3", text: "c" }] };

  {
    const r = judgeDecoy(decoy as any, "synthetic",
      [{ id: "AC1", verdict: "missing" }, { id: "AC2", verdict: "missing" }, { id: "AC3", verdict: "missing" }], 0.34);
    check("passes when the comparer rejects an unrelated story", r.passed);
  }
  {
    const r = judgeDecoy(decoy as any, "synthetic",
      [{ id: "AC1", verdict: "covered" }, { id: "AC2", verdict: "covered" }, { id: "AC3", verdict: "covered" }], 0.34);
    check("FAILS when the comparer rubber-stamps an unrelated story", !r.passed);
    check("  says the recent passes are suspect", /unproven|suspect/i.test(r.note), r.note);
  }
  {
    const r = judgeDecoy(decoy as any, "other-epic",
      [{ id: "AC1", verdict: "covered" }, { id: "AC2", verdict: "missing" }, { id: "AC3", verdict: "missing" }], 0.34);
    check("tolerates one brush with the real work", r.passed, `${r.falsePositiveRate.toFixed(2)}`);
  }

  check("decoy can be turned off", !shouldRunDecoy("off", "10.3"));
  check("  and run on every story", shouldRunDecoy("every", "10.3"));
}

async function main() {
  console.log("Harness self-test");
  storyTests();
  diffTests();
  blindnessTests();
  decoyTests();
  await phase1Tests();
  phase2Tests();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();

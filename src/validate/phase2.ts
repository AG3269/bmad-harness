import { z } from "zod";
import type { Config } from "../config.js";
import type { Story } from "../bmad/stories.js";

/**
 * Phase 2 — did it actually work?
 *
 * Phase 1 established that the code matches the story. This establishes that
 * the code runs. Different question, and both can fail independently: code can
 * match the story perfectly and not work, or work fine while solving a
 * different problem.
 *
 * Runs after Phase 1 passes, because it's the expensive one — it needs a
 * deployed app, real accounts and a mailbox.
 */

export const TestCase = z.object({
  name: z.string(),
  file: z.string().default(""),
  outcome: z.enum(["passed", "failed", "skipped", "flaky"]),
  skip_reason: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /**
   * For "should not be allowed" tests: did it actually sign in as the wrong
   * user and try? A test that never tries proves nothing, however green.
   */
  attempted: z.boolean().nullable().default(null),
  blame: z.enum(["app", "test", "environment", "unknown"]).nullable().default(null),
});

export const TestRun = z.object({
  story_id: z.string(),
  ran_where: z.enum(["local", "ci"]),
  against: z.string().default(""),
  /** Which criterion each test covers, by id. */
  covers: z.record(z.string(), z.array(z.string())).default({}),
  cases: z.array(TestCase),
});
export type TestRun = z.infer<typeof TestRun>;

export type Phase2Result = {
  outcome: "pass" | "fail" | "skipped";
  reasons: string[];
  unproven: string[];
  debt: string[];
};

export function checkPhase2(story: Story, run: TestRun | null, cfg: Config): Phase2Result {
  if (!cfg.phase2.enabled) {
    return { outcome: "skipped", reasons: ["phase 2 is off"], unproven: [], debt: [] };
  }

  const rules = cfg.phase2.rules;
  const reasons: string[] = [];
  const unproven: string[] = [];
  const debt: string[] = [];
  let invalid = false;

  if (!run) {
    return {
      outcome: "fail",
      reasons: ["No tests ran. Nothing proves this works."],
      unproven: story.criteria.map((c) => c.id),
      debt: [],
    };
  }

  const ran = run.cases.filter((c) => c.outcome !== "skipped");
  const skipped = run.cases.filter((c) => c.outcome === "skipped");
  if (run.story_id !== story.id) {
    reasons.push(`The results belong to story ${run.story_id}, not ${story.id}.`);
    invalid = true;
  }
  if (story.criteria.length === 0) {
    reasons.push("The story has no parsed acceptance criteria to validate.");
    invalid = true;
  }
  if (ran.length === 0 && skipped.length === 0) {
    reasons.push("No tests ran. Nothing proves this works.");
    invalid = true;
  }

  // The false green: nothing failed because nothing happened.
  if (rules.all_skipped_is_failure && ran.length === 0 && skipped.length > 0) {
    const why = skipped.find((s) => s.skip_reason)?.skip_reason ?? "no reason given";
    return {
      outcome: "fail",
      reasons: [
        `Every test skipped (${skipped.length}). That is not a pass.`,
        `Reason given: ${why}`,
      ],
      unproven: story.criteria.map((c) => c.id),
      debt: [],
    };
  }

  if (!run.against.trim()) {
    reasons.push("The results don't say what was tested — no test target recorded.");
    invalid = true;
  }
  if (new Set(run.cases.map((test) => test.name)).size !== run.cases.length) {
    reasons.push("The test results contain duplicate test names.");
    invalid = true;
  }

  const byName = new Map(run.cases.map((c) => [c.name, c]));

  // Which tests claim to cover which criteria.
  const coverage = new Map<string, string[]>();
  for (const [testName, criteria] of Object.entries(run.covers)) {
    for (const cid of criteria) {
      coverage.set(cid, [...(coverage.get(cid) ?? []), testName]);
    }
  }

  for (const crit of story.criteria) {
    const tests = coverage.get(crit.id) ?? [];

    if (tests.length === 0) {
      if (rules.every_criterion_needs_a_test) {
        unproven.push(crit.id);
        reasons.push(`${crit.id} (${short(crit.text)}): no test covers this.`);
      }
      continue;
    }

    let proven = false;
    for (const name of tests) {
      const t = byName.get(name);
      if (!t) {
        reasons.push(`${crit.id}: points at test "${name}", which isn't in the results.`);
        continue;
      }
      if (t.outcome === "skipped") {
        reasons.push(
          `${crit.id} (${short(crit.text)}): its test skipped` +
          `${t.skip_reason ? ` (${t.skip_reason})` : ""}. A skipped test proves nothing.`,
        );
        continue;
      }
      if (t.outcome === "failed") {
        reasons.push(`${crit.id} (${short(crit.text)}): its test failed.`);
        continue;
      }
      if (t.outcome === "flaky") {
        debt.push(`${name} — passed on retry, worth a look`);
      }

      // The one that catches a test proving nothing.
      if (rules.denial_tests_must_attempt && t.attempted === false) {
        reasons.push(
          `${crit.id} (${short(crit.text)}): its test passed, but never attempted ` +
          `the thing it claims is blocked. It needs to sign in as the wrong user ` +
          `and genuinely try.`,
        );
        continue;
      }

      if (rules.denial_tests_must_attempt && t.attempted === null && soundsLikeDenial(crit.text)) {
        reasons.push(
          `${crit.id}: reads like a "should be blocked" rule, but its test doesn't ` +
          `record whether it tried. Set attempted true/false.`,
        );
        continue;
      }

      proven = true;
    }

    if (!proven) unproven.push(crit.id);
  }

  const failed = run.cases.filter((c) => c.outcome === "failed");
  for (const f of failed) {
    if (!reasons.some((r) => r.includes(f.name))) {
      reasons.push(`Test failed: ${f.name}${f.blame ? ` (looks like ${f.blame})` : ""}`);
    }
  }

  const passed = !invalid && unproven.length === 0 && failed.length === 0;
  if (passed) {
    reasons.unshift(
      `All ${story.criteria.length} criteria backed by tests that ran and passed` +
      (run.against ? ` against ${run.against}` : "") + ".",
    );
  }

  return { outcome: passed ? "pass" : "fail", reasons, unproven, debt };
}

export function phase2Feedback(result: Phase2Result, story: Story): string {
  const lines = [
    `Story ${story.id} doesn't have working tests behind it yet.`,
    "",
    ...result.reasons.map((r) => `- ${r}`),
    "",
    "Fix these:",
  ];
  for (const id of result.unproven) {
    const c = story.criteria.find((x) => x.id === id);
    lines.push(`- ${id}: ${c?.text ?? id}`);
  }
  lines.push(
    "",
    "Rules:",
    "- Every criterion needs a test, listed in `covers`.",
    "- Tests for something being blocked must actually attempt it, as the wrong",
    "  user, and record attempted: true.",
    "- Don't report a skipped test as a pass.",
  );
  return lines.join("\n");
}

function soundsLikeDenial(text: string): boolean {
  return /\b(not|cannot|can't|denied|deny|forbidden|blocked|refuse|reject|unauthori[sz]ed|only|prevent)\b/i.test(text);
}

const short = (s: string, max = 60) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

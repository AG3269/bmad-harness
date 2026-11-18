import { z } from "zod";
import { minimatch } from "minimatch";
import type { Azure } from "../llm/azure.js";
import type { Config } from "../config.js";
import type { Story } from "../bmad/stories.js";
import { isEmpty, type Changes } from "./diff.js";
import {
  scrubForReader, assertReaderIsBlind, verbatimOverlap, type Scrub,
} from "./blindness.js";
import { pickDecoy, judgeDecoy, shouldRunDecoy, type DecoyResult } from "./decoy.js";

/**
 * Phase 1 — does the code match the story?
 *
 * Two steps, and the separation between them is the whole point.
 *
 *   Step 1 (read)    A model sees ONLY the diff. No story, no story id, no
 *                    hint about what was wanted. It writes the work item it
 *                    thinks produced this code.
 *
 *   Step 2 (compare) A second model, fresh, sees the real story and that
 *                    reconstruction, and judges where they diverge.
 *
 * Doing it in one call — "here's the story, here's the diff, do they match?" —
 * is close to worthless. Shown both, a model finds something in the diff that
 * loosely corresponds to each criterion and talks itself into a yes. The
 * reconstruction is only evidence because it was written by something that had
 * never seen what it was supposed to produce.
 *
 * Both steps have a quiet failure mode, and both are guarded:
 *
 *   The reader can be fed the story without anyone noticing — most obviously
 *   because BMAD edits the story file while working, so it turns up in the
 *   diff. blindness.ts strips those channels and hard-fails if any survive.
 *
 *   The comparer can simply agree with everything, which looks identical to
 *   working on every story that passes. decoy.ts periodically asks it to
 *   compare the same code against a story it definitely doesn't implement.
 */

// --- What the reader produces ------------------------------------------------
const ReconstructionSchema = z.object({
  summary: z.string().max(2000),
  capabilities: z.array(z.string()).default([]),
  inferred_criteria: z.array(z.string()).default([]),
  surfaces: z.array(z.string()).default([]),
  incomplete: z.array(z.object({
    file: z.string(),
    what: z.string(),
    detail: z.string().max(400),
  })).default([]),
  confidence: z.number().min(0).max(1),
});
export type Reconstruction = z.infer<typeof ReconstructionSchema>;

// --- What the comparer produces ----------------------------------------------
const ComparisonSchema = z.object({
  criteria: z.array(z.object({
    id: z.string(),
    verdict: z.enum(["covered", "partial", "missing", "unclear"]),
    evidence: z.string().max(600),
  })),
  extra: z.array(z.object({
    what: z.string().max(400),
    files: z.array(z.string()).default([]),
    concern: z.enum(["none", "minor", "serious"]).default("minor"),
  })).default([]),
  divergences: z.array(z.object({
    what: z.string().max(600),
    severity: z.enum(["minor", "major"]),
  })).default([]),
  overall: z.string().max(1000),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

/** What the guardrails observed. Goes in the audit whether or not it's clean. */
export type Integrity = {
  excludedFiles: string[];
  redactedText: number;
  redactedLabels: number;
  /** Code named criteria explicitly — the reading is less independent. */
  primed: boolean;
  /** How much of the story's wording turned up in the reconstruction. */
  overlap: number;
  overlapFlagged: boolean;
  decoy: DecoyResult | null;
  /** True when this reading follows feedback that named the gaps. */
  secondPass: boolean;
};

export type Phase1Result = {
  outcome: "pass" | "fail" | "escalate" | "skipped";
  reasons: string[];
  unmet: string[];
  reconstruction: Reconstruction | null;
  comparison: Comparison | null;
  integrity: Integrity | null;
};

export async function runPhase1(
  story: Story,
  changes: Changes,
  azure: Azure,
  cfg: Config,
  opts: { allStories?: Story[]; secondPass?: boolean } = {},
): Promise<Phase1Result> {
  if (!cfg.phase1.enabled) {
    return empty("skipped", ["phase 1 is off"]);
  }

  if (isEmpty(changes)) {
    return {
      outcome: "fail",
      reasons: ["Nothing changed. The agent reported finishing but the working tree is untouched."],
      unmet: story.criteria.map((c) => c.id),
      reconstruction: null, comparison: null, integrity: null,
    };
  }

  const storyProblems = criterionProblems(story, story.criteria.map((criterion) => ({ id: criterion.id })));
  if (storyProblems.length) {
    return empty("escalate", storyProblems);
  }

  const b = cfg.phase1.blindness;

  // ---- Strip the story out of the diff before anyone reads it ---------------
  const scrub = scrubForReader(changes, story, {
    exclude: b.exclude,
    redact: b.redact_criterion_text,
    maxChars: cfg.phase1.max_diff_chars,
  });

  if (!scrub.text.trim()) {
    return {
      outcome: "fail",
      reasons: [
        `Everything that changed was documentation the reader isn't allowed to ` +
        `see (${scrub.excluded.join(", ")}). No code was written.`,
      ],
      unmet: story.criteria.map((c) => c.id),
      reconstruction: null, comparison: null,
      integrity: baseIntegrity(scrub, opts.secondPass),
    };
  }

  // ---- Step 1: read the diff, blind ----------------------------------------
  const reconstruction = await read(scrub, changes, azure, cfg, story, b.assert_no_leak);

  const overlap = verbatimOverlap(
    [reconstruction.summary, ...reconstruction.capabilities, ...reconstruction.inferred_criteria].join(" "),
    story,
  );

  const integrity: Integrity = {
    ...baseIntegrity(scrub, opts.secondPass),
    overlap,
    overlapFlagged: overlap > b.max_verbatim_overlap,
    decoy: null,
  };

  if (reconstruction.confidence < cfg.phase1.min_confidence) {
    return {
      outcome: "escalate",
      reasons: [
        `The diff couldn't be read clearly enough to judge ` +
        `(confidence ${pct(reconstruction.confidence)}, needs ${pct(cfg.phase1.min_confidence)}).`,
        `Usually a very large, very scattered, or mostly generated change. ` +
        `Worth a human eye rather than a guess either way.`,
      ],
      unmet: [], reconstruction, comparison: null, integrity,
    };
  }

  // ---- Step 2: compare against what was actually asked for ------------------
  const comparison = await compare(story, reconstruction, azure, cfg);
  const problems = criterionProblems(story, comparison.criteria);
  if (problems.length) {
    return {
      outcome: "escalate", reasons: problems, unmet: [], reconstruction, comparison, integrity,
    };
  }

  // ---- Negative control: does the comparer discriminate at all? -------------
  if (shouldRunDecoy(b.decoy, story.id)) {
    const { story: decoyStory, kind } = pickDecoy(story, opts.allStories ?? []);
    try {
      const decoyComparison = await compare(decoyStory, reconstruction, azure, cfg);
      const decoyProblems = criterionProblems(decoyStory, decoyComparison.criteria);
      integrity.decoy = {
        used: decoyStory, kind,
        ...(decoyProblems.length
          ? { falsePositiveRate: null, passed: null, note: `Decoy comparison is invalid: ${decoyProblems.join(" ")}` }
          : judgeDecoy(decoyStory, kind, decoyComparison.criteria, b.decoy_tolerance)),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      integrity.decoy = {
        used: decoyStory, kind, falsePositiveRate: null, passed: null,
        note: `Decoy check could not run; Phase 1 is unverified: ${reason.slice(0, 300)}`,
      };
    }
  }

  return gate(story, reconstruction, comparison, integrity, cfg);
}

function criterionProblems(story: Story, verdicts: { id: string }[]): string[] {
  const expected = new Set(story.criteria.map((criterion) => criterion.id));
  if (expected.size === 0) return ["The story has no parsed acceptance criteria; Phase 1 cannot verify it."];
  if (expected.size !== story.criteria.length) return ["The story contains duplicate acceptance criterion IDs."];

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown = new Set<string>();
  for (const verdict of verdicts) {
    if (seen.has(verdict.id)) duplicates.add(verdict.id);
    seen.add(verdict.id);
    if (!expected.has(verdict.id)) unknown.add(verdict.id);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  return [
    missing.length ? `Missing comparison verdicts: ${missing.join(", ")}.` : "",
    duplicates.size ? `Duplicate comparison verdicts: ${[...duplicates].join(", ")}.` : "",
    unknown.size ? `Unknown comparison criterion IDs: ${[...unknown].join(", ")}.` : "",
  ].filter(Boolean);
}

// =============================================================================
// Step 1 — blind
// =============================================================================

async function read(
  scrub: Scrub,
  changes: Changes,
  azure: Azure,
  cfg: Config,
  story: Story,
  assertBlind: boolean,
): Promise<Reconstruction> {
  const system = [
    "You read code changes and describe what they do.",
    "",
    "You have NOT been told what this change was supposed to accomplish, and",
    "you will not be. Describe only what the code in front of you actually does.",
    "Do not guess at a larger plan it might be part of. Do not be generous about",
    "what half-finished code will eventually do — describe its current state.",
    "",
    "Some comments and strings may be marked as removed. That is deliberate and",
    "not something to work around: do not speculate about what they said, and",
    "do not treat a removal marker as evidence that the surrounding code does",
    "anything in particular.",
    "",
    "If something is a stub, a TODO, a hardcoded value standing in for real work,",
    "or a test that asserts nothing meaningful, say so. That is the most useful",
    "thing you can report.",
  ].join("\n");

  const user = [
    "Here is a code change. Describe it.",
    "",
    `${changes.files.length} file(s), +${changes.totalAdded}/-${changes.totalRemoved} lines.`,
    changes.oversized ? "(Large diff; some of it is truncated below.)" : "",
    "",
    scrub.text,
    "",
    "---",
    "",
    "Reply with only this JSON:",
    "{",
    '  "summary": "a paragraph: what this change accomplishes, in plain terms",',
    '  "capabilities": ["concrete things that can now happen that could not before"],',
    '  "inferred_criteria": ["the acceptance criteria you would write for this change"],',
    '  "surfaces": ["which parts it touches: auth, database, ui, api, tests, config"],',
    '  "incomplete": [{"file": "", "what": "stub | TODO | hardcoded | empty test | placeholder", "detail": ""}],',
    '  "confidence": 0.0',
    "}",
    "",
    "confidence is how well you could tell what this change does from the diff",
    "alone. Large, scattered or mostly-generated diffs should score low. Say so",
    "rather than inventing a confident reading.",
  ].filter(Boolean).join("\n");

  // Last line of defence. Throws rather than warns: a weakened gate is worse
  // than no gate, because it looks like it's working.
  if (assertBlind) assertReaderIsBlind(`${system}\n${user}`, story);

  return azure.askJson(
    { deployment: cfg.azure.deployments.reader, system, user, temperature: 0, maxTokens: 3000 },
    ReconstructionSchema,
  );
}

// =============================================================================
// Step 2
// =============================================================================

async function compare(
  story: Story,
  reconstruction: Reconstruction,
  azure: Azure,
  cfg: Config,
): Promise<Comparison> {
  const system = [
    "You are comparing what was asked for against what was built.",
    "",
    "You have two descriptions of the same piece of work:",
    "",
    "  A — the story. What someone asked for, written before any code existed.",
    "  B — a reconstruction. What a reader concluded the code does, written by",
    "      someone shown ONLY the diff, who never saw A.",
    "",
    "Because B was written blind, it is evidence about what the code actually",
    "does rather than a restatement of A. Where A and B disagree, that gap is",
    "the finding. Do not smooth it over.",
    "",
    "Be strict. A criterion is 'covered' only if B describes something that",
    "plainly satisfies it. If B is silent on a criterion, that is 'missing',",
    "not 'unclear' — a reader who understood the code and never mentioned the",
    "thing is good evidence the code does not do it. Use 'unclear' only when B",
    "says something ambiguous about that specific criterion.",
    "",
    "Marking things covered when they are not is the worst outcome here: it",
    "produces a clean report for work that was never done, and nobody finds out",
    "until much later.",
  ].join("\n");

  const user = [
    "## A — the story",
    "",
    `**${story.title}**`,
    story.narrative ? `\n${story.narrative}\n` : "",
    "Acceptance criteria:",
    ...story.criteria.map((c) => `- ${c.id}: ${c.text}`),
    "",
    "## B — reconstructed from the code, without seeing A",
    "",
    reconstruction.summary,
    "",
    reconstruction.capabilities.length ? "What it says can now happen:" : "",
    ...reconstruction.capabilities.map((c) => `- ${c}`),
    "",
    reconstruction.inferred_criteria.length ? "Criteria the reader inferred:" : "",
    ...reconstruction.inferred_criteria.map((c) => `- ${c}`),
    "",
    reconstruction.surfaces.length ? `Surfaces touched: ${reconstruction.surfaces.join(", ")}` : "",
    "",
    reconstruction.incomplete.length ? "Flagged as unfinished:" : "",
    ...reconstruction.incomplete.map((i) => `- ${i.file}: ${i.what} — ${i.detail}`),
    "",
    "---",
    "",
    "Reply with only this JSON:",
    "{",
    '  "criteria": [{"id": "AC1", "verdict": "covered|partial|missing|unclear", "evidence": "what in B supports this, or what is absent"}],',
    '  "extra": [{"what": "something B describes that A never asked for", "files": [], "concern": "none|minor|serious"}],',
    '  "divergences": [{"what": "A asked for X, B describes Y instead", "severity": "minor|major"}],',
    '  "overall": "one paragraph"',
    "}",
    "",
    "One entry in `criteria` for every criterion in A, in order.",
    "Mark `extra` 'serious' when it touches authentication, permissions, database",
    "schema or configuration — work nobody asked for in those places deserves a",
    "person looking at it.",
  ].filter(Boolean).join("\n");

  return azure.askJson(
    { deployment: cfg.azure.deployments.comparer, system, user, temperature: 0, maxTokens: 3000 },
    ComparisonSchema,
  );
}

// =============================================================================
// Gating — plain rules, no model involved
// =============================================================================

function gate(
  story: Story,
  reconstruction: Reconstruction,
  comparison: Comparison,
  integrity: Integrity,
  cfg: Config,
): Phase1Result {
  const reasons: string[] = [];
  const unmet: string[] = [];
  let escalate = false;

  const textFor = (id: string) => story.criteria.find((c) => c.id === id)?.text ?? id;

  // --- The guardrails come first. A pass from a gate that isn't working is
  //     worse than a fail. ----------------------------------------------------
  if (integrity.decoy && integrity.decoy.passed !== true) {
    return {
      outcome: "escalate",
      reasons: [
        integrity.decoy.note,
        `Phase 1 can't be trusted for this story until that's understood. ` +
        `Usually the comparer deployment changed, or its prompt did.`,
      ],
      unmet: [], reconstruction, comparison, integrity,
    };
  }

  if (integrity.overlapFlagged) {
    reasons.push(
      `The reconstruction reuses ${pct(integrity.overlap)} of the story's own wording. ` +
      `That can be innocent — code about the same subject uses the same words — ` +
      `but it's also what a leak looks like. Worth a glance at the kept diff.`,
    );
    escalate = true;
  }

  // --- The actual comparison -------------------------------------------------
  for (const c of comparison.criteria) {
    if (c.verdict === "missing") {
      unmet.push(c.id);
      reasons.push(`${c.id} (${short(textFor(c.id))}): the code doesn't appear to do this. ${c.evidence}`);
    } else if (c.verdict === "partial") {
      unmet.push(c.id);
      reasons.push(`${c.id} (${short(textFor(c.id))}): only partly done. ${c.evidence}`);
    } else if (c.verdict === "unclear") {
      escalate = true;
      reasons.push(`${c.id} (${short(textFor(c.id))}): can't tell from the code. ${c.evidence}`);
    }
  }

  if (cfg.phase1.fail_on.includes("stub_on_criterion_path")) {
    for (const i of reconstruction.incomplete) {
      reasons.push(`${i.file}: ${i.what} — ${i.detail}`);
      if (unmet.length === 0) unmet.push(`stub:${i.file}`);
    }
  }

  if (cfg.phase1.escalate_on.includes("extra_in_protected_path")) {
    for (const e of comparison.extra) {
      const protectedHit = e.files.some((f) =>
        cfg.decide.always_ask.files.some((p) => minimatch(f, p)),
      );
      if (e.concern === "serious" || protectedHit) {
        escalate = true;
        reasons.push(
          `Built something the story never asked for: ${e.what}` +
          (e.files.length ? ` (${e.files.join(", ")})` : "") + ".",
        );
      }
    }
  }

  if (cfg.phase1.escalate_on.includes("major_divergence")) {
    for (const d of comparison.divergences) {
      if (d.severity === "major") {
        escalate = true;
        reasons.push(`The code solves a different problem than the story describes: ${d.what}`);
      }
    }
  }

  if (unmet.length > 0) return { outcome: "fail", reasons, unmet, reconstruction, comparison, integrity };
  if (escalate) return { outcome: "escalate", reasons, unmet, reconstruction, comparison, integrity };

  // A pass, with any caveats attached rather than dropped.
  const caveats: string[] = [];
  if (integrity.primed) {
    caveats.push(
      `the code named criteria directly (${integrity.redactedText} quote(s), ` +
      `${integrity.redactedLabels} label(s) removed), so the reading is less ` +
      `independent than usual`,
    );
  }
  if (integrity.secondPass) {
    caveats.push(`this is a re-read after the gaps were pointed out`);
  }

  return {
    outcome: "pass",
    reasons: [
      `All ${comparison.criteria.length} criteria show up in the code, read blind. ${comparison.overall}` +
      (caveats.length ? ` (Caveat: ${caveats.join("; ")}.)` : ""),
    ],
    unmet: [], reconstruction, comparison, integrity,
  };
}

/** What to tell the dev agent when Phase 1 fails. */
export function phase1Feedback(result: Phase1Result, story: Story): string {
  const lines = [
    `Story ${story.id} isn't finished.`,
    "",
    `Someone read your diff without being told what the story was, and described ` +
    `what the code does. Comparing that to the story, these are missing:`,
    "",
  ];

  for (const id of result.unmet) {
    if (id.startsWith("stub:")) continue;
    const c = story.criteria.find((x) => x.id === id);
    const why = result.comparison?.criteria.find((x) => x.id === id)?.evidence ?? "";
    lines.push(`- ${id}: ${c?.text ?? id}`);
    if (why) lines.push(`  (${why})`);
  }

  const stubs = result.unmet.filter((u) => u.startsWith("stub:"));
  if (stubs.length) {
    lines.push("", "Unfinished code found:");
    for (const s of stubs) lines.push(`- ${s.slice(5)}`);
  }

  lines.push(
    "",
    "Implement these properly. Don't leave placeholders, TODOs or stubbed returns.",
    "",
    "Write the code so that what it does is clear from the code itself. Don't add",
    "comments quoting the acceptance criteria — they get stripped before review",
    "and they don't make the implementation any more real.",
  );

  return lines.join("\n");
}

// =============================================================================

function baseIntegrity(scrub: Scrub, secondPass?: boolean) {
  return {
    excludedFiles: scrub.excluded,
    redactedText: scrub.redactedText,
    redactedLabels: scrub.redactedLabels,
    primed: scrub.primed,
    overlap: 0,
    overlapFlagged: false,
    decoy: null as DecoyResult | null,
    secondPass: Boolean(secondPass),
  };
}

function empty(outcome: Phase1Result["outcome"], reasons: string[]): Phase1Result {
  return { outcome, reasons, unmet: [], reconstruction: null, comparison: null, integrity: null };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const short = (s: string, max = 60) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

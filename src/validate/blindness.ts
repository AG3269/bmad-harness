import { minimatch } from "minimatch";
import type { Story, Criterion } from "../bmad/stories.js";
import type { Changes } from "./diff.js";

/**
 * Keeping the reader blind.
 *
 * Phase 1 only means anything if the model reading the diff has never seen the
 * story. That property is fragile and it fails SILENTLY — a leaking gate and a
 * working gate produce identical output until the day you need one. So it is
 * enforced here rather than hoped for.
 *
 * Four layers, in order of how much they're worth:
 *
 *   1. Exclude   Files that contain the story. The story file itself is the
 *                big one: BMAD agents edit it while working, so it lands in
 *                every diff. Without this the reader reads the story verbatim
 *                and reconstructs it perfectly.
 *
 *   2. Redact    Criterion text and AC labels quoted inside comments and
 *                string literals. "// AC9: family B cannot read family A's
 *                photo" hands the reader the answer. Only comments and strings
 *                are touched — code structure is what we want it to read.
 *
 *   3. Assert    Before the prompt is sent, check no criterion text survived.
 *                A hard throw, not a warning: a future edit that passes the
 *                story in should break the run, not quietly weaken it.
 *
 *   4. Detect    After the reply, check whether the reconstruction quotes the
 *                story. High overlap doesn't prove leakage — code about photos
 *                and families uses those words legitimately — but it's worth
 *                surfacing.
 *
 * A fifth guardrail lives in phase1.ts: a decoy comparison, which catches the
 * other failure mode entirely — a comparer that marks everything covered.
 */

export type Scrub = {
  /** The diff, safe to show the reader. */
  text: string;
  /** Files removed whole because they contain the story. */
  excluded: string[];
  /** How many spans were redacted, and what kind. */
  redactedText: number;
  redactedLabels: number;
  /**
   * True when the code explicitly referenced criteria. The reading is still
   * usable — we removed the text — but the author clearly knew the criteria,
   * so the reconstruction is less independent than it looks.
   */
  primed: boolean;
};

/** Files that are the story, or restate it. Never shown to the reader. */
export function excludedBy(filePath: string, patterns: string[], storyFile: string): boolean {
  if (sameFile(filePath, storyFile)) return true;
  return patterns.some((p) => minimatch(filePath, p));
}

/**
 * Builds the diff text the reader sees.
 *
 * Deliberately separate from diff.ts's asText: that one renders a diff, this
 * one renders a diff that is safe to reason about blind.
 */
export function scrubForReader(
  changes: Changes,
  story: Story,
  opts: { exclude: string[]; redact: boolean; maxChars: number },
): Scrub {
  const excluded: string[] = [];
  const kept = changes.files.filter((f) => {
    if (excludedBy(f.path, opts.exclude, story.file)) { excluded.push(f.path); return false; }
    return true;
  });

  let redactedText = 0;
  let redactedLabels = 0;

  const parts: string[] = [];
  let used = 0;

  // Smallest first so the budget covers as many whole files as possible.
  for (const f of [...kept].sort((a, b) => a.patch.length - b.patch.length)) {
    const left = opts.maxChars - used;
    if (left < 500) {
      parts.push(`\n[${kept.length - parts.length} more file(s) not shown — diff too large]`);
      break;
    }

    let patch = f.patch;
    if (opts.redact && patch) {
      const r = redact(patch, story.criteria);
      patch = r.text;
      redactedText += r.textSpans;
      redactedLabels += r.labels;
    }

    if (!patch) {
      parts.push(`\n### ${f.path}\n[binary file changed]`);
      used += 60;
      continue;
    }

    if (patch.length <= left) {
      parts.push(`\n### ${f.path}\n${patch}`);
      used += patch.length;
    } else {
      parts.push(`\n### ${f.path}\n${patch.slice(0, left - 100)}\n[... truncated ...]`);
      used = opts.maxChars;
    }
  }

  return {
    text: parts.join("\n"),
    excluded,
    redactedText,
    redactedLabels,
    primed: redactedText + redactedLabels > 0,
  };
}

// =============================================================================
// Redaction
// =============================================================================

/**
 * Removes quoted criterion text and AC labels from comments and string
 * literals.
 *
 * Scoped to comments and strings on purpose. Redacting code itself would make
 * the diff unreadable, and code identifiers rarely carry whole sentences from
 * a story. The leak is nearly always a comment or a test name.
 */
export function redact(patch: string, criteria: Criterion[]): {
  text: string; textSpans: number; labels: number;
} {
  const grams = criterionShingles(criteria);
  let textSpans = 0;
  let labels = 0;

  const lines = patch.split("\n").map((line) => {
    // Leave diff headers alone.
    if (/^(diff |index |--- |\+\+\+ |@@ )/.test(line)) return line;

    let out = line;

    // Comments: // … , # … , * … (inside block comments)
    out = out.replace(/((?:\/\/|#|\*)\s*)(.+)$/g, (whole, lead: string, body: string) => {
      if (!quotesCriterion(body, grams)) return whole;
      textSpans++;
      return `${lead}[comment removed: quoted a story criterion]`;
    });

    // String literals.
    out = out.replace(/(['"`])((?:[^'"`\\]|\\.){8,}?)\1/g, (whole, q: string, body: string) => {
      if (!quotesCriterion(body, grams)) return whole;
      textSpans++;
      return `${q}[string removed: quoted a story criterion]${q}`;
    });

    // Bare criterion labels. "AC9" alone doesn't say WHAT 9 requires, but it
    // tells the reader this code exists to satisfy a criterion — and the
    // comparer would then count a label as evidence of implementation.
    out = out.replace(/\bAC[\s_-]?\d{1,3}\b/gi, () => { labels++; return "[AC ref]"; });
    out = out.replace(/\bacceptance criteri(?:on|a)\s+\d{1,3}\b/gi, () => { labels++; return "[AC ref]"; });

    return out;
  });

  return { text: lines.join("\n"), textSpans, labels };
}

/** Five-word sequences from each criterion. Long enough that a match is a quote. */
const SHINGLE = 5;

function criterionShingles(criteria: Criterion[]): Set<string> {
  const out = new Set<string>();
  for (const c of criteria) {
    for (const g of shingles(words(c.text), SHINGLE)) out.add(g);
  }
  return out;
}

function quotesCriterion(text: string, grams: Set<string>): boolean {
  if (grams.size === 0) return false;
  for (const g of shingles(words(text), SHINGLE)) {
    if (grams.has(g)) return true;
  }
  return false;
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function shingles(ws: string[], n: number): string[] {
  if (ws.length < n) return ws.length ? [ws.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(" "));
  return out;
}

// =============================================================================
// Assertion — the prompt must not contain the story
// =============================================================================

export class BlindnessBroken extends Error {
  constructor(message: string) {
    super(
      `Phase 1 blindness broken: ${message}\n\n` +
      `The reader must never see the story. If it does, its reconstruction is ` +
      `just the story read back, every criterion looks covered, and Phase 1 ` +
      `silently stops checking anything.\n\n` +
      `This is a hard stop on purpose — a weakened gate is worse than no gate, ` +
      `because it looks like it's working.`,
    );
  }
}

/**
 * Last line of defence, run on the actual prompt string.
 *
 * Catches a future change that passes the story into the reader — the kind of
 * edit that looks harmless in review and quietly disables the check.
 */
export function assertReaderIsBlind(prompt: string, story: Story): void {
  const promptGrams = new Set(shingles(words(prompt), SHINGLE));

  for (const c of story.criteria) {
    const cg = shingles(words(c.text), SHINGLE);
    const hit = cg.find((g) => promptGrams.has(g));
    if (hit) {
      throw new BlindnessBroken(
        `criterion ${c.id} appears in the reader's prompt ("…${hit}…").`,
      );
    }
  }

  // The narrative and title leak intent too.
  for (const [what, text] of [["title", story.title], ["narrative", story.narrative]] as const) {
    if (!text || words(text).length < SHINGLE) continue;
    const hit = shingles(words(text), SHINGLE).find((g) => promptGrams.has(g));
    if (hit) throw new BlindnessBroken(`the story ${what} appears in the reader's prompt ("…${hit}…").`);
  }
}

// =============================================================================
// Detection — did the reconstruction quote the story anyway?
// =============================================================================

/**
 * How much of the story's wording turns up in the reconstruction, 0..1.
 *
 * Not proof of anything on its own: code about families and photos will
 * legitimately produce a reconstruction using those words. It's a signal to
 * surface, and a number to watch across runs — a sudden jump usually means a
 * new leak channel opened.
 */
export function verbatimOverlap(reconstructionText: string, story: Story): number {
  const storyGrams = new Set<string>();
  for (const c of story.criteria) for (const g of shingles(words(c.text), 4)) storyGrams.add(g);
  for (const g of shingles(words(story.narrative), 4)) storyGrams.add(g);
  if (storyGrams.size === 0) return 0;

  const reconGrams = new Set(shingles(words(reconstructionText), 4));
  let hits = 0;
  for (const g of storyGrams) if (reconGrams.has(g)) hits++;

  return hits / storyGrams.size;
}

function sameFile(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm(a).endsWith(norm(b)) || norm(b).endsWith(norm(a));
}

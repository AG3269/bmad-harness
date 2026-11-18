import type { Story } from "../bmad/stories.js";
import type { Reconstruction } from "./phase1.js";

/**
 * The negative control.
 *
 * Blindness protects the reader. Nothing so far protects the comparer, and it
 * has its own quiet failure: marking everything "covered". A comparer that
 * rubber-stamps looks exactly like one that works, on every story that passes.
 *
 * So periodically we run the comparison again with the SAME reconstruction and
 * a story the code definitely does not implement. The answer should be
 * "missing" across the board. If it isn't, the comparer isn't discriminating
 * and every pass it has given is suspect.
 *
 * One extra call. It is the only thing in Phase 1 that can tell you the gate
 * still works.
 */

type DecoyJudgement = {
  falsePositiveRate: number;
  passed: boolean;
  note: string;
};

export type DecoyResult = {
  used: Story;
  kind: "other-epic" | "synthetic";
} & (DecoyJudgement | { falsePositiveRate: null; passed: null; note: string });

/**
 * Pick something the code can't plausibly implement.
 *
 * A real story from another epic is the better test — it's a harder, more
 * realistic distractor than something obviously unrelated. Falls back to a
 * synthetic one when there's nothing else around.
 */
export function pickDecoy(current: Story, all: Story[]): { story: Story; kind: "other-epic" | "synthetic" } {
  const currentEpic = current.id.split(".")[0];

  const otherEpic = all.filter((s) => s.id.split(".")[0] !== currentEpic && s.criteria.length > 0);
  if (otherEpic.length > 0) {
    // Deterministic pick, so a rerun of the same story uses the same decoy and
    // the result is comparable.
    const i = hash(current.id) % otherEpic.length;
    return { story: otherEpic[i]!, kind: "other-epic" };
  }

  return { story: synthetic(hash(current.id)), kind: "synthetic" };
}

/**
 * Stand-ins for when the repo has only one epic. Deliberately mundane and
 * plausible-sounding — an obviously absurd decoy tests nothing, because any
 * comparer rejects it.
 */
function synthetic(seed: number): Story {
  const options: { title: string; criteria: string[] }[] = [
    {
      title: "Export billing history",
      criteria: [
        "An account owner can download their billing history as a CSV",
        "The export excludes accounts the owner does not administer",
      ],
    },
    {
      title: "Scheduled digest email",
      criteria: [
        "A user can choose to receive a weekly digest email",
        "Users who have opted out receive no digest",
      ],
    },
    {
      title: "Admin audit log search",
      criteria: [
        "An administrator can search the audit log by date range",
        "Search results are limited to the administrator's own organisation",
      ],
    },
  ];

  const pick = options[seed % options.length]!;
  return {
    id: "decoy",
    title: pick.title,
    status: "Approved",
    narrative: "",
    criteria: pick.criteria.map((text, i) => ({ id: `AC${i + 1}`, text })),
    fullText: "",
    file: "(synthetic decoy)",
  };
}

/**
 * Judge the decoy comparison.
 *
 * A little tolerance: a genuinely good comparer may mark one decoy criterion
 * "covered" when the decoy happens to overlap with the real work — "results
 * limited to the caller's organisation" is not far from "reads scoped to the
 * caller's family". Anything beyond that is rubber-stamping.
 */
export function judgeDecoy(
  decoy: Story,
  kind: "other-epic" | "synthetic",
  verdicts: { id: string; verdict: string }[],
  tolerance: number,
): DecoyJudgement {
  const total = verdicts.length || decoy.criteria.length || 1;
  const wrong = verdicts.filter((v) => v.verdict === "covered").length;
  const rate = wrong / total;

  if (rate <= tolerance) {
    return {
      falsePositiveRate: rate,
      passed: true,
      note: `Decoy check passed — the comparer marked ${wrong}/${total} of an ` +
            `unrelated story's criteria as covered.`,
    };
  }

  return {
    falsePositiveRate: rate,
    passed: false,
    note:
      `Decoy check FAILED. Given the same code, the comparer said ${wrong}/${total} ` +
      `criteria of "${decoy.title}" — a story this code does not implement — were ` +
      `covered. It is agreeing rather than checking, so treat this story's pass, ` +
      `and recent ones, as unproven.`,
  };
}

/** Should the decoy run for this story? */
export function shouldRunDecoy(mode: string, storyId: string): boolean {
  if (mode === "off") return false;
  if (mode === "every") return true;
  // "sometimes" — roughly one in four, deterministic per story.
  return hash(storyId) % 4 === 0;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

import { z } from "zod";
import { minimatch } from "minimatch";
import * as readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import type { Azure } from "../llm/azure.js";
import type { Config } from "../config.js";
import type { Ledger } from "../audit/ledger.js";
import { summarizeForHuman } from "../audit/summarize.js";

/**
 * Who decides what.
 *
 * Three tiers, cheapest first. A model is never asked something a rule can
 * answer, and you are never asked something the model can handle.
 *
 *   1. Rules  — written in the config. Free, predictable, most cases.
 *   2. Model  — Azure OpenAI, for what the rules miss.
 *   3. You    — with a cap, so it can't nickel-and-dime you all night.
 *
 * The cap matters more than it looks. Without one it asks about everything and
 * you stop reading. With one it has to rank, and it wakes you for the schema
 * question instead of the naming question.
 */

export const Question = z.object({
  kind: z.string(),
  asks: z.union([
    z.string(),
    z.array(z.string().refine((text) => text.trim().length > 0, "Question paragraphs must not be blank.")).min(1),
  ]).transform((value) => typeof value === "string" ? value : value.join("\n\n"))
    .pipe(z.string().max(800)),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    detail: z.string().max(600).default(""),
    touches: z.array(z.string()).default([]),
    undoable: z.boolean().default(true),
  })).min(2),
  agent_suggests: z.string().default(""),
  agent_sureness: z.number().min(0).max(1).default(0.5),
  context: z.string().max(2000).default(""),
});
export type Question = z.infer<typeof Question>;

const ModelAnswer = z.object({
  pick: z.string(),
  sureness: z.number().min(0).max(1),
  because: z.string().max(600),
  ask_human_instead: z.boolean().default(false),
});

export type Decided = {
  pick: string;
  by: "rules" | "model" | "human";
  sureness: number | null;
  because: string;
};

/** Thrown when the harness can't go on without you and you aren't there. */
export class NeedsYou extends Error {
  constructor(public why: string, public question: Question, public summary = "") {
    super(why);
  }
}

export type Finding = {
  id: string;
  severity: "low" | "medium" | "high";
  kind: string;
  file: string;
  what: string;
  suggested_fix: string;
  is_proof_gap?: boolean;
};

export class Decider {
  private left: number;

  constructor(
    private cfg: Config,
    private ledger: Ledger,
    private azure: Azure,
    options: { interruptionsUsed?: number } = {},
  ) {
    this.left = Math.max(0, cfg.limits.interruptions - (options.interruptionsUsed ?? 0));
  }

  get interruptionsLeft() { return this.left; }

  // ---------------------------------------------------------------------------
  // Review findings: fix quietly, or stop and ask?
  // ---------------------------------------------------------------------------

  sortFindings(findings: Finding[]): { quiet: Finding[]; ask: Finding[]; reason: string } {
    const d = this.cfg.decide;
    const ask: Finding[] = [];
    const quiet: Finding[] = [];

    for (const f of findings) {
      const serious =
        d.always_ask.kinds.includes(f.kind) ||
        d.always_ask.files.some((p) => minimatch(f.file, p)) ||
        f.severity === "high";

      if (serious) { ask.push(f); continue; }

      const small =
        d.fix_quietly.includes(f.kind) &&
        !d.never_touch.some((p) => minimatch(f.file, p));

      // A proof gap is never "small" — it means the tests aren't proving
      // what they claim.
      if (small && !f.is_proof_gap) { quiet.push(f); continue; }

      ask.push(f);
    }

    const reason = ask.length
      ? `${ask.length} finding(s) need a decision`
      : quiet.length
        ? `${quiet.length} small finding(s), handling without you`
        : "nothing to fix";

    return { quiet, ask, reason };
  }

  // ---------------------------------------------------------------------------

  async answer(q: Question, story: string, storyTitle = ""): Promise<Decided> {
    // --- Things the model may never settle -----------------------------------
    if (this.cfg.decide.never.includes(q.kind)) {
      return this.askYou(q, story, storyTitle, `"${q.kind}" is yours to decide`);
    }

    const allRisky = q.options.every((o) =>
      o.touches.some((t) => this.cfg.decide.always_ask.files.some((p) => minimatch(t, p))),
    );
    if (allRisky) {
      return this.askYou(q, story, storyTitle, "every option touches protected files");
    }

    const permanent = q.options.filter((o) => !o.undoable);
    if (permanent.length && this.cfg.mode !== "solo") {
      return this.askYou(
        q, story, storyTitle,
        `option(s) ${permanent.map((o) => o.id).join(", ")} can't be undone`,
      );
    }

    if (this.cfg.mode === "watch") {
      return this.askYou(q, story, storyTitle, "running in watch mode");
    }

    // --- Ask the model -------------------------------------------------------
    const guess = await this.askModel(q);

    if (this.cfg.decide.shadow) {
      // Record what it would have done, then ask you anyway.
      const yours = await this.askYou(q, story, storyTitle, "shadow mode — model is watching, not deciding");
      this.ledger.write({
        type: "shadow",
        story,
        question: q.asks,
        wouldPick: guess?.pick ?? "(no answer)",
        sureness: guess?.sureness ?? 0,
        actual: yours.pick,
      });
      return yours;
    }

    if (!guess) return this.askYou(q, story, storyTitle, "the model didn't give a usable answer");
    if (guess.ask_human_instead) {
      return this.askYou(q, story, storyTitle, `the model passed: ${guess.because}`);
    }
    if (guess.sureness < this.cfg.decide.confidence) {
      return this.askYou(
        q, story, storyTitle,
        `the model was only ${pct(guess.sureness)} sure (needs ${pct(this.cfg.decide.confidence)})`,
      );
    }
    if (!q.options.some((o) => o.id === guess.pick)) {
      return this.askYou(q, story, storyTitle, "the model picked something that wasn't an option");
    }

    const d: Decided = { pick: guess.pick, by: "model", sureness: guess.sureness, because: guess.because };
    this.record(story, q, d);
    return d;
  }

  // ---------------------------------------------------------------------------

  private async askModel(q: Question) {
    const system = [
      "You pick between options in an automated development run.",
      "You are not writing code. Just choose.",
      "",
      "Passing is a correct answer. If the rules below don't clearly settle it,",
      "or choosing well would need code you haven't been shown, set",
      "ask_human_instead to true rather than guessing.",
      "",
      "Your sureness score is load-bearing: below the threshold a person gets",
      "woken up. Overstating it commits a decision they'd have made differently,",
      "and they won't find out until much later.",
    ].join("\n");

    const user = [
      "Rules you're working under:",
      `- Never decide about: ${this.cfg.decide.never.join(", ")}`,
      `- Always escalate anything touching: ${this.cfg.decide.always_ask.files.join(", ")}`,
      `- Small things you can settle: ${this.cfg.decide.fix_quietly.join(", ")}`,
      "",
      `Question: ${q.asks}`,
      "",
      "Options:",
      ...q.options.map((o) =>
        `  ${o.id}: ${o.label}\n     ${o.detail}\n     touches: ${o.touches.join(", ") || "nothing"} · undoable: ${o.undoable}`),
      "",
      q.agent_suggests
        ? `The agent suggested "${q.agent_suggests}" and was ${pct(q.agent_sureness)} sure. Weigh that, don't follow it.`
        : "",
      "",
      q.context ? `Context: ${q.context}` : "",
      "",
      'Reply with only: {"pick":"<id>","sureness":0.0,"because":"<one sentence>","ask_human_instead":false}',
    ].filter(Boolean).join("\n");

    try {
      return await this.azure.askJson(
        { deployment: this.cfg.azure.deployments.decider, system, user, temperature: 0, maxTokens: 500 },
        ModelAnswer,
      );
    } catch {
      return null;
    }
  }

  private async askYou(q: Question, story: string, storyTitle: string, why: string): Promise<Decided> {
    const summary = await summarizeForHuman({
      story, storyTitle, why, question: q,
      azure: this.azure, cfg: this.cfg, ledger: this.ledger,
    });

    this.ledger.write({ type: "escalated", story, why, summary });

    if (this.cfg.mode === "solo") {
      throw new NeedsYou(`${why} — and you said not to ask`, q, summary);
    }
    if (this.left <= 0) {
      throw new NeedsYou(`${why} — but I've used all my interruptions`, q, summary);
    }
    if (!process.stdin.isTTY && process.env.HARNESS_APP_INPUT !== "1") {
      throw new NeedsYou(`${why} — and there's nobody at the terminal`, q, summary);
    }

    this.left--;
    this.ledger.write({ type: "decision_requested", story, requestId: randomUUID(), question: q, why, summary });

    console.log("\n" + "─".repeat(72));
    console.log(`Need you on this one — ${why}`);
    console.log(`${story}: ${storyTitle}\n`);
    console.log(summary + "\n");
    console.log("Options:");
    for (const o of q.options) {
      console.log(`  ${o.id}  ${o.label}`);
      if (o.detail) console.log(`      ${o.detail}`);
      if (o.touches.length) console.log(`      touches: ${o.touches.join(", ")}`);
      if (!o.undoable) console.log(`      ⚠ can't be undone`);
    }
    console.log(`\nInterruptions left after this: ${this.left}`);
    console.log("─".repeat(72));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ids = q.options.map((o) => o.id);
    let pick = "";
    while (!ids.includes(pick)) {
      pick = (await rl.question(`Pick [${ids.join(" / ")}] or "stop": `)).trim();
      if (pick === "stop") { rl.close(); throw new NeedsYou("you stopped the run", q, summary); }
    }
    rl.close();

    const d: Decided = { pick, by: "human", sureness: null, because: why };
    this.record(story, q, d);
    return d;
  }

  private record(story: string, q: Question, d: Decided) {
    this.ledger.write({
      type: "answered",
      story,
      question: q.asks,
      pick: d.pick,
      by: d.by,
      sureness: d.sureness,
      because: d.because,
    });
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

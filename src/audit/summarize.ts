import type { Azure } from "../llm/azure.js";
import type { Config } from "../config.js";
import type { Ledger } from "./ledger.js";

/**
 * When the harness stops and asks you, it shouldn't make you read a log.
 *
 * This turns the run so far into a few paragraphs: what's being asked, how it
 * got here, what it already tried, and what it would do. Written to be read
 * on a phone at 7am by someone who wasn't watching.
 */
export async function summarizeForHuman(opts: {
  story: string;
  storyTitle: string;
  why: string;
  question?: { asks: string; options: { id: string; label: string; detail: string }[] };
  azure: Azure;
  cfg: Config;
  ledger: Ledger;
}): Promise<string> {
  const history = opts.ledger.recentFor(opts.story);

  const system = [
    "You write short briefings for someone who stepped away from an automated",
    "development run and has come back to a question.",
    "",
    "They have not been watching. They don't want a log. They want to know what",
    "is being asked, enough background to answer it, and what has already been",
    "tried.",
    "",
    "Be plain and brief. No headings beyond the three asked for. Don't",
    "editorialise, don't pad, and don't recommend an option — they are deciding,",
    "not you.",
  ].join("\n");

  const user = [
    `Story: ${opts.story} — ${opts.storyTitle}`,
    `Stopped because: ${opts.why}`,
    "",
    opts.question ? `The question: ${opts.question.asks}` : "",
    opts.question ? "Options:" : "",
    ...(opts.question?.options ?? []).map((o) => `  ${o.id}: ${o.label} — ${o.detail}`),
    "",
    "What happened, most recent last:",
    ...history.map((h) => `  ${h}`),
    "",
    "---",
    "",
    "Write at most 200 words, in three short paragraphs:",
    "1. What's being asked, in plain terms.",
    "2. How it got here — what was built, what checks ran, what they found.",
    "3. What's already been tried, so they don't suggest it again.",
  ].filter(Boolean).join("\n");

  try {
    return await opts.azure.ask({
      deployment: opts.cfg.azure.deployments.summarizer,
      system,
      user,
      temperature: 0.2,
      maxTokens: 600,
    });
  } catch (e) {
    // The summary is a convenience. If Azure is down, the escalation still
    // has to reach the human — just without the prose.
    return [
      `(Couldn't write a summary: ${(e as Error).message})`,
      "",
      "Raw history:",
      ...history.map((h) => `  ${h}`),
    ].join("\n");
  }
}

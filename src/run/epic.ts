import type { Config } from "../config.js";
import type { Azure } from "../llm/azure.js";
import type { Ledger } from "../audit/ledger.js";
import type { VSCode } from "../vscode/types.js";
import type { Decider } from "../decide/engine.js";
import { NeedsYou } from "../decide/engine.js";
import { findConfiguredStories, isDone, type Story } from "../bmad/stories.js";
import { creationSelection } from "../bmad/preparation.js";
import { runStory, type Result } from "./story.js";
import { StubSession } from "../vscode/stub.js";
import { AttachedSession } from "../vscode/attach.js";

/**
 * A whole epic, preparing missing story files before implementation.
 */

export type EpicOutcome = "finished" | "finished-with-gaps" | "stopped";

export async function runEpic(
  epicId: string,
  ctx: {
    cfg: Config; azure: Azure; ledger: Ledger; vscode: VSCode; decider: Decider;
    prepareStory?: (story: Story) => Promise<VSCode>;
    clock?: Clock;
    excludeStories?: ReadonlySet<string>;
    onlyStory?: string;
  },
): Promise<{ outcome: EpicOutcome; summary: string }> {
  const { cfg, azure, ledger, decider } = ctx;
  const clock = ctx.clock ?? new Clock(cfg);

  const all = findConfiguredStories(cfg, epicId);
  if (ctx.onlyStory && !all.some((story) => story.id === ctx.onlyStory)) {
    throw new Error(`Story "${ctx.onlyStory}" was not found in ${epicId}.`);
  }
  if (all.length === 0) {
    throw new Error(
      `No stories for "${epicId}" in ${cfg.repo}/${cfg.stories_dir}.\n` +
      `Check the story directory or enable story_creation with the epic plan. ` +
      `Story 10.3 matches "epic-10" or "10".`,
    );
  }

  const selected = ctx.onlyStory ? all.filter((story) => story.id === ctx.onlyStory) : all;
  const todo = selected.filter((s) => !ctx.excludeStories?.has(s.id) && !isDone(s, cfg.bmad.status_done));
  const already = selected.length - todo.length;

  console.log(`\n${epicId} — ${all.length} stor${all.length === 1 ? "y" : "ies"}`);
  if (already) console.log(`  ${already} already done, skipping`);
  for (const s of todo) console.log(`  ${s.id}  ${s.title}  [${s.status}]`);

  const results: Result[] = [];

  for (const story of todo) {
    let vscode = ctx.vscode;

    try {
      clock.check();
      if (ctx.prepareStory) vscode = await ctx.prepareStory(story);
      if (vscode instanceof StubSession) vscode.setStory(story.id);
      if (vscode instanceof AttachedSession) {
        const turns = [
          ...(story.planned ? [creationSelection(cfg)] : []),
          { agent: cfg.bmad.agents.develop, model: cfg.bmad.models.develop },
          { agent: cfg.bmad.agents.review, model: cfg.bmad.models.review },
          ...(cfg.phase2.enabled ? [{ agent: cfg.bmad.agents.test, model: cfg.bmad.models.test }] : []),
        ];
        await vscode.verifySelections(turns);
      }
      const result = await runStory(story, {
        cfg, azure, ledger, vscode, decider, allStories: all,
        spend: () => clock.tick(),
      });
      results.push(result);
      if (result.outcome === "stopped" || result.outcome === "failed") break;
    } catch (e) {
      if (e instanceof NeedsYou) {
        results.push({ story: story.id, outcome: "stopped", why: e.why, debt: [] });
        console.log(`\n  Stopping: ${e.why}`);
        if (e.summary) console.log(`\n${e.summary}\n`);
        break;
      }
      if (e instanceof OutOfTime) {
        results.push({ story: story.id, outcome: "stopped", why: e.message, debt: [] });
        console.log(`\n  Stopping: ${e.message}`);
        break;
      }
      throw e;
    } finally {
      if (ctx.prepareStory && vscode !== ctx.vscode) await vscode.detach();
    }
  }

  // ---- how did it go? -------------------------------------------------------
  const done = results.filter((r) => r.outcome === "done");
  const withDebt = results.filter((r) => r.outcome === "done-with-debt");
  const stuck = results.filter((r) => r.outcome === "stopped" || r.outcome === "failed");
  const allDebt = results.flatMap((r) => r.debt);

  const spend = Object.entries(azure.usage)
    .map(([d, u]) => `${d}: ${u.prompt + u.completion} tokens`)
    .join(", ");

  const summary = [
    `${done.length + withDebt.length} of ${todo.length} stories validated.`,
    withDebt.length ? `${withDebt.length} carried debt.` : "",
    stuck.length ? `${stuck.length} didn't finish:` : "",
    ...stuck.map((s) => `  - ${s.story}: ${s.why}`),
    allDebt.length ? `\nLeft behind:` : "",
    ...allDebt.map((d) => `  - ${d}`),
    `\nInterruptions left: ${decider.interruptionsLeft}`,
    `Agent turns: ${clock.turns}, ${clock.minutes} min`,
    spend ? `Harness thinking (Azure): ${spend}` : "",
  ].filter(Boolean).join("\n");

  const outcome: EpicOutcome =
    stuck.length === 0 && withDebt.length === 0 ? "finished"
    : stuck.length === 0 ? "finished-with-gaps"
    : "stopped";

  return { outcome, summary };
}

export class OutOfTime extends Error {}

/** Stops a stuck run from going all night. */
export class Clock {
  turns: number;
  private started: number;
  constructor(private cfg: Config, previous?: { started: number; turns: number }) {
    this.started = previous?.started ?? Date.now();
    this.turns = previous?.turns ?? 0;
  }

  get minutes() { return Math.round((Date.now() - this.started) / 60_000); }

  check() {
    if (this.turns > this.cfg.limits.max_agent_turns) {
      throw new OutOfTime(`used ${this.turns} agent turns, cap is ${this.cfg.limits.max_agent_turns}`);
    }
    if (Date.now() - this.started >= this.cfg.limits.max_minutes * 60_000) {
      throw new OutOfTime(`running ${this.minutes} minutes, cap is ${this.cfg.limits.max_minutes}`);
    }
  }

  tick() {
    this.check();
    if (this.turns >= this.cfg.limits.max_agent_turns) {
      throw new OutOfTime(`used ${this.turns} agent turns, cap is ${this.cfg.limits.max_agent_turns}`);
    }
    this.turns++;
  }
}

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Config } from "../config.js";
import type { Azure } from "../llm/azure.js";
import type { Ledger } from "../audit/ledger.js";
import type { Reply, VSCode } from "../vscode/types.js";
import { Decider, NeedsYou, Question } from "../decide/engine.js";
import { type Story, refresh, isDone, findPlannedStories } from "../bmad/stories.js";
import { snapshotWorktree, collect, type WorktreeSnapshot } from "../validate/diff.js";
import { runPhase1, phase1Feedback } from "../validate/phase1.js";
import { archivePreviousReview, archivePreviousTest, readFreshOutput, readReview } from "../validate/review.js";
import { checkPhase2, phase2Feedback, TestRun } from "../validate/phase2.js";
import { summarizeForHuman } from "../audit/summarize.js";
import { saveBaseline } from "./baseline.js";
import { creationPrompt, creationSelection, planHash, plannedStory, readPreparedStory } from "../bmad/preparation.js";

/**
 * One story, start to finish.
 *
 *   develop → review → (fix → review)* → phase 1 → phase 2
 *
 * Phase 1 is the gate that matters most and runs first, because it's cheap.
 * There's no point deploying and testing code that doesn't implement the
 * story — that just turns a clear failure into a confusing one.
 */

const QUESTION_FILE = ".harness/question.json";

export type Outcome = "done" | "done-with-debt" | "stopped" | "failed";
export type Result = { story: string; outcome: Outcome; why: string; debt: string[] };

export type Ctx = {
  cfg: Config;
  allStories: Story[];
  azure: Azure;
  ledger: Ledger;
  vscode: VSCode;
  decider: Decider;
  spend: () => void;
  recovery?: {
    baseline: WorktreeSnapshot;
    stage: string;
    agent: string;
    model: string;
    reply: Reply;
    priorFixes: number;
    alreadyReworked: boolean;
    alreadyRetested: boolean;
  };
};

export async function runStory(story: Story, ctx: Ctx): Promise<Result> {
  const { cfg, azure, ledger, vscode, decider, spend, allStories, recovery } = ctx;
  const debt: string[] = [];
  let recoveryConsumed = false;

  ledger.write({
    type: "story_started",
    story: story.id,
    title: story.title,
    criteria: story.criteria.length,
  });

  console.log(`\n▸ ${story.id}  ${story.title}`);
  console.log(`    ${story.criteria.length} acceptance criteria · status ${story.status}`);

  // The baseline for Phase 1. Taken before the dev agent touches anything, so
  // the diff is real regardless of how the agent commits.
  const baseline = recovery?.baseline ?? snapshotWorktree(cfg.repo, { ignore: cfg.phase1.ignore });
  if (!recovery) {
    const baselineFile = `baseline-${createHash("sha256").update(story.file).digest("hex")}.json.gz`;
    saveBaseline(path.join(ledger.dir, baselineFile), baseline);
    ledger.write({ type: "story_baseline", story: story.id, file: baselineFile, ignore: cfg.phase1.ignore });
  }

  try {
    if (cfg.story_creation.enabled && !story.planned && !recovery) {
      const source = findPlannedStories(cfg).find((candidate) => candidate.id === story.id);
      if (source) readPreparedStory(cfg, { ...source, file: story.file }, ["Ready", "ready-for-dev", "Ready for Development", "Approved"]);
    }
    if (story.planned || recovery?.stage === "create") {
      if (recovery && recovery.stage !== "create") {
        throw new Error("The prepared story is missing; restore it before continuing the recorded implementation turn.");
      }
      const source = plannedStory(cfg, story.id);
      if (source.file !== story.file) throw new Error("The planned story output path changed; inspect it before continuing.");
      if (!recovery && fs.existsSync(source.file)) {
        throw new Error(`Story output already exists but is not a valid prepared story: ${source.file}. Inspect it rather than overwriting it.`);
      }
      const sourceHash = planHash(source);
      if (recovery) {
        const recorded = ledger.read().find((event) => event.type === "story_planned" && event.story === story.id);
        if (!recorded || recorded.type !== "story_planned" || recorded.sourceHash !== sourceHash) {
          throw new Error("The original story plan is missing or changed; automatic creation recovery is unsafe.");
        }
      } else {
        ledger.write({ type: "story_planned", story: story.id, sourceHash });
      }
      await stage("create", { ...creationSelection(cfg), say: creationPrompt(cfg, source) });
      story = readPreparedStory(cfg, source);
      const index = allStories.findIndex((candidate) => candidate.id === story.id);
      if (index >= 0) allStories[index] = story;
      ledger.write({ type: "note", story: story.id, text: `Prepared ${story.file}; acceptance criteria preserved. Beginning implementation.` });
    }
    if (recovery && (recovery.stage === "test" || recovery.stage === "retest") && !cfg.phase2.enabled) {
      throw new Error("Phase 2 is disabled; the recovered test stage requires manual inspection.");
    }
    // ---- develop -----------------------------------------------------------
    if (!recovery || recovery.stage === "develop" || recovery.stage === "create") {
      await stage("develop", {
        agent: cfg.bmad.agents.develop,
        model: cfg.bmad.models.develop,
        say:
          `Implement story ${story.id} (${story.title}). It's already specified in ` +
          `${story.file} — read it and build it. Don't redesign it, don't expand ` +
          `the scope.\n\n` +
          `When you're done, update the story's ${cfg.bmad.status_field} field as ` +
          `BMAD normally does.`,
      });
    } else if (recovery.stage === "fix" || recovery.stage === "rework" || recovery.stage === "retest") {
      await stage(recovery.stage, { agent: recovery.agent, model: recovery.model, say: "" });
    } else if (recovery.stage !== "review" && recovery.stage !== "test") {
      throw new Error(`Automatic continuation from stage "${recovery.stage}" is not supported; inspect the recovered run.`);
    }

    // ---- review, and fix what comes back ------------------------------------
    if (recovery?.stage !== "test") {
      for (let round = recovery?.priorFixes ?? 0; ; round++) {
        if (!(recovery && !recoveryConsumed && recovery.stage === "review")) preserveReview();
        const reply = await stage("review", {
          agent: cfg.bmad.agents.review,
          model: cfg.bmad.models.review,   // deliberately a different model
          say:
            `Review the work on story ${story.id}. You didn't write this — be hard ` +
            `on it.\n\n` +
            `Check it against the acceptance criteria in ${story.file}.\n\n` +
            `Watch especially for tests that don't prove anything: one that checks ` +
            `something is absent without ever trying to fetch it, or one that can't ` +
            `run in this environment.\n\n` +
            `Write your findings to .harness/review.json as a JSON array of ` +
            `{id, severity, kind, file, what, suggested_fix, is_proof_gap}. ` +
            `An empty array means it's clean. Don't fix anything yourself.`,
        });

        const findings = readReview(vscode);
        ledger.write({ type: "review_findings", story: story.id, findings });
        const sorted = decider.sortFindings(findings);
        console.log(`    review: ${sorted.reason}`);

        if (sorted.ask.length === 0 && sorted.quiet.length === 0) break;

        if (sorted.ask.length > 0) {
          const d = await decider.answer({
            kind: "review-findings",
            asks: `The review raised ${sorted.ask.length} thing(s) I'm not allowed to fix on my own. What now?`,
            options: [
              {
                id: "fix",
                label: "Fix them now",
                detail: sorted.ask.map((f) => `${f.severity} · ${f.file}: ${f.what}`).join(" | ").slice(0, 580),
                touches: sorted.ask.map((f) => f.file),
                undoable: true,
              },
              { id: "carry-on", label: "Note as debt and move on", detail: "They go in the report.", touches: [], undoable: true },
              { id: "stop", label: "Stop here", detail: "Hand the story back to me.", touches: [], undoable: true },
            ],
            agent_suggests: sorted.ask.some((f) => f.is_proof_gap) ? "fix" : "carry-on",
            agent_sureness: 0.5,
            context: reply.text.slice(0, 1500),
          }, story.id, story.title);

          if (d.pick === "stop") return finish("stopped", "you asked me to stop");
          if (d.pick === "carry-on") {
            debt.push(...sorted.ask.map((f) => `${f.file}: ${f.what}`));
            break;
          }
        }

        if (round >= cfg.limits.fix_attempts) {
          debt.push(...findings.map((f) => `${f.file}: ${f.what}`));
          console.log(`    out of fix attempts — leftovers noted as debt`);
          break;
        }

        const toFix = [...sorted.quiet, ...sorted.ask];
        await stage("fix", {
          agent: cfg.bmad.agents.develop,
          model: cfg.bmad.models.develop,
          say:
            `Fix these review findings, and nothing else:\n` +
            toFix.map((f) => `- ${f.file}: ${f.what} → ${f.suggested_fix}`).join("\n") +
            `\n\nDon't touch: ${cfg.decide.never_touch.join(", ")}\n` +
            `No opportunistic tidying while you're in there.`,
        });
      }
    }

    // ---- Phase 1: does the code match the story? ----------------------------
    console.log(`    phase 1 — reading the diff blind`);
    const changes = collect(cfg.repo, baseline, {
      ignore: cfg.phase1.ignore,
      maxChars: cfg.phase1.max_diff_chars,
    });
    console.log(`      ${changes.files.length} file(s), +${changes.totalAdded}/-${changes.totalRemoved}`);

    let p1 = await runPhase1(story, changes, azure, cfg, { allStories, secondPass: recovery?.alreadyReworked });
    recordPhase1(ledger, story.id, p1, "");

    if (p1.outcome === "escalate") {
      const summary = await summarizeForHuman({
        story: story.id, storyTitle: story.title,
        why: "Phase 1 found something that needs your eye",
        azure, cfg, ledger,
      });
      throw new NeedsYou(p1.reasons[0] ?? "phase 1 escalation", {
        kind: "phase1-review",
        asks: "Phase 1 turned up something I shouldn't decide. How do you want to handle it?",
        options: [
          { id: "accept", label: "Accept and carry on", detail: "Treat the story as matching.", touches: [], undoable: true },
          { id: "rework", label: "Send it back", detail: "Give the findings to the dev agent.", touches: [], undoable: true },
          { id: "stop", label: "Stop the run", detail: "", touches: [], undoable: true },
        ],
        agent_suggests: "", agent_sureness: 0,
        context: p1.reasons.join("\n"),
      }, summary);
    }

    if (p1.outcome === "fail") {
      console.log(`    phase 1 failed:`);
      for (const r of p1.reasons) console.log(`      · ${r}`);

      if (recovery?.alreadyReworked || recovery?.stage === "test") {
        return finish("failed", `phase 1: ${p1.reasons[0] ?? "the code doesn't match the story"}`);
      }

      // One go at closing the gap. Not a loop — if it can't fix this when told
      // exactly what's missing, another round won't help.
      await stage("rework", {
        agent: cfg.bmad.agents.develop,
        model: cfg.bmad.models.develop,
        say: phase1Feedback(p1, story),
      });

      const after = collect(cfg.repo, baseline, {
        ignore: cfg.phase1.ignore,
        maxChars: cfg.phase1.max_diff_chars,
      });
      // Marked as a second pass: we just told the agent which criteria were
      // missing, so this reading is less independent than the first.
      p1 = await runPhase1(story, after, azure, cfg, { allStories, secondPass: true });
      recordPhase1(ledger, story.id, p1, "-retry");

      if (p1.outcome !== "pass") {
        return finish("failed", `phase 1: ${p1.reasons[0] ?? "the code doesn't match the story"}`);
      }
    }

    if (p1.outcome === "pass") console.log(`    phase 1 ✓`);

    // ---- Phase 2: did it actually work? -------------------------------------
    if (cfg.phase2.enabled) {
      const missing = cfg.phase2.needs.filter((k) => !process.env[k]);

      if (recovery && missing.length) {
        return finish("stopped", `can't recover tests — missing ${missing.join(", ")}; inspect any previous CI run`);
      }

      if (missing.length && cfg.phase2.when_missing === "stop") {
        return finish("stopped", `can't test — missing ${missing.join(", ")}`);
      }

      let run: TestRun | null = null;
      if (missing.length) {
        console.log(`    phase 2 — needs ${missing.join(", ")}, dispatching to CI`);
        run = await dispatchCi(story.id, cfg);
      } else {
        if (!(recovery && !recoveryConsumed && recovery.stage === "test")) preserveTest();
        await stage("test", {
          agent: cfg.bmad.agents.test,
          model: cfg.bmad.models.test,
          say:
            `Run the end-to-end tests for story ${story.id} against the real app.\n\n` +
            `Write .harness/test.json: {story_id, ran_where, against, covers, cases}.\n` +
            `- \`covers\` maps each test name to the criterion ids it proves.\n` +
            `- If a test skipped, say so and why. Don't report it as a pass.\n` +
            `- For any test about something being blocked, set attempted: true only ` +
            `if it really signed in as the wrong user and tried.`,
        });
        run = readTestRun(vscode, story.id);
      }

      const p2 = checkPhase2(story, run, cfg);
      ledger.write({ type: "phase2", story: story.id, outcome: p2.outcome, reasons: p2.reasons });
      debt.push(...p2.debt);

      if (p2.outcome === "fail") {
        console.log(`    phase 2 failed:`);
        for (const r of p2.reasons) console.log(`      · ${r}`);

        if (recovery?.alreadyRetested) {
          return finish("failed", `phase 2: ${p2.reasons[0] ?? "tests don't prove it works"}`);
        }

        await stage("retest", {
          agent: cfg.bmad.agents.develop,
          model: cfg.bmad.models.develop,
          say: phase2Feedback(p2, story),
        });
        preserveTest();
        await stage("test", {
          agent: cfg.bmad.agents.test,
          model: cfg.bmad.models.test,
          say: `Run the tests again for ${story.id} and rewrite .harness/test.json.`,
        });

        const retry = checkPhase2(story, readTestRun(vscode, story.id), cfg);
        ledger.write({ type: "phase2", story: story.id, outcome: retry.outcome, reasons: retry.reasons });
        if (retry.outcome !== "pass") {
          return finish("failed", `phase 2: ${retry.reasons[0] ?? "tests don't prove it works"}`);
        }
      }

      if (p2.outcome === "pass") console.log(`    phase 2 ✓`);
    }

    // ---- is BMAD itself happy? ----------------------------------------------
    const latest = refresh(story);
    if (!isDone(latest, cfg.bmad.status_done)) {
      ledger.write({
        type: "note",
        story: story.id,
        text: `The configured validation stages completed, but the story status is "${latest.status}", not one of ` +
              `${cfg.bmad.status_done.join("/")}. The dev agent may not have updated it.`,
      });
    }

    return finish(debt.length ? "done-with-debt" : "done", p1.reasons[0] ?? "validated");

  } catch (e) {
    if (e instanceof NeedsYou) {
      ledger.write({ type: "escalated", story: story.id, why: e.why, summary: e.summary });
      return finish("stopped", e.why);
    }
    throw e;
  }

  // ---------------------------------------------------------------------------

  function finish(outcome: Outcome, why: string): Result {
    ledger.write({ type: "story_finished", story: story.id, outcome, why });
    console.log(`    → ${outcome}: ${why}`);
    return { story: story.id, outcome, why, debt };
  }

  function preserveReview(): void {
    const archived = archivePreviousReview(cfg.repo);
    if (archived) {
      ledger.write({ type: "note", story: story.id, text: `Previous review preserved at ${archived}.` });
    }
  }

  function preserveTest(): void {
    const archived = archivePreviousTest(cfg.repo);
    if (archived) {
      ledger.write({ type: "note", story: story.id, text: `Previous test output preserved at ${archived}.` });
    }
  }

  /**
   * One turn with a BMAD agent. Switches agent and model, sends, and deals
   * with the agent stopping to ask something.
   */
  async function stage(name: string, turn: { agent: string; model: string; say: string }) {
    const started = Date.now();
    console.log(`    ${name} · ${turn.agent} · ${turn.model}`);

    let reply: Reply;
    if (recovery && !recoveryConsumed && name === recovery.stage) {
      if (turn.agent !== recovery.agent || turn.model !== recovery.model) {
        throw new Error("The recovered turn does not match the configured agent and model.");
      }
      recoveryConsumed = true;
      reply = recovery.reply;
      ledger.write({ type: "note", story: story.id, text: `Using recovered ${name} turn without resending it.` });
    } else {
      reply = await sendTurn(turn);
    }

    for (let asked = 0; asked < cfg.limits.questions_per_stage; asked++) {
      const viaFile = vscode.readFile(QUESTION_FILE) !== null;
      const q = await pickUpQuestion(vscode, reply.text, azure, cfg);
      if (!q) break;

      if (asked === cfg.limits.questions_per_stage - 1) {
        const summary = await summarizeForHuman({
          story: story.id, storyTitle: story.title,
          why: `${turn.agent} keeps asking during ${name}`,
          question: q, azure, cfg, ledger,
        });
        throw new NeedsYou(
          `${turn.agent} asked ${cfg.limits.questions_per_stage} times during ${name}. ` +
          `It's stuck on something answers aren't fixing.`,
          q, summary,
        );
      }

      ledger.write({
        type: "agent_asked",
        story: story.id,
        question: q.asks,
        options: q.options.map((o) => o.id),
        viaProse: !viaFile,
      });

      if (!viaFile) {
        console.log(`      (asked in prose — its .agent.md needs tightening)`);
        ledger.write({
          type: "note",
          story: story.id,
          text: `${turn.agent} asked in prose during ${name} instead of writing ${QUESTION_FILE}.`,
        });
      }

      const answer = await decider.answer(q, story.id, story.title);
      const chosen = q.options.find((o) => o.id === answer.pick);
      console.log(`      asked: ${short(q.asks)}`);
      console.log(`      → ${answer.pick} (${answer.by})`);

      if (name === "review") preserveReview();
      if (name === "test") preserveTest();
      vscode.removeFile(QUESTION_FILE);

      reply = await sendTurn({
        agent: turn.agent,
        model: turn.model,
        say:
          `Answer to your question: go with "${answer.pick}"` +
          (chosen ? ` — ${chosen.label}. ${chosen.detail}` : "") +
          `\n\nWhy: ${answer.because}\n\n` +
          `Carry on from where you stopped. Don't ask about this again.` +
          (name === "review" ? `\n\nWrite a fresh .harness/review.json when the review is complete.` : "") +
          (name === "test" ? `\n\nWrite a fresh .harness/test.json when testing is complete.` : ""),
      });
    }

    ledger.write({
      type: "turn",
      story: story.id,
      stage: name,
      agent: turn.agent,
      model: turn.model,
      seconds: Math.round((Date.now() - started) / 1000),
    });

    return reply;

    async function sendTurn(next: { agent: string; model: string; say: string }) {
      spend();
      const turnId = randomUUID();
      ledger.write({ type: "turn_started", story: story.id, stage: name, turnId, agent: next.agent, model: next.model });
      const result = await vscode.send({ ...next, id: turnId });
      ledger.write({ type: "turn_result", story: story.id, stage: name, turnId });
      return result;
    }
  }
}

// =============================================================================

/**
 * Did the agent ask something?
 *
 * Two ways. The proper way is writing the question file, which is what its
 * instructions say. The other is asking in prose and stopping — which happens
 * because models lean hard that way whatever their instructions say.
 */
async function pickUpQuestion(
  vscode: VSCode,
  replyText: string,
  azure: Azure,
  cfg: Config,
): Promise<Question | null> {
  const raw = vscode.readFile(QUESTION_FILE);
  if (raw !== null) {
    try {
      return Question.parse(JSON.parse(raw));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The agent's ${QUESTION_FILE} is invalid: ${reason}`);
    }
  }

  if (!replyText || replyText.trim().length < 30) return null;

  // Only worth a model call if the reply looks like a question.
  if (!/\?|choose|which|option|reply with|let me know|how.*proceed/i.test(replyText)) return null;

  try {
    const out = await azure.ask({
      deployment: cfg.azure.deployments.decider,
      system: "You work out whether an agent stopped to ask something, and what the choices were.",
      user: [
        "An agent stopped partway through without finishing. Was it asking the",
        "operator something? If so, what were the options?",
        "",
        "What it wrote:",
        "---",
        replyText.slice(0, 4000),
        "---",
        "",
        "If it was asking, reply:",
        `{"asking":true,"kind":"<short label>","asks":"<the question>","options":[{"id":"","label":"","detail":"","touches":[],"undoable":true}],"agent_suggests":"","agent_sureness":0.5,"context":""}`,
        "",
        'If it just failed or rambled, reply: {"asking":false}',
        "",
        "Only JSON.",
      ].join("\n"),
      json: true,
      temperature: 0,
      maxTokens: 1200,
    });

    const text = out.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? out;
    const parsed = JSON.parse(text.trim());
    if (!parsed.asking || !Array.isArray(parsed.options) || parsed.options.length < 2) return null;
    return Question.parse(parsed);
  } catch {
    return null;
  }
}

function readTestRun(vscode: VSCode, storyId: string): TestRun {
  const raw = readFreshOutput(vscode, "test");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("The fresh .harness/test.json is not valid JSON."); }
  const parsed = TestRun.safeParse(value);
  if (!parsed.success) throw new Error("The fresh .harness/test.json has invalid test results.");
  if (parsed.data.story_id !== storyId) throw new Error("The fresh test results belong to a different story.");
  return parsed.data;
}

async function dispatchCi(storyId: string, cfg: Config): Promise<TestRun | null> {
  try {
    execFileSync("gh", ["workflow", "run", cfg.phase2.ci_workflow, "-f", `story=${storyId}`], {
      stdio: "inherit",
      cwd: cfg.repo,
    });
    // Left to wire up: poll `gh run list`, download the results artifact, parse.
    // Until then this returns null, which Phase 2 treats as "nothing proven" —
    // the safe direction to fail.
    return null;
  } catch {
    return null;
  }
}

/**
 * Writes the Phase 1 outcome AND what the guardrails observed.
 *
 * The integrity record goes in whether or not anything was wrong. A guardrail
 * you only hear from when it fires is one you can't tell apart from a
 * guardrail that stopped running.
 */
function recordPhase1(ledger: Ledger, storyId: string, p1: any, suffix: string) {
  ledger.write({
    type: "phase1",
    story: storyId,
    outcome: p1.outcome,
    reasons: p1.reasons,
    unmet: p1.unmet,
    integrity: p1.integrity ?? null,
  });
  if (p1.reconstruction) ledger.keep(`${storyId}-reconstruction${suffix}.json`, p1.reconstruction);
  if (p1.comparison) ledger.keep(`${storyId}-comparison${suffix}.json`, p1.comparison);
  if (p1.integrity) ledger.keep(`${storyId}-blindness${suffix}.json`, p1.integrity);
}

const short = (s: string, max = 90) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

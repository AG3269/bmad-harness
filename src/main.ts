import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "./config.js";
import { Azure } from "./llm/azure.js";
import { fakeAzure } from "./llm/fake.js";
import { Ledger } from "./audit/ledger.js";
import { Decider } from "./decide/engine.js";
import { Clock, runEpic } from "./run/epic.js";
import { runStory } from "./run/story.js";
import { acquireRepoLock, withRecoveryLock } from "./run/lock.js";
import { askRecoveryAgent, recoverRecordedTurn, withRecoveryAudit, RECOVERY_DECISION_REQUIRED, assertRecoveryAssessmentFingerprint } from "./run/recover.js";
import { assertRecoveryConfig, recoveryConfigFingerprint } from "./run/config-fingerprint.js";
import { StubSession } from "./vscode/stub.js";
import { AttachedSession } from "./vscode/attach.js";
import { discoverSessions, selectSession } from "./vscode/sessions.js";
import { StoryBindings } from "./vscode/bindings.js";
import { createApprovalHandler } from "./vscode/approval.js";
import { findConfiguredStories, isDone, type Story } from "./bmad/stories.js";
import { creationSelection } from "./bmad/preparation.js";
import type { VSCode } from "./vscode/types.js";

/**
 *   harness epic-10
 *   harness epic-10 --config other.yaml
 *   harness --stories            list what it found, change nothing
 *   harness --select-session     choose a session without starting a run
 */

async function main() {
  const args = process.argv.slice(2);
  const configFile = flag(args, "--config") ?? "harness.config.yaml";
  const cfg = loadConfig(configFile, {
    requireAzureKey: !args.includes("--stories") && !args.includes("--select-session") && !args.includes("--session-status") &&
      (!args.includes("--recover-turn") || args.includes("--continue")),
  });

  // Just show what's there.
  if (args.includes("--stories")) {
    const stories = findConfiguredStories(cfg);
    const sources = cfg.story_creation.enabled
      ? `${cfg.stories_dir} and ${cfg.story_creation.epics_file}` : cfg.stories_dir;
    console.log(`\n${stories.length} stor${stories.length === 1 ? "y" : "ies"} from ${sources}\n`);
    for (const s of stories) {
      console.log(`  ${s.id.padEnd(8)} ${s.status.padEnd(12)} ${s.title}`);
      for (const c of s.criteria) console.log(`           ${c.id}: ${c.text.slice(0, 70)}`);
    }
    return;
  }

  const requestedSession = flag(args, "--session");
  const recoverRun = flag(args, "--recover-turn");
  if (recoverRun) {
    if (args.includes("--accept-uncertainty") && !args.includes("--continue")) {
      throw new Error("--accept-uncertainty requires --continue.");
    }
    if (args.includes("--assessment-fingerprint") && !args.includes("--accept-uncertainty")) {
      throw new Error("--assessment-fingerprint requires --accept-uncertainty.");
    }
    const storyId = flag(args, "--story");
    if (!storyId) throw new Error("Specify a story ID: --recover-turn <run-id> --story 1.1");
    const stories = findConfiguredStories(cfg).filter((story) => story.id === storyId);
    if (stories.length !== 1) throw new Error(`Story "${storyId}" was not found uniquely.`);
    const story = stories[0]!;
    let ledger = new Ledger(path.join(process.cwd(), "runs"), recoverRun, { resume: true });
    ledger.hide([...cfg.phase2.needs.map((key) => process.env[key]), process.env[cfg.azure.key_env]]);
    if (requestedSession) throw new Error("Turn recovery must use the story's original saved session, not --session.");
    const started = ledger.read().find((event) => event.type === "run_started");
    if (!started || started.type !== "run_started") throw new Error("The run does not have a valid start record.");
    if (args.includes("--continue")) {
      assertRecoveryConfig(cfg, process.env.HARNESS_FAKE_AZURE === "1", started.configFingerprint);
    }
    const releaseRepo = acquireRepoLock(path.join(path.dirname(path.resolve(configFile)), ".harness-state", "locks"), cfg.repo);
    try {
      await withRecoveryLock(ledger.dir, started.pid, async () => {
        ledger = new Ledger(path.join(process.cwd(), "runs"), recoverRun, { resume: true });
        ledger.hide([...cfg.phase2.needs.map((key) => process.env[key]), process.env[cfg.azure.key_env]]);
        await withRecoveryAudit(ledger, storyId, async () => {
        const bindings = new StoryBindings(cfg.repo, path.join(path.dirname(path.resolve(configFile)), ".harness-state", "sessions"));
        const session = await bindings.resolveExisting(story);
        const attached = new AttachedSession(cfg.repo, {
          session, allowActive: true, turnTimeoutMs: cfg.limits.turn_timeout_minutes * 60_000,
          onApproval: createApprovalHandler({ ...cfg, mode: "watch" }, ledger, storyId),
          onApprovalResolved: approvalLogger(ledger, storyId),
        });
        let resumed = false;
        try {
          await attached.attach();
          const result = await recoverRecordedTurn({ cfg, ledger, story, session: session.resource, driver: attached });
          console.log(`Recovered ${result.stage} turn ${result.turnId} without resending it.`);
          console.log(`Current diff: ${result.filesChanged} file(s). Recovered response: ${result.artifact}`);
          console.log(`Suggested next step: ${result.recommendation}`);
          const runStartedAt = Date.parse(started.at);
          if (!Number.isFinite(runStartedAt)) throw new Error("The original run has an invalid start time.");
          const clock = new Clock(cfg, {
            started: runStartedAt,
            turns: ledger.read().filter((event) => event.type === "turn_started").length,
          });
          if (args.includes("--continue")) {
            if (result.unsafeReason) throw new Error(result.unsafeReason);
            if (!["create", "develop", "review", "fix", "rework", "test", "retest"].includes(result.stage)) {
              throw new Error(`Automatic continuation from stage "${result.stage}" is not supported; inspect the recovered run.`);
            }
          }
          if (args.includes("--ask-agent") || args.includes("--continue")) {
            let assessment = result.assessment;
            if (!assessment) {
              clock.tick();
              assessment = await askRecoveryAgent({
                cfg, ledger, story, vscode: attached, previousStage: result.stage, originalTurnId: result.turnId,
              });
            }
            console.log(`Agent assessment: ${assessment.summary}`);
            console.log(`Agent suggested: ${assessment.next_step}`);
            for (const uncertainty of assessment.uncertainties) console.log(`  Uncertain: ${uncertainty}`);
            console.log("The agent assessment is advisory; it does not prove a validation passed.");
            const confirmedAssessment = flag(args, "--assessment-fingerprint");
            if (confirmedAssessment) assertRecoveryAssessmentFingerprint(assessment, confirmedAssessment);
            if (args.includes("--continue") &&
                (assessment.next_step === "human" || assessment.uncertainties.length ||
                 !compatibleRecoveryStep(result.stage, assessment.next_step)) &&
                !args.includes("--accept-uncertainty")) {
              throw new Error(RECOVERY_DECISION_REQUIRED);
            }
          }
          if (!args.includes("--continue")) {
            console.log("The story was not automatically continued. Add --continue to resume supported stages.");
            return;
          }
          const priorEvents = ledger.read();
          const azure = process.env.HARNESS_FAKE_AZURE === "1" ? fakeAzure(cfg.azure.deployments) : new Azure(cfg.azure);
          const decider = new Decider(cfg, ledger, azure, {
            interruptionsUsed: priorEvents.filter((event) => event.type === "answered" && event.by === "human").length,
          });
          const allStories = findConfiguredStories(cfg, started.epic)
            .filter((candidate) => !started.onlyStory || candidate.id === started.onlyStory);
          if (!allStories.some((candidate) => candidate.id === storyId && candidate.file === story.file)) {
            throw new Error("The story is no longer part of the original epic.");
          }
          await attached.verifySelections([
            ...(result.stage === "create" ? [creationSelection(cfg)] : []),
            { agent: cfg.bmad.agents.develop, model: cfg.bmad.models.develop },
            { agent: cfg.bmad.agents.review, model: cfg.bmad.models.review },
            ...(cfg.phase2.enabled ? [{ agent: cfg.bmad.agents.test, model: cfg.bmad.models.test }] : []),
          ]);
          attached.setApprovalHandler(createApprovalHandler(cfg, ledger, storyId));
          clock.check();
          ledger.write({ type: "run_resumed", story: storyId });
          resumed = true;
          const storyResult = await runStory(story, {
            cfg, azure, ledger, vscode: attached, decider, allStories, spend: () => clock.tick(), recovery: result,
          });
          let outcome = storyResult.outcome === "done" ? "finished"
            : storyResult.outcome === "done-with-debt" ? "finished-with-gaps" : "stopped";
          let summary = `Recovered story ${storyId}: ${storyResult.outcome} — ${storyResult.why}`;
          if ((storyResult.outcome === "done" || storyResult.outcome === "done-with-debt") &&
              allStories.some((candidate) => candidate.id !== storyId && !isDone(candidate, cfg.bmad.status_done))) {
            await attached.detach();
            const stub = new StubSession(cfg.repo);
            const rest = await runEpic(started.epic, {
              cfg, azure, ledger, vscode: stub, decider, clock, excludeStories: new Set([storyId]),
              prepareStory: async (nextStory: Story) => {
                const nextSession = await bindings.resolve(nextStory,
                  started.preferredSession ?? (process.env.HARNESS_APP_INPUT === "1" ? session.resource : undefined));
                const next = new AttachedSession(cfg.repo, {
                  session: nextSession,
                  turnTimeoutMs: cfg.limits.turn_timeout_minutes * 60_000,
                  onApproval: createApprovalHandler(cfg, ledger, nextStory.id),
                  onApprovalResolved: approvalLogger(ledger, nextStory.id),
                });
                await next.attach();
                ledger.write({ type: "story_session", story: nextStory.id, session: nextSession.resource });
                return next;
              },
            });
            if (rest.outcome === "stopped") outcome = "stopped";
            else if (rest.outcome === "finished-with-gaps") outcome = "finished-with-gaps";
            summary += `\n${rest.summary}`;
          }
          ledger.write({ type: "run_finished", outcome, summary });
          console.log(`\n${summary}\nReport: ${ledger.saveReport()}`);
          if (outcome === "stopped") process.exitCode = 2;
        } catch (error) {
          if (resumed) {
            const reason = error instanceof Error ? error.message : String(error);
            ledger.write({ type: "run_finished", outcome: "error", summary: reason });
            console.error(`Recovery stopped. Report: ${ledger.saveReport()}`);
          }
          throw error;
        } finally {
          await attached.detach();
        }
        });
      });
    } finally {
      releaseRepo();
    }
    return;
  }
  if (args.includes("--continue") || args.includes("--ask-agent") || args.includes("--accept-uncertainty") || args.includes("--assessment-fingerprint")) {
    throw new Error("--continue, --ask-agent and --accept-uncertainty require --recover-turn.");
  }
  if (args.includes("--session-status")) {
    const storyId = positional(args);
    if (!storyId) throw new Error("Specify a story ID: --session-status 1.1");
    const stories = findConfiguredStories(cfg).filter((story) => story.id === storyId);
    if (stories.length !== 1) throw new Error(`Story "${storyId}" was not found uniquely.`);
    const bindings = new StoryBindings(cfg.repo, path.join(path.dirname(path.resolve(configFile)), ".harness-state", "sessions"));
    const session = await bindings.resolve(stories[0]!, requestedSession);
    const attached = new AttachedSession(cfg.repo, { session, allowActive: true });
    try {
      await attached.attach();
      const state = await attached.inspect();
      console.log(JSON.stringify(state, null, 2));
    } finally {
      await attached.detach();
    }
    return;
  }
  if (args.includes("--select-session")) {
    const storyId = positional(args);
    let chosen;
    if (storyId) {
      const stories = findConfiguredStories(cfg).filter((story) => story.id === storyId);
      if (stories.length !== 1) throw new Error(`Story "${storyId}" was not found uniquely.`);
      const bindings = new StoryBindings(cfg.repo, path.join(path.dirname(path.resolve(configFile)), ".harness-state", "sessions"));
      chosen = await bindings.resolve(stories[0]!, requestedSession, true);
      console.log(`\nSession saved for story ${storyId}.`);
    } else {
      chosen = await selectSession(await discoverSessions(cfg.repo), {
        requested: requestedSession,
        allowPipedInput: true,
      });
    }
    console.log(`\nSelected session: ${chosen.resource}`);
    return;
  }

  const onlyStory = flag(args, "--story");
  if (onlyStory && !/^\d+\.\d+$/.test(onlyStory)) throw new Error("--story requires a story ID such as 1.2.");
  const epic = positional(args) ?? (onlyStory ? `epic-${onlyStory.split(".")[0]}` : undefined);
  if (!epic) {
    console.error("Which epic?  harness epic-10\n(or --stories to see what's there)");
    process.exit(1);
  }

  const releaseRepo = acquireRepoLock(path.join(path.dirname(path.resolve(configFile)), ".harness-state", "locks"), cfg.repo);
  try {
    const runId = `${epic}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const ledger = new Ledger(path.join(process.cwd(), "runs"), runId);
    ledger.hide([
      ...cfg.phase2.needs.map((k) => process.env[k]),
      process.env[cfg.azure.key_env],
    ]);

    // HARNESS_FAKE_AZURE=1 runs the whole thing offline — no endpoint, no spend.
    const dryAzure = process.env.HARNESS_FAKE_AZURE === "1";
    const azure = dryAzure ? fakeAzure(cfg.azure.deployments) : new Azure(cfg.azure);

    const vscode: VSCode = new StubSession(cfg.repo);
    const bindings = new StoryBindings(cfg.repo, path.join(path.dirname(path.resolve(configFile)), ".harness-state", "sessions"));

    console.log(`\n${epic}`);
    console.log(`  repo     ${cfg.repo}`);
    console.log(`  stories  ${cfg.stories_dir}`);
    console.log(`  mode     ${cfg.mode}${cfg.decide.shadow ? " · model watching, not deciding" : ""}`);
    console.log(`  driver   ${cfg.driver}`);
    console.log(`  azure    ${dryAzure ? "FAKE — dry run, nothing really checked" : `${cfg.azure.endpoint} (${cfg.azure.auth})`}`);
    console.log(`  log      ${ledger.dir}`);

    if (cfg.driver === "stub") await vscode.attach();
    console.log(`  session  ${cfg.driver === "attach" ? "selected per story" : vscode.describe}\n`);

    ledger.write({
      type: "run_started", epic, mode: cfg.mode, repo: fs.realpathSync.native(cfg.repo), pid: process.pid, onlyStory, preferredSession: requestedSession,
      session: cfg.driver === "attach" ? "selected per story" : vscode.describe,
      configFingerprint: recoveryConfigFingerprint(cfg, dryAzure),
    });

    const decider = new Decider(cfg, ledger, azure);

    try {
      const { outcome, summary } = await runEpic(epic, {
        cfg, azure, ledger, vscode, decider, onlyStory,
        prepareStory: cfg.driver === "attach" ? async (story) => {
          const session = await bindings.resolve(story, requestedSession);
          const attached = new AttachedSession(cfg.repo, {
            session,
            turnTimeoutMs: cfg.limits.turn_timeout_minutes * 60_000,
            onApproval: createApprovalHandler(cfg, ledger, story.id),
            onApprovalResolved: approvalLogger(ledger, story.id),
          });
          await attached.attach();
          console.log(`  session for ${story.id}: ${attached.describe} (${session.resource})`);
          ledger.write({ type: "story_session", story: story.id, session: session.resource });
          return attached;
        } : undefined,
      });
      ledger.write({ type: "run_finished", outcome, summary });

      console.log("\n" + "─".repeat(72));
      console.log(
        outcome === "finished" ? "Finished."
        : outcome === "finished-with-gaps" ? "Finished, with gaps."
        : "Stopped.",
      );
      console.log(summary);
      console.log("─".repeat(72));
      console.log(`\nReport: ${ledger.saveReport()}`);

      process.exitCode = outcome === "stopped" ? 2 : 0;
    } catch (e) {
      const why = (e as Error).message;
      ledger.write({ type: "run_finished", outcome: "error", summary: why });
      console.error(`\nSomething went wrong:\n  ${why}`);
      console.error(`\nWhat happened so far: ${ledger.saveReport()}`);
      process.exitCode = 1;
    } finally {
      await vscode.detach();
    }
  } finally {
    releaseRepo();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config" || arg === "--session" || arg === "--recover-turn" || arg === "--story" || arg === "--assessment-fingerprint") { i++; continue; }
    if (!arg.startsWith("--")) return arg;
  }
  return undefined;
}

function compatibleRecoveryStep(stage: string, next: string): boolean {
  if (stage === "create") return next === "develop";
  if (stage === "develop" || stage === "fix") return next === "review";
  if (stage === "rework") return next === "review" || next === "phase1";
  if (stage === "review") return next === "develop" || next === "review" || next === "phase1";
  if (stage === "test" || stage === "retest") return next === "test" || next === "review" || next === "phase1";
  return false;
}

function approvalLogger(ledger: Ledger, story: string): NonNullable<ConstructorParameters<typeof AttachedSession>[1]["onApprovalResolved"]> {
  return (decision) => {
    ledger.write({
      type: "note", story,
      text: `Host ${decision.approved ? "approved" : "denied"} ${decision.kind} ${decision.toolCallId} (${decision.source}).`,
    });
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

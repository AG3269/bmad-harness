import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Config } from "../config.js";
import { findPlannedStories, findStories, type Story } from "./stories.js";
import { resolveRepoFile } from "./paths.js";

export function creationSelection(cfg: Config): { agent: string; model: string } {
  return { agent: cfg.story_creation.agent, model: cfg.story_creation.model ?? cfg.bmad.models.develop };
}

export function plannedStory(cfg: Config, id: string): Story {
  if (!cfg.story_creation.enabled) throw new Error("Story creation is disabled; the creation stage cannot continue.");
  const found = findPlannedStories(cfg).filter((story) => story.id === id);
  if (found.length !== 1) throw new Error(`Story ${id} is not uniquely defined in the epic plan.`);
  return found[0]!;
}

export function planHash(story: Story): string {
  return createHash("sha256").update(story.fullText).digest("hex");
}

export function creationPrompt(cfg: Config, story: Story): string {
  return [
    `Prepare the standalone BMAD implementation story ${story.id}: ${story.title}. Do not implement it.`,
    `Read its source in ${resolveRepoFile(cfg.repo, cfg.story_creation.epics_file)}, linked requirements, approved architecture, and previous story implementation evidence.`,
    "Use the installed BMAD story-preparation workflow if available. Do not start a build workflow or wait at an agent menu.",
    `Write only this story to ${story.file}; do not overwrite existing stories or change the epic's scope.`,
    "Include a '# Story <id>: <title>' heading, '## Status', '## Story', '## Acceptance Criteria', implementation tasks, dependencies, and architecture references.",
    "Copy every acceptance criterion below in order as a numbered single-line item with its AC label. Preserve its complete wording; do not weaken or omit requirements.",
    ...story.criteria.map((criterion) => `${criterion.id}: ${criterion.text}`),
    "Set '## Status' to Ready only when requirements, dependencies, and required architecture approvals are resolved.",
    "Do not grant yourself architecture approval or infer that approval for an earlier story covers this one.",
    `Do not change protected files: ${cfg.decide.never_touch.join(", ")}.`,
    "If blocked, write .harness/question.json as your final action and stop. The asks field must be a single string of at most 800 characters; use context for supporting details (at most 2000 characters). Do not ask only in prose.",
    'Use {"kind":"...","asks":"The question","context":"Supporting details","options":[{"id":"a","label":"First option"},{"id":"b","label":"Second option"}]} with at least two distinct options.',
    "A blocked or incomplete story must not be marked Ready. Do not change application code or implement future stories.",
  ].join("\n\n");
}

export function readPreparedStory(cfg: Config, source: Story, allowedStatuses: readonly string[] = ["Ready"]): Story {
  const file = resolveRepoFile(cfg.repo, source.file);
  if (!fs.existsSync(file)) throw new Error(`Story creation did not produce ${source.file}.`);
  const stat = fs.lstatSync(source.file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The generated story must be a regular file, not a symbolic link.");
  const found = findStories(cfg.repo, cfg.stories_dir).filter((story) => story.id === source.id);
  if (found.length !== 1 || resolveRepoFile(cfg.repo, found[0]!.file) !== file) {
    throw new Error(`Story creation must produce exactly one story ${source.id} at ${source.file}.`);
  }
  const story = found[0]!;
  const normalizedStatus = story.status.toLowerCase().replace(/\.$/, "");
  if (!allowedStatuses.some((status) => status.toLowerCase() === normalizedStatus)) {
    throw new Error(`Prepared story ${story.id} is "${story.status}", not ${allowedStatuses.join("/")}; resolve its blockers before implementation.`);
  }
  const normalize = (text: string) => text.replace(/\*{1,2}|`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (story.criteria.length !== source.criteria.length ||
      story.criteria.some((criterion, index) => criterion.id !== source.criteria[index]!.id ||
        normalize(criterion.text) !== normalize(source.criteria[index]!.text))) {
    throw new Error(`Generated story ${story.id} must preserve all planned acceptance criteria in order without changing their wording.`);
  }
  return { ...story, file };
}

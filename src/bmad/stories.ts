import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.js";
import { resolveRepoFile } from "./paths.js";

/**
 * Reads the story files BMAD already wrote.
 *
 * Finds prepared stories and, optionally, missing stories in the epic plan.
 *
 * BMAD story files look roughly like:
 *
 *   # Story 10.3: Check-in photo
 *   ## Status
 *   Approved
 *   ## Story
 *   As a caregiver, I want ...
 *   ## Acceptance Criteria
 *   1. Caregivers can attach a photo to a check-in
 *   2. A caregiver in another family cannot retrieve that photo
 *
 * Headings vary between BMAD versions and between people, so the parsing is
 * deliberately forgiving — it matches on heading text rather than position.
 */

export type Story = {
  id: string;
  title: string;
  status: string;
  /** The "as a ... I want ..." statement, if there is one. */
  narrative: string;
  criteria: Criterion[];
  /** Everything, for handing to the comparer. */
  fullText: string;
  file: string;
  planned?: boolean;
};

export type Criterion = {
  /** AC1, AC2 … assigned by position if the file doesn't label them. */
  id: string;
  text: string;
};

export function findStories(repo: string, storiesDir: string, epicId?: string): Story[] {
  const dir = path.join(repo, storiesDir);
  const files = walk(dir).filter((f) => f.endsWith(".md"));

  const stories = files
    .map((f) => parseStory(f))
    .filter((s): s is Story => s !== null);

  const matching = epicId
    ? stories.filter((s) => belongsToEpic(s, epicId))
    : stories;

  // Sort by the numbers in the id so 10.2 comes before 10.10.
  return matching.sort((a, b) => compareIds(a.id, b.id));
}

export function findConfiguredStories(cfg: Config, epicId?: string): Story[] {
  const existing = findStories(cfg.repo, cfg.stories_dir, epicId);
  const byId = new Map<string, Story>();
  for (const story of existing) {
    if (byId.has(story.id)) throw new Error(`Duplicate implementation story ID: ${story.id}`);
    byId.set(story.id, cfg.story_creation.enabled
      ? { ...story, file: resolveRepoFile(cfg.repo, story.file) } : story);
  }
  if (!cfg.story_creation.enabled) return existing;
  const planned = findPlannedStories(cfg, epicId);
  if (epicId && planned.length === 0) throw new Error(`No planned stories for "${epicId}" in ${cfg.story_creation.epics_file}.`);
  for (const story of planned) {
    if (!byId.has(story.id)) {
      byId.set(story.id, story);
    }
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export function findPlannedStories(cfg: Config, epicId?: string): Story[] {
  const file = resolveRepoFile(cfg.repo, cfg.story_creation.epics_file);
  const text = fs.readFileSync(file, "utf8");
  const headings = [...text.matchAll(/^#{2,4}\s+Story\s+(\d+\.\d+)\s*[:—-]\s*(.+)\r?$/gim)];
  const stories: Story[] = [];
  const ids = new Set<string>();
  for (const heading of headings) {
    const id = heading[1]!;
    if (ids.has(id)) throw new Error(`Duplicate planned story ID: ${id}`);
    ids.add(id);
    const start = heading.index! + heading[0].length;
    const rest = text.slice(start);
    const next = rest.search(/^#{1,4}\s+(?:Epic\s+\d+|Story\s+\d+\.\d+)\b/im);
    const body = rest.slice(0, next < 0 ? undefined : next).trim();
    const title = heading[2]!.trim();
    const ac = (body.match(/^(?:\*{2}Acceptance Criteria:\*{2}|#{2,4}\s+Acceptance Criteria)\s*\r?\n([\s\S]*)/im)?.[1] ?? "")
      .split(/^#{1,6}\s+/m)[0]!;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "story";
    const story: Story = {
      id, title, status: "Planned", narrative: body.split(/\*{2}(?:Requirements|Acceptance Criteria)/i)[0]!.trim(),
      fullText: `# Story ${id}: ${title}\n\n${body}`,
      criteria: parseCriteria(ac), planned: true,
      file: resolveRepoFile(cfg.repo, path.join(cfg.stories_dir, `${id.replace(".", "-")}-${slug}.md`)),
    };
    if (!epicId || belongsToEpic(story, epicId)) {
      if (!story.criteria.length) throw new Error(`Planned story ${id} has no parseable acceptance criteria.`);
      stories.push(story);
    }
  }
  return stories.sort((a, b) => compareIds(a.id, b.id));
}

export function parseStory(file: string): Story | null {
  const text = fs.readFileSync(file, "utf8");

  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return null;

  // "Story 10.3: Check-in photo" → id 10.3, title "Check-in photo"
  const m = heading.match(/^(?:story\s+)?([\d]+(?:\.[\d]+)*)\s*[:—-]\s*(.+)$/i);
  const id = m?.[1] ?? path.basename(file, ".md");
  const title = m?.[2]?.trim() ?? heading;

  return {
    id,
    title,
    status: section(text, ["status"])?.trim().split("\n")[0]?.trim() ?? "unknown",
    narrative: section(text, ["story", "user story", "description"])?.trim() ?? "",
    criteria: parseCriteria(section(text, ["acceptance criteria", "acceptance-criteria", "ac"]) ?? ""),
    fullText: text,
    file,
  };
}

/** Pull the body under a `## Heading`, matched case-insensitively. */
function section(text: string, names: string[]): string | null {
  for (const name of names) {
    // Stops at the next heading, or at the end of the file. `$(?![\s\S])` is
    // the end-of-string anchor — with the `m` flag a bare `$` would stop at
    // the first line break, and `\Z` isn't a thing in JavaScript regex.
    const re = new RegExp(
      `^#{2,4}\\s*${escapeRe(name)}\\s*$\\r?\\n([\\s\\S]*?)(?=^#{1,4}\\s|$(?![\\s\\S]))`,
      "im",
    );
    const found = text.match(re);
    if (found?.[1]) return found[1];
  }
  return null;
}

function parseCriteria(block: string): Criterion[] {
  const out: Criterion[] = [];

  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // "1. ...", "- ...", "* ...", "- [ ] ..."
    const item = line.match(/^(?:\d+[.)]\s*|[-*]\s+(?:\[[ xX]\]\s*)?)(.+)$/);
    if (!item?.[1]) continue;

    let body = item[1].trim();
    if (!body) continue;

    // If the line labels itself (AC9: ...), keep that label — the dev agent
    // and the tests will refer to it by that name.
    const labelled = body.match(/^\*{0,2}(AC[-\s]?\d+)\*{0,2}\s*[:.\-—]\s*(.+)$/i);
    if (labelled?.[1] && labelled[2]) {
      out.push({ id: labelled[1].replace(/[\s-]/g, "").toUpperCase(), text: labelled[2].trim() });
      continue;
    }

    out.push({ id: `AC${out.length + 1}`, text: body });
  }

  if (out.length) return out;
  const bdd = block.split(/(?=^(?:\*{2})?Given\b)/im).filter((part) => /^(?:\*{2})?Given\b/i.test(part.trim()));
  return bdd.map((text, index) => ({
    id: `AC${index + 1}`,
    text: text.replace(/^\s+|\s+$/g, "").replace(/\*{2}/g, "").replace(/\s+/g, " "),
  }));
}

export function isDone(story: Story, doneStatuses: string[]): boolean {
  return doneStatuses.some((s) => s.toLowerCase() === story.status.toLowerCase());
}

/** Re-read a story from disk — BMAD agents update the status in place. */
export function refresh(story: Story): Story {
  return parseStory(story.file) ?? story;
}

function belongsToEpic(story: Story, epicId: string): boolean {
  // "epic-10" or "10" both match story 10.3
  const n = epicId.match(/(\d+)/)?.[1];
  if (!n) return story.fullText.toLowerCase().includes(epicId.toLowerCase());
  return story.id.startsWith(`${n}.`) || story.id === n;
}

function compareIds(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

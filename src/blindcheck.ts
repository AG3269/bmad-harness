import * as path from "node:path";
import { loadConfig } from "./config.js";
import { findStories } from "./bmad/stories.js";
import { snapshot, collect } from "./validate/diff.js";
import { scrubForReader, assertReaderIsBlind, BlindnessBroken } from "./validate/blindness.js";

/**
 *   npm run blindcheck -- 10.3 [--since <git-ref>]
 *
 * Shows exactly what the Phase 1 reader would see for a story, and whether any
 * of the story survived into it.
 *
 * Worth running against your own repo before trusting Phase 1, and again
 * whenever BMAD's output format changes. Blindness fails silently — a reader
 * that has seen the story reconstructs it perfectly and every criterion looks
 * covered — so the only way to know it's holding is to look.
 *
 * Costs nothing: no Azure, no VS Code, no agents.
 */

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig(flag(args, "--config") ?? "harness.config.yaml");
  const storyId = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--config" && args[args.indexOf(a) - 1] !== "--since");
  const since = flag(args, "--since") ?? snapshot(cfg.repo) + "~1";

  const stories = findStories(cfg.repo, cfg.stories_dir);
  const story = storyId
    ? stories.find((s) => s.id === storyId)
    : stories[0];

  if (!story) {
    console.error(`No story "${storyId}". Found: ${stories.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nBlindness check — story ${story.id}: ${story.title}`);
  console.log(`Diffing against ${since}\n`);

  const changes = collect(cfg.repo, since, {
    ignore: cfg.phase1.ignore,
    maxChars: cfg.phase1.max_diff_chars,
  });

  if (changes.files.length === 0) {
    console.log("Nothing changed since that ref — nothing to check.");
    console.log("Pass --since <ref> to pick a point before the work started.");
    return;
  }

  const b = cfg.phase1.blindness;

  // What it would look like with no protection.
  const naive = scrubForReader(changes, story, { exclude: [], redact: false, maxChars: cfg.phase1.max_diff_chars });
  let naiveLeaks = false;
  try { assertReaderIsBlind(naive.text, story); } catch { naiveLeaks = true; }

  // What it actually looks like.
  const safe = scrubForReader(changes, story, {
    exclude: b.exclude, redact: b.redact_criterion_text, maxChars: cfg.phase1.max_diff_chars,
  });

  console.log(`Files changed:  ${changes.files.length}`);
  console.log(`Excluded:       ${safe.excluded.length ? safe.excluded.join(", ") : "(none)"}`);
  console.log(`Redacted:       ${safe.redactedText} criterion quote(s), ${safe.redactedLabels} AC label(s)`);
  console.log("");

  if (naiveLeaks) {
    console.log(`Without the guardrails this diff WOULD have leaked the story.`);
    console.log(`They're doing real work here, not sitting idle.\n`);
  } else {
    console.log(`This diff wouldn't have leaked even unprotected — nothing to strip.\n`);
  }

  let stillLeaks: string | null = null;
  try {
    assertReaderIsBlind(safe.text, story);
  } catch (e) {
    stillLeaks = e instanceof BlindnessBroken ? e.message.split("\n")[0]! : String(e);
  }

  if (stillLeaks) {
    console.log(`  ✗ STILL LEAKING`);
    console.log(`    ${stillLeaks}`);
    console.log(`\n  Phase 1 would refuse to run on this story, which is the right`);
    console.log(`  answer — but find the channel. Usually a file that needs adding`);
    console.log(`  to phase1.blindness.exclude.\n`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ Clean — none of the story's wording reaches the reader.\n`);
  }

  if (safe.primed) {
    console.log(`  Note: the code names criteria directly. The text was stripped, but`);
    console.log(`  the author clearly knew them, so the reading is a bit less`);
    console.log(`  independent than usual. Worth telling the dev agent to stop`);
    console.log(`  quoting acceptance criteria in comments.\n`);
  }

  console.log("─".repeat(72));
  console.log("What the reader sees:");
  console.log("─".repeat(72));
  console.log(safe.text.slice(0, 4000));
  if (safe.text.length > 4000) console.log(`\n[... ${safe.text.length - 4000} more characters ...]`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

main();

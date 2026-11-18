import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseEnv } from "dotenv";
import * as YAML from "yaml";
import { z } from "zod";
import { resolveRepoFile } from "./bmad/paths.js";

/**
 * Loads harness.config.yaml and checks it makes sense before anything starts.
 *
 * Bad config fails here, loudly, in the first second — not four stories into
 * an overnight run.
 */

const Config = z.object({
  repo: z.string(),
  stories_dir: z.string(),
  mode: z.enum(["watch", "normal", "solo"]),
  driver: z.enum(["stub", "attach"]),

  story_creation: z.object({
    enabled: z.boolean().default(false),
    epics_file: z.string().min(1).default("_bmad-output/planning-artifacts/epics.md"),
    agent: z.string().min(1).default("bmad-agent-pm"),
    model: z.string().min(1).optional(),
  }).default({}),

  azure: z.object({
    endpoint: z.string(),
    api_version: z.string(),
    auth: z.enum(["aad", "key"]),
    key_env: z.string().default("AZURE_OPENAI_KEY"),
    deployments: z.object({
      reader: z.string(),
      comparer: z.string(),
      decider: z.string(),
      summarizer: z.string(),
    }),
  }),

  bmad: z.object({
    agents: z.object({
      develop: z.string(),
      review: z.string(),
      test: z.string(),
    }),
    models: z.object({
      develop: z.string(),
      review: z.string(),
      test: z.string(),
    }),
    status_field: z.string().default("Status"),
    status_done: z.array(z.string()),
  }),

  phase1: z.object({
    enabled: z.boolean(),
    min_confidence: z.number().min(0).max(1),
    ignore: z.array(z.string()),
    max_diff_chars: z.number().int().min(1000),
    fail_on: z.array(z.string()),
    escalate_on: z.array(z.string()),
    blindness: z.object({
      exclude: z.array(z.string()),
      redact_criterion_text: z.boolean(),
      assert_no_leak: z.boolean(),
      max_verbatim_overlap: z.number().min(0).max(1),
      decoy: z.enum(["every", "sometimes", "off"]),
      decoy_tolerance: z.number().min(0).max(1),
    }),
  }),

  phase2: z.object({
    enabled: z.boolean(),
    needs: z.array(z.string()),
    when_missing: z.enum(["ci", "stop"]),
    ci_workflow: z.string(),
    rules: z.object({
      every_criterion_needs_a_test: z.boolean(),
      skipped_is_not_passed: z.boolean(),
      all_skipped_is_failure: z.boolean(),
      denial_tests_must_attempt: z.boolean(),
    }),
  }),

  decide: z.object({
    shadow: z.boolean(),
    confidence: z.number().min(0).max(1),
    never: z.array(z.string()),
    fix_quietly: z.array(z.string()),
    always_ask: z.object({
      kinds: z.array(z.string()),
      files: z.array(z.string()),
    }),
    never_touch: z.array(z.string()),
  }),

  tool_approvals: z.object({
    auto_allow: z.array(z.object({
      tool: z.string().min(1),
      input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })).default([]),
  }).default({ auto_allow: [] }),

  limits: z.object({
    fix_attempts: z.number().int().min(0),
    questions_per_stage: z.number().int().min(1),
    interruptions: z.number().int().min(0),
    max_agent_turns: z.number().int().min(1),
    max_minutes: z.number().int().min(1),
    turn_timeout_minutes: z.number().int().min(1).max(35_000).default(25),
  }),
});

export type Config = z.infer<typeof Config>;

export function loadConfig(file = "harness.config.yaml", options: { requireAzureKey?: boolean; env?: NodeJS.ProcessEnv } = {}): Config {
  if (!fs.existsSync(file)) {
    throw new Error(`No config at ${file}.`);
  }

  const env = options.env ?? process.env;
  loadEnvironment(file, env);

  const parsed = Config.safeParse(YAML.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config has problems:\n${problems}`);
  }

  const cfg = parsed.data;
  applyAzureEnvironment(cfg, env);
  cfg.repo = expandHome(cfg.repo);

  if (!fs.existsSync(cfg.repo)) {
    throw new Error(`repo points at ${cfg.repo}, which doesn't exist.`);
  }

  const stories = path.join(cfg.repo, cfg.stories_dir);
  if (cfg.story_creation.enabled) {
    resolveRepoFile(cfg.repo, cfg.stories_dir);
    const epics = resolveRepoFile(cfg.repo, cfg.story_creation.epics_file);
    if (!fs.statSync(epics).isFile()) throw new Error(`story_creation.epics_file is not a file: ${epics}`);
  } else if (!fs.existsSync(stories)) {
    throw new Error(
      `No stories at ${stories}.\n` +
      `Check stories_dir, or enable story_creation with an existing epic plan.`,
    );
  }

  // Same model developing and reviewing makes the review worth much less.
  if (cfg.bmad.models.develop === cfg.bmad.models.review) {
    console.warn(
      "\n  Heads up: the same model is developing and reviewing.\n" +
      "  A model reviewing its own work tends to agree with itself.\n" +
      "  Pick a different one for bmad.models.review.\n",
    );
  }

  if (options.requireAzureKey !== false && cfg.azure.auth === "key" &&
      !env[cfg.azure.key_env] && env.HARNESS_FAKE_AZURE !== "1") {
    throw new Error(
      `azure.auth is "key" but ${cfg.azure.key_env} isn't set.\n` +
      `Set it in the environment or .env, or switch to auth: aad (which uses your Azure login).`,
    );
  }

  const b = cfg.phase1.blindness;
  if (cfg.phase1.enabled && !b.assert_no_leak) {
    console.warn(
      "\n  Warning: phase1.blindness.assert_no_leak is off.\n" +
      "  Nothing now checks that the story stayed out of the reader's prompt.\n" +
      "  If it leaks, every criterion looks covered and Phase 1 stops checking\n" +
      "  anything — without failing.\n",
    );
  }
  if (cfg.phase1.enabled && b.decoy === "off") {
    console.warn(
      "\n  Warning: the decoy check is off.\n" +
      "  Nothing now verifies the comparer still discriminates. A comparer that\n" +
      "  marks everything covered looks exactly like one that works.\n",
    );
  }
  if (cfg.phase1.enabled && !b.exclude.some((p) => p.includes(cfg.stories_dir.split(/[\\/]/)[0] ?? "docs"))) {
    console.warn(
      `\n  Warning: phase1.blindness.exclude doesn't cover ${cfg.stories_dir}.\n` +
      "  BMAD agents edit story files while working, so the story will appear in\n" +
      "  the diff and the reader will read it verbatim.\n",
    );
  }

  if (cfg.mode === "solo" && cfg.limits.interruptions > 0) {
    console.warn("  Note: mode is 'solo', so it never asks. interruptions is ignored.\n");
  }

  return cfg;
}

function loadEnvironment(configFile: string, env: NodeJS.ProcessEnv): void {
  const configDir = path.dirname(path.resolve(configFile));
  const candidates = [
    path.join(configDir, ".env"),
    path.join(path.dirname(configDir), ".env"),
  ];

  for (const file of candidates) {
    let contents: string;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read environment file ${file}: ${message}`);
    }

    for (const [name, value] of Object.entries(parseEnv(contents))) {
      if (env[name] === undefined) env[name] = value;
    }
    return;
  }
}

function applyAzureEnvironment(cfg: Config, env: NodeJS.ProcessEnv): void {
  const endpoint = envValue("AZURE_ENDPOINT", env);
  const apiVersion = envValue("AZURE_API_VERSION", env);
  const model = envValue("AZURE_MODEL_NAME", env);
  const apiKey = envValue("AZURE_API_KEY", env);

  if (endpoint !== undefined) cfg.azure.endpoint = endpoint;
  if (apiVersion !== undefined) cfg.azure.api_version = apiVersion;
  if (apiKey !== undefined) {
    cfg.azure.auth = "key";
    cfg.azure.key_env = "AZURE_API_KEY";
  }

  for (const role of ["reader", "comparer", "decider", "summarizer"] as const) {
    const deployment = envValue(`AZURE_${role.toUpperCase()}_DEPLOYMENT`, env) ?? model;
    if (deployment !== undefined) cfg.azure.deployments[role] = deployment;
  }
}

function envValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  if (value !== undefined && value.trim() === "") {
    throw new Error(`${name} is set but empty. Provide a value or remove it from the environment or .env.`);
  }
  return value;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { loadConfig, type Config } from "./config.js";
import { Azure } from "./llm/azure.js";
import { collect, snapshot } from "./validate/diff.js";

const envNames = [
  "AZURE_ENDPOINT",
  "AZURE_API_KEY",
  "AZURE_MODEL_NAME",
  "AZURE_API_VERSION",
  "AZURE_READER_DEPLOYMENT",
  "AZURE_COMPARER_DEPLOYMENT",
  "AZURE_DECIDER_DEPLOYMENT",
  "AZURE_SUMMARIZER_DEPLOYMENT",
  "AZURE_OPENAI_KEY",
  "CUSTOM_AZURE_KEY",
  "HARNESS_FAKE_AZURE",
] as const;

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let savedEnv: Map<string, string | undefined>;

beforeEach(() => {
  savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setup(t: TestContext, azureOverrides: Partial<Config["azure"]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const configDir = path.join(root, "harness");
  const repo = path.join(root, "repo");
  const stories = path.join(repo, "docs", "stories");
  fs.mkdirSync(configDir);
  fs.mkdirSync(stories, { recursive: true });
  fs.writeFileSync(
    path.join(stories, "10.3.md"),
    "# Story 10.3: Fixture story\n\n## Status\nReady\n\n## Acceptance Criteria\n- A fixture criterion\n",
  );

  const template: Record<string, unknown> = YAML.parse(
    fs.readFileSync(path.join(projectDir, "harness.config.yaml"), "utf8"),
  );
  const azure: Config["azure"] = {
    endpoint: "https://yaml.example.test",
    api_version: "2024-10-21",
    auth: "aad",
    key_env: "AZURE_OPENAI_KEY",
    deployments: {
      reader: "yaml-reader",
      comparer: "yaml-comparer",
      decider: "yaml-decider",
      summarizer: "yaml-summarizer",
    },
    ...azureOverrides,
  };
  const configFile = path.join(configDir, "harness.config.yaml");
  fs.writeFileSync(configFile, YAML.stringify({
    ...template, repo, stories_dir: "docs/stories", azure, story_creation: { enabled: false },
  }));
  return { root, configDir, configFile, repo };
}

for (const covered of [true, false]) {
  test(`Windows story paths ${covered ? "recognize exclusions" : "warn when exclusions are missing"}`, (t) => {
    const fixture = setup(t);
    const config: Config = YAML.parse(fs.readFileSync(fixture.configFile, "utf8"));
    config.stories_dir = "_bmad-output\\implementation-artifacts";
    config.phase1.blindness.exclude = covered ? ["_bmad-output/**"] : ["docs/stories/**"];
    fs.mkdirSync(path.join(fixture.repo, config.stories_dir), { recursive: true });
    fs.writeFileSync(fixture.configFile, YAML.stringify(config));
    const warnings = t.mock.method(console, "warn", () => {});

    loadConfig(fixture.configFile);

    assert.equal(warnings.mock.callCount(), covered ? 0 : 1);
    if (!covered) {
      assert.match(String(warnings.mock.calls[0]?.arguments[0]), /exclude doesn't cover/);
    }
  });
}

test("loads Azure settings from the parent .env and applies role overrides", (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), [
    "AZURE_ENDPOINT=https://env.example.test",
    "AZURE_API_KEY=example-test-key",
    "AZURE_MODEL_NAME=shared-deployment",
    "AZURE_API_VERSION=2025-04-01-preview",
    "AZURE_READER_DEPLOYMENT=reader-deployment",
    "AZURE_SUMMARIZER_DEPLOYMENT=summarizer-deployment",
  ].join("\n"));

  const cfg = loadConfig(fixture.configFile);
  assert.deepEqual(cfg.azure, {
    endpoint: "https://env.example.test",
    api_version: "2025-04-01-preview",
    auth: "key",
    key_env: "AZURE_API_KEY",
    deployments: {
      reader: "reader-deployment",
      comparer: "shared-deployment",
      decider: "shared-deployment",
      summarizer: "summarizer-deployment",
    },
  });
  assert.equal(process.env.AZURE_API_KEY, "example-test-key");
});

test("prefers an .env beside the config without mixing it with the parent", (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), [
    "AZURE_ENDPOINT=https://parent.example.test",
    "AZURE_API_KEY=parent-test-key",
  ].join("\n"));
  fs.writeFileSync(path.join(fixture.configDir, ".env"), "AZURE_ENDPOINT=https://local.example.test\n");

  const cfg = loadConfig(fixture.configFile);
  assert.equal(cfg.azure.endpoint, "https://local.example.test");
  assert.equal(cfg.azure.auth, "aad");
  assert.equal(process.env.AZURE_API_KEY, undefined);
});

test("preserves existing process environment values over .env", (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), [
    "AZURE_ENDPOINT=https://file.example.test",
    "AZURE_API_KEY=file-test-key",
    "AZURE_MODEL_NAME=file-deployment",
    "AZURE_API_VERSION=file-version",
  ].join("\n"));
  process.env.AZURE_ENDPOINT = "https://shell.example.test";
  process.env.AZURE_API_KEY = "shell-test-key";
  process.env.AZURE_MODEL_NAME = "shell-deployment";
  process.env.AZURE_API_VERSION = "shell-version";

  const cfg = loadConfig(fixture.configFile);
  assert.equal(cfg.azure.endpoint, "https://shell.example.test");
  assert.equal(cfg.azure.api_version, "shell-version");
  assert.deepEqual(Object.values(cfg.azure.deployments), Array(4).fill("shell-deployment"));
  assert.equal(process.env.AZURE_API_KEY, "shell-test-key");
});

test("preserves YAML and AAD configuration when Azure environment values are absent", (t) => {
  const fixture = setup(t);
  const cfg = loadConfig(fixture.configFile);
  assert.equal(cfg.azure.endpoint, "https://yaml.example.test");
  assert.equal(cfg.azure.api_version, "2024-10-21");
  assert.equal(cfg.azure.auth, "aad");
  assert.equal(cfg.azure.key_env, "AZURE_OPENAI_KEY");
  assert.equal(cfg.azure.deployments.reader, "yaml-reader");
  assert.equal(cfg.azure.deployments.decider, "yaml-decider");
});

test("supports individual deployment overrides without a shared model", (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), [
    "AZURE_COMPARER_DEPLOYMENT=comparer-deployment",
    "AZURE_DECIDER_DEPLOYMENT=decider-deployment",
  ].join("\n"));
  const cfg = loadConfig(fixture.configFile);
  assert.deepEqual(cfg.azure.deployments, {
    reader: "yaml-reader",
    comparer: "comparer-deployment",
    decider: "decider-deployment",
    summarizer: "yaml-summarizer",
  });
});

test("preserves an existing custom key environment variable", (t) => {
  const fixture = setup(t, { auth: "key", key_env: "CUSTOM_AZURE_KEY" });
  process.env.CUSTOM_AZURE_KEY = "legacy-test-key";
  const cfg = loadConfig(fixture.configFile);
  assert.equal(cfg.azure.auth, "key");
  assert.equal(cfg.azure.key_env, "CUSTOM_AZURE_KEY");
});

test("rejects empty Azure environment values", (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), "AZURE_API_KEY=\n");
  assert.throws(() => loadConfig(fixture.configFile), /AZURE_API_KEY is set but empty/);
});

test("reports a missing configured key unless fake Azure is enabled", (t) => {
  const fixture = setup(t, { auth: "key", key_env: "CUSTOM_AZURE_KEY" });
  assert.throws(() => loadConfig(fixture.configFile), /CUSTOM_AZURE_KEY isn't set/);
  assert.equal(loadConfig(fixture.configFile, { requireAzureKey: false }).azure.key_env, "CUSTOM_AZURE_KEY");
  process.env.HARNESS_FAKE_AZURE = "1";
  assert.equal(loadConfig(fixture.configFile).azure.key_env, "CUSTOM_AZURE_KEY");
});

test("reports an unreadable .env rather than falling back", (t) => {
  const fixture = setup(t);
  fs.mkdirSync(path.join(fixture.configDir, ".env"));
  assert.throws(() => loadConfig(fixture.configFile), /Could not read environment file/);
});

test("sends the .env deployment and key to the Azure client", async (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), [
    "AZURE_ENDPOINT=https://env.example.test",
    "AZURE_API_KEY=example-test-key",
    "AZURE_MODEL_NAME=example-deployment",
    "AZURE_API_VERSION=2025-04-01-preview",
  ].join("\n"));
  const cfg = loadConfig(fixture.configFile);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async (input, init) => {
    called = true;
    assert.equal(
      String(input),
      "https://env.example.test/openai/deployments/example-deployment/chat/completions?api-version=2025-04-01-preview",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("api-key"), "example-test-key");
    assert.equal(headers.get("authorization"), null);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "fixture response" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }), { status: 200 });
  };

  const azure = new Azure(cfg.azure);
  assert.equal(await azure.ask({ deployment: cfg.azure.deployments.reader, user: "fixture prompt" }), "fixture response");
  assert.equal(called, true);
  assert.deepEqual(azure.usage["example-deployment"], { prompt: 2, completion: 3 });
});

test("the stories CLI loads the .env before validating key authentication", (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.root, ".env"), [
    "AZURE_ENDPOINT=https://env.example.test",
    "AZURE_API_KEY=example-test-key",
    "AZURE_MODEL_NAME=example-deployment",
  ].join("\n"));
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/main.ts", "--stories", "--config", fixture.configFile],
    { cwd: projectDir, encoding: "utf8", env: { ...process.env } },
  );
  assert.match(output, /10\.3\s+Ready\s+Fixture story/);
  assert.doesNotMatch(output, /example-test-key/);
});

test("excludes tracked and untracked environment credentials from the diff", (t) => {
  const fixture = setup(t);
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", fixture.repo, ...args], { encoding: "utf8", stdio: "pipe" },
  );
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(fixture.repo, ".config"));
  fs.writeFileSync(path.join(fixture.repo, ".env"), "AZURE_API_KEY=old-test-key\n");
  fs.writeFileSync(path.join(fixture.repo, ".config", ".env.local"), "SECRET=old-test-key\n");
  fs.writeFileSync(path.join(fixture.repo, ".env.example"), "AZURE_MODEL_NAME=old-example\n");
  git("add", "--all");
  git("add", "-f", "--", ".env", ".config/.env.local", ".env.example");
  git("commit", "-qm", "base");
  const baseline = snapshot(fixture.repo);

  fs.writeFileSync(path.join(fixture.repo, ".env"), "AZURE_API_KEY=new-test-key\n");
  fs.writeFileSync(path.join(fixture.repo, ".config", ".env.local"), "SECRET=new-test-key\n");
  fs.writeFileSync(path.join(fixture.repo, ".env.example"), "AZURE_MODEL_NAME=new-example\n");
  fs.mkdirSync(path.join(fixture.repo, "app"));
  fs.writeFileSync(path.join(fixture.repo, "app", ".env.test"), "SECRET=untracked-test-key\n");

  const changes = collect(fixture.repo, baseline, { ignore: [], maxChars: 50_000 });
  const visible = changes.files.map((file) => file.path);
  assert.ok(visible.includes(".env.example"));
  assert.ok(!visible.includes(".env"));
  assert.ok(!visible.includes(".config/.env.local"));
  assert.ok(!visible.includes("app/.env.test"));
  assert.ok(changes.ignored.includes(".env"));
  assert.ok(changes.ignored.includes(".config/.env.local"));
  assert.ok(changes.files.every((file) => !file.patch.includes("test-key")));
});

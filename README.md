# The harness

Drives your BMAD session in VS Code through an epic, and checks that what got
built is what was asked for.

You start VS Code, open the repo, set BMAD up. Stories can already exist or be
prepared from an existing epic plan. The harness attaches to that session —
switching agents, switching
models, answering the questions BMAD stops to ask, and validating the result
in two phases.

## First-time setup

Use Node.js 22 or later, npm, and Git. Live runs also need VS Code with a
running local agent host, the configured BMAD agents and models, and Azure
OpenAI access.

From the cloned repository directory in PowerShell:

```powershell
npm install
Copy-Item harness.config.example.yaml harness.config.yaml
```

Edit `harness.config.yaml` to set the target repository, story directory, and
existing epic plan. For existing story files without preparation, set
`story_creation.enabled: false`. The target repository must already be a Git
repository. Start with a disposable target: the stub can overwrite files.

The template starts with `driver: stub`, Watch mode, shadow decisions enabled,
and Phase 2 disabled. Your local `harness.config.yaml`, `.env`, session state,
run history, dependencies, and build output are excluded from Git. The
repository includes templates, source, fixtures, and tests, not live sessions
or credentials.

For real Azure calls, copy `.env.example` to `.env` and fill in the values, or
configure Azure AD authentication as described below. Keep the harness outside
the repository it drives.

## Try it now, offline

```bash
npm install
HARNESS_FAKE_AZURE=1 npm run harness -- epic-10
```

`driver: stub` means no VS Code, and `HARNESS_FAKE_AZURE=1` means no Azure.
The stub can copy fixture files into the configured repo and overwrite existing
files, so use a disposable repo for a dry run.

In PowerShell, set the flag with `$env:HARNESS_FAKE_AZURE = "1"` before
running the harness. Remove it with `Remove-Item Env:\HARNESS_FAKE_AZURE`
before using real Azure.

Also useful:

```bash
npm run harness -- --stories    # list the stories it found, change nothing
npm run harness -- --select-session # choose a VS Code session, without starting a run
npm run blindcheck -- 10.3      # show exactly what the Phase 1 reader sees
npm run selftest                # 47 checks on the validation and guardrails
npm run test:config             # Azure environment configuration tests
npm run test:stories            # planned-story creation and lifecycle tests
npm run test:sessions           # session discovery and selection tests
npm run test:diff               # working-tree baseline tests
npm run test:guards             # review and Phase 1 guardrail tests
npm run test:driver             # agent host driver and session binding tests
npm run test:recovery           # recovery and multi-story tests
```

## Local session monitor

From the `harness` directory:

```powershell
npm run app
```

Open `http://127.0.0.1:4317`. This is a lightweight local browser app, not an
Electron install. Use `-- --port 4320` or `-- --config C:\configs\other.yaml`
to change the listener or initial workspace configuration.

- **New session** selects a workspace, a single story or full epic, and an
  explicitly chosen VS Code session. It can also create an idle session on
  a selected running VS Code editor host; creation sends no story prompt.
- **Add workspace** registers an existing configuration or copies the default
  settings for an existing repository/worktree. Generated configurations use
  Watch mode and inherit the default configuration's credential source.
  Configurations and app records stay outside the target repository.
- Independent working directories can run in parallel. Work sharing a directory
  is queued while the app owns a run or an agent is active there. The app does
  not create Git worktrees or infer story dependencies; use an epic for ordered
  story execution. Do not start a separate CLI writer alongside app-managed work.
- Each run shows agent activity separately from harness connectivity, plus its
  errors, output, report, and saved session/turn identity.
  The backend inspects bound VS Code sessions immediately at startup and every
  **30 seconds**, whether or not a browser is open and even while a harness
  decision is pending. Latest responses and session-owned terminal tails include
  their successful-sync timestamp. Inspection failures retain the previous
  evidence with an explicit error; newer activity is flagged without marking
  the story accepted or replaying a turn.
- Pending decisions show the question, reason, background, review findings,
  latest observed session activity, and labeled choice buttons together on the
  session card and in its details drawer. Choices are tied to the pending
  question so a stale card cannot answer a newer question. Older running harness
  processes are supported using their existing terminal prompts; any latest
  workspace review used as background is labeled separately from recorded
  harness review evidence.
- **Reconnect & watch** follows the recorded turn without resending it.
  **Continue workflow** performs recovery assessment and resumes supported
  stages. It does not silently substitute sessions or accept uncertainty.
  Recovered single-story runs do not continue the rest of their epic.
  When an advisory assessment blocks continuation, the run is labeled
  **Recovery decision needed**. Its drawer lists the saved uncertainties and
  next step. **Continue after review** stays disabled until you explicitly
  acknowledge them. This passes the existing `--accept-uncertainty` override
  for that continuation only; original-session checks, review, and Phase 1
  validation remain mandatory. Keeping the acknowledgment unchecked keeps the
  workflow paused. Confirmation is bound to the reviewed assessment; a changed
  assessment requires a fresh acknowledgment.
- Harness decision option IDs can be submitted from the run drawer. Tool
  approval, authentication, and agent-input requests remain in the owning
  VS Code session.

The app binds only to loopback, checks request origins and a per-launch request
token, and keeps Azure credentials on the server. It retains records under
`.harness-state/app`; treat those records and local run reports as private.
After an app restart, interrupted tasks require inspection/reconnection and are
never automatically redispatched. Closing a monitor does not cancel its agent.

For a single story from the CLI:

```powershell
npm run harness -- --story 1.2 --session <full-session-id>
```

## What a run does

```
for each story in the epic that isn't already done:

  create (if missing) → develop → review → (fix → review)* → phase 1 → phase 2
```

The harness switches BMAD agent and model between stages. Review deliberately
runs on a different model than develop — a model reviewing its own work tends
to agree with itself.

With `story_creation.enabled`, the queue combines implementation story files
with `Story N.M` entries from the configured epic plan. Completed stories are
skipped. A missing story is prepared by the configured BMAD agent, then
implemented and validated before the next story is created. A failed or stopped
story stops the epic; later dependent work is not started.

Preparation must produce the expected story file with Status `Ready` and every
planned acceptance criterion preserved in order. Missing, blocked, duplicate,
or weakened output stops the run before development. Architecture approvals
are not inferred or granted automatically. Creation questions and tool requests
use the existing human-decision and approval paths.

Readiness checks are case-insensitive and accept an optional final period
(for example, `Ready` or `Ready.`). Existing planned stories also accept
`ready-for-dev`, `Ready for Development`, or `Approved`, with or without a period.

Before each story, the harness snapshots existing tracked changes and untracked
files before creation or development as the baseline instead of treating them
as new work. Changes, deletions,
and new files made afterwards remain visible to Phase 1. This does not modify
Git's ignore rules or remove any files. The saved baseline is limited to
256 MiB total and 64 MiB per file; exceeding a limit stops the run.

### Phase 1 — does the code match the story?

This is the part worth understanding, because the obvious version of it
doesn't work.

The obvious version shows a model the story and the diff and asks "do these
match?" That's close to worthless. Given both, a model finds something in the
diff that loosely corresponds to each criterion and talks itself into a yes.

So it's two calls, with clean context between them:

1. **Read.** A model sees **only the diff**. Not the story, not the story id,
   no hint about what was wanted. It writes the work item it thinks produced
   this code.
2. **Compare.** A second model, fresh, sees the real story and that
   reconstruction, and judges where they diverge.

The reconstruction is evidence precisely because it was written by something
that had never seen what it was supposed to produce.

#### Keeping it blind

Blindness fails **silently**. A reader that has seen the story reconstructs it
perfectly, every criterion looks covered, and the report is indistinguishable
from a clean one. So it's enforced, not hoped for.

The channel that matters most: **BMAD edits the story file while it works** —
status, completion notes, file list. That lands in `git diff`, which hands the
reader the story verbatim. Without a guard, Phase 1 passes everything and looks
like it's working.

Four layers:

| | |
|---|---|
| **Exclude** | story files, epic and PRD docs — never shown to the reader |
| **Redact** | criterion text and `AC9`-style labels quoted in comments and string literals. Only comments and strings; code structure is what we want it to read |
| **Assert** | before the prompt is sent, check no criterion text survived. Throws, doesn't warn |
| **Detect** | after the reply, flag a reconstruction that reuses the story's wording |

Check it on your own repo, free, no Azure needed:

```bash
npm run blindcheck -- 10.3 --since <ref-before-the-work>
```

It prints what was excluded, what was redacted, whether anything leaked, and
the exact text the reader would see. Run it before trusting Phase 1, and again
whenever BMAD's output format changes.

#### The other failure: a comparer that agrees with everything

Blindness protects the reader. Nothing so far protects the comparer, and it has
its own silent failure — marking everything covered looks identical to working,
on every story that passes.

So the harness periodically re-runs the comparison with the **same
reconstruction** and a story the code definitely doesn't implement (a real one
from another epic where possible). The answer should be "missing" throughout.
If it isn't, the comparer is agreeing rather than checking, and the story
escalates — along with a note that recent passes are suspect.

One extra call per story. If the decoy fails to run, or its comparison omits
or duplicates a criterion, the result is unverified and the story escalates.
The real comparison must also provide exactly one verdict per criterion.

```yaml
blindness:
  decoy: every          # every | sometimes (~1 in 4) | off
  decoy_tolerance: 0.34 # an unrelated story can brush against the real work
```

#### What it catches

A reviewer asks whether the code is good. This asks whether it's the code that
was asked for:

| | |
|---|---|
| **Missing** | the story asked for it, the code doesn't do it |
| **Extra** | the code does something nobody asked for — escalates if it's somewhere sensitive |
| **Divergent** | it solved a different problem |
| **Stub** | technically present, but a TODO or a hardcoded return |

Phase 1 is cheap and needs no test environment, so it runs first. There's no
point deploying and testing code that doesn't implement the story — that turns
a clear failure into a confusing one.

### Phase 2 — did it actually work?

Runs after Phase 1 passes. Needs a deployed app, real accounts and a mailbox.
Every criterion must name a test that ran and passed, and a test for something
being blocked must have actually signed in as the wrong user and tried. One
that never tries proves nothing, however green.

Off by default (`phase2.enabled: false`). Turn it on once the test environment
is up.

Local test-result validation is implemented. The optional GitHub Actions
fallback currently dispatches the configured workflow, but polling, artifact
download, and result parsing are not implemented. Dispatch alone does not
count as passing Phase 2. Keep `when_missing: stop` until that integration is
completed, and provide the local test prerequisites when enabling Phase 2.

## Setting it up

**1. Point it at your repo and stories.**

```yaml
repo: ~/dev/kinloop
stories_dir: docs/stories
story_creation:
  enabled: true
  epics_file: docs/epics.md
  agent: bmad-agent-pm
  model: GPT-6.1 Sol
```

The epic plan must already exist. The preparation agent must be installed in
the selected VS Code session. If `model` is omitted, creation uses the
development model. The example configuration enables creation from
`_bmad-output/planning-artifacts/epics.md` using a Product Manager agent,
not a standalone create-story workflow. The agent is instructed
to prepare the story directly or use an installed preparation workflow.

Omit `story_creation` or set `enabled: false` to retain the original behavior
of running only existing story files. `--stories` lists both prepared stories
and missing entries marked `Planned`, without writing anything.

**2. Azure OpenAI.** This is for the harness's own thinking: reading diffs,
comparing, deciding, summarizing. It is **not** what the BMAD agents run on —
they stay on Copilot's models in VS Code. Two separate surfaces.

If you don't already have a workspace `.env`, copy `.env.example` to `.env`
and fill in your Azure details:

```dotenv
AZURE_ENDPOINT=https://your-resource.openai.azure.com
AZURE_API_KEY=your-azure-api-key
AZURE_MODEL_NAME=your-deployment-name
AZURE_API_VERSION=2025-04-01-preview
```

`AZURE_MODEL_NAME` is the Azure **deployment name**, not necessarily the model
name. It is used for all four harness roles. To use different deployments, set
`AZURE_READER_DEPLOYMENT`, `AZURE_COMPARER_DEPLOYMENT`,
`AZURE_DECIDER_DEPLOYMENT`, or `AZURE_SUMMARIZER_DEPLOYMENT`; each overrides
the shared name for that role. Omit `AZURE_API_VERSION` to use the version in
the YAML config.

The harness loads one `.env`: it first checks the directory containing the
selected config, then its parent directory. Existing process environment
variables take precedence over entries with the same name in the file. Empty
Azure variables are errors; remove an optional entry instead of leaving it
blank.

When `AZURE_API_KEY` is set, key authentication is selected automatically.
Without these environment settings, the existing `azure` YAML settings,
including custom `key_env` values, remain supported. To use `auth: aad`, remove
`AZURE_API_KEY` from both the environment and `.env`; you need the **Cognitive
Services OpenAI User** role on the resource.

**3. Tell your BMAD agents the two contracts.** Each `.agent.md` must say:

- The last thing it does is write its output file (`.harness/review.json`,
  `.harness/test.json`).
- It never asks a question in prose and stops. On a fork it writes
  `.harness/question.json` and ends its turn.

The question's `asks` field should be one string, at most 800 characters;
supporting details belong in `context` (at most 2000 characters). For
compatibility, a non-empty array of non-blank strings is also accepted and
joined with blank lines. The 800-character limit applies to the complete
joined text; nothing is truncated. Alternatives belong in `options`, not in
separate question objects. Malformed arrays still stop the run.

There's a backstop for the second one — if an agent stops without producing
anything, a model works out whether it was asking and turns it into options.
It gets logged by agent name so you can see which one keeps ignoring its
instructions.

**4. Switch the driver** to `attach` when you're ready to test against your
open VS Code session. Keep `mode: watch` for the first run.

## The VS Code driver — read before turning it on

Choose a session without starting a run:

```powershell
cd harness
npm run harness -- --select-session
```

The picker lists saved sessions for the configured repo, most recent first.
It shows whether a turn is running, waiting, idle, or archived. An idle session
may be open or closed; the session list does not tell us which. Enter a number,
or `q` to cancel. The selected ID is printed and nothing is sent to the agent.
The VS Code CLI and a running local agent host are required, but Azure is not.
The command above lists and selects only; it does not save a story binding.

An `attach` run asks for a session **the first time each story is run**, then
stores its ID outside the target repo under `.harness-state/sessions/` beside
the configuration file. Later runs of the same story reuse that session without
asking. A planned story can be bound before its file exists; creation and
implementation use the same selected session. If it is unavailable or ambiguous, the harness stops rather than
choosing another. Use `--session <full-id>` to explicitly replace a binding,
or choose and save one without starting an agent:

```powershell
npm run harness -- --select-session 1.1
```

The driver negotiates the Agent Host Protocol with the local host, verifies
the workspace and configured BMAD agents and models, and waits for each turn.
Tool requests are presented for approval in the terminal or can be resolved in
VS Code; the harness keeps watching if there is no terminal. Agent input and
authentication requests are resolved in VS Code. Tool approvals do not consume
the BMAD-question interruption budget. Do not select a session with other
working directories. The actual provider may impose additional restrictions.

Automatic approval is off by default. An entry in `tool_approvals.auto_allow`
may specify a `tool` and the exact `input_sha256` shown at the prompt. Only a
non-recursive `list_directory` request inside the repo is eligible, with an
inline JSON input containing `path` and `recursive: false`. Requests with
host risk assessments or approval options always need a person. Rules are
inactive in `watch` mode or while `decide.shadow` is on.

Each review must produce a fresh, valid `.harness/review.json` array. A prior
review is preserved under `.harness/review-previous-*` before the next review
or a continuation after a question. Missing or invalid review or question
output stops the run, rather than counting as a clean review. Local Phase 2
test output is likewise preserved before a new test turn and must be fresh.

## Three settings to get right

**`mode`** — start on `watch`, which stops and asks at every fork. Move to
`normal` when you trust it. `solo` never asks and stops instead.

**`decide.shadow`** — leave this `true` for the first week. The model writes
down what it *would* have chosen but doesn't act. The report tallies how often
it matched you, bucketed by how sure it was:

```
Agreement by how sure it was:
  low  (<70%)    7/18
  mid  (70–85%)  26/31
  high (85%+)    21/22
```

Then set `decide.confidence` from that, rather than picking a number and
finding out the hard way.

**`limits.interruptions`** — how often it may ask about BMAD decisions per epic.
The example config allows 30. Tool approvals are separate and do not consume
this budget.

**Long runs and recovery.** The example config allows seven days per epic,
500 agent turns and one day per turn. The turn limit includes time waiting for
approval. The epic time and turn caps are checked before new work starts; an
in-flight turn can continue until its separate turn timeout. These are not an
automatic process supervisor. VS Code and the harness process must remain
available, or the run must be recovered after a restart.

To inspect a bound session without sending a message:

```powershell
npm run harness -- --session-status 1.1
```

This prints recent chat responses and up to five terminals owned by that
session and chat. It does not expose unrelated VS Code terminals. Output may
contain sensitive data, so use a private terminal.

New runs save the initial story baseline and record each turn ID before
dispatch. If a run stops, use its run-directory name printed in the log:

```powershell
npm run harness -- --recover-turn <run-id> --story 1.1
npm run harness -- --recover-turn <run-id> --story 1.1 --continue
```

The first command follows or reads the recorded turn without resending it,
then reports a suggested next step. `--continue` also asks the Copilot agent
for an advisory assessment and resumes supported creation, development, review, fix,
rework, local test or retest stages against the saved baseline. It stops on
uncertainty, missing history, changed sessions, or missing test prerequisites.
Creation recovery validates the saved plan fingerprint and generated output
before implementation; it never resends the recorded creation turn.
Recovery assessments may be wrapped in completion text or repeated by the
agent host. Repeated assessments must agree on the next step; their distinct
summaries and uncertainties are combined without truncation. Conflicting,
malformed, or oversized assessments stop recovery. Both the raw response and
validated JSON are preserved in the run directory.
It does not automatically redispatch an uncertain prior CI workflow. After
inspecting the assessment, `--accept-uncertainty` explicitly overrides an
advisory mismatch; it does not bypass Phase 1. `--ask-agent` requests the
assessment without continuing. A recovered pending approval must first be
resolved in VS Code. Automatic continuation also requires the same effective
configuration and real/fake Azure mode as the original run; older runs without
a configuration fingerprint can be inspected but cannot be continued
automatically. Credential values are not stored in the fingerprint.

Customization inventory refreshes no longer terminate monitoring when the
selected agent definition and its local file are unchanged. Identical workspace
and default-chat notifications are also safe. Actual workspace/chat changes,
selected-agent changes, unavailable selections, and a different active turn
still stop recovery without replaying or cancelling the original work.
Once the exclusive recovery lock is acquired, failures before continuation are
recorded in the run log and report, including the underlying error text. Earlier
configuration and locking errors remain explicit in terminal/app output.

Recovery requires the original process to be stopped, the saved session and
run files to exist, and the original Phase 1 ignore settings to match. A local
lock prevents concurrent runs using the same config directory. Old runs without
a baseline and turn IDs cannot be resumed automatically.

The run directory contains compressed baseline copies of non-ignored files,
including potentially sensitive files other than `.env`; keep it private.

## When it stops and asks

It doesn't make you read a log. Each escalation gets a short briefing — what's
being asked, how it got here, what's already been tried — written for someone
who wasn't watching.

## What you get afterwards

```
runs/epic-10-<timestamp>/
├── report.md                   ← read this
├── log.jsonl                   ← every event, append-only
├── 10.3-reconstruction.json    ← what the code looked like, read blind
├── 10.3-comparison.json        ← how that lined up against the story
└── 10.3-blindness.json         ← what was excluded, redacted, and how the decoy went
```

The reconstruction is worth reading when something surprises you. It's the
clearest statement you'll get of what the code actually does, written without
any knowledge of what it was meant to do.

The report leads with the outcome, then every call made without you and why,
then a **Phase 1 guardrails** section — printed every run, clean or not. A
guardrail you only hear from when it fires can't be told apart from one that
stopped running.

## Layout

```
harness/                    ← this. Lives OUTSIDE your repo.
├── harness.config.yaml     ← what you edit
├── runs/                   ← one folder per run
├── fixtures/               ← canned output for dry runs
└── src/
    ├── validate/phase1.ts     ← blind reconstruction. The centre of it.
    ├── validate/blindness.ts  ← exclude, redact, assert, detect
    ├── validate/decoy.ts      ← the negative control
    ├── validate/phase2.ts     ← test-based validation
    ├── validate/diff.ts    ← what actually changed
    ├── decide/engine.ts    ← rules → model → you
    ├── bmad/stories.ts     ← reads BMAD story files
    ├── vscode/attach.ts    ← drives your open session
    ├── audit/              ← ledger + the escalation briefings
    └── run/                ← story and epic loops

your-repo/
├── .github/agents/         ← the BMAD agents
├── docs/stories/           ← the stories
└── .harness/               ← scratch; gitignore it
```

The split matters. If the config lived in the repo, an agent could edit the
rules it's meant to follow. `.github/agents/**` is in `never_touch` for the
same reason.

## Credentials

Keep `.env` outside the target repo when possible and never commit it. The
harness redacts the active Azure key and values named in `phase2.needs` from
its own logs and artifacts when the values are longer than three characters.
The Phase 1 diff excludes `.env` and `.env.*` files, even if tracked; the
non-secret `.env.example` template remains visible.
This does not prevent other processes or agents from reading an accessible
`.env` file. `testkit/mail.ts` reads verification codes from your shared Outlook
mailbox via Graph — copy it into your repo next to the Playwright tests.

Two things that bite if skipped: always pass `sentAfter` when waiting for a
code (otherwise a retry reads the previous attempt's and tells you nothing),
and clear the mailbox before each run.

## Suggested order

1. `--stories` — check it parses your story files and criteria correctly.
2. Dry run with `HARNESS_FAKE_AZURE=1`. Read the report.
3. Wire up Azure. Dry run again with the real reader on one finished story —
   compare the reconstruction against what you know that story did. This is the
   cheapest way to see whether Phase 1 is reading your codebase usefully.
4. Confirm the intended session and BMAD agent/model availability, switch to
   `attach`, and run one story in `watch` mode.
5. Move to `normal` with `shadow: true`. Leave it a week.
6. Read the shadow tally. Set `decide.confidence`. Turn shadow off.
7. Phase 2, once the test environment is up.

Step 1a, before anything else: `npm run blindcheck -- <story>` on a story
that's already finished. If it reports a leak, Phase 1 was never going to work
on your repo and everything after is wasted. If it reports that nothing was
excluded or redacted on a BMAD-written story, that's also suspicious — BMAD
almost always touches the story file.

Step 3 is the one not to skip. If the reconstruction on a story you already
understand reads as vague or wrong, the model or the diff filtering needs work
before you rely on it to gate anything.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { Story } from "../bmad/stories.js";
import { resolveRepoFile } from "../bmad/paths.js";
import { discoverSessions, selectSession, type AvailableSession } from "./sessions.js";

type SessionDiscovery = (repo: string) => Promise<AvailableSession[]>;
type SessionSelection = (sessions: AvailableSession[], options: { requested?: string }) => Promise<AvailableSession>;

const BindingFile = z.object({
  version: z.literal(1),
  repo: z.string().min(1),
  storyFile: z.string().min(1),
  storyId: z.string().min(1),
  session: z.string().min(1),
  hostType: z.string().min(1),
});

export class StoryBindings {
  private readonly repo: string;

  constructor(
    repo: string,
    private readonly root: string,
    private readonly discover: SessionDiscovery = discoverSessions,
    private readonly choose: SessionSelection = selectSession,
  ) {
    const resolved = fs.realpathSync.native(repo);
    this.repo = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  async resolve(story: Story, requested?: string, reselect = false): Promise<AvailableSession> {
    const identity = this.identity(story);
    const previous = this.read(identity.file);
    if (previous && (previous.repo !== this.repo || previous.storyFile !== identity.storyFile)) {
      throw new Error("The saved story-session binding does not match this repository and story.");
    }

    const sessions = await this.discover(this.repo);
    if (previous && requested === undefined && !reselect) {
      const matches = sessions.filter((session) =>
        session.resource === previous.session && session.host.type === previous.hostType);
      if (matches.length !== 1) {
        throw new Error(
          `The saved session for story ${story.id} is unavailable or ambiguous. ` +
          "Restore that session, or explicitly select a replacement with --session <id>.",
        );
      }
      return matches[0]!;
    }

    const selected = await this.choose(sessions, { requested });
    const binding = {
      version: 1 as const, repo: this.repo, storyFile: identity.storyFile, storyId: story.id,
      session: selected.resource, hostType: selected.host.type,
    };
    this.write(identity.file, binding);
    return selected;
  }

  async resolveExisting(story: Story): Promise<AvailableSession> {
    const identity = this.identity(story);
    if (!this.read(identity.file)) {
      throw new Error(`No saved session exists for story ${story.id}; recovery requires manual inspection.`);
    }
    return this.resolve(story);
  }

  private identity(story: Story): { file: string; storyFile: string } {
    let resolved: string;
    try {
      resolved = resolveRepoFile(this.repo, story.file);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Path must be inside")) {
        throw new Error(`Story ${story.id} is not inside the configured repository.`);
      }
      throw error;
    }
    const storyFile = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const relative = path.relative(this.repo, storyFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Story ${story.id} is not inside the configured repository.`);
    }
    const key = createHash("sha256").update(this.repo).update("\0").update(storyFile).digest("hex");
    return { file: path.join(this.root, `${key}.json`), storyFile };
  }

  private read(file: string): z.infer<typeof BindingFile> | undefined {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Saved session binding is not valid JSON: ${file}`);
    }
    const result = BindingFile.safeParse(value);
    if (!result.success) throw new Error(`Saved session binding is invalid: ${file}`);
    return result.data;
  }

  private write(file: string, value: z.infer<typeof BindingFile>): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch (cleanup) {
        if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT")) throw cleanup;
      }
      throw error;
    }
  }
}

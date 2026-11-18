import * as fs from "node:fs";
import * as path from "node:path";
import type { VSCode, Turn, Reply } from "./types.js";

/**
 * A pretend VS Code session.
 *
 * Nothing real runs. This is how you check the harness works — the stages, the
 * decisions, Phase 1, the audit trail — before pointing it at your actual
 * session, and how you test changes without spending anything.
 *
 * It reads canned replies from `fixtures/<story>/`:
 *   <agent>.reply.txt       what the agent "says"
 *   <agent>.question.json   a question it asks, once, before carrying on
 *   <agent>.files/          files it "writes" into the repo
 */
export class StubSession implements VSCode {
  private asked = new Set<string>();

  constructor(private repo: string, private fixtures = "fixtures", private story = "") {}

  get describe() { return `stub session on ${path.basename(this.repo)}`; }
  get folder() { return this.repo; }

  async attach() {
    console.log("  (stub — nothing real is running)");
  }

  setStory(id: string) { this.story = id; this.asked.clear(); }

  async send(turn: Turn): Promise<Reply> {
    console.log(`      [stub] ${turn.agent} @ ${turn.model}`);

    const dir = path.join(this.fixtures, this.story);

    // Ask a question once, then carry on — like the real thing.
    const q = path.join(dir, `${turn.agent}.question.json`);
    if (fs.existsSync(q) && !this.asked.has(turn.agent)) {
      this.asked.add(turn.agent);
      fs.mkdirSync(path.join(this.repo, ".harness"), { recursive: true });
      fs.writeFileSync(path.join(this.repo, ".harness", "question.json"), fs.readFileSync(q));
      return { text: "I need a decision before I can continue.", changed: [], idle: true };
    }

    // Copy in whatever files this agent "writes".
    const filesDir = path.join(dir, `${turn.agent}.files`);
    const changed: string[] = [];
    if (fs.existsSync(filesDir)) {
      for (const rel of walkRel(filesDir)) {
        const dest = path.join(this.repo, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(filesDir, rel), dest);
        changed.push(rel);
      }
    }

    const replyFile = path.join(dir, `${turn.agent}.reply.txt`);
    const text = fs.existsSync(replyFile)
      ? fs.readFileSync(replyFile, "utf8")
      : `[stub] ${turn.agent} finished.`;

    return { text, changed, idle: true };
  }

  readFile(rel: string): string | null {
    const p = path.join(this.repo, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }

  removeFile(rel: string): void {
    const p = path.join(this.repo, rel);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async detach() {}
}

function walkRel(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, e.name);
    if (e.isDirectory()) out.push(...walkRel(root, rel));
    else out.push(rel);
  }
  return out;
}

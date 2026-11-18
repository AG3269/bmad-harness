import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { Finding } from "../decide/engine.js";
import type { VSCode } from "../vscode/types.js";

const Findings = z.array(z.object({
  id: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  kind: z.string().min(1),
  file: z.string(),
  what: z.string().min(1),
  suggested_fix: z.string(),
  is_proof_gap: z.boolean(),
}));

export function archivePreviousReview(repo: string): string | null {
  return archivePreviousOutput(repo, "review");
}

export function archivePreviousTest(repo: string): string | null {
  return archivePreviousOutput(repo, "test");
}

function archivePreviousOutput(repo: string, kind: "review" | "test"): string | null {
  const dir = path.join(repo, ".harness");
  const filename = `${kind}.json`;
  const source = path.join(dir, filename);
  try {
    const parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error(".harness must be a real directory, not a symbolic link.");
    }
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`.harness/${filename} must be a regular file.`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  const archive = fs.mkdtempSync(path.join(dir, `${kind}-previous-`));
  const destination = path.join(archive, filename);
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    fs.rmdirSync(archive);
    throw error;
  }
  return path.relative(repo, destination);
}

export function readReview(vscode: Pick<VSCode, "folder" | "readFile">): Finding[] {
  const raw = readFreshOutput(vscode, "review");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The fresh .harness/review.json is not valid JSON.");
  }
  const result = Findings.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new Error(`The fresh .harness/review.json has invalid findings at: ${issues}.`);
  }
  return result.data;
}

export function readFreshOutput(vscode: Pick<VSCode, "folder" | "readFile">, kind: "review" | "test"): string {
  const filename = `${kind}.json`;
  const file = path.join(vscode.folder, ".harness", filename);
  try {
    const parent = fs.lstatSync(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`The fresh .harness/${filename} must be a regular file in a real directory.`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${kind === "review" ? "Review" : "Test"} did not produce a fresh .harness/${filename}.`);
    }
    throw error;
  }
  const raw = vscode.readFile(`.harness/${filename}`);
  if (raw === null) throw new Error(`${kind === "review" ? "Review" : "Test"} did not produce a fresh .harness/${filename}.`);
  return raw;
}

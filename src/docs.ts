import fs from "node:fs";
import path from "node:path";
import { markdownToPlain } from "./text";

export interface CliDocs {
  rootDir: string;
  readmePath: string;
  skillPath: string;
}

export function resolveCliRoot(): string {
  return path.resolve(__dirname, "..");
}

export function resolveDocs(): CliDocs {
  const root = resolveCliRoot();
  return {
    rootDir: root,
    readmePath: path.join(root, "README.md"),
    skillPath: path.join(root, "SKILL.md"),
  };
}

export function readDoc(kind: string, plain = false): string {
  const docs = resolveDocs();
  const normalized = String(kind || "").trim().toLowerCase();
  let text = "";
  if (normalized === "readme") {
    text = fs.readFileSync(docs.readmePath, "utf8");
  } else if (normalized === "skill") {
    text = fs.readFileSync(docs.skillPath, "utf8");
  } else {
    throw new Error(`unknown_doc:${kind}`);
  }
  return plain ? markdownToPlain(text) : text;
}


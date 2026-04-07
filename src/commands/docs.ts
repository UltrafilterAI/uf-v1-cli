import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { readDoc, resolveDocs } from "../docs";
import { withRuntime, type CommandContext } from "../commandContext";

export function registerDocsCommands(program: Command, context: CommandContext): void {
  const docs = program.command("docs").description("Read CLI documentation and skill guidance");

  docs
    .command("readme")
    .description("Print CLI README")
    .option("--plain", "Render README as simplified plain text")
    .action(
      withRuntime(context, async (runtime, options: { plain?: boolean }) => {
        const text = readDoc("readme", Boolean(options?.plain));
        return runtime.emitSuccess({ data: { kind: "readme", content: text }, human: text.trimEnd() });
      })
    );

  docs
    .command("skill")
    .description("Print CLI skill instructions")
    .option("--plain", "Render SKILL as simplified plain text")
    .action(
      withRuntime(context, async (runtime, options: { plain?: boolean }) => {
        const text = readDoc("skill", Boolean(options?.plain));
        return runtime.emitSuccess({ data: { kind: "skill", content: text }, human: text.trimEnd() });
      })
    );

  docs
    .command("paths")
    .description("Show documentation file paths")
    .action(
      withRuntime(context, async (runtime) => {
        const docsPaths = resolveDocs();
        const payload = {
          root_dir: docsPaths.rootDir,
          readme_path: docsPaths.readmePath,
          skill_path: docsPaths.skillPath,
          exists: {
            readme: fs.existsSync(docsPaths.readmePath),
            skill: fs.existsSync(docsPaths.skillPath),
          },
        };
        return runtime.emitSuccess({
          data: payload,
          human: [`root:   ${payload.root_dir}`, `readme: ${payload.readme_path}`, `skill:  ${payload.skill_path}`],
        });
      })
    );

  docs
    .command("tree")
    .description("Show CLI package tree")
    .action(
      withRuntime(context, async (runtime) => {
        const docsPaths = resolveDocs();
        const root = docsPaths.rootDir;
        const files = listFiles(root);
        const lines = ["cli/", "  README.md", "  SKILL.md"];
        for (const file of files) {
          const rel = path.relative(root, file);
          if (rel === "README.md" || rel === "SKILL.md") {
            continue;
          }
          const parts = rel.split(path.sep).filter(Boolean);
          const depth = parts.length;
          lines.push(`${"  ".repeat(depth)}${parts[parts.length - 1]}`);
        }
        return runtime.emitSuccess({ data: { tree: lines }, human: lines.join("\n") });
      })
    );
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      out.push(...listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
}

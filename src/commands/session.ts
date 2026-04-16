import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";
import { CliError } from "../errors";

type GenericRecord = Record<string, any>;

function resolveProjectId(options: Record<string, any>, runtime: any): string {
  const explicit = String(options.projectId || "").trim();
  if (explicit) {
    return explicit;
  }
  const envValue = String(process.env.UF_PROJECT_ID || "").trim();
  if (envValue) {
    return envValue;
  }
  const current = String(runtime.profile.current_project_id || "").trim();
  if (current) {
    return current;
  }
  throw new CliError({
    errorCode: "project_required",
    message: "Project context is required. Use `uf project use <id>` or pass `--project-id`.",
    exitCode: 5,
    recoverable: true,
    nextActions: ["Run `uf project list` then `uf project use <id>`."],
  });
}

function preferWorkSessionAuth(runtime: any): "api_key" | "session" {
  return runtime.resolvedApiKey() ? "api_key" : "session";
}

function listLine(row: GenericRecord): string {
  const kind = String(row.kind || "unknown").toUpperCase();
  const title = String(row.title || "");
  const status = String(row.status || "unknown");
  const stage = String(row.stage || "").trim();
  const updatedAt = String(row.updated_at || "");
  return `${kind}  ${status}${stage ? `/${stage}` : ""}  ${title}  ${updatedAt}`;
}

export function registerSessionCommands(program: Command, context: CommandContext): void {
  const session = program.command("session").description("Shared work session visibility across UI and CLI");

  session
    .command("list")
    .description("List shared work sessions for the current project")
    .option("--project-id <projectId>", "Project id (defaults to current project for session auth)")
    .option("--limit <limit>", "Maximum rows to return", parseInteger, 25)
    .action(
      withRuntime(context, async (runtime, options: { projectId?: string; limit: number }) => {
        const auth = preferWorkSessionAuth(runtime);
        const projectId = auth === "session" ? resolveProjectId(options as Record<string, any>, runtime) : undefined;
        const rows = (await runtime.request({
          method: "GET",
          path: "/work-sessions",
          auth,
          query: {
            project_id: projectId,
            limit: options.limit,
          },
        })) as GenericRecord[];
        const human = Array.isArray(rows) && rows.length ? rows.map((row) => listLine(row)).join("\n") : "No shared work sessions found.";
        return runtime.emitSuccess({ data: rows, human });
      })
    );

  session
    .command("show <ref>")
    .description("Show one shared work session by ref, for example index:<uuid>")
    .action(
      withRuntime(context, async (runtime, ref: string) => {
        const auth = preferWorkSessionAuth(runtime);
        const payload = (await runtime.request({
          method: "GET",
          path: `/work-sessions/${encodeURIComponent(ref)}`,
          auth,
        })) as GenericRecord;
        const human = [listLine(payload), payload.summary ? `summary: ${JSON.stringify(payload.summary)}` : ""]
          .filter(Boolean)
          .join("\n");
        return runtime.emitStructured({ payload, human });
      })
    );
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

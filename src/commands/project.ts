import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";
import { CliError } from "../errors";

const DEFAULT_SCOPES = ["index:write", "search:read"];
const MANAGED_KEY_PREFIX_PATTERN = /^(uf_[^_]+_[^_]+)_/;

type KeyResolutionStatus = "resolved" | "no_session" | "no_match" | "ambiguous" | "invalid_key_format";

async function getMe(runtime: any): Promise<Record<string, any>> {
  return (await runtime.request({ method: "GET", path: "/control/me", auth: "session" })) as Record<string, any>;
}

function parseManagedKeyPrefix(rawKey: string): string | null {
  const match = MANAGED_KEY_PREFIX_PATTERN.exec(rawKey.trim());
  return match ? String(match[1]) : null;
}

async function resolveApiKeyUseMetadata(
  runtime: any,
  rawApiKey: string,
  explicitApiKeyId?: string
): Promise<{ activeApiKeyId: string | null; resolutionStatus: KeyResolutionStatus; matchedCount: number }> {
  if (explicitApiKeyId) {
    return {
      activeApiKeyId: explicitApiKeyId,
      resolutionStatus: "resolved",
      matchedCount: 1,
    };
  }

  const keyPrefix = parseManagedKeyPrefix(rawApiKey);
  if (!keyPrefix) {
    return {
      activeApiKeyId: null,
      resolutionStatus: "invalid_key_format",
      matchedCount: 0,
    };
  }

  if (!runtime.resolvedSessionToken()) {
    return {
      activeApiKeyId: null,
      resolutionStatus: "no_session",
      matchedCount: 0,
    };
  }

  let rows: Array<Record<string, any>> = [];
  try {
    rows = (await runtime.request({
      method: "GET",
      path: "/control/api-keys",
      auth: "session",
    })) as Array<Record<string, any>>;
  } catch (err) {
    if (err instanceof CliError && err.errorCode === "auth_required") {
      return {
        activeApiKeyId: null,
        resolutionStatus: "no_session",
        matchedCount: 0,
      };
    }
    throw err;
  }

  const matches = rows.filter(
    (row) => String(row.key_prefix || "") === keyPrefix && String(row.status || "active") === "active"
  );
  if (matches.length === 1) {
    return {
      activeApiKeyId: String(matches[0].id || "") || null,
      resolutionStatus: "resolved",
      matchedCount: 1,
    };
  }
  if (matches.length === 0) {
    return {
      activeApiKeyId: null,
      resolutionStatus: "no_match",
      matchedCount: 0,
    };
  }
  return {
    activeApiKeyId: null,
    resolutionStatus: "ambiguous",
    matchedCount: matches.length,
  };
}

function resolveProjectId(options: Record<string, any>, runtime: any, required: boolean): string | undefined {
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
  if (required) {
    throw new CliError({
      errorCode: "project_required",
      message: "Project context is required. Use `uf project use <id>` or pass `--project-id`.",
      exitCode: 5,
      recoverable: true,
      nextActions: ["Run `uf project list` then `uf project use <id>`."],
    });
  }
  return undefined;
}

export function registerProjectCommands(program: Command, context: CommandContext): void {
  const project = program.command("project").description("Project context commands");

  project.command("list").description("List available projects").action(
    withRuntime(context, async (runtime) => {
      const me = await getMe(runtime);
      const projects = Array.isArray(me.projects) ? me.projects : [];
      const human = projects.map((p) => `${String(p.id)}  ${String(p.name)}`).join("\n");
      return runtime.emitSuccess({ data: projects, human: human || "No projects found." });
    })
  );

  project.command("current").description("Show current project from profile").action(
    withRuntime(context, async (runtime) => {
      const data = {
        project_id: runtime.profile.current_project_id || null,
        project_name: runtime.profile.current_project_name || null,
      };
      const human = data.project_id ? `${data.project_id}  ${data.project_name || ""}`.trim() : "No active project.";
      return runtime.emitSuccess({ data, human });
    })
  );

  project
    .command("use <project>")
    .description("Set active project by id or name")
    .action(
      withRuntime(context, async (runtime, projectNameOrId: string) => {
        const me = await getMe(runtime);
        const projects = Array.isArray(me.projects) ? me.projects : [];
        const selected = projects.find(
          (p) => String(p.id) === projectNameOrId || String(p.name) === projectNameOrId
        );
        if (!selected) {
          throw new CliError({
            errorCode: "project_not_found",
            message: `Project not found: ${projectNameOrId}`,
            exitCode: 4,
            recoverable: true,
            nextActions: ["Run `uf project list` and choose a valid project id."],
          });
        }
        runtime.profile.current_project_id = String(selected.id);
        runtime.profile.current_project_name = String(selected.name);
        runtime.saveProfile();
        return runtime.emitSuccess({
          data: {
            project_id: runtime.profile.current_project_id,
            project_name: runtime.profile.current_project_name,
          },
          human: `Active project set: ${runtime.profile.current_project_id} (${runtime.profile.current_project_name})`,
        });
      })
    );

  project
    .command("create")
    .description("Create a project")
    .requiredOption("--name <name>", "Project name")
    .option("--use", "Set created project as current")
    .action(
      withRuntime(context, async (runtime, options: { name: string; use?: boolean }) => {
        const created = await runtime.request({
          method: "POST",
          path: "/control/projects",
          auth: "session",
          body: { name: options.name },
        });
        const obj = created as Record<string, any>;
        if (options.use) {
          runtime.profile.current_project_id = String(obj.id || "");
          runtime.profile.current_project_name = String(obj.name || "");
          runtime.saveProfile();
        }
        return runtime.emitSuccess({
          data: created,
          human: `Project created: ${String(obj.id)} (${String(obj.name)})`,
        });
      })
    );

  const key = project.command("key").description("API key management");

  key
    .command("list")
    .description("List API keys")
    .option("--project-id <projectId>", "Filter by project id")
    .action(
      withRuntime(context, async (runtime, options: { projectId?: string }) => {
        const rows = (await runtime.request({
          method: "GET",
          path: "/control/api-keys",
          auth: "session",
        })) as Array<Record<string, any>>;
        const projectId = resolveProjectId(options as Record<string, any>, runtime, false);
        const filtered = projectId ? rows.filter((row) => String(row.project_id) === projectId) : rows;
        const human = filtered
          .map(
            (row) =>
              `${String(row.id)}  ${String(row.name)}  ${String(row.project_id)}  ${String(
                (row.scopes || []).join(",")
              )}  ${String(row.status)}`
          )
          .join("\n");
        return runtime.emitSuccess({ data: filtered, human: human || "No API keys found." });
      })
    );

  key
    .command("create")
    .description("Create an API key")
    .option("--project-id <projectId>", "Project id (defaults to current project)")
    .option("--name <name>", "API key label", "cli")
    .option("--scope <scope>", "Scope value; repeatable", collect, [])
    .option("--activate", "Persist new key as active profile key")
    .option("--no-activate", "Do not persist key in profile")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: {
            projectId?: string;
            name: string;
            scope?: string[];
            activate?: boolean;
          }
        ) => {
          const projectId = resolveProjectId(options as Record<string, any>, runtime, true);
          const scopes = options.scope && options.scope.length ? options.scope : DEFAULT_SCOPES;
          const created = await runtime.request({
            method: "POST",
            path: "/control/api-keys",
            auth: "session",
            body: {
              project_id: projectId,
              name: options.name,
              scopes,
            },
          });
          const obj = created as Record<string, any>;
          if (options.activate !== false) {
            runtime.profile.active_api_key = String(obj.api_key || "");
            runtime.profile.active_api_key_id = String((obj.key || {}).id || "") || null;
            runtime.saveProfile();
          }
          return runtime.emitSuccess({
            data: created,
            human: `API key created: ${String((obj.key || {}).id)} (raw key shown in JSON mode)`,
          });
        }
      )
    );

  key
    .command("revoke <apiKeyId>")
    .description("Revoke API key by id")
    .action(
      withRuntime(context, async (runtime, apiKeyId: string) => {
        const data = await runtime.request({
          method: "DELETE",
          path: `/control/api-keys/${apiKeyId}`,
          auth: "session",
        });
        if (String(runtime.profile.active_api_key_id || "") === apiKeyId) {
          runtime.profile.active_api_key = null;
          runtime.profile.active_api_key_id = null;
          runtime.saveProfile();
        }
        return runtime.emitSuccess({ data, human: `Revoked API key: ${apiKeyId}` });
      })
    );

  key
    .command("use <apiKey>")
    .description("Set active raw API key locally")
    .option("--id <apiKeyId>", "Optional API key id metadata")
    .action(
      withRuntime(context, async (runtime, apiKey: string, options: { id?: string }) => {
        const rawKey = apiKey.trim();
        const metadata = await resolveApiKeyUseMetadata(runtime, rawKey, options.id ? options.id.trim() : undefined);
        runtime.profile.active_api_key = rawKey;
        runtime.profile.active_api_key_id = metadata.activeApiKeyId;
        runtime.saveProfile();
        const resolutionLabels: Record<KeyResolutionStatus, string> = {
          resolved: "resolved",
          no_session: "saved, but no session available for API key id resolution",
          no_match: "saved, but no matching managed key prefix found",
          ambiguous: "saved, but key prefix matched multiple keys",
          invalid_key_format: "saved, but key format cannot be resolved to managed key prefix",
        };
        return runtime.emitSuccess({
          data: {
            active_api_key_set: true,
            active_api_key_id: runtime.profile.active_api_key_id,
            resolution_status: metadata.resolutionStatus,
            matched_count: metadata.matchedCount,
          },
          human: `Active API key updated in local profile (${resolutionLabels[metadata.resolutionStatus]}).`,
        });
      })
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";

type GenericRecord = Record<string, unknown>;

type ProjectContext = {
  project_count: number;
  current_project_id: string | null;
  current_project_name: string | null;
  project_selection_required: boolean;
};

function toProjects(meObj: GenericRecord): GenericRecord[] {
  const raw = meObj.projects;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((row) => row && typeof row === "object" && !Array.isArray(row)) as GenericRecord[];
}

function syncProjectContext(runtime: any, meObj: GenericRecord): ProjectContext {
  const projects = toProjects(meObj);
  const existingId = String(runtime.profile.current_project_id || "").trim();
  let selected: GenericRecord | undefined;

  if (existingId) {
    selected = projects.find((project) => String(project.id || "") === existingId);
  }
  if (!selected && projects.length === 1) {
    selected = projects[0];
  }

  if (selected) {
    runtime.profile.current_project_id = String(selected.id || "") || null;
    runtime.profile.current_project_name = String(selected.name || "") || null;
  } else {
    runtime.profile.current_project_id = null;
    runtime.profile.current_project_name = null;
  }
  runtime.saveProfile();

  return {
    project_count: projects.length,
    current_project_id: runtime.profile.current_project_id || null,
    current_project_name: runtime.profile.current_project_name || null,
    project_selection_required: projects.length > 1 && !selected,
  };
}

function profileProjectFallback(runtime: any): Pick<ProjectContext, "current_project_id" | "current_project_name"> {
  return {
    current_project_id: runtime.profile.current_project_id || null,
    current_project_name: runtime.profile.current_project_name || null,
  };
}

function humanAuthMessage(
  label: string,
  meObj: GenericRecord,
  projectContext: ProjectContext
): string {
  let message = `${label}: ${String(meObj.email)} (${String(meObj.user_id)})`;
  if (projectContext.project_selection_required) {
    message += " | Multiple projects found. Run `uf project use <id>`.";
    return message;
  }
  if (projectContext.current_project_id) {
    message += ` | Active project ${projectContext.current_project_id} (${projectContext.current_project_name || "unknown"})`;
  }
  return message;
}

async function completeAuthSuccess(
  runtime: any,
  sessionData: unknown,
  successLabel: string
): Promise<number> {
  runtime.profile.session_token = String((sessionData as GenericRecord).token || "");
  const me = (await runtime.request({ method: "GET", path: "/control/me", auth: "session" })) as GenericRecord;
  const projectContext = syncProjectContext(runtime, me);
  return runtime.emitSuccess({
    data: { session: sessionData, me, ...projectContext },
    human: humanAuthMessage(successLabel, me, projectContext),
  });
}

export function registerAuthCommands(program: Command, context: CommandContext): void {
  const auth = program.command("auth").description("Authentication and session commands");
  const key = auth.command("key").description("API key agent authentication");

  auth
    .command("signup")
    .description("Create account and open a new session")
    .requiredOption("--email <email>", "User email")
    .requiredOption("--password <password>", "User password")
    .requiredOption("--organization-name <organizationName>", "Organization name")
    .requiredOption("--project-name <projectName>", "Project name")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: { email: string; password: string; organizationName: string; projectName: string }
        ) => {
          const data = await runtime.request({
            method: "POST",
            path: "/control/signup",
            auth: "none",
            body: {
              email: options.email,
              password: options.password,
              organization_name: options.organizationName,
              project_name: options.projectName,
            },
          });
          return completeAuthSuccess(runtime, data, "Signup successful");
        }
      )
    );

  auth
    .command("login")
    .description("Login with email and password")
    .requiredOption("--email <email>", "User email")
    .requiredOption("--password <password>", "User password")
    .action(
      withRuntime(
        context,
        async (runtime, options: { email: string; password: string }) => {
          const data = await runtime.request({
            method: "POST",
            path: "/control/login",
            auth: "none",
            body: {
              email: options.email,
              password: options.password,
            },
          });
          return completeAuthSuccess(runtime, data, "Logged in");
        }
      )
    );

  auth
    .command("dev-login")
    .description("Login via dev backdoor token")
    .requiredOption("--token <token>", "Dev backdoor token")
    .option("--email <email>", "Dev user email", "dev@ultrafilter.local")
    .option("--organization-name <organizationName>", "Organization name", "Dev Org")
    .option("--project-name <projectName>", "Project name", "Dev Project")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: { token: string; email: string; organizationName: string; projectName: string }
        ) => {
          const data = await runtime.request({
            method: "POST",
            path: "/control/dev-login",
            auth: "none",
            body: {
              token: options.token,
              email: options.email,
              organization_name: options.organizationName,
              project_name: options.projectName,
            },
          });
          return completeAuthSuccess(runtime, data, "Dev login successful");
        }
      )
    );

  auth.command("logout").description("Clear local session token").action(
    withRuntime(context, async (runtime) => {
      runtime.profile.session_token = null;
      runtime.saveProfile();
      return runtime.emitSuccess({ data: { logged_out: true }, human: "Logged out." });
    })
  );

  auth.command("status").description("Check authentication status").action(
    withRuntime(context, async (runtime) => {
      const token = runtime.resolvedSessionToken();
      if (!token) {
        const profileProject = profileProjectFallback(runtime);
        return runtime.emitSuccess({
          data: {
            authenticated: false,
            reason: "missing_session_token",
            project_count: 0,
            current_project_id: profileProject.current_project_id,
            current_project_name: profileProject.current_project_name,
            project_selection_required: false,
          },
          human: "Not authenticated.",
        });
      }
      try {
        const me = (await runtime.request({ method: "GET", path: "/control/me", auth: "session" })) as GenericRecord;
        const meObj = me as GenericRecord;
        const projectContext = syncProjectContext(runtime, meObj);
        return runtime.emitSuccess({
          data: { authenticated: true, me, ...projectContext },
          human: humanAuthMessage("Authenticated", meObj, projectContext),
        });
      } catch (err) {
        const profileProject = profileProjectFallback(runtime);
        return runtime.emitSuccess({
          data: {
            authenticated: false,
            reason: String((err as Error)?.message || err),
            project_count: null,
            current_project_id: profileProject.current_project_id,
            current_project_name: profileProject.current_project_name,
            project_selection_required: false,
          },
          human: `Session is not valid: ${String((err as Error)?.message || err)}`,
        });
      }
    })
  );

  auth.command("whoami").description("Show current user from control plane").action(
    withRuntime(context, async (runtime) => {
      const me = (await runtime.request({ method: "GET", path: "/control/me", auth: "session" })) as GenericRecord;
      const meObj = me as GenericRecord;
      const projectContext = syncProjectContext(runtime, meObj);
      return runtime.emitSuccess({
        data: { me, ...projectContext },
        human: humanAuthMessage("Current user", meObj, projectContext),
      });
    })
  );

  key
    .command("use <apiKey>")
    .description("Validate and store an agent API key")
    .action(
      withRuntime(context, async (runtime, apiKey: string) => {
        const rawKey = apiKey.trim();
        const response = await runtime.httpClient().requestJson({
          method: "GET",
          path: "/control/api-key-status",
          headers: {
            "X-API-Key": rawKey,
            Accept: "application/json",
          },
        });
        const payload = response.data as GenericRecord;
        runtime.profile.active_api_key = rawKey;
        runtime.profile.active_api_key_id = String(payload.key_id || "") || null;
        runtime.profile.current_project_id = String(payload.project_id || "") || null;
        runtime.profile.current_project_name = String(payload.project_name || "") || null;
        runtime.saveProfile();
        return runtime.emitStructured({
          payload,
          human: `Active agent key set for project ${String(payload.project_name || payload.project_id || "unknown")}.`,
        });
      })
    );

  key
    .command("status")
    .description("Inspect the current agent API key")
    .action(
      withRuntime(context, async (runtime) => {
        const payload = (await runtime.request({
          method: "GET",
          path: "/control/api-key-status",
          auth: "api_key",
        })) as GenericRecord;
        if (payload.project_id) {
          runtime.profile.current_project_id = String(payload.project_id || "") || null;
          runtime.profile.current_project_name = String(payload.project_name || "") || null;
          runtime.profile.active_api_key_id = String(payload.key_id || "") || runtime.profile.active_api_key_id || null;
          runtime.saveProfile();
        }
        return runtime.emitStructured({
          payload,
          human: `Agent key is authenticated for project ${String(payload.project_name || payload.project_id || "unknown")}.`,
        });
      })
    );
}

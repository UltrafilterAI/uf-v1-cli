import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { registerAuthCommands } from "../src/commands/auth";
import { registerProjectCommands } from "../src/commands/project";
import { CliRuntime } from "../src/runtime";

type RequestParams = Record<string, unknown>;
type RequestHandler = (params: RequestParams) => unknown;

class FakeRuntime {
  public readonly calls: RequestParams[] = [];
  public readonly profile: Record<string, unknown>;
  public lastSuccess: { data: unknown; human?: string | string[] } | null = null;
  public lastErrorCode: number | null = null;
  private readonly requestHandler: RequestHandler;
  private readonly sessionToken?: string;

  constructor(params: {
    requestHandler: RequestHandler;
    profile?: Record<string, unknown>;
    sessionToken?: string;
  }) {
    this.requestHandler = params.requestHandler;
    this.sessionToken = params.sessionToken;
    this.profile = {
      session_token: null,
      current_project_id: null,
      current_project_name: null,
      active_api_key: null,
      active_api_key_id: null,
      ...(params.profile || {}),
    };
  }

  async request(params: RequestParams): Promise<unknown> {
    this.calls.push(params);
    return this.requestHandler(params);
  }

  saveProfile(): void {}

  resolvedSessionToken(): string | undefined {
    if (this.sessionToken !== undefined) {
      return this.sessionToken;
    }
    const token = this.profile.session_token;
    return typeof token === "string" && token.trim() ? token : undefined;
  }

  emitSuccess(payload: { data: unknown; human?: string | string[] }): number {
    this.lastSuccess = payload;
    return 0;
  }

  emitError(err: { exitCode: number }): number {
    this.lastErrorCode = err.exitCode;
    return err.exitCode;
  }
}

function parseWithRuntime(
  argv: string[],
  register: (program: Command, context: { exitCode: number }) => void,
  runtime: FakeRuntime
): Promise<{ exitCode: number }> {
  const context = { exitCode: 2 };
  const program = new Command();
  register(program, context);
  vi.spyOn(CliRuntime, "fromCommand").mockReturnValue(runtime as unknown as CliRuntime);
  return program.parseAsync(argv, { from: "user" }).then(() => context);
}

describe("auth commands", () => {
  test("signup auto-selects the only project", async () => {
    const runtime = new FakeRuntime({
      requestHandler: (params) => {
        const path = String(params.path || "");
        if (path === "/control/signup") {
          return { token: "session-1" };
        }
        if (path === "/control/me") {
          return {
            user_id: "user_1",
            email: "agent@example.com",
            projects: [{ id: "proj_1", name: "Project One" }],
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const out = await parseWithRuntime(
      [
        "auth",
        "signup",
        "--email",
        "agent@example.com",
        "--password",
        "verysecurepass",
        "--organization-name",
        "Org One",
        "--project-name",
        "Project One",
      ],
      registerAuthCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(runtime.profile.current_project_id).toBe("proj_1");
    expect(data.project_count).toBe(1);
    expect(data.project_selection_required).toBe(false);
    vi.restoreAllMocks();
  });

  test("login preserves pinned project when still present", async () => {
    const runtime = new FakeRuntime({
      profile: {
        current_project_id: "proj_2",
        current_project_name: "Old Name",
      },
      requestHandler: (params) => {
        const path = String(params.path || "");
        if (path === "/control/login") {
          return { token: "session-2" };
        }
        if (path === "/control/me") {
          return {
            user_id: "user_2",
            email: "agent@example.com",
            projects: [
              { id: "proj_1", name: "Project One" },
              { id: "proj_2", name: "Project Two" },
            ],
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const out = await parseWithRuntime(
      ["auth", "login", "--email", "agent@example.com", "--password", "verysecurepass"],
      registerAuthCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(runtime.profile.current_project_id).toBe("proj_2");
    expect(runtime.profile.current_project_name).toBe("Project Two");
    expect(data.project_selection_required).toBe(false);
    vi.restoreAllMocks();
  });

  test("login marks project selection required for multi-project account with no pinned project", async () => {
    const runtime = new FakeRuntime({
      requestHandler: (params) => {
        const path = String(params.path || "");
        if (path === "/control/login") {
          return { token: "session-3" };
        }
        if (path === "/control/me") {
          return {
            user_id: "user_3",
            email: "agent@example.com",
            projects: [
              { id: "proj_1", name: "Project One" },
              { id: "proj_2", name: "Project Two" },
            ],
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const out = await parseWithRuntime(
      ["auth", "login", "--email", "agent@example.com", "--password", "verysecurepass"],
      registerAuthCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(runtime.profile.current_project_id).toBeNull();
    expect(runtime.profile.current_project_name).toBeNull();
    expect(data.project_selection_required).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("project key use", () => {
  test("resolves active_api_key_id when key prefix has a unique match", async () => {
    const runtime = new FakeRuntime({
      sessionToken: "session-1",
      requestHandler: (params) => {
        const path = String(params.path || "");
        if (path === "/control/api-keys") {
          return [
            { id: "key_1", key_prefix: "uf_live_abcd1234", status: "active" },
            { id: "key_2", key_prefix: "uf_live_ffff1111", status: "active" },
          ];
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const out = await parseWithRuntime(
      ["project", "key", "use", "uf_live_abcd1234_secretPart"],
      registerProjectCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(data.active_api_key_id).toBe("key_1");
    expect(data.resolution_status).toBe("resolved");
    expect(data.matched_count).toBe(1);
    vi.restoreAllMocks();
  });

  test("returns no_session when token is unavailable", async () => {
    const runtime = new FakeRuntime({
      sessionToken: undefined,
      requestHandler: () => {
        throw new Error("request should not be called without session");
      },
    });
    const out = await parseWithRuntime(
      ["project", "key", "use", "uf_live_abcd1234_secretPart"],
      registerProjectCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(data.active_api_key_id).toBeNull();
    expect(data.resolution_status).toBe("no_session");
    expect(data.matched_count).toBe(0);
    expect(runtime.calls.length).toBe(0);
    vi.restoreAllMocks();
  });

  test("returns ambiguous when key prefix matches multiple active keys", async () => {
    const runtime = new FakeRuntime({
      sessionToken: "session-2",
      requestHandler: (params) => {
        const path = String(params.path || "");
        if (path === "/control/api-keys") {
          return [
            { id: "key_1", key_prefix: "uf_live_abcd1234", status: "active" },
            { id: "key_2", key_prefix: "uf_live_abcd1234", status: "active" },
          ];
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const out = await parseWithRuntime(
      ["project", "key", "use", "uf_live_abcd1234_secretPart"],
      registerProjectCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(data.active_api_key_id).toBeNull();
    expect(data.resolution_status).toBe("ambiguous");
    expect(data.matched_count).toBe(2);
    vi.restoreAllMocks();
  });

  test("returns no_match when prefix is valid but not found in key list", async () => {
    const runtime = new FakeRuntime({
      sessionToken: "session-4",
      requestHandler: (params) => {
        const path = String(params.path || "");
        if (path === "/control/api-keys") {
          return [{ id: "key_1", key_prefix: "uf_live_other000", status: "active" }];
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const out = await parseWithRuntime(
      ["project", "key", "use", "uf_live_abcd1234_secretPart"],
      registerProjectCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(data.active_api_key_id).toBeNull();
    expect(data.resolution_status).toBe("no_match");
    expect(data.matched_count).toBe(0);
    vi.restoreAllMocks();
  });

  test("returns invalid_key_format for non-managed raw keys", async () => {
    const runtime = new FakeRuntime({
      sessionToken: "session-3",
      requestHandler: () => {
        throw new Error("request should not be called for invalid key format");
      },
    });
    const out = await parseWithRuntime(
      ["project", "key", "use", "test_legacy_key"],
      registerProjectCommands,
      runtime
    );
    const data = runtime.lastSuccess?.data as Record<string, unknown>;
    expect(out.exitCode).toBe(0);
    expect(data.active_api_key_id).toBeNull();
    expect(data.resolution_status).toBe("invalid_key_format");
    expect(data.matched_count).toBe(0);
    expect(runtime.calls.length).toBe(0);
    vi.restoreAllMocks();
  });
});

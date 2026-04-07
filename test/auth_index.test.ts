import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { registerAuthCommands } from "../src/commands/auth";
import { registerIndexCommands } from "../src/commands/index";
import { CliRuntime } from "../src/runtime";

type RequestParams = Record<string, unknown>;

class FakeRuntime {
  public readonly profile: Record<string, unknown>;
  public lastStructured: { payload: unknown; human?: string | string[] } | null = null;
  public readonly calls: RequestParams[] = [];

  constructor(
    private readonly handler: (params: RequestParams) => unknown,
    profile?: Record<string, unknown>
  ) {
    this.profile = {
      current_project_id: null,
      current_project_name: null,
      active_api_key: null,
      active_api_key_id: null,
      last_index_session_id: null,
      ...(profile || {}),
    };
  }

  async request(params: RequestParams): Promise<unknown> {
    this.calls.push(params);
    return this.handler(params);
  }

  httpClient() {
    return {
      requestJson: async (params: RequestParams) => ({ data: this.handler(params), statusCode: 200, headers: {} }),
    };
  }

  saveProfile(): void {}

  emitStructured(payload: { payload: unknown; human?: string | string[] }): number {
    this.lastStructured = payload;
    return 0;
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

describe("auth key commands", () => {
  test("auth key use validates and stores project context", async () => {
    const runtime = new FakeRuntime(() => ({
      authenticated: true,
      key_id: "key_1",
      key_fingerprint: "abc123",
      key_label: "agent",
      key_prefix: "uf_live_demo",
      project_id: "proj_1",
      project_name: "Project One",
      organization_id: "org_1",
      organization_name: "Org One",
      scopes: ["index:write", "search:read"],
      status: "active",
    }));
    const out = await parseWithRuntime(["auth", "key", "use", "uf_live_demo_secret"], registerAuthCommands, runtime);
    expect(out.exitCode).toBe(0);
    expect(runtime.profile.active_api_key_id).toBe("key_1");
    expect(runtime.profile.current_project_id).toBe("proj_1");
    expect(runtime.lastStructured?.payload).toMatchObject({ key_id: "key_1", project_id: "proj_1" });
    vi.restoreAllMocks();
  });
});

describe("index commands", () => {
  test("index init stores last session id", async () => {
    const runtime = new FakeRuntime(() => ({
      ok: true,
      stage: "source",
      stage_status: "not_started",
      session: { id: "idx_1", project_id: "proj_1", organization_id: "org_1" },
      auth_context: { key_fingerprint: "abc123", project_id: "proj_1", project_name: "Project One", organization_id: "org_1", organization_name: "Org One", scopes: ["index:write"], authenticated: true },
      state: {},
      summary: { message: "Choose a source." },
      warnings: [],
      missing_requirements: ["Source is not configured."],
      next_actions: [],
      artifacts: {},
    }));
    const out = await parseWithRuntime(["index", "init"], registerIndexCommands, runtime);
    expect(out.exitCode).toBe(0);
    expect(runtime.profile.last_index_session_id).toBe("idx_1");
    expect(runtime.lastStructured?.payload).toMatchObject({ stage: "source" });
    vi.restoreAllMocks();
  });
});

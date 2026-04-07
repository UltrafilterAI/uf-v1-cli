import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CliRuntime } from "../src/runtime";
import { loadProfile, saveProfile } from "../src/profile";

describe("runtime/profile precedence", () => {
  test("round-trips profile", () => {
    const tmp = path.resolve("/tmp", `uf-cli-test-${Date.now()}`);
    vi.stubEnv("XDG_CONFIG_HOME", tmp);
    const saved = saveProfile({
      name: "default",
      api_base: "http://localhost:8000",
      session_token: "token-a",
      current_project_id: "proj_1",
      current_project_name: "Project One",
      active_api_key: "key-raw",
      active_api_key_id: "ak_1",
      last_sync_preview: { bucket_name: "bkt" },
    });
    const loaded = loadProfile("default");
    expect(saved.includes("default.json")).toBe(true);
    expect(loaded.session_token).toBe("token-a");
    expect(loaded.current_project_id).toBe("proj_1");
    vi.unstubAllEnvs();
  });

  test("explicit overrides env and profile", () => {
    const tmp = path.resolve("/tmp", `uf-cli-test-${Date.now()}-2`);
    vi.stubEnv("XDG_CONFIG_HOME", tmp);
    saveProfile({
      name: "default",
      api_base: "http://profile-base:8000",
      session_token: "profile-session",
      active_api_key: "profile-key",
    });
    vi.stubEnv("UF_API_BASE", "http://env-base:8000");
    vi.stubEnv("UF_SESSION_TOKEN", "env-session");
    vi.stubEnv("UF_API_KEY", "env-key");
    const runtime = CliRuntime.fromGlobalOptions({
      profile: "default",
      apiBase: "http://explicit-base:8000",
      sessionToken: "explicit-session",
      apiKey: "explicit-key",
    });
    expect(runtime.apiBase).toBe("http://explicit-base:8000");
    expect(runtime.resolvedSessionToken()).toBe("explicit-session");
    expect(runtime.resolvedApiKey()).toBe("explicit-key");
    vi.unstubAllEnvs();
  });
});


import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { registerSyncCommands } from "../src/commands/sync";
import { registerMappingCommands } from "../src/commands/mapping";
import { CliRuntime } from "../src/runtime";

class FakeRuntime {
  public readonly calls: Array<Record<string, unknown>> = [];
  public readonly profile: Record<string, unknown> = { last_sync_preview: null };
  public lastErrorCode: number | null = null;

  constructor(private readonly responses: Array<any>) {}

  async request(params: Record<string, unknown>): Promise<any> {
    this.calls.push(params);
    return this.responses.shift() ?? {};
  }

  apiKeyFingerprint(): string {
    return "fingerprint-1";
  }

  saveProfile(): void {}

  emitSuccess(): number {
    return 0;
  }

  emitError(err: { exitCode: number }): number {
    this.lastErrorCode = err.exitCode;
    return err.exitCode;
  }
}

describe("safety gates", () => {
  test("sync run blocks when preview has deletions and no confirmation", async () => {
    const context = { exitCode: 2 };
    const program = new Command();
    registerSyncCommands(program, context);
    const fake = new FakeRuntime([
      {
        sync_run_id: "sr_preview",
        status: "completed",
        preview: { new: [], changed: [], deleted: ["a.json"] },
      },
    ]);
    vi.spyOn(CliRuntime, "fromCommand").mockReturnValue(fake as unknown as CliRuntime);
    await program.parseAsync(["sync", "run", "demo"], { from: "user" });
    expect(context.exitCode).toBe(6);
    expect(fake.calls.length).toBe(1);
    expect(String(fake.calls[0].path)).toContain("/sync/preview");
    vi.restoreAllMocks();
  });

  test("mapping set activate blocks without passed validation", async () => {
    const context = { exitCode: 2 };
    const program = new Command();
    registerMappingCommands(program, context);
    const fake = new FakeRuntime([
      {
        id: "ms_1",
        validation_status: "failed",
        version: 1,
        status: "draft",
      },
    ]);
    vi.spyOn(CliRuntime, "fromCommand").mockReturnValue(fake as unknown as CliRuntime);
    await program.parseAsync(["mapping", "set", "activate", "ms_1"], { from: "user" });
    expect(context.exitCode).toBe(6);
    expect(fake.calls.length).toBe(1);
    expect(String(fake.calls[0].path)).toContain("/mapping-sets/ms_1");
    vi.restoreAllMocks();
  });
});


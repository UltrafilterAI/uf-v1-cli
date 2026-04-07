import { describe, expect, test } from "vitest";
import { normalizeGlobalFlags } from "../src/main";

describe("normalizeGlobalFlags", () => {
  test("moves global flags to front", () => {
    const out = normalizeGlobalFlags(["auth", "status", "--json", "--profile", "agent"]);
    expect(out.slice(0, 3)).toEqual(["--json", "--profile", "agent"]);
    expect(out.slice(3)).toEqual(["auth", "status"]);
  });
});


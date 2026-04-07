import { describe, expect, test } from "vitest";
import { classifyHttpError } from "../src/errors";

describe("classifyHttpError", () => {
  test("maps 404 to not_found/exit4", () => {
    const err = classifyHttpError({ statusCode: 404, message: "Missing" });
    expect(err.errorCode).toBe("not_found");
    expect(err.exitCode).toBe(4);
  });

  test("maps validation conflict to safety", () => {
    const err = classifyHttpError({
      statusCode: 409,
      message: "Validation must pass before activation",
    });
    expect(err.errorCode).toBe("safety_blocked");
    expect(err.exitCode).toBe(6);
  });

  test("maps 500 to server_error/exit8", () => {
    const err = classifyHttpError({ statusCode: 500, message: "boom" });
    expect(err.errorCode).toBe("server_error");
    expect(err.exitCode).toBe(8);
  });

  test("maps data_plane_auth_failed to non-transient remediation", () => {
    const err = classifyHttpError({
      statusCode: 502,
      message: "Control plane cannot authenticate to data plane",
      errorCode: "data_plane_auth_failed",
    });
    expect(err.errorCode).toBe("data_plane_auth_failed");
    expect(err.exitCode).toBe(8);
    expect(err.nextActions[0]).toContain("UF_DATA_PLANE_INTERNAL_TOKEN");
  });
});

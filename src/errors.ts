import * as exitCodes from "./exitCodes";
import type { EmitMeta } from "./types";

const SAFETY_HINT_TOKENS = [
  "validation must pass before activation",
  "mapping set must pass validation before activation",
  "selection changed",
  "confirm sample preview before activation",
  "confirm sample",
  "confirm deletion",
  "deletions",
  "proposal is not ready",
];

function isSafetyMessage(message: string): boolean {
  const lowered = String(message || "").trim().toLowerCase();
  return SAFETY_HINT_TOKENS.some((token) => lowered.includes(token));
}

export class CliError extends Error {
  public readonly errorCode: string;
  public readonly exitCode: number;
  public readonly recoverable: boolean;
  public readonly nextActions: string[];
  public readonly meta: EmitMeta;

  constructor(params: {
    errorCode: string;
    message: string;
    exitCode: number;
    recoverable?: boolean;
    nextActions?: string[];
    meta?: EmitMeta;
  }) {
    super(params.message);
    this.name = "CliError";
    this.errorCode = params.errorCode;
    this.exitCode = params.exitCode;
    this.recoverable = Boolean(params.recoverable);
    this.nextActions = params.nextActions ?? [];
    this.meta = params.meta ?? {};
  }
}

export function classifyHttpError(params: {
  statusCode: number;
  message: string;
  errorCode?: string | null;
  meta?: EmitMeta;
}): CliError {
  const statusCode = Number(params.statusCode);
  const message = String(params.message || "").trim() || `Request failed (${statusCode})`;
  const errorCode = String(params.errorCode ?? "").trim();

  if (errorCode === "data_plane_auth_failed") {
    return new CliError({
      errorCode: "data_plane_auth_failed",
      message,
      exitCode: exitCodes.SERVER,
      recoverable: true,
      nextActions: [
        "Ensure UF_DATA_PLANE_INTERNAL_TOKEN matches between control plane and data plane.",
        "Redeploy both services, then retry sync run.",
      ],
      meta: params.meta ?? {},
    });
  }

  if (statusCode === 401) {
    return new CliError({
      errorCode: errorCode || "auth_required",
      message,
      exitCode: exitCodes.AUTH,
      recoverable: true,
      nextActions: ["Run `uf auth login` and retry."],
      meta: params.meta ?? {},
    });
  }
  if (statusCode === 404) {
    return new CliError({
      errorCode: errorCode || "not_found",
      message,
      exitCode: exitCodes.NOT_FOUND,
      recoverable: true,
      nextActions: ["Verify ids, bucket name, and project context."],
      meta: params.meta ?? {},
    });
  }
  if (statusCode === 409) {
    const safety = isSafetyMessage(message);
    return new CliError({
      errorCode: errorCode || (safety ? "safety_blocked" : "conflict"),
      message,
      exitCode: safety ? exitCodes.SAFETY : exitCodes.CONFLICT,
      recoverable: true,
      nextActions: safety ? ["Follow the required safety step and retry."] : ["Refresh state and retry."],
      meta: params.meta ?? {},
    });
  }
  if ([429, 502, 503, 504].includes(statusCode)) {
    return new CliError({
      errorCode: errorCode || "transient_error",
      message,
      exitCode: exitCodes.NETWORK,
      recoverable: true,
      nextActions: ["Retry with backoff."],
      meta: params.meta ?? {},
    });
  }
  if (statusCode >= 500) {
    return new CliError({
      errorCode: errorCode || "server_error",
      message,
      exitCode: exitCodes.SERVER,
      recoverable: true,
      nextActions: ["Retry later or inspect backend logs."],
      meta: params.meta ?? {},
    });
  }

  const safety = isSafetyMessage(message);
  return new CliError({
    errorCode: errorCode || (safety ? "safety_blocked" : "request_failed"),
    message,
    exitCode: safety ? exitCodes.SAFETY : exitCodes.CONFLICT,
    recoverable: true,
    nextActions: ["Fix request inputs and retry."],
    meta: params.meta ?? {},
  });
}

export function networkError(message: string, meta?: EmitMeta): CliError {
  return new CliError({
    errorCode: "network_error",
    message,
    exitCode: exitCodes.NETWORK,
    recoverable: true,
    nextActions: ["Check network connectivity and API base URL, then retry."],
    meta: meta ?? {},
  });
}

export function authRequired(message = "Missing session token."): CliError {
  return new CliError({
    errorCode: "auth_required",
    message,
    exitCode: exitCodes.AUTH,
    recoverable: true,
    nextActions: ["Run `uf auth login` and retry."],
  });
}

export function apiKeyRequired(message = "Missing API key."): CliError {
  return new CliError({
    errorCode: "api_key_required",
    message,
    exitCode: exitCodes.AUTH,
    recoverable: true,
    nextActions: ["Run `uf project key create` or `uf project key use <key>` and retry."],
  });
}

export function safetyBlocked(message: string, nextActions?: string[]): CliError {
  return new CliError({
    errorCode: "safety_blocked",
    message,
    exitCode: exitCodes.SAFETY,
    recoverable: true,
    nextActions: nextActions ?? ["Satisfy the required safety step and retry."],
  });
}

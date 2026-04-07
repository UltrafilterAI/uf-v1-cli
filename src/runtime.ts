import { createHash } from "node:crypto";
import type { Command } from "commander";
import * as exitCodes from "./exitCodes";
import { CliError, apiKeyRequired, authRequired } from "./errors";
import { HttpClient } from "./http";
import { DEFAULT_PROFILE, type CliProfile, loadProfile, saveProfile } from "./profile";
import type { AuthMode, EmitMeta, GlobalOptions, JsonValue } from "./types";

const DEFAULT_API_BASE = "https://p01--uf-v1-alpha--rx59fhdj57cl.code.run";
const DEFAULT_TIMEOUT_SEC = 30;

function env(name: string): string | undefined {
  const value = String(process.env[name] || "").trim();
  return value || undefined;
}

function normalizeApiBase(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\/+$/, "");
}

export class CliRuntime {
  public readonly profile: CliProfile;
  public readonly jsonOutput: boolean;
  public readonly apiBase: string;
  public readonly timeoutSec: number;
  private readonly explicitSessionToken?: string;
  private readonly explicitApiKey?: string;

  constructor(params: {
    profile: CliProfile;
    jsonOutput: boolean;
    apiBase: string;
    timeoutSec: number;
    explicitSessionToken?: string;
    explicitApiKey?: string;
  }) {
    this.profile = params.profile;
    this.jsonOutput = params.jsonOutput;
    this.apiBase = params.apiBase;
    this.timeoutSec = params.timeoutSec;
    this.explicitSessionToken = params.explicitSessionToken;
    this.explicitApiKey = params.explicitApiKey;
    this.profile.api_base = this.apiBase;
  }

  static fromGlobalOptions(opts: GlobalOptions): CliRuntime {
    const profileName = String(opts.profile || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
    const profile = loadProfile(profileName);
    const apiBase =
      normalizeApiBase(opts.apiBase) ||
      normalizeApiBase(env("UF_API_BASE")) ||
      normalizeApiBase(profile.api_base || undefined) ||
      DEFAULT_API_BASE;
    const timeoutRaw =
      opts.requestTimeout !== undefined ? opts.requestTimeout : Number(env("UF_REQUEST_TIMEOUT"));
    const timeoutSec =
      timeoutRaw && Number.isFinite(timeoutRaw) ? Math.max(1, Number(timeoutRaw)) : DEFAULT_TIMEOUT_SEC;
    const explicitSessionToken = String(opts.sessionToken || "").trim() || undefined;
    const explicitApiKey = String(opts.apiKey || "").trim() || undefined;
    return new CliRuntime({
      profile,
      jsonOutput: Boolean(opts.json),
      apiBase,
      timeoutSec,
      explicitSessionToken,
      explicitApiKey,
    });
  }

  static fromCommand(command: Command): CliRuntime {
    const raw = command.optsWithGlobals() as Record<string, unknown>;
    const options: GlobalOptions = {
      apiBase: stringOrUndefined(raw.apiBase),
      profile: stringOrUndefined(raw.profile),
      json: Boolean(raw.json),
      requestTimeout: numberOrUndefined(raw.requestTimeout),
      sessionToken: stringOrUndefined(raw.sessionToken),
      apiKey: stringOrUndefined(raw.apiKey),
    };
    return CliRuntime.fromGlobalOptions(options);
  }

  saveProfile(): void {
    saveProfile(this.profile);
  }

  resolvedSessionToken(): string | undefined {
    return this.explicitSessionToken || env("UF_SESSION_TOKEN") || stringOrUndefined(this.profile.session_token);
  }

  requireSessionToken(): string {
    const token = this.resolvedSessionToken();
    if (token) {
      return token;
    }
    throw authRequired("Missing bearer session token.");
  }

  resolvedApiKey(): string | undefined {
    return this.explicitApiKey || env("UF_API_KEY") || stringOrUndefined(this.profile.active_api_key);
  }

  requireApiKey(): string {
    const apiKey = this.resolvedApiKey();
    if (apiKey) {
      return apiKey;
    }
    throw apiKeyRequired("Missing X-API-Key credential.");
  }

  apiKeyFingerprint(): string {
    return createHash("sha256").update(this.requireApiKey()).digest("hex").slice(0, 12);
  }

  httpClient(): HttpClient {
    return new HttpClient({ baseUrl: this.apiBase, timeoutSec: this.timeoutSec });
  }

  async request(params: {
    method: string;
    path: string;
    auth?: AuthMode;
    query?: Record<string, unknown>;
    body?: Record<string, unknown> | null;
    retries?: number;
  }): Promise<any> {
    const auth = params.auth || "none";
    const headers: Record<string, string> = {};
    if (auth === "session") {
      headers.Authorization = `Bearer ${this.requireSessionToken()}`;
    } else if (auth === "api_key") {
      headers["X-API-Key"] = this.requireApiKey();
    } else if (auth !== "none") {
      throw new CliError({
        errorCode: "invalid_auth_mode",
        message: `Unsupported auth mode: ${auth}`,
        exitCode: exitCodes.SERVER,
        recoverable: false,
      });
    }
    const result = await this.httpClient().requestJson({
      method: params.method,
      path: params.path,
      headers,
      query: params.query,
      body: params.body || undefined,
      retries: params.retries ?? 2,
    });
    return result.data;
  }

  emitSuccess(params: { data: unknown; human?: string | string[]; meta?: EmitMeta }): number {
    if (this.jsonOutput) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            data: params.data,
            meta: params.meta || {},
          },
          null,
          2
        )}\n`
      );
      return exitCodes.OK;
    }
    if (params.human === undefined) {
      if (typeof params.data === "string") {
        process.stdout.write(`${params.data}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(params.data, null, 2)}\n`);
      }
      return exitCodes.OK;
    }
    if (Array.isArray(params.human)) {
      process.stdout.write(`${params.human.join("\n")}\n`);
      return exitCodes.OK;
    }
    process.stdout.write(`${params.human}\n`);
    return exitCodes.OK;
  }

  emitStructured(params: { payload: unknown; human?: string | string[] }): number {
    if (this.jsonOutput) {
      process.stdout.write(`${JSON.stringify(params.payload, null, 2)}\n`);
      return exitCodes.OK;
    }
    if (params.human === undefined) {
      if (typeof params.payload === "string") {
        process.stdout.write(`${params.payload}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(params.payload, null, 2)}\n`);
      }
      return exitCodes.OK;
    }
    if (Array.isArray(params.human)) {
      process.stdout.write(`${params.human.join("\n")}\n`);
      return exitCodes.OK;
    }
    process.stdout.write(`${params.human}\n`);
    return exitCodes.OK;
  }

  emitError(err: CliError): number {
    if (this.jsonOutput) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            error_code: err.errorCode,
            message: err.message,
            recoverable: Boolean(err.recoverable),
            next_actions: err.nextActions || [],
            meta: err.meta || {},
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stderr.write(`error[${err.errorCode}]: ${err.message}\n`);
      if (err.nextActions.length) {
        process.stderr.write("next:\n");
        for (const action of err.nextActions) {
          process.stderr.write(`- ${action}\n`);
        }
      }
    }
    return Number(err.exitCode);
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  const out = String(value || "").trim();
  return out || undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function emitUnknownError(runtime: CliRuntime, err: unknown): number {
  if (err instanceof CliError) {
    return runtime.emitError(err);
  }
  return runtime.emitError(
    new CliError({
      errorCode: "unexpected_error",
      message: String((err as Error)?.message || err),
      exitCode: exitCodes.SERVER,
      recoverable: false,
      nextActions: ["Inspect traceback and fix the failing command path."],
    })
  );
}

import * as exitCodes from "./exitCodes";
import { CliError, classifyHttpError, networkError } from "./errors";
import type { EmitMeta, JsonValue } from "./types";
import { randomUUID } from "node:crypto";

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface HttpResult {
  data: JsonValue | Record<string, unknown> | unknown;
  statusCode: number;
  headers: Record<string, string>;
}

export interface RequestJsonParams {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown> | null;
  retries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorFields(payload: unknown): { message: string; code?: string | null } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { message: "Request failed" };
  }
  const obj = payload as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
    const error = obj.error as Record<string, unknown>;
    return {
      message: String(error.message || "Request failed"),
      code: typeof error.code === "string" ? error.code : null,
    };
  }
  const detail = obj.detail;
  if (typeof detail === "string") {
    return { message: detail };
  }
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    if (d.error && typeof d.error === "object" && !Array.isArray(d.error)) {
      const error = d.error as Record<string, unknown>;
      return {
        message: String(error.message || "Request failed"),
        code: typeof error.code === "string" ? error.code : null,
      };
    }
  }
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const f = first as Record<string, unknown>;
      if (typeof f.msg === "string") {
        return { message: f.msg };
      }
    }
  }
  return { message: String(obj.message || "Request failed") };
}

function buildQuery(query?: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (!query) {
    return "";
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && item !== undefined) {
          params.append(key, String(item));
        }
      }
      continue;
    }
    params.append(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeoutSec: number;

  constructor(params: { baseUrl: string; timeoutSec: number }) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.timeoutSec = params.timeoutSec;
  }

  async requestJson(params: RequestJsonParams): Promise<HttpResult> {
    const method = String(params.method).trim().toUpperCase();
    const retries = Number.isFinite(params.retries) ? Number(params.retries) : 2;
    const requestHeaders: Record<string, string> = { Accept: "application/json", ...(params.headers || {}) };
    const body =
      params.body !== undefined && params.body !== null ? JSON.stringify(params.body) : undefined;
    if (body) {
      requestHeaders["Content-Type"] = "application/json";
    }
    if (MUTATING_METHODS.has(method) && !requestHeaders["Idempotency-Key"]) {
      requestHeaders["Idempotency-Key"] = randomUUID();
    }
    const url = `${this.baseUrl}${params.path}${buildQuery(params.query)}`;

    let lastError: CliError | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, this.timeoutSec) * 1000);
      try {
        const response = await fetch(url, {
          method,
          headers: requestHeaders,
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const raw = await response.text();
        let payload: unknown = {};
        if (raw) {
          try {
            payload = JSON.parse(raw);
          } catch (err) {
            throw new CliError({
              errorCode: "invalid_json_response",
              message: `Failed to parse JSON response: ${String(err)}`,
              exitCode: exitCodes.SERVER,
              recoverable: false,
              nextActions: ["Inspect backend response and retry."],
            });
          }
        }
        if (!response.ok) {
          const fields = extractErrorFields(payload);
          const error = classifyHttpError({
            statusCode: response.status,
            message: fields.message,
            errorCode: fields.code ?? undefined,
            meta: { method, path: params.path, status_code: response.status } as EmitMeta,
          });
          if (
            TRANSIENT_STATUSES.has(response.status) &&
            error.errorCode !== "data_plane_auth_failed" &&
            attempt < retries
          ) {
            await sleep(250 * (attempt + 1));
            lastError = error;
            continue;
          }
          throw error;
        }
        const obj = payload as Record<string, unknown>;
        if (obj && typeof obj === "object" && !Array.isArray(obj) && "data" in obj) {
          return {
            data: obj.data as unknown,
            statusCode: response.status,
            headers: normalizeHeaders(response.headers),
          };
        }
        return {
          data: payload as unknown,
          statusCode: response.status,
          headers: normalizeHeaders(response.headers),
        };
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof CliError) {
          throw err;
        }
        const wrapped = networkError(`Network request failed: ${String((err as Error)?.message || err)}`, {
          method,
          path: params.path,
        });
        if (attempt < retries) {
          await sleep(250 * (attempt + 1));
          lastError = wrapped;
          continue;
        }
        throw wrapped;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new CliError({
      errorCode: "network_error",
      message: "Request failed",
      exitCode: exitCodes.NETWORK,
      recoverable: true,
      nextActions: ["Retry request."],
    });
  }
}

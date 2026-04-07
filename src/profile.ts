import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "./types";

export const DEFAULT_PROFILE = "default";

export interface CliProfile {
  name: string;
  api_base?: string | null;
  session_token?: string | null;
  current_project_id?: string | null;
  current_project_name?: string | null;
  active_api_key?: string | null;
  active_api_key_id?: string | null;
  last_sync_preview?: Record<string, JsonValue> | null;
  last_index_session_id?: string | null;
}

function configHome(): string {
  const xdg = String(process.env.XDG_CONFIG_HOME || "").trim();
  if (xdg) {
    return path.resolve(xdg);
  }
  return path.join(os.homedir(), ".config");
}

export function profileDir(): string {
  return path.join(configHome(), "ultrafilter-cli", "profiles");
}

export function profilePath(name?: string): string {
  const normalized = String(name || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
  return path.join(profileDir(), `${normalized}.json`);
}

export function loadProfile(name?: string): CliProfile {
  const normalized = String(name || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
  const target = profilePath(normalized);
  if (!fs.existsSync(target)) {
    return { name: normalized };
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { name: normalized };
  }
  const record = payload as Record<string, unknown>;
  return {
    name: normalized,
    api_base: asNullableString(record.api_base),
    session_token: asNullableString(record.session_token),
    current_project_id: asNullableString(record.current_project_id),
    current_project_name: asNullableString(record.current_project_name),
    active_api_key: asNullableString(record.active_api_key),
    active_api_key_id: asNullableString(record.active_api_key_id),
    last_sync_preview: asNullableObject(record.last_sync_preview) as Record<string, JsonValue> | null,
    last_index_session_id: asNullableString(record.last_index_session_id),
  };
}

function asNullableString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function asNullableObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function saveProfile(profile: CliProfile): string {
  const target = profilePath(profile.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.chmodSync(path.dirname(target), 0o700);
  } catch {
    // ignore on unsupported filesystems/platforms
  }
  const payload: Record<string, unknown> = { ...profile };
  delete payload.name;
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // ignore on unsupported filesystems/platforms
  }
  return target;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export type AuthMode = "none" | "session" | "api_key";

export interface GlobalOptions {
  apiBase?: string;
  profile?: string;
  json?: boolean;
  requestTimeout?: number;
  sessionToken?: string;
  apiKey?: string;
}

export interface EmitMeta {
  [key: string]: JsonValue;
}


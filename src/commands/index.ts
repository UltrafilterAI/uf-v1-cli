import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";
import { CliError } from "../errors";

type GenericRecord = Record<string, any>;

function resolveSessionId(options: Record<string, any>, runtime: any): string {
  const explicit = String(options.session || "").trim();
  if (explicit) {
    return explicit;
  }
  const cached = String(runtime.profile.last_index_session_id || "").trim();
  if (cached) {
    return cached;
  }
  throw new CliError({
    errorCode: "index_session_required",
    message: "Index session is required. Pass `--session` or run `uf index init` first.",
    exitCode: 5,
    recoverable: true,
    nextActions: ["Run `uf index init --json` to create a session."],
  });
}

function resolveProjectId(options: Record<string, any>, runtime: any): string | undefined {
  const explicit = String(options.projectId || "").trim();
  if (explicit) {
    return explicit;
  }
  const envValue = String(process.env.UF_PROJECT_ID || "").trim();
  if (envValue) {
    return envValue;
  }
  const current = String(runtime.profile.current_project_id || "").trim();
  return current || undefined;
}

function rememberSession(runtime: any, payload: GenericRecord): void {
  const session = (payload.session || {}) as GenericRecord;
  const sessionId = String(session.id || "").trim();
  if (!sessionId) {
    return;
  }
  runtime.profile.last_index_session_id = sessionId;
  if (session.project_id) {
    runtime.profile.current_project_id = String(session.project_id || "") || runtime.profile.current_project_id || null;
  }
  runtime.saveProfile();
}

function humanSummary(payload: GenericRecord): string {
  const stage = String(payload.stage || "unknown");
  const stageStatus = String(payload.stage_status || "unknown");
  const summary = (payload.summary || {}) as GenericRecord;
  const message = String(summary.message || "").trim();
  return `${stage}/${stageStatus}${message ? `: ${message}` : ""}`;
}

function normalizeExtension(value: string): string {
  const token = String(value || "").trim().toLowerCase();
  if (!token) {
    return "";
  }
  if (token === "[no_ext]") {
    return token;
  }
  return token.startsWith(".") ? token : `.${token}`;
}

function familyForExtension(ext: string): string {
  const token = normalizeExtension(ext);
  if ([".json", ".jsonl", ".md", ".txt", "[no_ext]"].includes(token)) {
    return "text";
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(token)) {
    return "image";
  }
  if (token === ".pdf") {
    return "pdf";
  }
  return "other";
}

async function walkFolder(rootPath: string): Promise<Array<{ absolute_path: string; relative_path: string; size_bytes: number; last_modified_ms: number; family: string }>> {
  const root = path.resolve(rootPath);
  const out: Array<{ absolute_path: string; relative_path: string; size_bytes: number; last_modified_ms: number; family: string }> = [];

  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const fileName = relative.split("/").pop() || relative;
      const extName = path.posix.extname(fileName);
      const normalizedExt = extName ? normalizeExtension(extName) : "[no_ext]";
      out.push({
        absolute_path: absolute,
        relative_path: relative,
        size_bytes: stat.size,
        last_modified_ms: Math.max(0, Math.floor(stat.mtimeMs)),
        family: familyForExtension(normalizedExt),
      });
    }
  }

  await visit(root);
  return out;
}

async function uploadPreparedFiles(
  preparedFiles: Array<{ relative_path: string; upload_url: string; headers?: Record<string, string> }>,
  sourceFiles: Map<string, string>
): Promise<void> {
  for (const item of preparedFiles) {
    const absolutePath = sourceFiles.get(String(item.relative_path || ""));
    if (!absolutePath) {
      throw new CliError({
        errorCode: "local_file_missing",
        message: `Prepared upload file not found locally: ${String(item.relative_path || "")}`,
        exitCode: 5,
        recoverable: false,
      });
    }
    const body = await fs.readFile(absolutePath);
    const response = await fetch(String(item.upload_url), {
      method: "PUT",
      headers: item.headers || {},
      body,
    });
    if (!response.ok) {
      throw new CliError({
        errorCode: "upload_failed",
        message: `Failed to upload ${String(item.relative_path || "")}: ${response.status} ${response.statusText}`,
        exitCode: 7,
        recoverable: true,
        nextActions: ["Retry the folder source command."],
      });
    }
  }
}

function parseRouteSpec(value: string): { extension: string; route: string } {
  const [left, right] = String(value || "").split("=", 2);
  const extension = normalizeExtension(left || "");
  const route = String(right || "").trim().toLowerCase();
  if (!extension || !["text", "image", "pdf", "skip"].includes(route)) {
    throw new CliError({
      errorCode: "invalid_route_spec",
      message: `Invalid route spec: ${value}. Use --route .ext=text|image|pdf|skip`,
      exitCode: 2,
      recoverable: false,
    });
  }
  return { extension, route };
}

export function registerIndexCommands(program: Command, context: CommandContext): void {
  const index = program.command("index").description("Agent-first staged indexing workflow");
  const source = index.command("source").description("Configure source stage");
  const emitSessionStatus = async (runtime: any, options: { session: string }) => {
    const payload = (await runtime.request({
      method: "GET",
      path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}`,
      auth: "api_key",
    })) as GenericRecord;
    rememberSession(runtime, payload);
    return runtime.emitStructured({ payload, human: humanSummary(payload) });
  };

  index
    .command("init")
    .description("Create a new index session")
    .option("--project-id <projectId>", "Optional project id; defaults to the API key project")
    .action(
      withRuntime(context, async (runtime, options: { projectId?: string }) => {
        const payload = (await runtime.request({
          method: "POST",
          path: "/index-sessions",
          auth: "api_key",
          body: { project_id: resolveProjectId(options as Record<string, any>, runtime) ?? null },
        })) as GenericRecord;
        rememberSession(runtime, payload);
        return runtime.emitStructured({ payload, human: humanSummary(payload) });
      })
    );

  index
    .command("status")
    .description("Show the current index session status")
    .requiredOption("--session <session>", "Index session id")
    .action(withRuntime(context, emitSessionStatus));

  index
    .command("check")
    .description("Check current progress, especially for background sync runs")
    .requiredOption("--session <session>", "Index session id")
    .action(withRuntime(context, emitSessionStatus));

  source
    .command("bucket")
    .description("Attach a bucket source to the current index session")
    .requiredOption("--session <session>", "Index session id")
    .requiredOption("--bucket-name <bucketName>", "Bucket name")
    .option("--provider <provider>", "Bucket provider", "r2")
    .option("--endpoint-url <endpointUrl>", "Provider endpoint URL")
    .option("--region <region>", "Bucket region", "auto")
    .requiredOption("--access-key-id <accessKeyId>", "Access key id")
    .requiredOption("--secret-access-key <secretAccessKey>", "Secret access key")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: {
            session: string;
            bucketName: string;
            provider: string;
            endpointUrl?: string;
            region?: string;
            accessKeyId: string;
            secretAccessKey: string;
          }
        ) => {
          const payload = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/source/bucket`,
            auth: "api_key",
            body: {
              bucket_name: options.bucketName,
              provider: options.provider,
              endpoint_url: options.endpointUrl ?? null,
              region: options.region ?? null,
              aws_access_key_id: options.accessKeyId,
              aws_secret_access_key: options.secretAccessKey,
            },
          })) as GenericRecord;
          rememberSession(runtime, payload);
          return runtime.emitStructured({ payload, human: humanSummary(payload) });
        }
      )
    );

  source
    .command("folder")
    .description("Upload a local folder and use it as the source")
    .requiredOption("--session <session>", "Index session id")
    .requiredOption("--path <folderPath>", "Local folder path")
    .option("--display-name <displayName>", "Display name for the uploaded folder")
    .action(
      withRuntime(
        context,
        async (runtime, options: { session: string; path: string; displayName?: string }) => {
          const sessionId = resolveSessionId(options as Record<string, any>, runtime);
          const rootPath = path.resolve(options.path);
          const scanned = await walkFolder(rootPath);
          const sourceFiles = new Map<string, string>(scanned.map((item) => [item.relative_path, item.absolute_path]));
          const manifest = scanned.map((item) => ({
            relative_path: item.relative_path,
            size_bytes: item.size_bytes,
            last_modified_ms: item.last_modified_ms,
            family: item.family,
          }));
          const prepared = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${sessionId}/source/folder/prepare`,
            auth: "api_key",
            body: {
              folder_path: rootPath,
              display_name: options.displayName || path.basename(rootPath),
              files: manifest,
            },
          })) as GenericRecord;
          await uploadPreparedFiles((prepared.approved_files || []) as Array<{ relative_path: string; upload_url: string; headers?: Record<string, string> }>, sourceFiles);
          const payload = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${sessionId}/source/folder/complete`,
            auth: "api_key",
            body: { files: manifest },
          })) as GenericRecord;
          rememberSession(runtime, payload);
          return runtime.emitStructured({ payload, human: humanSummary(payload) });
        }
      )
    );

  source
    .command("verify")
    .description("Verify the configured source")
    .requiredOption("--session <session>", "Index session id")
    .action(
      withRuntime(context, async (runtime, options: { session: string }) => {
        const payload = (await runtime.request({
          method: "POST",
          path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/source/verify`,
          auth: "api_key",
          body: {},
        })) as GenericRecord;
        rememberSession(runtime, payload);
        return runtime.emitStructured({ payload, human: humanSummary(payload) });
      })
    );

  index
    .command("select")
    .description("Select what to index")
    .requiredOption("--session <session>", "Index session id")
    .option("--include-prefix <prefix>", "Include prefix; repeatable", collect, [])
    .option("--exclude-prefix <prefix>", "Exclude prefix; repeatable", collect, [])
    .option("--include-ext <extension>", "Include extension; repeatable", collect, [])
    .option("--exclude-ext <extension>", "Exclude extension; repeatable", collect, [])
    .option("--max-objects <maxObjects>", "Max objects to scan", parseInteger, 2000)
    .option("--sample-limit <sampleLimit>", "Sample key limit", parseInteger, 10)
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: {
            session: string;
            includePrefix: string[];
            excludePrefix: string[];
            includeExt: string[];
            excludeExt: string[];
            maxObjects: number;
            sampleLimit: number;
          }
        ) => {
          const payload = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/selection`,
            auth: "api_key",
            body: {
              include_prefixes: options.includePrefix || [],
              exclude_prefixes: options.excludePrefix || [],
              include_extensions: (options.includeExt || []).map(normalizeExtension).filter(Boolean),
              exclude_extensions: (options.excludeExt || []).map(normalizeExtension).filter(Boolean),
              max_objects: options.maxObjects,
              sample_limit: options.sampleLimit,
            },
          })) as GenericRecord;
          rememberSession(runtime, payload);
          return runtime.emitStructured({ payload, human: humanSummary(payload) });
        }
      )
    );

  index
    .command("route")
    .description("Assign file types to text, image, pdf, or skip")
    .requiredOption("--session <session>", "Index session id")
    .option("--route <route>", "Repeatable route spec like .txt=text", collect, [])
    .option("--sample-size <sampleSize>", "Validation sample size", parseInteger, 3)
    .option("--max-objects <maxObjects>", "Validation scan limit", parseInteger, 2000)
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: { session: string; route: string[]; sampleSize: number; maxObjects: number }
        ) => {
          const routes = (options.route || []).map(parseRouteSpec);
          const payload = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/routing`,
            auth: "api_key",
            body: {
              routes,
              sample_size: options.sampleSize,
              max_objects: options.maxObjects,
            },
          })) as GenericRecord;
          rememberSession(runtime, payload);
          return runtime.emitStructured({ payload, human: humanSummary(payload) });
        }
      )
    );

  index
    .command("preview")
    .description("Preview sync changes")
    .requiredOption("--session <session>", "Index session id")
    .action(
      withRuntime(context, async (runtime, options: { session: string }) => {
        const payload = (await runtime.request({
          method: "POST",
          path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/preview`,
          auth: "api_key",
          body: {},
        })) as GenericRecord;
        rememberSession(runtime, payload);
        return runtime.emitStructured({ payload, human: humanSummary(payload) });
      })
    );

  index
    .command("sync")
    .description("Apply the previewed sync changes and wait for completion")
    .requiredOption("--session <session>", "Index session id")
    .option("--confirm-deletes", "Confirm previewed deletions")
    .option("--yes", "Alias for --confirm-deletes")
    .action(
      withRuntime(
        context,
        async (runtime, options: { session: string; confirmDeletes?: boolean; yes?: boolean }) => {
          const payload = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/sync`,
            auth: "api_key",
            body: { confirm_deletes: Boolean(options.confirmDeletes || options.yes) },
          })) as GenericRecord;
          rememberSession(runtime, payload);
          return runtime.emitStructured({ payload, human: humanSummary(payload) });
        }
      )
    );

  index
    .command("sync-start")
    .description("Start sync in the background and return immediately")
    .requiredOption("--session <session>", "Index session id")
    .option("--confirm-deletes", "Confirm previewed deletions")
    .option("--yes", "Alias for --confirm-deletes")
    .action(
      withRuntime(
        context,
        async (runtime, options: { session: string; confirmDeletes?: boolean; yes?: boolean }) => {
          const payload = (await runtime.request({
            method: "POST",
            path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/sync-start`,
            auth: "api_key",
            body: { confirm_deletes: Boolean(options.confirmDeletes || options.yes) },
          })) as GenericRecord;
          rememberSession(runtime, payload);
          return runtime.emitStructured({ payload, human: humanSummary(payload) });
        }
      )
    );

  index
    .command("endpoint")
    .description("Get the query endpoint for the indexed source")
    .requiredOption("--session <session>", "Index session id")
    .action(
      withRuntime(context, async (runtime, options: { session: string }) => {
        const payload = (await runtime.request({
          method: "GET",
          path: `/index-sessions/${resolveSessionId(options as Record<string, any>, runtime)}/endpoint`,
          auth: "api_key",
        })) as GenericRecord;
        rememberSession(runtime, payload);
        return runtime.emitStructured({ payload, human: humanSummary(payload) });
      })
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

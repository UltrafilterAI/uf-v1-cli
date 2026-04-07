import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";
import { CliError } from "../errors";

function resolveProjectId(options: Record<string, any>, runtime: any): string {
  const explicit = String(options.projectId || "").trim();
  if (explicit) {
    return explicit;
  }
  const envValue = String(process.env.UF_PROJECT_ID || "").trim();
  if (envValue) {
    return envValue;
  }
  const current = String(runtime.profile.current_project_id || "").trim();
  if (current) {
    return current;
  }
  throw new CliError({
    errorCode: "project_required",
    message: "Project context is required. Use `uf project use <id>` or pass `--project-id`.",
    exitCode: 5,
    recoverable: true,
    nextActions: ["Run `uf project list` then `uf project use <id>`."],
  });
}

function preferConnectorReadAuth(runtime: any): "api_key" | "session" {
  return runtime.resolvedApiKey() ? "api_key" : "session";
}

export function registerConnectorCommands(program: Command, context: CommandContext): void {
  const connector = program.command("connector").description("Connector and bucket commands");

  connector
    .command("list")
    .description("List connectors for current project")
    .option("--project-id <projectId>", "Project id (defaults to current project)")
    .action(
      withRuntime(context, async (runtime, options: { projectId?: string }) => {
        const auth = preferConnectorReadAuth(runtime);
        const projectId = auth === "session" ? resolveProjectId(options as Record<string, any>, runtime) : undefined;
        const rows = await runtime.request({
          method: "GET",
          path: "/connectors",
          auth,
          query: projectId ? { project_id: projectId } : undefined,
        });
        const list = Array.isArray(rows) ? rows : [];
        const human = list
          .map(
            (row) =>
              `${String((row as any).id)}  ${String((row as any).bucket_name)}  ${String(
                (row as any).provider
              )}  ${String((row as any).project_id)}`
          )
          .join("\n");
        return runtime.emitSuccess({ data: list, human: human || "No connectors found." });
      })
    );

  connector
    .command("create")
    .description("Create connector")
    .option("--project-id <projectId>", "Project id (defaults to current project)")
    .option("--provider <provider>", "Bucket provider (aws/r2)", "r2")
    .requiredOption("--bucket-name <bucketName>", "Bucket name")
    .option("--endpoint-url <endpointUrl>", "Provider endpoint URL")
    .option("--region <region>", "Region")
    .requiredOption("--access-key-id <accessKeyId>", "Access key id")
    .requiredOption("--secret-access-key <secretAccessKey>", "Secret access key")
    .option("--register-bucket", "Also register /buckets/{bucket} using active API key")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          options: {
            projectId?: string;
            provider: string;
            bucketName: string;
            endpointUrl?: string;
            region?: string;
            accessKeyId: string;
            secretAccessKey: string;
            registerBucket?: boolean;
          }
        ) => {
          const projectId = resolveProjectId(options as Record<string, any>, runtime);
          const created = await runtime.request({
            method: "POST",
            path: "/connectors",
            auth: "session",
            body: {
              project_id: projectId,
              provider: options.provider,
              bucket_name: options.bucketName,
              endpoint_url: options.endpointUrl ?? null,
              region: options.region ?? null,
              credentials: {
                aws_access_key_id: options.accessKeyId,
                aws_secret_access_key: options.secretAccessKey,
              },
            },
          });
          const out: Record<string, unknown> = { connector: created };
          if (options.registerBucket) {
            const registration = await runtime.request({
              method: "POST",
              path: `/buckets/${options.bucketName}`,
              auth: "api_key",
              body: {
                aws_access_key_id: options.accessKeyId,
                aws_secret_access_key: options.secretAccessKey,
                region: options.region || "auto",
                provider: options.provider,
                endpoint_url: options.endpointUrl ?? null,
              },
            });
            out.bucket_registration = registration;
          }
          let human = `Connector created: ${String((created as any).id)} (${String((created as any).bucket_name)})`;
          if (options.registerBucket) {
            human += "\nBucket registered for API key access.";
          }
          return runtime.emitSuccess({ data: out, human });
        }
      )
    );

  connector
    .command("verify <connectorId>")
    .description("Verify connector access")
    .action(
      withRuntime(context, async (runtime, connectorId: string) => {
        const data = await runtime.request({
          method: "POST",
          path: `/connectors/${connectorId}/verify`,
          auth: "session",
          body: {},
        });
        return runtime.emitSuccess({
          data,
          human: `Connector verify: ${String((data as any).connector_id)} verified=${String(
            (data as any).verified
          )}`,
        });
      })
    );

  connector
    .command("inspect <connectorId>")
    .description("Inspect connector structure")
    .option("--depth <depth>", "Depth 1-6", parseInteger, 2)
    .option("--max-objects <maxObjects>", "Max objects to scan", parseInteger, 2000)
    .option("--prefix <prefix>", "Optional prefix filter")
    .action(
      withRuntime(
        context,
        async (runtime, connectorId: string, options: { depth: number; maxObjects: number; prefix?: string }) => {
        const data = await runtime.request({
          method: "GET",
          path: `/connectors/${connectorId}/structure`,
          auth: preferConnectorReadAuth(runtime),
          query: {
            depth: options.depth,
            max_objects: options.maxObjects,
              prefix: options.prefix,
            },
          });
          return runtime.emitSuccess({
            data,
            human: `Connector ${String((data as any).connector_id)} bucket=${String(
              (data as any).bucket_name
            )} nodes=${Array.isArray((data as any).prefix_nodes) ? (data as any).prefix_nodes.length : 0} scanned=${String(
              (data as any).scanned_objects
            )}`,
          });
        }
      )
    );

  connector
    .command("samples <connectorId>")
    .description("List connector sample objects")
    .option("--prefix <prefix>", "Prefix filter; repeatable", collect, [])
    .option("--ext <ext>", "Extension filter; repeatable", collect, [])
    .option("--limit <limit>", "Sample count limit", parseInteger, 20)
    .option("--max-objects <maxObjects>", "Max objects to scan", parseInteger, 2000)
    .action(
      withRuntime(
        context,
        async (
          runtime,
          connectorId: string,
          options: { prefix: string[]; ext: string[]; limit: number; maxObjects: number }
        ) => {
          const data = await runtime.request({
            method: "GET",
            path: `/connectors/${connectorId}/samples`,
            auth: preferConnectorReadAuth(runtime),
            query: {
              prefixes: options.prefix || [],
              extensions: options.ext || [],
              limit: options.limit,
              max_objects: options.maxObjects,
            },
          });
          return runtime.emitSuccess({
            data,
            human: `Samples: ${Array.isArray((data as any).samples) ? (data as any).samples.length : 0} from bucket ${String(
              (data as any).bucket_name
            )}`,
          });
        }
      )
    );

  connector
    .command("sample-object <connectorId>")
    .description("Fetch sample object content")
    .requiredOption("--key <key>", "Object key")
    .option("--max-bytes <maxBytes>", "Maximum bytes to fetch", parseInteger, 65536)
    .action(
      withRuntime(context, async (runtime, connectorId: string, options: { key: string; maxBytes: number }) => {
        const data = await runtime.request({
          method: "GET",
          path: `/connectors/${connectorId}/sample-object`,
          auth: preferConnectorReadAuth(runtime),
          query: { key: options.key, max_bytes: options.maxBytes },
        });
        return runtime.emitSuccess({
          data,
          human: `Sample object loaded: ${String((data as any).key)} (${String((data as any).size_bytes)} bytes)`,
        });
      })
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

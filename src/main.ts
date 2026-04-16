import { Command, CommanderError } from "commander";
import * as exitCodes from "./exitCodes";
import { CliError } from "./errors";
import { CliRuntime, emitUnknownError } from "./runtime";
import { VERSION } from "./version";
import { registerDocsCommands } from "./commands/docs";
import { registerAuthCommands } from "./commands/auth";
import { registerProjectCommands } from "./commands/project";
import { registerConnectorCommands } from "./commands/connector";
import { registerMappingCommands } from "./commands/mapping";
import { registerSyncCommands } from "./commands/sync";
import { registerSearchCommands } from "./commands/search";
import { registerIndexCommands } from "./commands/index";
import { registerSessionCommands } from "./commands/session";
import type { CommandContext } from "./commandContext";
import type { GlobalOptions } from "./types";

const GLOBAL_VALUE_FLAGS = new Set([
  "--api-base",
  "--profile",
  "--request-timeout",
  "--session-token",
  "--api-key",
]);
const GLOBAL_BOOL_FLAGS = new Set(["--json"]);

export function normalizeGlobalFlags(argv: string[]): string[] {
  const extracted: string[] = [];
  const kept: string[] = [];

  let idx = 0;
  while (idx < argv.length) {
    const token = argv[idx];
    if (GLOBAL_BOOL_FLAGS.has(token)) {
      extracted.push(token);
      idx += 1;
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      extracted.push(token);
      if (idx + 1 < argv.length) {
        extracted.push(argv[idx + 1]);
        idx += 2;
      } else {
        idx += 1;
      }
      continue;
    }
    if ([...GLOBAL_VALUE_FLAGS].some((flag) => token.startsWith(`${flag}=`))) {
      extracted.push(token);
      idx += 1;
      continue;
    }
    kept.push(token);
    idx += 1;
  }
  return [...extracted, ...kept];
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const context: CommandContext = { exitCode: exitCodes.USAGE };

  const program = new Command();
  program.name("uf");
  program.description("Ultrafilter CLI: agent-first command surface over the Ultrafilter backend");
  program.version(VERSION, "--version", "show program version");
  program.option("--api-base <apiBase>", "Control API base URL (default: https://p01--uf-v1-alpha--rx59fhdj57cl.code.run; fallback: https://ultrafilter-api.onrender.com)");
  program.option("--profile <profile>", "Local CLI profile name (default: default)", "default");
  program.option("--json", "Emit deterministic JSON output envelope");
  program.option("--request-timeout <requestTimeout>", "Request timeout in seconds", parseFloat);
  program.option("--session-token <sessionToken>", "Bearer session token (overrides env/profile)");
  program.option("--api-key <apiKey>", "X-API-Key credential (overrides env/profile)");

  registerDocsCommands(program, context);
  registerAuthCommands(program, context);
  registerProjectCommands(program, context);
  registerConnectorCommands(program, context);
  registerMappingCommands(program, context);
  registerSyncCommands(program, context);
  registerSearchCommands(program, context);
  registerIndexCommands(program, context);
  registerSessionCommands(program, context);

  program.exitOverride();
  const normalizedArgv = normalizeGlobalFlags(argv);
  try {
    await program.parseAsync(normalizedArgv, { from: "user" });
    if (
      normalizedArgv.includes("--help") ||
      normalizedArgv.includes("-h") ||
      normalizedArgv.includes("help") ||
      normalizedArgv.includes("--version")
    ) {
      return exitCodes.OK;
    }
    return context.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return exitCodes.OK;
      }
      return Number(err.exitCode || exitCodes.USAGE);
    }
    const runtime = CliRuntime.fromGlobalOptions(extractGlobalOptions(normalizedArgv));
    if (err instanceof CliError) {
      return runtime.emitError(err);
    }
    return emitUnknownError(runtime, err);
  }
}

function extractGlobalOptions(argv: string[]): GlobalOptions {
  const out: GlobalOptions = {};
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = argv[idx];
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (token === "--api-base" && idx + 1 < argv.length) {
      out.apiBase = argv[idx + 1];
      idx += 1;
      continue;
    }
    if (token.startsWith("--api-base=")) {
      out.apiBase = token.slice("--api-base=".length);
      continue;
    }
    if (token === "--profile" && idx + 1 < argv.length) {
      out.profile = argv[idx + 1];
      idx += 1;
      continue;
    }
    if (token.startsWith("--profile=")) {
      out.profile = token.slice("--profile=".length);
      continue;
    }
    if (token === "--request-timeout" && idx + 1 < argv.length) {
      out.requestTimeout = Number(argv[idx + 1]);
      idx += 1;
      continue;
    }
    if (token.startsWith("--request-timeout=")) {
      out.requestTimeout = Number(token.slice("--request-timeout=".length));
      continue;
    }
    if (token === "--session-token" && idx + 1 < argv.length) {
      out.sessionToken = argv[idx + 1];
      idx += 1;
      continue;
    }
    if (token.startsWith("--session-token=")) {
      out.sessionToken = token.slice("--session-token=".length);
      continue;
    }
    if (token === "--api-key" && idx + 1 < argv.length) {
      out.apiKey = argv[idx + 1];
      idx += 1;
      continue;
    }
    if (token.startsWith("--api-key=")) {
      out.apiKey = token.slice("--api-key=".length);
      continue;
    }
  }
  return out;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const runtime = CliRuntime.fromGlobalOptions({});
      process.exitCode = runtime.emitError(
        new CliError({
          errorCode: "unexpected_error",
          message: String((err as Error)?.message || err),
          exitCode: exitCodes.SERVER,
          recoverable: false,
          nextActions: ["Inspect traceback and fix the failing command path."],
        })
      );
    });
}

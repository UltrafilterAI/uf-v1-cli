import type { Command } from "commander";
import * as exitCodes from "./exitCodes";
import { CliError } from "./errors";
import { CliRuntime, emitUnknownError } from "./runtime";

export interface CommandContext {
  exitCode: number;
}

export type CommandHandler<TArgs extends unknown[]> = (runtime: CliRuntime, ...args: TArgs) => Promise<number | void> | number | void;

export function withRuntime<TArgs extends unknown[]>(
  context: CommandContext,
  handler: CommandHandler<TArgs>
): (...args: [...TArgs, Command]) => Promise<void> {
  return async (...args: [...TArgs, Command]) => {
    const command = args[args.length - 1] as Command;
    const callArgs = args.slice(0, -1) as unknown as TArgs;
    const runtime = CliRuntime.fromCommand(command);
    try {
      const code = await handler(runtime, ...callArgs);
      context.exitCode = typeof code === "number" ? code : exitCodes.OK;
    } catch (err) {
      if (err instanceof CliError) {
        context.exitCode = runtime.emitError(err);
        return;
      }
      context.exitCode = emitUnknownError(runtime, err);
    }
  };
}


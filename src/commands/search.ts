import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";

export function registerSearchCommands(program: Command, context: CommandContext): void {
  const search = program.command("search").description("Search indexed content");

  search
    .command("text <bucketName>")
    .description("Run search against routed indexes")
    .requiredOption("--query <query>", "Query string")
    .option("--route <route>", "Route: all|text|image|pdf", "all")
    .option("--mode <mode>", "Text mode when route=text", "hybrid")
    .option("--amount <amount>", "Result count", parseInteger, 10)
    .action(
      withRuntime(
        context,
        async (
          runtime,
          bucketName: string,
          options: {
            query: string;
            route: string;
            mode: string;
            amount: number;
          }
        ) => {
          const data = (await runtime.request({
            method: "GET",
            path: `/buckets/${bucketName}/search`,
            auth: "api_key",
            query: {
              query: options.query,
              mode: options.route,
              search_mode: options.mode,
              amount: options.amount,
            },
          })) as Record<string, any>;
          const results = Array.isArray(data.results) ? data.results : [];
          const lines = results.map(
            (row: Record<string, unknown>) =>
              `${String(row.type || "text")}  ${String(row.result_id || row.doc_id)}  score=${String(row.score)}  title=${String(row.title || "")}`
          );
          return runtime.emitSuccess({ data, human: lines.length ? lines.join("\n") : "No search results." });
        }
      )
    );
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

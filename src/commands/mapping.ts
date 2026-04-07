import fs from "node:fs";
import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";
import { CliError, safetyBlocked } from "../errors";

const RULE_KEYS = ["prefix", "suffix", "parser", "id_field", "text_field", "metadata_field", "visibility"] as const;

type Rule = {
  prefix: string;
  suffix: string;
  parser: string;
  id_field: unknown;
  text_field: unknown;
  metadata_field: unknown;
  visibility: string;
};

function normalizeRule(rule: Record<string, any>): Rule {
  return {
    prefix: String(rule.prefix || ""),
    suffix: String(rule.suffix || ""),
    parser: String(rule.parser || ""),
    id_field: rule.id_field ?? null,
    text_field: rule.text_field ?? null,
    metadata_field: rule.metadata_field ?? null,
    visibility: String(rule.visibility || "public"),
  };
}

function ruleSignature(rule: Record<string, any>): string {
  const normalized = normalizeRule(rule);
  const payload: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    payload[key] = normalized[key];
  }
  return JSON.stringify(payload);
}

function loadRulesFile(filePath: string): Rule[] {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(payload)) {
    throw new CliError({
      errorCode: "invalid_rules_file",
      message: "Rules file must be a JSON array of mapping rules.",
      exitCode: 5,
      recoverable: false,
    });
  }
  return payload.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CliError({
        errorCode: "invalid_rules_file",
        message: "Each rule must be a JSON object.",
        exitCode: 5,
        recoverable: false,
      });
    }
    return normalizeRule(item as Record<string, any>);
  });
}

export function registerMappingCommands(program: Command, context: CommandContext): void {
  const mapping = program.command("mapping").description("Mapping session and activation commands");

  const guided = mapping.command("guided").description("Guided mapping-session workflow");
  guided
    .command("start <connectorId>")
    .description("Start guided mapping session")
    .option("--prefix <prefix>", "Selected prefix; repeatable", collect, [])
    .option("--ext <ext>", "Selected extension; repeatable", collect, [])
    .option("--max-objects <maxObjects>", "Max objects scan budget", parseInteger, 2000)
    .action(
      withRuntime(
        context,
        async (
          runtime,
          connectorId: string,
          options: { prefix: string[]; ext: string[]; maxObjects: number }
        ) => {
          const data = await runtime.request({
            method: "POST",
            path: "/mapping-agent-lab/sessions",
            auth: "session",
            body: {
              connector_id: connectorId,
              selected_prefixes: options.prefix || [],
              selected_extensions: options.ext || [],
              max_objects: options.maxObjects,
            },
          });
          return runtime.emitSuccess({
            data,
            human: `Guided session started: ${String((data as any).id)} state=${String((data as any).state)}`,
          });
        }
      )
    );

  guided
    .command("status <sessionId>")
    .description("Get guided session status")
    .action(
      withRuntime(context, async (runtime, sessionId: string) => {
        const data = await runtime.request({
          method: "GET",
          path: `/mapping-agent-lab/sessions/${sessionId}`,
          auth: "session",
        });
        return runtime.emitSuccess({
          data,
          human: `Session ${String((data as any).id)} state=${String((data as any).state)} pending_step=${String(
            (data as any).pending_step
          )}`,
        });
      })
    );

  guided
    .command("answer <sessionId>")
    .description("Submit guided session answer")
    .requiredOption("--answer <answer>", "Answer string")
    .action(
      withRuntime(context, async (runtime, sessionId: string, options: { answer: string }) => {
        const data = await runtime.request({
          method: "POST",
          path: `/mapping-agent-lab/sessions/${sessionId}/answer`,
          auth: "session",
          body: { answer: options.answer },
        });
        return runtime.emitSuccess({
          data,
          human: `Session ${String((data as any).id)} updated: state=${String((data as any).state)}`,
        });
      })
    );

  guided
    .command("proposal <sessionId>")
    .description("Get guided proposal")
    .action(
      withRuntime(context, async (runtime, sessionId: string) => {
        const data = await runtime.request({
          method: "GET",
          path: `/mapping-agent-lab/sessions/${sessionId}/proposal`,
          auth: "session",
        });
        const rules = Array.isArray((data as any).include_rules) ? (data as any).include_rules.length : 0;
        return runtime.emitSuccess({ data, human: `Proposal ready: include_rules=${rules}` });
      })
    );

  guided
    .command("validate <sessionId>")
    .description("Validate guided proposal")
    .option("--selection-fingerprint <selectionFingerprint>", "Optional scope fingerprint")
    .action(
      withRuntime(
        context,
        async (runtime, sessionId: string, options: { selectionFingerprint?: string }) => {
          const body: Record<string, unknown> = {};
          if (options.selectionFingerprint) {
            body.selection_fingerprint = options.selectionFingerprint;
          }
          const data = await runtime.request({
            method: "POST",
            path: `/mapping-agent-lab/sessions/${sessionId}/validate`,
            auth: "session",
            body,
          });
          return runtime.emitSuccess({
            data,
            human: `Session validated: status=${String((data as any).validation_status)}`,
          });
        }
      )
    );

  guided
    .command("activate <sessionId>")
    .description("Activate guided proposal")
    .option("--selection-fingerprint <selectionFingerprint>", "Optional scope fingerprint")
    .option("--confirm-sample", "Confirm sample preview before activation")
    .option("--yes", "Alias for --confirm-sample")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          sessionId: string,
          options: { selectionFingerprint?: string; confirmSample?: boolean; yes?: boolean }
        ) => {
          const status = (await runtime.request({
            method: "GET",
            path: `/mapping-agent-lab/sessions/${sessionId}`,
            auth: "session",
          })) as Record<string, any>;
          if (String(status.validation_status || "") !== "passed") {
            throw safetyBlocked("Validation must pass before activation.", [
              `Run \`uf mapping guided validate ${sessionId}\` first.`,
            ]);
          }
          if (!options.confirmSample && !options.yes) {
            throw safetyBlocked("Confirm sample preview before activation.", [
              "Pass `--confirm-sample` after reviewing proposal preview.",
            ]);
          }
          const body: Record<string, unknown> = { sample_confirmed: true };
          if (options.selectionFingerprint) {
            body.selection_fingerprint = options.selectionFingerprint;
          }
          const data = await runtime.request({
            method: "POST",
            path: `/mapping-agent-lab/sessions/${sessionId}/activate`,
            auth: "session",
            body,
          });
          return runtime.emitSuccess({
            data,
            human: `Guided mapping activated: session=${String((data as any).id)} mapping_set_id=${String(
              (data as any).mapping_set_id
            )}`,
          });
        }
      )
    );

  const set = mapping.command("set").description("Low-level mapping-set commands");
  set
    .command("create <connectorId>")
    .description("Create draft mapping set from rules file")
    .requiredOption("--rules-file <rulesFile>", "Path to JSON array of mapping rules")
    .option("--created-by <createdBy>", "Creator label", "agent")
    .action(
      withRuntime(
        context,
        async (runtime, connectorId: string, options: { rulesFile: string; createdBy: string }) => {
          const rules = loadRulesFile(options.rulesFile);
          const data = await runtime.request({
            method: "POST",
            path: `/connectors/${connectorId}/mapping-sets`,
            auth: "session",
            body: { created_by: options.createdBy, rules },
          });
          return runtime.emitSuccess({
            data,
            human: `Draft mapping set created: ${String((data as any).id)} v${String((data as any).version)}`,
          });
        }
      )
    );

  set
    .command("list <connectorId>")
    .description("List mapping sets for connector")
    .option("--status <status>", "Optional status filter")
    .action(
      withRuntime(context, async (runtime, connectorId: string, options: { status?: string }) => {
        const data = (await runtime.request({
          method: "GET",
          path: `/connectors/${connectorId}/mapping-sets`,
          auth: "session",
          query: options.status ? { status: options.status } : undefined,
        })) as Array<Record<string, any>>;
        const human = data
          .map(
            (row) =>
              `${String(row.id)}  v${String(row.version)}  status=${String(row.status)}  validation=${String(
                row.validation_status
              )}`
          )
          .join("\n");
        return runtime.emitSuccess({ data, human: human || "No mapping sets found." });
      })
    );

  set
    .command("get <mappingSetId>")
    .description("Get mapping set detail")
    .action(
      withRuntime(context, async (runtime, mappingSetId: string) => {
        const data = await runtime.request({
          method: "GET",
          path: `/mapping-sets/${mappingSetId}`,
          auth: "session",
        });
        return runtime.emitSuccess({
          data,
          human: `Mapping set ${String((data as any).id)} v${String((data as any).version)} status=${String(
            (data as any).status
          )}`,
        });
      })
    );

  set
    .command("validate <mappingSetId>")
    .description("Validate mapping set")
    .option("--sample-size <sampleSize>", "Validation sample size", parseInteger, 3)
    .option("--max-objects <maxObjects>", "Validation object cap", parseInteger, 2000)
    .action(
      withRuntime(
        context,
        async (
          runtime,
          mappingSetId: string,
          options: {
            sampleSize: number;
            maxObjects: number;
          }
        ) => {
          const data = await runtime.request({
            method: "POST",
            path: `/mapping-sets/${mappingSetId}/validate`,
            auth: "session",
            body: {
              sample_size: options.sampleSize,
              max_objects: options.maxObjects,
            },
          });
          return runtime.emitSuccess({
            data,
            human: `Validation status: ${String((data as any).validation_status)}`,
          });
        }
      )
    );

  set
    .command("activate <mappingSetId>")
    .description("Activate mapping set")
    .action(
      withRuntime(context, async (runtime, mappingSetId: string) => {
        const current = (await runtime.request({
          method: "GET",
          path: `/mapping-sets/${mappingSetId}`,
          auth: "session",
        })) as Record<string, any>;
        if (String(current.validation_status || "") !== "passed") {
          throw safetyBlocked("Mapping set must pass validation before activation.", [
            `Run \`uf mapping set validate ${mappingSetId}\` first.`,
          ]);
        }
        const data = await runtime.request({
          method: "POST",
          path: `/mapping-sets/${mappingSetId}/activate`,
          auth: "session",
          body: {},
        });
        return runtime.emitSuccess({
          data,
          human: `Mapping set activated: ${String((data as any).id)} v${String((data as any).version)}`,
        });
      })
    );

  mapping
    .command("diff")
    .description("Diff candidate rules against active mapping set")
    .option("--mapping-set-id <mappingSetId>", "Candidate mapping set id")
    .option("--guided-session-id <guidedSessionId>", "Candidate guided session id")
    .action(
      withRuntime(
        context,
        async (runtime, options: { mappingSetId?: string; guidedSessionId?: string }) => {
          const hasMappingSet = Boolean(options.mappingSetId);
          const hasGuided = Boolean(options.guidedSessionId);
          if (hasMappingSet === hasGuided) {
            throw new CliError({
              errorCode: "invalid_arguments",
              message: "Provide exactly one of --mapping-set-id or --guided-session-id.",
              exitCode: 2,
              recoverable: false,
            });
          }

          let connectorId = "";
          let candidateRules: Rule[] = [];
          let sourceMeta: Record<string, unknown> = {};

          if (options.mappingSetId) {
            const detail = (await runtime.request({
              method: "GET",
              path: `/mapping-sets/${options.mappingSetId}`,
              auth: "session",
            })) as Record<string, any>;
            connectorId = String(detail.connector_id || "");
            candidateRules = Array.isArray(detail.rules)
              ? detail.rules
                  .filter((row) => row && typeof row === "object" && !Array.isArray(row))
                  .map((row) => normalizeRule(row as Record<string, any>))
              : [];
            sourceMeta = { source: "mapping_set", mapping_set: detail };
          } else {
            const sessionId = String(options.guidedSessionId || "");
            const session = (await runtime.request({
              method: "GET",
              path: `/mapping-agent-lab/sessions/${sessionId}`,
              auth: "session",
            })) as Record<string, any>;
            const proposal = (await runtime.request({
              method: "GET",
              path: `/mapping-agent-lab/sessions/${sessionId}/proposal`,
              auth: "session",
            })) as Record<string, any>;
            connectorId = String(session.connector_id || "");
            candidateRules = Array.isArray(proposal.include_rules)
              ? proposal.include_rules
                  .filter((row) => row && typeof row === "object" && !Array.isArray(row))
                  .map((row) => normalizeRule(row as Record<string, any>))
              : [];
            sourceMeta = { source: "guided_session", session_id: sessionId, proposal };
          }

          if (!connectorId) {
            throw new CliError({
              errorCode: "connector_id_missing",
              message: "Unable to resolve connector id for diff source.",
              exitCode: 5,
              recoverable: false,
            });
          }

          const activeRows = (await runtime.request({
            method: "GET",
            path: `/connectors/${connectorId}/mapping-sets`,
            auth: "session",
            query: { status: "active" },
          })) as Array<Record<string, any>>;

          let activeRules: Rule[] = [];
          let activeMappingSetId: string | null = null;
          if (activeRows.length > 0) {
            const active = [...activeRows].sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
            activeMappingSetId = String(active.id || "");
            const activeDetail = (await runtime.request({
              method: "GET",
              path: `/mapping-sets/${activeMappingSetId}`,
              auth: "session",
            })) as Record<string, any>;
            activeRules = Array.isArray(activeDetail.rules)
              ? activeDetail.rules
                  .filter((row) => row && typeof row === "object" && !Array.isArray(row))
                  .map((row) => normalizeRule(row as Record<string, any>))
              : [];
          }

          const activeBySig = new Map(activeRules.map((rule) => [ruleSignature(rule), normalizeRule(rule)]));
          const candidateBySig = new Map(candidateRules.map((rule) => [ruleSignature(rule), normalizeRule(rule)]));

          const added = [...candidateBySig.keys()]
            .filter((sig) => !activeBySig.has(sig))
            .sort()
            .map((sig) => candidateBySig.get(sig) as Rule);
          const removed = [...activeBySig.keys()]
            .filter((sig) => !candidateBySig.has(sig))
            .sort()
            .map((sig) => activeBySig.get(sig) as Rule);
          const unchanged = [...candidateBySig.keys()]
            .filter((sig) => activeBySig.has(sig))
            .sort()
            .map((sig) => candidateBySig.get(sig) as Rule);

          const result = {
            connector_id: connectorId,
            active_mapping_set_id: activeMappingSetId,
            source: sourceMeta,
            summary: {
              active_rule_count: activeRules.length,
              candidate_rule_count: candidateRules.length,
              added: added.length,
              removed: removed.length,
              unchanged: unchanged.length,
            },
            added_rules: added,
            removed_rules: removed,
            unchanged_rules: unchanged,
          };

          return runtime.emitSuccess({
            data: result,
            human: `Mapping diff connector=${connectorId} added=${added.length} removed=${removed.length} unchanged=${unchanged.length}`,
          });
        }
      )
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

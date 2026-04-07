import type { Command } from "commander";
import { withRuntime, type CommandContext } from "../commandContext";
import { safetyBlocked } from "../errors";

function syncBody(options: {
  mode: string;
  prefix?: string;
  forceApplyDeletes?: boolean;
  dryRun: boolean;
}): Record<string, unknown> {
  return {
    mode: options.mode,
    dry_run: options.dryRun,
    force_apply_deletes: Boolean(options.forceApplyDeletes),
    prefix: options.prefix ?? null,
  };
}

function storePreview(runtime: any, bucketName: string, mode: string, previewData: Record<string, any>): void {
  const preview = (previewData.preview || {}) as Record<string, any>;
  const deletedCount = Array.isArray(preview.deleted) ? preview.deleted.length : 0;
  runtime.profile.last_sync_preview = {
    bucket_name: bucketName,
    mode,
    api_key_fingerprint: runtime.apiKeyFingerprint(),
    deleted_count: deletedCount,
    sync_run_id: previewData.sync_run_id || null,
    preview,
  };
  runtime.saveProfile();
}

function previewMatchesLast(runtime: any, bucketName: string, mode: string): boolean {
  const last = (runtime.profile.last_sync_preview || {}) as Record<string, any>;
  if (!last || Object.keys(last).length === 0) {
    return false;
  }
  if (String(last.bucket_name || "") !== String(bucketName)) {
    return false;
  }
  if (String(last.mode || "") !== String(mode)) {
    return false;
  }
  return String(last.api_key_fingerprint || "") === runtime.apiKeyFingerprint();
}

export function registerSyncCommands(program: Command, context: CommandContext): void {
  const sync = program.command("sync").description("Sync preview and execution commands");

  sync
    .command("preview <bucketName>")
    .description("Preview sync changes")
    .option("--mode <mode>", "Sync mode", "incremental")
    .option("--prefix <prefix>", "Optional prefix")
    .option("--force-apply-deletes", "Force apply deletes in preview payload")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          bucketName: string,
          options: { mode: string; prefix?: string; forceApplyDeletes?: boolean }
        ) => {
          const data = (await runtime.request({
            method: "POST",
            path: `/buckets/${bucketName}/sync/preview`,
            auth: "api_key",
            body: syncBody({
              mode: options.mode,
              prefix: options.prefix,
              forceApplyDeletes: options.forceApplyDeletes,
              dryRun: true,
            }),
          })) as Record<string, any>;
          storePreview(runtime, bucketName, options.mode, data);
          const deleted = Array.isArray((data.preview || {}).deleted) ? (data.preview || {}).deleted.length : 0;
          return runtime.emitSuccess({
            data,
            human: `Sync preview: run=${String(data.sync_run_id)} status=${String(data.status)} deleted=${deleted}`,
          });
        }
      )
    );

  sync
    .command("run <bucketName>")
    .description("Run sync after preview safety checks")
    .option("--mode <mode>", "Sync mode", "incremental")
    .option("--prefix <prefix>", "Optional prefix")
    .option("--use-last-preview", "Reuse matching last preview from profile")
    .option("--confirm-deletes", "Required when preview includes deletions")
    .option("--yes", "Alias for --confirm-deletes")
    .option("--force-apply-deletes", "Pass force apply deletes to backend")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          bucketName: string,
          options: {
            mode: string;
            prefix?: string;
            useLastPreview?: boolean;
            confirmDeletes?: boolean;
            yes?: boolean;
            forceApplyDeletes?: boolean;
          }
        ) => {
          const confirmed = Boolean(options.confirmDeletes || options.yes);
          let previewData: Record<string, any>;
          if (options.useLastPreview && previewMatchesLast(runtime, bucketName, options.mode)) {
            const last = (runtime.profile.last_sync_preview || {}) as Record<string, any>;
            previewData = {
              sync_run_id: last.sync_run_id || null,
              preview: last.preview || {},
              status: "completed",
            };
          } else {
            previewData = (await runtime.request({
              method: "POST",
              path: `/buckets/${bucketName}/sync/preview`,
              auth: "api_key",
              body: syncBody({
                mode: options.mode,
                prefix: options.prefix,
                forceApplyDeletes: options.forceApplyDeletes,
                dryRun: true,
              }),
            })) as Record<string, any>;
            storePreview(runtime, bucketName, options.mode, previewData);
          }

          const deletedCount = Array.isArray((previewData.preview || {}).deleted)
            ? (previewData.preview || {}).deleted.length
            : 0;
          if (deletedCount > 0 && !confirmed) {
            throw safetyBlocked(`Preview includes ${deletedCount} deletions. Pass --confirm-deletes to proceed.`, [
              `Run \`uf sync preview ${bucketName}\` to inspect deletions.`,
              `Re-run \`uf sync run ${bucketName} --confirm-deletes\` if intended.`,
            ]);
          }

          const runBody = syncBody({
            mode: options.mode,
            prefix: options.prefix,
            forceApplyDeletes: options.forceApplyDeletes,
            dryRun: false,
          });
          if (confirmed) {
            runBody.force_apply_deletes = true;
          }
          const run = await runtime.request({
            method: "POST",
            path: `/buckets/${bucketName}/sync`,
            auth: "api_key",
            body: runBody,
          });
          return runtime.emitSuccess({
            data: { preview: previewData, run },
            human: `Sync run started: run=${String((run as any).sync_run_id)} status=${String((run as any).status)}`,
          });
        }
      )
    );

  sync
    .command("runs <bucketName>")
    .description("List sync runs for bucket")
    .action(
      withRuntime(context, async (runtime, bucketName: string) => {
        const data = (await runtime.request({
          method: "GET",
          path: `/buckets/${bucketName}/sync-runs`,
          auth: "api_key",
        })) as Array<Record<string, any>>;
        const human = data
          .map(
            (row) =>
              `${String(row.id)}  ${String(row.status)}  mode=${String(row.mode)}  created=${String(row.created_at)}`
          )
          .join("\n");
        return runtime.emitSuccess({ data, human: human || "No sync runs found." });
      })
    );

  sync
    .command("get <bucketName> <syncRunId>")
    .description("Get sync run detail")
    .action(
      withRuntime(context, async (runtime, bucketName: string, syncRunId: string) => {
        const data = (await runtime.request({
          method: "GET",
          path: `/buckets/${bucketName}/sync-runs/${syncRunId}`,
          auth: "api_key",
        })) as Record<string, any>;
        const run = (data.run || {}) as Record<string, any>;
        return runtime.emitSuccess({ data, human: `Sync run ${String(run.id)} status=${String(run.status)}` });
      })
    );

  sync
    .command("retry <bucketName> <syncRunId>")
    .description("Retry a sync run")
    .option("--force-apply-deletes", "Force apply deletes on retry")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          bucketName: string,
          syncRunId: string,
          options: { forceApplyDeletes?: boolean }
        ) => {
          const data = await runtime.request({
            method: "POST",
            path: `/buckets/${bucketName}/sync-runs/${syncRunId}/retry`,
            auth: "api_key",
            body: { force_apply_deletes: Boolean(options.forceApplyDeletes) },
          });
          return runtime.emitSuccess({
            data,
            human: `Sync retry started: run=${String((data as any).sync_run_id)} status=${String((data as any).status)}`,
          });
        }
      )
    );

  sync
    .command("settings <bucketName>")
    .description("Get or update sync settings")
    .option("--enable-auto-sync", "Enable auto sync")
    .option("--disable-auto-sync", "Disable auto sync")
    .option("--schedule-minutes <scheduleMinutes>", "Set schedule interval in minutes", parseInteger)
    .option("--delete-threshold-ratio <deleteThresholdRatio>", "Set delete threshold ratio (0-1)", parseFloatStrict)
    .option("--require-manual-delete-confirm", "Require manual delete confirm")
    .option("--no-require-manual-delete-confirm", "Disable manual delete confirm")
    .action(
      withRuntime(
        context,
        async (
          runtime,
          bucketName: string,
          options: {
            enableAutoSync?: boolean;
            disableAutoSync?: boolean;
            scheduleMinutes?: number;
            deleteThresholdRatio?: number;
            requireManualDeleteConfirm?: boolean;
            noRequireManualDeleteConfirm?: boolean;
          }
        ) => {
          const payload: Record<string, unknown> = {};
          if (options.enableAutoSync) {
            payload.auto_sync_enabled = true;
          }
          if (options.disableAutoSync) {
            payload.auto_sync_enabled = false;
          }
          if (options.scheduleMinutes !== undefined) {
            payload.schedule_minutes = options.scheduleMinutes;
          }
          if (options.deleteThresholdRatio !== undefined) {
            payload.delete_threshold_ratio = options.deleteThresholdRatio;
          }
          if (options.requireManualDeleteConfirm === true) {
            payload.require_manual_delete_confirm = true;
          }
          if (options.noRequireManualDeleteConfirm === true || options.requireManualDeleteConfirm === false) {
            payload.require_manual_delete_confirm = false;
          }
          if (Object.keys(payload).length > 0) {
            const data = await runtime.request({
              method: "PUT",
              path: `/buckets/${bucketName}/sync-settings`,
              auth: "api_key",
              body: payload,
            });
            return runtime.emitSuccess({ data, human: `Sync settings updated for bucket ${bucketName}` });
          }
          const data = await runtime.request({
            method: "GET",
            path: `/buckets/${bucketName}/sync-settings`,
            auth: "api_key",
          });
          return runtime.emitSuccess({ data, human: `Sync settings loaded for bucket ${bucketName}` });
        }
      )
    );
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

function parseFloatStrict(value: string): number {
  return Number.parseFloat(value);
}

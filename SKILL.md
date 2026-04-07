# Ultrafilter CLI Skill

Use this CLI when an AI agent needs to control Ultrafilter indexing and search from a terminal.

## Mission

Drive the backend through an agent-first staged workflow instead of dashboard clicks.

Implementation note:

- primary runtime is Node/TypeScript (`uf` npm binary)
- legacy Python entrypoint is compatibility-only and forwards to Node build

## Identity Model

Treat human identity and agent identity separately.

- humans authenticate in the UI
- agents authenticate with project-scoped API keys
- the agent must not use email/password login for the normal indexing workflow
- the backend is the source of truth for API key project scope, status, and audit metadata

Use:

```text
uf auth key use <raw_api_key> --json
uf auth key status --json
```

The key-status payload is authoritative for:

- `key_id`
- `key_fingerprint`
- `project_id`
- `project_name`
- `organization_id`
- `organization_name`
- `scopes`
- `status`

Do not rely on session/key matching for security decisions.

## Primary Workflow

The default agent surface is `uf index ...`.

Low-level commands such as `uf connector ...`, `uf mapping ...`, `uf sync ...`, and `uf search ...` still exist for debugging, but they are not the primary workflow.

The canonical stage order is:

1. `source`
2. `selection`
3. `routing`
4. `preview`
5. `sync`
6. `endpoint`

Use:

```text
uf index init --json
uf index status --session <index_session_id> --json
uf index source bucket --session <index_session_id> ... --json
uf index source folder --session <index_session_id> --path <local_folder> --json
uf index source verify --session <index_session_id> --json
uf index select --session <index_session_id> ... --json
uf index route --session <index_session_id> --route .txt=text --route .jpg=image --json
uf index preview --session <index_session_id> --json
uf index sync --session <index_session_id> [--confirm-deletes] --json
uf index endpoint --session <index_session_id> --json
```

## Stage Semantics

### Source

Choose one source type:

- `bucket`
- `local_folder`

Rules:

- `bucket` creates or updates an external bucket connector
- `local_folder` uploads files into managed storage and normalizes to the same connector model
- after configuring a bucket source, run `uf index source verify`
- after configuring a folder source, selection can start immediately once upload completes

### Selection

Selection is explicit and file-oriented.

Supported filters:

- `include_prefixes`
- `exclude_prefixes`
- `include_extensions`
- `exclude_extensions`
- scan budget and sample limit

The selection response must tell the agent:

- resolved filters
- matched object count estimate
- sample keys
- extension counts
- family counts
- `selection_fingerprint`

### Routing

Routing is explicit and file-type based.

Each selected extension must be assigned to exactly one of:

- `text`
- `image`
- `pdf`
- `skip`

The response must include:

- full route table
- unmatched extensions
- ambiguous cases
- counts by route
- parser assumptions

Routing creates, validates, and activates a mapping set under the hood. The agent does not need to use guided mapping for the normal `uf index ...` path.

### Preview

Preview is mandatory before sync.

The preview response must include:

- new count
- updated count
- deleted count
- skipped count
- examples for each category
- whether delete confirmation is required

### Sync

Rules:

- sync requires a prior valid preview from the same `index_session`
- if preview shows deletions, the agent must pass `--confirm-deletes`
- sync returns the resulting run id and updates session state

### Endpoint

The endpoint stage returns the final query artifact:

- query URL
- bucket/index identifier
- supported routes
- ready-to-run example queries

## JSON Contract

Every successful `uf index ...` command must emit the same top-level JSON envelope:

- `ok`
- `stage`
- `stage_status`
- `session`
- `auth_context`
- `state`
- `summary`
- `warnings`
- `missing_requirements`
- `next_actions`
- `artifacts`

`next_actions` must contain exact runnable CLI commands. Do not replace them with generic advice.

## Agent Rules

1. Always prefer `--json` for automation.
2. Never guess ids. Read and reuse the returned `index_session_id`, `connector_id`, and `sync_run_id`.
3. Never skip preview.
4. Never apply deletions without explicit confirmation.
5. Always read `stage`, `stage_status`, `missing_requirements`, and `next_actions` before deciding the next command.
6. Treat `auth_context` as the authoritative project scope for the session.

## Fallback Guidance

If the `uf index ...` workflow cannot complete because a feature is missing or the backend blocks the request:

- report that clearly
- do not invent state
- use `uf index status --session <id> --json` to re-anchor state
- only fall back to low-level commands when the task explicitly requires debugging

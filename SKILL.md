# Ultrafilter CLI Skill

Use this CLI when an AI agent needs to control Ultrafilter indexing and search from a terminal.

## Mission

Drive the backend through an agent-first staged workflow instead of dashboard clicks.

Implementation note:

- primary runtime is Node/TypeScript (`uf` npm binary)
- legacy Python entrypoint is compatibility-only and forwards to the Node build

## Start Here

Default assumptions:

- the CLI talks to the control API base URL, not the frontend URL
- project-scoped API keys are the default auth mode for agent work
- session auth exists for bootstrap, testing, and human-operated setup

Read this skill in this order:

1. decide auth mode
2. establish project context
3. inspect shared work state when needed
4. use `uf index ...` as the primary workflow
5. fall back to lower-level commands only for debugging or missing features

## Auth Decision Rule

Use exactly one of these modes based on the task.

### Mode 1: Agent Runtime

Use project-scoped API keys for normal indexing, sync, search, and connector work.

Use:

```text
uf auth key use <raw_api_key> --json
uf auth key status --json
```

This is the default agent auth mode.

Use it when:

- the task is normal agent execution
- the project already exists
- the agent is expected to operate deterministically inside one project

Do not use email/password login for steady-state agent operation.

### Mode 2: Human Session Bootstrap

Use session auth only when the task explicitly involves account creation, human login, testing a user session, or creating the first project/key.

Supported commands:

```text
uf auth signup --email <email> --password <password> --organization-name <org> --project-name <project>
uf auth login --email <email> --password <password>
uf auth dev-login --token <UF_DEV_BACKDOOR_TOKEN>
uf auth status
uf auth whoami
uf auth logout
```

Use session auth when:

- bootstrapping a new account
- verifying `/control/signup`, `/control/login`, or `/control/dev-login`
- creating or selecting a project before switching to API-key auth
- debugging human-facing auth behavior

Do not stop at session auth if the actual task is indexing automation. Switch to API-key auth after bootstrap.

## Identity Model

Treat human identity and agent identity separately.

- humans authenticate with sessions
- agents authenticate with project-scoped API keys
- the backend is the source of truth for API key project scope, status, and audit metadata

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

## Shared-State Rule

The CLI is an alternate control surface for the same Ultrafilter project, not a separate subsystem.

Assume shared state is authoritative:

- connectors created in the dashboard should be reusable from the CLI
- local-folder sources created through the CLI should become visible in the dashboard
- sync runs started by the agent should appear in shared sync history
- failed objects discovered during agent sync should be treated as shared project health state

Do not invent parallel agent-only state when shared resources already exist.

## Shared Work Sessions

Use `uf session ...` to inspect work created from either the dashboard or the CLI.

Use:

```text
uf session list --json
uf session show <work_session_ref> --json
```

Expect shared work-session refs such as:

- `index:<uuid>`
- `mapping:<uuid>`
- `upload:<uuid>`
- `sync:<uuid>`

Use this before guessing what happened in a project. The dashboard and the CLI should describe the same underlying work.

## Project Context Rule

Project context must be explicit and stable.

After `signup`, `login`, or `dev-login`:

- the CLI fetches `/control/me`
- if exactly one project exists, it sets that project as current automatically
- if a current project is already pinned and still exists, it keeps it
- if multiple projects exist and no valid current project is pinned, it clears current project and reports `project_selection_required=true`

The agent must read that result and resolve project context before continuing.

## Primary Workflow

The default agent surface is `uf index ...`.

Low-level commands such as `uf connector ...`, `uf mapping ...`, `uf sync ...`, and `uf search ...` still exist for debugging, but they are not the primary workflow.

Auth boundary rules for lower-level commands:

- `uf connector create` with an active API key is agent-safe. It creates an `index_session` and attaches the bucket source there.
- `uf connector create` with only session auth uses the legacy human `/connectors` path.
- `uf connector verify` is legacy session-only. For the agent workflow, use `uf index source verify --session <index_session_id>`.
- `uf connector list`, `inspect`, `samples`, and `sample-object` can use API-key auth.
- `uf sync clean` is API-key-safe. It deletes indexed state while keeping the bucket or folder source configuration.

Canonical stage order:

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
uf index sync-start --session <index_session_id> [--confirm-deletes] --json
uf index check --session <index_session_id> --json
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
- scan budget
- sample limit

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

Agent waiting rule:

- for small jobs, it is acceptable to use `uf index sync` and wait for completion
- for larger jobs, prefer `uf index sync-start` so the agent can continue doing other work
- after `uf index sync-start`, use `uf index check --session <index_session_id> --json` whenever progress needs to be checked
- once `check` shows the sync is ready/completed, use `uf index endpoint --session <index_session_id> --json`

Cleanup rules:

- `uf sync clean <bucket> --type <text|image|pdf> --confirm` deletes vectors, manifests, and source-object tracking for one index type
- `uf sync clean <bucket> --all-types --confirm` runs the same cleanup for `text`, `image`, and `pdf`
- cleanup keeps the connector/source definition intact
- cleanup is not the same as resetting change state; treat those as separate operations

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
2. Never guess ids. Read and reuse the returned `index_session_id`, `connector_id`, `sync_run_id`, `project_id`, and `key_id`.
3. Never skip preview.
4. Never apply deletions without explicit confirmation.
5. Always read `stage`, `stage_status`, `missing_requirements`, `warnings`, and `next_actions` before deciding the next command.
6. Treat `auth_context` as the authoritative project scope for the current session.
7. Use session auth only for bootstrap or auth testing; use API-key auth for normal agent execution.
8. Talk to the control API base URL, not the frontend URL.

## Fallback Guidance

If the `uf index ...` workflow cannot complete because a feature is missing or the backend blocks the request:

- report that clearly
- do not invent state
- use `uf index status --session <id> --json` to re-anchor state
- only fall back to low-level commands when the task explicitly requires debugging

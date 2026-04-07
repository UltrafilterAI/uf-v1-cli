# Ultrafilter CLI

Ultrafilter CLI is the agent-first command surface for the Ultrafilter backend.

This repository is a standalone npm package. It is not a second backend. It is a thin orchestration layer over the same control-plane and public bucket APIs used by the Ultrafilter product.

## Purpose

The CLI is designed for AI agents and automation systems that need to:

- authenticate with project-scoped API keys
- create and resume staged indexing sessions
- connect a bucket or upload a local folder
- choose what to index
- assign file types to text, image, pdf, or skip
- preview and run sync safely
- retrieve the final query endpoint
- use lower-level project, connector, mapping, sync, and search commands when debugging is required

## Primary Workflow

The default workflow is `uf index ...`.

Main commands:

- `uf auth key use <raw_key> --json`
- `uf auth key status --json`
- `uf index init --json`
- `uf index status --session <session_id> --json`
- `uf index source bucket --session <session_id> ... --json`
- `uf index source folder --session <session_id> --path <folder> --json`
- `uf index source verify --session <session_id> --json`
- `uf index select --session <session_id> ... --json`
- `uf index route --session <session_id> --route .txt=text --route .jpg=image --json`
- `uf index preview --session <session_id> --json`
- `uf index sync --session <session_id> [--confirm-deletes] --json`
- `uf index endpoint --session <session_id> --json`

The lower-level namespaces remain available:

- `uf project ...`
- `uf connector ...`
- `uf mapping ...`
- `uf sync ...`
- `uf search ...`
- `uf docs ...`

## Output Contract

For agent use, prefer `--json`.

The `uf index ...` commands return a structured envelope that includes:

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

`next_actions` always contains exact runnable commands so an agent can continue without guessing.

## Safety Rules

- do not use human email/password login for the normal agent workflow
- do not skip preview before sync
- do not confirm deletions unless intended
- do not guess ids; reuse the returned `session.id`, `connector_id`, and `sync_run_id`
- read `missing_requirements` and `next_actions` before deciding what to do next

## Example

```bash
uf auth key use <raw-managed-api-key> --json
uf auth key status --json
uf index init --json
uf index source bucket --session <session_id> --bucket-name my-bucket --provider r2 --region auto --access-key-id <id> --secret-access-key <secret> --json
uf index source verify --session <session_id> --json
uf index select --session <session_id> --include-ext .json --include-ext .jpg --json
uf index route --session <session_id> --route .json=text --route .jpg=image --json
uf index preview --session <session_id> --json
uf index sync --session <session_id> --json
uf index endpoint --session <session_id> --json
```

## Development

Run from this package root:

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/main.js --help
```

Read local docs:

```bash
node dist/main.js docs readme --plain
node dist/main.js docs skill --plain
```

## Publishing

Package name: `@tuzhenzhao/ultrafilter-cli`

Before publishing:

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

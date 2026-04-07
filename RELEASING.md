# Releasing Ultrafilter CLI

Package: `@tuzhenzhao/ultrafilter-cli`

## Versioning Policy

- `MAJOR`: breaking CLI contract changes
- `MINOR`: backward-compatible new commands or options
- `PATCH`: fixes and internal improvements with no CLI contract break

## Local Verification Before Publish

Run from this package root:

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
node dist/main.js --help
```

## Publish Flow

1. Update `package.json` version.
2. Commit and push the release branch/tag in your GitHub repo.
3. Publish from GitHub Actions or locally with `npm publish`.

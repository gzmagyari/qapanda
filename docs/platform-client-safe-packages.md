# QA Panda Hosted Platform Packages

This repository consumes the hosted platform through the client-safe `@qapanda/*` packages only. The short-term `B-01` workflow uses local tarballs produced from the platform repo. The long-term path is a private registry.

## Client-safe packages this repo must be able to consume

- `@qapanda/contracts`
- `@qapanda/run-protocol`
- `@qapanda/cloud-sdk`
- `@qapanda/sync-core`
- `@qapanda/security`
- `@qapanda/ui`
- `@qapanda/client-cloud`

These packages are marked `qapanda.clientSafe = true` in the platform repo and are packed from `propanda/qapanda-platform/packages/*`.

## Short-term local tarball workflow

1. Build and pack the platform packages:

```bash
npm run platform:cloud:pack
```

This builds `propanda/qapanda-platform` and writes tarballs plus a manifest to `.qpanda/platform-client-safe/`.

2. Install those tarballs into this repo:

```bash
npm run platform:cloud:install
```

This updates this repo's `package.json` and `package-lock.json` to point at the generated tarballs with `file:` dependencies.

3. Verify the imports resolve from this repo:

```bash
npm run platform:cloud:verify-imports
```

4. To refresh everything after platform package changes:

```bash
npm run platform:cloud:refresh
```

## Notes

- The tarballs and manifest live under `.qpanda/` and are intentionally ignored by git.
- This repo is `commonjs`, but the hosted platform packages are `ESM`; the import verification uses an `.mjs` script.
- `@qapanda/client-cloud` currently re-exports the SQLite-backed sync store, which imports `node:sqlite`. In practice, full import verification currently requires a Node runtime that supports `node:sqlite`.

## Long-term private-registry path

The tarball path is a local development bridge only. The intended stable path is:

1. Publish the client-safe `@qapanda/*` packages from the platform repo to a private registry.
2. Replace the tarball-based `file:` dependencies in this repo with semver versions from that registry.
3. Keep the package boundary the same: this repo may consume only the client-safe packages, never server-only platform internals.
4. Continue running a repo-local import verification step after upgrades so boundary regressions fail early.

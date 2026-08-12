# Standalone repository decisions

## Keep plugin, tests, replay corpus, and pinned runtime manifest together

**Status:** active · **Evidence:** confirmed (current integration tests and stock-host loader)

The repository root contains production TypeScript, all focused/integration tests, the redacted replay fixtures/goldens, and a small `runtime/omp-17.2.12` development fixture containing only its manifest, lockfile, launcher contract, and smoke instructions. Installed dependencies and generated `.omp-compact-test` state are ignored. **Reason:** the integration suite imports exact stock OMP 17.2.12 sources through a local runtime install; retaining the manifest and lockfile makes that boundary reproducible without committing roughly 1.1 GB of `node_modules`. **Rejected:** publishing only production files and losing the verified stock-host corpus, committing `node_modules`, or preserving the old nested `omp-compact/` directory.

## Keep internal research outside the public package surface

**Status:** active · **Evidence:** confirmed (marketplace package contract and current working files)

The repository keeps maintainable architecture/configuration/contributing documentation, but excludes raw review transcripts, migration reports, legacy global patch scripts, and private session handoff material from the plugin package and Git history. **Reason:** those artifacts are useful during migration but contain stale findings, old project paths, and recovery procedures unrelated to installing `omp-compact`. **Rejected:** copying the entire former `omp-patch` project into the new repository.


## Reject a second fold on the same live transcript

**Status:** active · **Evidence:** confirmed (real resumed-session stack overflow and duplicate-fold regression)

Every `TranscriptFold` claims its exact transcript instance with a `Symbol.for` ownership marker before installing descriptors, releases the claim on rollback/disposal, and rejects a second owner. The isolated source launcher also passes `--no-extensions` when loading `-e ./index.ts`. **Reason:** OMP path de-duplication compares resolved path strings rather than realpaths, so a user-linked symlink and an explicit checkout path can load the same plugin twice; the second fold otherwise captures the first fold's wrappers as "native" methods and recursively calls `isTranscriptBlockFinalized` until stack overflow. **Rejected:** prototype/global method patches, silently composing fold wrappers, or relying only on users never combining an installed plugin with `-e`.
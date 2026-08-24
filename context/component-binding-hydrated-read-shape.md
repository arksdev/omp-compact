## Legacy ledger-level read-segment queue shape (ComponentBinding)

**Status:** active · **Evidence:** confirmed

`#hydratedReadSegments` in `component-binding.ts` carries two queue shapes behind one interface: exact segments `{ ledger, stateIds: readonly string[] }` queued via `addHydratedReadSegment`, and the legacy ledger-level shape `{ ledger, stateIds: undefined }` queued via `addHydratedReadLedger`, resolved at pair time by the `stateIds ??` branch in `#assignReadSegment` to every unbound `read` state of that ledger.

`#queueReadSegments` in `rebuild-lifecycle.ts` is the sole production caller of either method and always passes a length-guarded `string[]` (`segmentIds.length > 0`), so the `undefined` shape never occurs in production. The two source comments (field doc and `addHydratedReadLedger` method doc) are accurate as written, including `"kept only for unit tests that queue one read state per ledger"` — every queued ledger in tests holds at most one read (the `reset` test queues an empty `TurnLedger("replay-1")` as an opaque queue filler, never resolved).

Tests that queue the legacy shape — the exact set to migrate before deleting it, all in `docs/tests/component-binding.test.ts`: "bindHydrated pairs read groups with hydrated ledgers in order" (~line 1012), "duplicate-ledger group stays unbound instead of a zero-claim ledger mark" (~1048), "bindHydrated ordinal offset accounts for exact-bound groups (no duplicate zero-claim)" (~1086), "bindHydrated suffix-aligns read groups to the trailing ledgers" (~1152), "bindHydrated suffix-aligns read groups carrying unresolved observed ids" (~1168), and "reset drops every association and component ref" (~1466, uses `hydratedReadLedgers()`).

**Reason:** the legacy shape is a semantic fork in a safety-critical replay path but it is test-only and deliberate; production never queues it, so it is not a defect. **Rejected:** deleting the shape now — six tests depend on it and `docs/tests/` must be editable in the same pass as the deletion; tightening the comments — they are accurate as written.

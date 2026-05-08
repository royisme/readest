# Fork merge policy

This is a fork of [readest/readest](https://github.com/readest/readest). It is
maintained as **single-device** reader (Inkline brand). Upstream features
related to multi-device sync are intentionally excluded.

This document is the source of truth for what to drop / keep when merging
upstream. Both humans and AI agents (Claude Code) should consult it before
running any upstream merge.

---

## Excluded feature categories

| Category | Reason |
|---|---|
| **Replica sync (CRDT)** — #4075 and follow-ups | No multi-device need |
| **Cross-device font sync** — #4077 | Same |
| **Cross-device background texture sync** — #4079 | Same |
| **Encrypted-field sync session** — #4084 | Same |
| **Dictionary store sync** — #4076 | Same |
| **KOSync** (KOReader Sync) | Same |
| **Readwise sync** | Same |
| **Hardcover sync** (book metadata service) | Same |
| **Notes sync / Progress sync / Books sync** | Same |
| **RSVP cross-device resume** — #4004 | Same |

> Note: per-device cloud-backup of `book_configs` (used by RSVP local resume)
> is **kept** — it is the local persistence layer, not multi-device sync.

---

## Files / directories to remove after merge

```
apps/readest-app/src/services/sync/
apps/readest-app/src/libs/replicaSyncClient.ts
apps/readest-app/src/libs/replicaSyncServer.ts
apps/readest-app/src/libs/sync.ts
apps/readest-app/src/hooks/useSync.ts
apps/readest-app/src/context/SyncContext.tsx
apps/readest-app/src/pages/api/sync.ts
apps/readest-app/src/pages/api/kosync.ts
apps/readest-app/src/pages/api/sync/**
apps/readest-app/src/app/reader/hooks/useReadwiseSync.ts
apps/readest-app/src/app/reader/hooks/useNotesSync.ts
apps/readest-app/src/app/reader/hooks/useKOSync.ts
apps/readest-app/src/app/reader/hooks/useHardcoverSync.ts
apps/readest-app/src/app/reader/hooks/useProgressSync.ts
apps/readest-app/src/app/library/hooks/useBooksSync.ts
apps/readest-app/src/app/reader/components/KOSyncResolver.tsx
apps/readest-app/src/app/reader/components/KOSyncSettings.tsx
apps/readest-app/src/app/reader/components/SyncInfoDialog.tsx
apps/readest-app/src/services/hardcover/HardcoverSyncMapStore.ts
apps/readest-app/src/types/kosync.ts
apps/readest-app/src/__tests__/libs/replicaSync*.test.ts
apps/readest-app/src/__tests__/services/sync/
apps/readest-app/src/__tests__/services/hardcover/HardcoverSyncMapStore.test.ts
apps/readest-app/src/__tests__/utils/kosync-ssrf.test.ts
```

> Re-grep before deleting — upstream may add/rename files. The list above is a
> starting point, not a contract.

---

## Required follow-up edits

After deleting the above, the build will break in these expected places.
Resolve by **removing the imports / call sites**, not by re-introducing the
removed code.

1. `src/app/layout.tsx` — drop `<SyncProvider>` wrapping
2. `src/app/reader/page.tsx` (or composition file) — drop sync hook calls
3. `src/app/library/**` — drop `useBooksSync` references
4. `src/components/settings/**` — remove sync settings panels and their entries
   in `SettingsDialog` panel map
5. `src/store/*Store.ts` — remove `subscribeToSync` style calls on stores
6. i18n keys: leave orphan keys in `i18next-options.json`; the extractor will
   prune on next `pnpm i18n:extract`

---

## Kept-but-watch areas

These touch sync-adjacent code but are **kept** because they have local-only
value:

- `book_configs` cloud backup (single-device read/write of own data)
- Hardcover **OAuth login + import** (without the sync-back map store)
- KOReader plugin (the koplugin itself; no Readest-side KOSync server)

If upstream changes these in ways that re-introduce multi-device coupling,
re-evaluate during merge review.

---

## Workflow per upstream merge

1. `git fetch upstream && git merge upstream/main`
2. Resolve conflicts as usual; **commit** the merge
3. Re-read this file; refresh the path list against the current tree
4. Delete excluded paths in a **separate** commit titled
   `chore(fork): strip sync features per FORK_POLICY`
5. Fix import/call-site fallout in the **same** commit
6. `pnpm lint && pnpm test`
7. Push

The two-commit shape keeps `git log --first-parent` readable: one merge
commit + one teardown commit per upstream cycle.

---

## When to revisit this policy

- If multi-device reading becomes a product requirement
- If upstream restructures so sync becomes a hard core dependency
  (currently it is opt-in via `SyncContext`)
- If a non-sync feature ends up gated behind a sync-only API

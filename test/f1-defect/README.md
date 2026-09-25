# TASK-009 k2 — kernel F1 drift guards

Ported from TASK-008's StuRaOS integration worktree
(`t009-int:test/f1-defect/guards/committees-no-manage-link.test.ts` and
`protocols-no-edit-link.test.ts`) into the kernel civitas repo, TASK-009 k2
item 2. The drift map found the kernel's own `/protokolle` list
(`gremion-ui/src/routes/protokolle/`) had the same discoverability defect the
product's `/protocols` page had before TASK-009 lane A fixed it there
(c33778d6): no `isAdmin` in the load, so no row could point at the
already-working per-committee editor. The kernel's `OrgDetailPanel.svelte`
seat-management link had the analogous defect, already fixed in this repo at
715c829 (link) + 008372e (aria-label) before this session started.

## Guards

| Guard file | Ports | Kernel target | Adaptation |
|---|---|---|---|
| `guards/committees-no-manage-link.test.ts` | `t009-int` guard of the same name | `gremion-ui/src/lib/components/committee/OrgDetailPanel.svelte` (unchanged path — same component, product carries it from here) | None — the kernel IS the file under test |
| `guards/protokolle-no-edit-link.test.ts` | `t009-int:protocols-no-edit-link.test.ts` | `gremion-ui/src/routes/protokolle/+page.svelte` | Renamed `protocols` → `protokolle` (the kernel never renamed this URL segment — see `c71fc29a`, product-only); adds an `aria-label` assertion the product fix does not carry (see TASK-009 k2 item 1's commit message) |

Run (from the kernel civitas repo root, after `pnpm install --frozen-lockfile
--filter gremion-ui...` in a fresh worktree):

```
pnpm --dir gremion-ui exec vitest run --config ../test/f1-defect/vitest.config.ts
```

Current result (2026-09-24, this session): **2 test files, 4 tests, all
GREEN** — both fixes (item 1 in this session; 715c829/008372e already on
this branch) are in place.

## RED-before-the-fix proof

Per this task's own rule ("prove each ported guard RED against the kernel
BEFORE the fixes … or revert the fix in a scratch commit and restore"), each
guard was run once against the pre-fix file content, then the working tree
was restored:

- **committees-no-manage-link**: `git show 715c829~1:<path> > <path>`
  (content immediately before the lane-A fix), guard run —
  admin case **RED** (`expected [] to include
  '/members/committees/committee-1'`), non-admin case still GREEN (no
  privilege leak, trivially true with no link at all) — then
  `git checkout -- <path>` to restore.
- **protokolle-no-edit-link**: `git show 008372e:<path> > <path>` for both
  `+page.server.ts` and `+page.svelte` (content immediately before this
  session's item-1 fix), guard run — admin case **RED** (same "expected []
  to include" shape) — then `git checkout -- <path>` (both files) to
  restore.

Both restores were verified against `git status --short` (clean) and a
full re-run of the guard suite (GREEN) before this file and the guards were
committed.

## Config

`vitest.config.ts` is a standalone config (same rationale as the ported
`t009-int` original — `gremion-ui/vite.config.ts`'s own `test.include` is
deliberately narrow and this task forbids widening it) — see the file's own
header comment for why `@sveltejs/kit/vite` and
`@testing-library/svelte/vite` are resolved by hand rather than imported by
bare specifier.

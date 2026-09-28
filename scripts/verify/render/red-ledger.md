# TASK-053 RED ledger (G-053-ledger, TRD-343)

One `## <guard-id>` per id exported by `render/suite.mjs` `GUARD_IDS`; each holds a dated
mutation, the observed failing output, the observed passing output on the same case after
the restore, the verifier and the restore. `render/ledger.test.mjs` fails on an incomplete
section or on fewer than 5 ids.

All mutations ran in a scratch worktree (`.scratch/seed`, git-excluded, detached HEAD), one
break at a time, restored byte-identical before the next; never on the branch. Times are
Europe/Berlin (CEST). Kernel `main` was a8c25883 when these ran (merged into the branch at
the start of R28).

**Grants used (brief section 3):** G1 TASK-045 (`verify.mjs` two imports + two
`SUITE_REGISTRY` entries after `census`; `required-suites.txt` two lines after `census`);
G2 TASK-040 (`colourSuffixViolations` body in `check-pooled-stack.mjs` delegates to
`render/colour-suffix.mjs`, plus the one `import` line the body needs; signature and output
strings unchanged); G3 gremion-ui `scripts/boundary-lint.ts` (`collectAll(root)`, `--root`,
`--min-files`, the refusal, the usage line); G4 new
`gremion-ui/src/lib/server/boundary/boundary-lint-vacuity.test.ts`.

**Deviations recorded here (brief Q7/Q8, section 9):**

- Build absence is split: the render half is `G-053-build-absence` here; the pins-text half is
  TASK-046's `check-pins.mjs` `real-build`.
- B32 parts not taken: router contract and middleware (TASK-034); HostRegexp and
  X-Forwarded-Host (TASK-041, landed); the N20 flag guard and `ci.yml` (D17); B34's second
  `--all` (TASK-125).
- `Makefile:276` still says "TASK-053 wires `verify`", but `lint-pooled-stack` has been in
  `verify` since 14c02f63. The Makefile is not this unit's file; the note goes to its owner.
- Seeded-regression chronology: the rescued WIP commit 0afbf0a9 (orchestrator, R28) already
  held a G2 body when this lane resumed. It had no import, so it threw a ReferenceError on
  every app render. The section 1 seed was therefore run at the guard commit 0b72442e (G2 not
  applied) in the scratch tree, and G2 was completed afterwards in 81d24a16. The binding order
  guard commit, then (1)-(3), then G2 holds for the evidence below.
- `kernel-api` did not exist on `main` at the start (TASK-077 G7 had not landed), so the seed
  used the name `kernel-api` itself, not `seed-probe`.
- Allowances (brief Q4): `render/allowances.json` carries dated rows for `tenant-create` (app)
  and `legal`, `vector`, `fallback` (state), all retiring with TASK-048b. X-053 goes to
  TASK-048b through the orchestrator.

## G-053-harness

Date: 2026-09-29 (a: 01:30:41 CEST)

### Mutation

Break (a): in `scripts/verify/render/harness.mjs` `renderProblems()`, deleted the line
`if (Object.keys(svcs).length === 0) out.push(`${id}: renders zero services -- every guard over it would pass vacuously`)`.
Break (e), 01:29:43: `SWAP_PINS` gained `state: RELEASE_PINS_FIXTURE` (swap pins for state).

### Observed failing output

```text
$ node --test --test-reporter=tap scripts/verify/render/harness.test.mjs      # break (a)
not ok 3 - a project rendering {"services":{}} is unparseable, naming it
error: 'the harness did not refuse'
# tests 11
# pass 10
# fail 1

$ node --test --test-reporter=tap scripts/verify/render/harness.test.mjs      # break (e)
not ok 1 - renders every TASK-040 project once and returns {project -> render} plus counts
not ok 7 - the pins swap is app-only and carries COMPOSE_PATH_SEPARATOR ":"
not ok 8 - the swapped app render has no gremion-ui build and carries the fixture digest (post-condition)
not ok 9 - the state render contains no APP_SERVICES entry; swapping pins for state is caught as phantoms
not ok 10 - a parent COMPOSE_PROFILES=dev (or COMPOSE_FILE) changes nothing the harness passes
error: |-
  state: the pins swap did not take -- gremion-ui image is "ghcr.io/hello-n00del/gremion-gremion-ui:x", want the fixture digest
# tests 11
# pass 6
# fail 5
```

### Observed passing output (after)

```text
$ node --test --test-reporter=tap scripts/verify/render/harness.test.mjs      # (a) restored 01:30:42, (e) restored 01:29:44
# tests 11
# pass 11
# fail 0
```

### Verifier

`node --test --test-reporter=tap scripts/verify/render/harness.test.mjs` (also collected by
verify's `unit` suite). Real renders: `node scripts/verify/verify.mjs --only render-guards`.

### Restore

The original bytes were written back (checked byte-identical), then the same command ran green.

## G-053-drift

Date: 2026-09-29 (j: 01:30:48 CEST)

### Mutation

Break (j): drift compares only profiles. In `scripts/verify/render/drift.mjs`
`driftViolations()`, a `return out` was inserted directly before
`const fl = f.COMPOSE_FILE.split(':')`, so the `COMPOSE_FILE` comparison never ran.

### Observed failing output

```text
$ node --test --test-reporter=tap scripts/verify/render/drift.test.mjs
not ok 3 - a dropped docker-compose.app.yml fails
error: |-
  The input did not match the regular expression /COMPOSE_FILE has 1 entr\(ies\) in fixture/. Input:
not ok 4 - a replaced non-pins entry fails verbatim
error: |-
  The input did not match the regular expression /entry 1 is docker-compose\.app\.dev\.yml in fixture, docker-compose\.app\.yml in template/. Input:
not ok 8 - a missing pins slot fails (same length, pins slot replaced by another file)
error: |-
  The input did not match the regular expression /the pins slot moved or vanished/. Input:
# tests 10
# pass 7
# fail 3
```

### Observed passing output (after)

```text
$ node --test --test-reporter=tap scripts/verify/render/drift.test.mjs      # restored 01:30:48
# tests 10
# pass 10
# fail 0
```

### Verifier

`node --test --test-reporter=tap scripts/verify/render/drift.test.mjs`; in `verify`, one
drift check per project in `render-guards`.

### Restore

The original bytes were written back (checked byte-identical), then the same command ran green.

## G-053-colour-suffix

Date: 2026-09-29 (seed: 00:53-01:22 CEST; breaks b-d, k: 01:29-01:30 CEST)

### Mutation

Section 1 seeded regression, a seed TASK-040 cannot see. Step (0), on the guard commit
0b72442e in the scratch tree (commit 1c69fba7, never on the branch): `docker-compose.app.yml`
gained a `kernel-api` that conforms fully to TASK-040.
It has `image: ghcr.io/hello-n00del/gremion-kernel-api:${IMAGE_TAG:?IMAGE_TAG required}`, the
`kernel-api-${COLOUR}` alias on `edge` and `state`, `COLOUR`, `traefik.enable: "false"`,
`deploy: *limits-m` and no profile, plus a `PLACEMENT.app` row in the scratch
`check-pooled-stack.mjs`. The one defect was `KERNEL_API_URL: http://kernel-api:3000` on
`gremion-ui`.
Unit breaks in `render/colour-suffix.mjs`:

- (b) hard-code TASK-040's list in `appTierServiceNames`;
- (c) drop the template check from `colourSuffixGuard`;
- (d) scan comments, with `envLines` accepting `# KEY=VALUE`;
- (k2) sort alphabetically instead of longest first.

In `render/suite.mjs`, (k1) let the state, ops and mail renders contribute names.

### Observed failing output

```text
# (1) 00:53:12, seeded 0b72442e: TASK-040's own guard does not see it
$ node scripts/check-pooled-stack.mjs
[pooled-stack] OK: 31 service(s) across 5 project(s) {"state":15,"app-blue":5,"app-green":5,"ops":5,"mail":1}

# (2) 01:03:05, seeded commit 1c69fba7 (guard commit 0b72442e + seed, G2 not applied)
$ node scripts/verify/verify.mjs --only render-guards
[render-guards] derived app-tier names (14): newsletter-service, calendar-service, messages-service, content-service, finance-service, gremion-public, board-service, files-service, tenant-create, vault-service, votes-service, gremion-ui, kernel-api, migrate
[render-guards] FAIL colour-suffix: app-blue/gremion-ui: environment.KERNEL_API_URL names kernel-api without the -blue suffix: http://kernel-api:3000
[render-guards] FAIL colour-suffix: app-green/gremion-ui: environment.KERNEL_API_URL names kernel-api without the -green suffix: http://kernel-api:3000
[verify] FAIL render-guards (3.1s) collected=16 passed=14 failed=2 skipped=0 -- 2 of 16 failed
[verify] FAILED
exit=1
$ node scripts/check-pooled-stack.mjs        # same tree, still blind
[pooled-stack] OK: 31 service(s) across 5 project(s) {"state":15,"app-blue":5,"app-green":5,"ops":5,"mail":1}
exit=0

# bonus 01:22:27, after G2 (81d24a16 + the seed, uncommitted): TASK-040's guard now fails too
$ node scripts/check-pooled-stack.mjs
FAIL app-blue/gremion-ui: environment.KERNEL_API_URL names kernel-api without the -blue suffix: http://kernel-api:3000
FAIL app-green/gremion-ui: environment.KERNEL_API_URL names kernel-api without the -green suffix: http://kernel-api:3000
[pooled-stack] 2 violation(s) over 31 rendered service(s) {"state":15,"app-blue":5,"app-green":5,"ops":5,"mail":1}
exit=1

# unit breaks: node --test --test-reporter=tap scripts/verify/render/colour-suffix.test.mjs
(b)  not ok 2 - G2: check-pooled-stack colourSuffixViolations delegates here -- a strict superset of its old list-bound scan
     not ok 8 - KERNEL_API_URL=http://kernel-api:3000 fails when kernel-api is known only by its image
     not ok 12 - fewer than 3 derived names is vacuous, on every check
     not ok 16 - longest name first: kernel-api-migrate-blue passes when kernel-api and kernel-api-migrate are both derived
     # tests 21  # pass 17  # fail 4
(c)  not ok 5 - an unsuffixed INTERNAL_BASE_URL template line fails, naming line and key
     not ok 6 - a template line with a literal colour fails (it must be ${COLOUR})
     # tests 21  # pass 19  # fail 2
(d)  not ok 14 - a \# comment naming a bare gremion-ui passes (comments are skipped)
     # tests 21  # pass 20  # fail 1
(k2) not ok 16 - longest name first: kernel-api-migrate-blue passes when kernel-api and kernel-api-migrate are both derived
     not ok 19 - claimingName and longestFirst
     # tests 21  # pass 19  # fail 2
# node --test --test-reporter=tap scripts/verify/render/suite.test.mjs
(k1) not ok 1 - the suite is green over a conforming stack, one check per (guard, project)
     error: derived app-tier names (16): ..., gremion-ui, fallback, migrate, vector, legal
     not ok 2 - state renders never contribute names: legal referenced from the app tier passes
     # tests 11  # pass 9  # fail 2
```

### Observed passing output (after)

```text
# (3) 01:04:48, restored: the guard commit 0b72442e without the seed
$ node scripts/verify/verify.mjs --only render-guards
[render-guards] derived app-tier names (13): newsletter-service, calendar-service, messages-service, content-service, finance-service, gremion-public, board-service, files-service, tenant-create, vault-service, votes-service, gremion-ui, migrate
[verify] PASS render-guards (1.1s) collected=16 passed=16 failed=0 skipped=0
exit=0

# unit breaks restored (01:29-01:30): colour-suffix.test.mjs # tests 21 # pass 21 # fail 0;
# suite.test.mjs # tests 11 # pass 11 # fail 0
```

### Verifier

`node scripts/verify/verify.mjs --only render-guards` for the seed, and
`node --test --test-reporter=tap scripts/verify/render/colour-suffix.test.mjs scripts/verify/render/suite.test.mjs`
for the unit breaks.

### Restore

For the seed: `git checkout --detach 0b72442e` in the scratch tree, leaving the seed commit
1c69fba7 orphaned there and never on the branch. For the bonus: `git reset --hard 81d24a16`
in the scratch tree. For the unit breaks: the original bytes were written back and checked
byte-identical.

## G-053-build-absence

Date: 2026-09-29 (f: 01:29:46 CEST)

### Mutation

Break (f1): `build: null` read as present. In `render/build-absence.mjs`, `hasBuild` became
`svc != null && 'build' in svc`. Break (f2), 01:29:50: the vacuity count was dropped, with
`if (false && scope === 'app' && judged < MIN_JUDGED_APP)`.

### Observed failing output

```text
$ node --test --test-reporter=tap scripts/verify/render/build-absence.test.mjs     # (f1)
not ok 3 - build: null is no build (the release pins reset it with !reset null)
error: |-
  Expected values to be strictly deep-equal:
# tests 12
# pass 11
# fail 1

$ node --test --test-reporter=tap scripts/verify/render/build-absence.test.mjs     # (f2)
not ok 5 - an all-allowance app render is vacuous
error: |-
  The input did not match the regular expression /judged 0 non-allowance first-party service\(s\), fewer than 2/. Input:
not ok 6 - an all-third-party app render is vacuous (and its allowance row is absent)
error: |-
  The input did not match the regular expression /fewer than 2/. Input:
# tests 12
# pass 10
# fail 2
```

### Observed passing output (after)

```text
$ node --test --test-reporter=tap scripts/verify/render/build-absence.test.mjs     # restored 01:29:48 / 01:29:51
# tests 12
# pass 12
# fail 0
# real renders, 01:04:48 (0b72442e):
[render-guards] build-absence state: judged 0, allowance 3 (first-party 3)
[render-guards] build-absence app-blue: judged 3, allowance 1 (first-party 4)
[render-guards] build-absence app-green: judged 3, allowance 1 (first-party 4)
```

### Verifier

`node --test --test-reporter=tap scripts/verify/render/build-absence.test.mjs`; in `verify`,
the `build-absence` checks of `render-guards`.

### Restore

The original bytes were written back (checked byte-identical), then the same command ran green.

## G-053-boundary-lint-vacuity

Date: 2026-09-29 (two commits re-observed 01:33 CEST; break g 01:34 CEST)

### Mutation

Watched across the two G3 commits (brief 5.5). 688ed79a adds `--root` and `--min-files` with
no refusal. 37a5f7d2 adds the refusal before `runBoundaryLint`. Both were re-run in the scratch
tree against an empty directory under `scripts/verify/out/`. Then break (g) at 81d24a16 deleted
the refusal (`if (false && mode === '--all' && inputs.length < allFlags!.minFiles)`) and ran the
collected vitest cases.

### Observed failing output

```text
# 01:33:14, head=688ed79a (no refusal yet): an empty scan reports OK
$ pnpm -C gremion-ui exec tsx scripts/boundary-lint.ts --all --root ../scripts/verify/out/t053-empty-root
[boundary-lint] OK (0 file(s) checked, mode --all)
exit=0

# 01:34:16, 81d24a16 with the refusal deleted (g)
$ pnpm exec vitest run --project unit src/lib/server/boundary/boundary-lint-vacuity.test.ts   (cwd gremion-ui)
 ❯ |unit| src/lib/server/boundary/boundary-lint-vacuity.test.ts (3 tests | 2 failed) 4943ms
     × --root <empty dir> exits 1 with "scanned 0 file(s)" and never prints OK 475ms
     × --min-files 100000 over the real tree exits 1 (below the floor) 2575ms
AssertionError: [boundary-lint] OK (0 file(s) checked, mode --all)
: expected +0 to be 1 // Object.is equality
AssertionError: [boundary-lint] OK (512 file(s) checked, mode --all)
: expected +0 to be 1 // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
exit=1
```

### Observed passing output (after)

```text
# 01:33:20, head=37a5f7d2 (refusal added), same command
[boundary-lint] scanned 0 file(s) under <scratch>\scripts\verify\out\t053-empty-root -- below the floor of 1; refusing to report OK on a scan that checked (almost) nothing
exit=1

# 01:37:02, 81d24a16 (refusal restored)
$ pnpm exec vitest run --project unit --reporter=verbose src/lib/server/boundary/boundary-lint-vacuity.test.ts
 ✓ ... > scans the real tree: more than 0 (and more than the 300 floor) files, exit 0
 ✓ ... > --root <empty dir> exits 1 with "scanned 0 file(s)" and never prints OK
 ✓ ... > --min-files 100000 over the real tree exits 1 (below the floor)
 Test Files  1 passed (1)
      Tests  3 passed (3)
exit=0
```

### Verifier

`pnpm -C gremion-ui exec vitest run --project unit src/lib/server/boundary` (3 collected in
`boundary-lint-vacuity.test.ts`), then `node scripts/verify/verify.mjs --only boundary-lint`.
The suite judges the printed count against the 300 floor. `suite.test.mjs` shows that an
`OK (0 file(s) checked)` exit 0 fails there too.

### Restore

For the two commits: `git checkout -f --detach` in the scratch tree only. For break (g): the
original bytes of `gremion-ui/scripts/boundary-lint.ts` were written back, and
`git status --short` showed the file clean.

## G-053-wiring

Date: 2026-09-29 (h: 01:30:42-01:30:45 CEST)

### Mutation

One at a time: (h1) dropped the `render-guards` line from `scripts/verify/required-suites.txt`.
(h2) dropped the `boundary-lint` line. (h3) dropped the `'render-guards'` entry from
`SUITE_REGISTRY` in `scripts/verify/verify.mjs`. (h4) dropped the `'boundary-lint'` entry.

### Observed failing output

```text
(h1) $ node --test --test-reporter=tap scripts/verify/render/wiring.test.mjs
not ok 1 - required-suites.txt names render-guards
error: 'required-suites.txt dropped "render-guards"'
# tests 3  # pass 2  # fail 1
(h2) $ node --test --test-reporter=tap scripts/verify/boundary-lint/wiring.test.mjs
not ok 1 - required-suites.txt names boundary-lint
error: 'required-suites.txt dropped "boundary-lint"'
# tests 3  # pass 2  # fail 1
(h3) $ node --test --test-reporter=tap scripts/verify/render/wiring.test.mjs
not ok 2 - SUITE_REGISTRY["render-guards"] is a synchronous runner
  SUITE_REGISTRY has no runner for "render-guards"
not ok 3 - the render-guards runner is runRenderGuardsSuite, not a stand-in
# tests 3  # pass 1  # fail 2
(h4) $ node --test --test-reporter=tap scripts/verify/boundary-lint/wiring.test.mjs
not ok 2 - SUITE_REGISTRY["boundary-lint"] is a synchronous runner
  SUITE_REGISTRY has no runner for "boundary-lint"
not ok 3 - the boundary-lint runner is runBoundaryLintSuite, not a stand-in
# tests 3  # pass 1  # fail 2
```

### Observed passing output (after)

```text
(h1-h4 restored) render/wiring.test.mjs and boundary-lint/wiring.test.mjs:
# tests 3
# pass 3
# fail 0
```

### Verifier

`node --test --test-reporter=tap scripts/verify/render/wiring.test.mjs scripts/verify/boundary-lint/wiring.test.mjs`

### Restore

The original bytes were written back (checked byte-identical) after each break.

## G-053-ledger

Date: 2026-09-29 (i1: 01:40:01, i2: 01:40:02 CEST, both on this file)

### Mutation

(i1) deleted the `## G-053-drift` heading line of this file. (i2) deleted the `Date:` prefix
of the `G-053-harness` section, leaving `(a: 01:30:41 CEST)`.

### Observed failing output

```text
(i1) $ node --test --test-reporter=tap scripts/verify/render/ledger.test.mjs
not ok 10 - the real red-ledger.md is complete for every exported guard id
error: |-
  Expected values to be strictly deep-equal:
# tests 10
# pass 9
# fail 1
(i2) $ node --test --test-reporter=tap scripts/verify/render/ledger.test.mjs
not ok 10 - the real red-ledger.md is complete for every exported guard id
error: |-
  Expected values to be strictly deep-equal:
# tests 10
# pass 9
# fail 1
```

### Observed passing output (after)

```text
$ node --test --test-reporter=tap scripts/verify/render/ledger.test.mjs
# tests 10
# pass 10
# fail 0
```

### Verifier

`node --test --test-reporter=tap scripts/verify/render/ledger.test.mjs`. Its nine synthetic
cases watch each incomplete shape fail: a missing section, `Date:`, failing block,
passing-after block, Mutation, Verifier or Restore; fewer than 5 ids; an unexported or
duplicate id. The first run of the real-file case, before this file existed, failed with
`ENOENT ... red-ledger.md` (01:25 CEST).

### Restore

The original bytes were written back (checked byte-identical) after each break.

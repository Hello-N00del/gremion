# JS/TS lint — Oxlint config rationale

`.oxlintrc.json` (repo root) is the standalone Oxlint config (R25 pivot off
Vite+: vite-plus as a workspace devDependency made pnpm resolve peers against
its bundled vite core + Vitest 5, which broke gremion-ui svelte-check;
standalone `oxlint` has no vite/vitest dependency). JSON has no comment
syntax, so the reasons for the non-obvious settings live here instead of
inline; `make lint-js` (`scripts/check-lint-js.mjs`) points back at this file.

## Plugins and categories

`unicorn`, `typescript`, `oxc` are Oxlint's own on-by-default plugins;
`import`, `promise`, `node`, `vitest` are opt-in (normally behind CLI flags
like `--import-plugin`) and named explicitly so both `oxlint` and
`oxlint --type-aware` pick them up the same way. `correctness` is the only
category kept at `error`; `suspicious`/`perf` stay `warn`; `pedantic`,
`style`, `restriction`, `nursery` are `off` — this is a ratchet gate
(`scripts/lint-js-baseline.json`), not a style enforcer.

`options.typeAware: true` mirrors the CLI's `--type-aware` flag (TypeScript
7 / TS-Go rules via `oxlint-tsgolint`, e.g. `typescript/no-floating-promises`,
`typescript/await-thenable`); both the config key and the CLI flag are kept
so the setting is visible in one place and enforced even if a caller forgets
the flag.

## Rule-specific reasons

- **`typescript/no-floating-promises` `allowForKnownSafeCalls`** — `node:test`'s
  `test()`/`describe()`/hooks return promises that the test runner itself
  awaits, so a top-level `test(...)` is not a floating promise. This is the
  allow-list typescript-eslint documents for exactly this case. Every other
  unawaited promise stays an error. Without it the rule reported 258 false
  positives across `scripts/**/*.test.mjs` and `ops/**`.
- **`vitest/require-mock-type-parameters: off`** — a `vi.fn()`/`vi.spyOn()`
  without type parameters is loosely typed, not wrong: a typing preference,
  not a correctness defect (479 sites). Off rather than churn every mock;
  tighten per package if wanted later.
- **`vitest/valid-expect` `maxArgs: 2`** — Vitest's `expect` takes an optional
  second argument, a custom failure message: `expect(actual, message)`. The
  rule's Jest-derived default (`maxArgs: 1`) flagged every such call (58
  kernel / 246 StuRaOS sites), none of them a vacuous test.
- **`typescript/unbound-method: off` in the test-file override** (`**/*.test.ts`,
  `**/*.test.mjs`, `**/*.spec.ts`, `**/test/**/*.ts`) — `expect(mock.method).
  toHaveBeenCalled...()` passes a `vi.fn()` spy, which has no `this` to lose:
  every one of the 102 unbound-method hits in test files was this shape.
  typescript-eslint's own docs point test files at the test framework's
  variant of the rule, which Oxlint does not ship, so the rule is off in
  tests and stays an error in source.

- **Frozen module copies: per-rule, per-file `off` overrides** (TASK-200,
  2026-09-27) - the overrides after the test-file override each name ONE
  rule and the exact `modules/**` files where that rule reported an
  error-level diagnostic when TASK-200 moved the StuRa module source
  in-tree (96 errors in 50 files, 14 rules; the largest:
  `typescript/no-base-to-string` 23, `typescript/no-redundant-type-constituents`
  20, `unicorn/no-useless-fallback-in-spread` 15,
  `vitest/require-to-throw-message` 13). Those files are frozen copies:
  byte-equal to the `extraction-source-f2` tag or listed in
  `modules/EXTRACTION-DELTA.json`, proven by
  `scripts/check-module-source-parity.mjs`; fixing them in the move would
  turn a verbatim copy into an unreviewed rewrite. The re-pin from
  `extraction-source-f1` to `-f2` (StuRa's own lint clean-up, R25-4 S-C,
  landed between them) removed 17 file entries and three whole overrides
  (`no-misused-spread`, `restrict-template-expressions`, `no-new-array`):
  those files no longer report the rule. They are StuRa-era debt,
  not new errors, and raising `scripts/lint-js-baseline.json` is not allowed.
  Deliberately NOT a `modules/**` ignore pattern: every other rule stays on
  in those files, and every rule stays on in every other file under
  `modules/`. New module code (TASK-152..157, TASK-190, TASK-205) is linted
  in full, and a new error in a frozen file still fails (both watched RED).
  A task that edits one of these files fixes the finding and deletes the
  path from its override; an override left with no files is deleted.
  TASK-205 (2026-10-02) added the in-process halves it moved (`modules/{board,
  calendar,elections,files,messaging,votes}/app`): 66 files, 7 rules
  (`typescript/no-redundant-type-constituents` 56 of the findings - the
  type-aware pass cannot resolve `./$types` or `$lib` from `modules/*/app`, so
  the route handlers' types read as `any` - plus
  `vitest/no-conditional-expect`, `unicorn/prefer-string-starts-ends-with`,
  `eslint/no-unused-vars`, `vitest/require-to-throw-message`,
  `unicorn/no-useless-fallback-in-spread`, `typescript/no-base-to-string`).
  The same files, once overlaid onto `gremion-ui/src`, are type-checked in full
  by `svelte-check` (0 errors). New files of that task are linted in full. File
  paths containing `[` or `]` (SvelteKit route params) are written with `?`
  in their place, because the override globs treat brackets as a class.

## Svelte 5 runes

Empirically Oxlint 1.85.0 already resolves `$state`, `$derived`, `$effect`,
`$props`, `$bindable`, `$inspect` and `$host` natively (a whole-tree run
across `gremion-ui/src` and `gremion-public/src` with `-f json` found zero
`no-undef` diagnostics naming any of them). They are declared in `globals`
anyway as a harmless, explicit safety net.

## Ignore patterns

`node_modules/**`, `build/**`, `dist/**`, `.svelte-kit/**`, `coverage/**`,
generated clients (`packages/generated-clients{,-dart}/**`), `docs/**`,
`**/__fixtures__/**`, `**/*.min.js` — generated or vendored output that is
never hand-edited, so lint findings in it are not actionable.

## Formatting

No standalone formatter config was ported: Oxlint has no `fmt` block (that
was a Vite+-specific feature). Formatting is out of scope for this unit;
`make lint-js` only runs `oxlint`.

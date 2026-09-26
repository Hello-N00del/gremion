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

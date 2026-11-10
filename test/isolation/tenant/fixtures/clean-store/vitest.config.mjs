// Only the fixture's own case file. The directory has no node_modules, so
// this config imports nothing and the case uses vitest's globals; the suite
// test runs it from a package that has vitest (--root points here).
export default {
  test: { include: ['cases/*.case.mjs'], environment: 'node', globals: true },
}

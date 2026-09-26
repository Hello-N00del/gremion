// TASK-045 fixture config. Deliberately NOT `vitest/config`'s defineConfig
// (that import only resolves from a package that actually depends on
// vitest -- gremion-ui/gremion-public/packages/ports -- and this file is run
// via THEIR installed vitest binary against THIS directory, so a bare object
// export is what actually resolves).
export default {
  test: { include: ['**/*.fixture.test.ts'], globals: true },
}

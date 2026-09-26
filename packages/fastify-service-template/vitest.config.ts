import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Scaffolded services under .tmp/ import '@gremion/fastify-service-template'
// by name, exactly as a real service does. .tmp/ is not a workspace member, so
// nothing links the package there: the alias points the name at this source
// tree, the same thing routes:check's resolve hook does for plain Node.
export default defineConfig({
  resolve: {
    alias: {
      '@gremion/fastify-service-template': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
  },
})

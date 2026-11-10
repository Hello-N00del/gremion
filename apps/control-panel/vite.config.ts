import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['src/**/*.test.ts', 'codemap/**/*.test.mjs'],
    environment: 'node',
    // passWithNoTests is deliberately NOT set: zero collected tests fail.
  },
})

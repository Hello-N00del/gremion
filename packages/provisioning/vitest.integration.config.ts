import { BaseSequencer, type TestSpecification } from 'vitest/node'
import { defineConfig } from 'vitest/config'

// platform.int.test.ts proves gremion_platform is ABSENT before its own
// bootstrap (TDD 4 of TASK-043); every other spec bootstraps it again
// (idempotent), so the platform spec always runs first (TASK-043d).
class PlatformFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (f: TestSpecification) => (f.moduleId.endsWith('platform.int.test.ts') ? 0 : 1)
    return [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId))
  }
}

// The provisioning package's integration specs: one scratch PostgreSQL 18
// started by test/integration/run.mjs (`pnpm test:integration`). The files
// share that server, so they run one at a time. Zero collected tests fail.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    sequence: { sequencer: PlatformFirst },
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
})

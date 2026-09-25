import { describe, expect, it } from 'vitest'
import * as api from './index.js'

describe('@gremion/tenant-store public API', () => {
  it('exports the post-condition surface', () => {
    for (const name of [
      'openTenantDb',
      'openMigrationDb',
      'createTenantStore',
      'tenantModuleDbName',
      'envResolveTarget',
      'isUuidV7',
      'runMigrations',
      'checkSchemaCurrent',
      'schemaGate',
      'stripOuterTransaction',
      'ADVISORY_LOCKS',
      'ADVISORY_LOCK_CLASS_ID',
      'MigrationManifestError',
      'MigrationRunnerError',
      'MigrationSqlError',
    ]) {
      expect(api, name).toHaveProperty(name)
    }
  })

  it('exports no database create/drop helper (TASK-021 owns that)', () => {
    expect(Object.keys(api).filter((k) => /create(Database|Db)$|drop/i.test(k))).toEqual([])
  })
})

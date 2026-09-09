// D-GUARD-TESTS fixture: a per-tenant env read planted in a *.test.ts file.
// Tests legitimately pin env behavior and do NOT ship, so the guard SKIPS them.
// The scanner must not report this read (it would otherwise be a false positive
// once the build-failing --enforce flip lands at P2.1c T14).
import { env } from '$env/dynamic/private'
export function plantedTestRead() {
  return env.DATABASE_URL
}

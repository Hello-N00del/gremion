// @gremion/kernel-api — the app module routes:check boots (package.json
// gremion.fastifyService.app). Routes come from openapi/kernel-core.json at
// boot; do not register routes here: routes:check fails on any route the spec
// does not declare. This module imports no database driver, JWKS client or
// secret (C18); main.ts wires those (src/app/wire.ts).
export { buildApp, SPEC_URL, TENANT_EXEMPT_OPERATIONS } from './app/build.ts'
export { unwiredDeps } from './app/deps.ts'
export type { CustomerGate, KernelApiDeps, ModuleDeclarations, RegistryStore, TenancyStore, TenantRow, TokenVerifier } from './app/deps.ts'

// @gremion/edge-routers — the single per-tenant router emitter (brief TASK-034).
// The control plane (TASK-043's provisioner) CALLS this library; it never runs as
// a CLI and it never runs inside the app process, which holds no writable mount
// of etc/edge.
export * from './names.js'
export * from './platform-middlewares.js'
export * from './classify.js'
export * from './render.js'
export * from './emit.js'
export * from './sync.js'
export * from './dns-preflight.js'

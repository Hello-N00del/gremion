// @gremion/edge-routers — the single per-tenant router emitter (brief TASK-034).
// The control plane (TASK-043's provisioner) CALLS this library; it never runs as
// a CLI and it never runs inside the app process, which holds no writable mount
// of etc/edge.
export * from './names.ts'
export * from './platform-middlewares.ts'
export * from './render.ts'

// gremion-ui/src/lib/server/ports/tracer.ts
// P1 (D-P1-7): tracer moved to @gremion/ports so the monolith and the newsletter
// leaf share ONE TracerPort. This file is now a re-export shim so every existing
// `$lib/server/ports/tracer` import path stays byte-stable.
export * from '@gremion/ports/tracer'

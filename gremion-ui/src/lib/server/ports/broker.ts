// gremion-ui/src/lib/server/ports/broker.ts
// P1 (D-P1-7): broker moved to @gremion/ports so the monolith and the newsletter
// leaf share ONE reference implementation. This file is now a re-export shim so
// every existing `$lib/server/ports/broker` import path stays byte-stable.
export * from '@gremion/ports/broker'

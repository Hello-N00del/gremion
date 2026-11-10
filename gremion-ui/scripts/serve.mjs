// Runtime entry of the gremion-ui image (Dockerfile CMD): starts adapter-node's server unchanged
// and lifts one limit it does not expose.
//
// adapter-node leaves Node's http server at its default requestTimeout of 300 s, and the timer runs
// for as long as the client takes to SEND the body. A file upload is one PUT of up to 100 MiB, and the
// edge (docker/traefik/traefik.yml, websecure readTimeout) allows 600 s for it, so without this the
// app cut every body slower than 300 s while the edge still waited. REQUEST_TIMEOUT_MS must stay at
// least the edge readTimeout; scripts/check-app-compose-env.test.mjs pins that.
//
// Node reads the property on every connection check (30 s granularity), so setting it once the
// server object exists is enough, even though adapter-node has already called listen().
import { server } from '../build/index.js'

const REQUEST_TIMEOUT_MS = 600 * 1000

server.server.requestTimeout = REQUEST_TIMEOUT_MS

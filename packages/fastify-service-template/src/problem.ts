// RFC 9457 problem details (TASK-083 Q6 default: application/problem+json).
//
// `type` URIs: TASK-083's scheme had not merged when this template was cut,
// so the brief's fallback applies (§5 Q5): `urn:gremion:problem:<slug>`.
// TASK-083 should align its scheme with these, or this table moves to it.
import type { FastifyReply } from 'fastify'

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export const PROBLEM_TYPES = {
  payloadTooLarge: 'urn:gremion:problem:payload-too-large',
  notFound: 'urn:gremion:problem:not-found',
  validation: 'urn:gremion:problem:validation-failed',
  notImplemented: 'urn:gremion:problem:not-implemented',
  badRequest: 'urn:gremion:problem:bad-request',
  internal: 'urn:gremion:problem:internal',
} as const

export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  [extension: string]: unknown
}

/**
 * Send a problem body. The payload goes out as a pre-serialized string on
 * purpose: a route's response schema describes that route's documented
 * bodies, and would otherwise strip the extension members (e.g.
 * `limitBytes`) off a problem the template itself produces.
 */
export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem))
}

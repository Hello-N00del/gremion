// Shared test helpers: the fixture spec and a handler table that covers it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { OpenApiDocument, OperationHandler } from '../src/index.ts'

// Loosely typed on purpose: tests mutate the fixture to build broken variants.
export type FixtureSpec = OpenApiDocument & { paths: Record<string, any>; [key: string]: any }

export const FIXTURE_SPEC_PATH = fileURLToPath(new URL('./fixtures/widgets.openapi.json', import.meta.url))
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const KERNEL_SPEC_PATH = fileURLToPath(new URL('../../../contracts/kernel/openapi.governance.json', import.meta.url))

/** A fresh, mutable copy of the fixture spec. */
export function fixtureSpec(): FixtureSpec {
  return JSON.parse(readFileSync(FIXTURE_SPEC_PATH, 'utf8'))
}

/** The fixture's operation set as `METHOD /path` keys, straight from the JSON. */
export const FIXTURE_ROUTE_KEYS = [
  'DELETE /widgets/{widgetId}',
  'GET /widgets',
  'GET /widgets/{widgetId}',
  'POST /uploads',
  'POST /widgets',
]

const ok: OperationHandler = async (_request, reply) => {
  reply.code(204)
  return null
}

/** One trivial handler per fixture operationId. */
export function fixtureHandlers(): Record<string, OperationHandler> {
  return {
    listWidgets: async () => [],
    createWidget: async (request, reply) => {
      reply.code(201)
      const body = request.body as { name: string; note?: string | null }
      return { id: '00000000-0000-4000-8000-000000000001', name: body.name, note: body.note ?? null }
    },
    getWidget: async (request) => {
      const { widgetId } = request.params as { widgetId: string }
      return { id: widgetId, name: 'w', note: null }
    },
    deleteWidget: ok,
    uploadFile: ok,
  }
}

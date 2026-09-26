// @gremion/fastify-service-template — public surface.
export {
  createService,
  getRouteTable,
  getUploadCeilingBytes,
  notImplemented,
  toSpecPath,
  type CreateServiceOptions,
  type ServiceConfig,
} from './service.ts'
export { PLATFORM_ROUTES, toFastifyPath, type HandlerTable, type OperationHandler, type PlatformRoute } from './loader.ts'
export { DEFAULT_UPLOAD_CEILING_BYTES, InvalidUploadCeilingError, resolveUploadCeiling } from './ceiling.ts'
export { ServiceBootError, SpecLoadError } from './errors.ts'
export { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES, sendProblem, type Problem } from './problem.ts'
export { loadSpec, inlineRefs, listOperations, routeKey, specRouteKeys, type OpenApiDocument, type SpecSource } from './spec.ts'

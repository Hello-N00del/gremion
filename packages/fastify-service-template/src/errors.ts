// Boot-time errors. A template service that cannot prove its route table,
// handler table or limits are what the spec and config say refuses to start;
// it never falls back to a guess. Every problem found is collected, so one
// boot attempt names all of them.

export class ServiceBootError extends Error {
  readonly code: string = 'GREMION_SERVICE_BOOT'
  readonly problems: readonly string[]

  constructor(problems: readonly string[], summary = 'service refused to boot') {
    super(`${summary}:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ServiceBootError'
    this.problems = problems
  }
}

/** The spec itself cannot be loaded as an OpenAPI 3.1 route source. */
export class SpecLoadError extends ServiceBootError {
  override readonly code: string = 'GREMION_SPEC_LOAD'

  constructor(problems: readonly string[]) {
    super(problems, 'OpenAPI spec cannot be loaded')
    this.name = 'SpecLoadError'
  }
}

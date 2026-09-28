// services/finance/src/csv/errors.ts
// #383 Lane E3 — typed CSV errors. Ported from the native oracle
// gremion-ui/.../services/money/errors.ts (the two CSV members only). STRUCTURAL
// failures (missing required column mapping, malformed CSV) throw; per-row failures
// are collected into the errors[] result. Message strings are byte-identical to the
// native so error shapes match at the API surface.

export class CsvParseError extends Error {
  constructor(msg: string) {
    super(`CSV parse error: ${msg}`)
    this.name = 'CsvParseError'
  }
}

export class CsvMappingError extends Error {
  constructor(msg: string) {
    super(`CSV mapping error: ${msg}`)
    this.name = 'CsvMappingError'
  }
}

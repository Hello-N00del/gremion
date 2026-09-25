// TASK-032 (TRD-410 [D R20-D5]): a `$state`-backed stand-in for kit 3's
// `$app/state` `page`, for component tests that must prove a read of
// `page.data` stays REACTIVE. Kit's real `page` is a rune-backed object, so a
// plain-object mock (as most tests use) can never show a missed update.
export const reactivePage = $state({ data: { brand: null as Record<string, unknown> | null } })

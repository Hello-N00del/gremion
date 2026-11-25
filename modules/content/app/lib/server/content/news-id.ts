// news_posts.id is a SERIAL (int4). `Number()` is not a validator: "1.5" and
// "99999999999" are numbers, reach the integer column and come back from the
// driver as an error that SvelteKit answers with a 500. Accept only plain decimal
// digits that fit the column; anything else is a client error, before any query.

const POSITIVE_INT4 = /^[1-9][0-9]{0,9}$/
const INT4_MAX = 2_147_483_647

/** The id as a number, or null when the route segment is not a positive int4. */
export function parseNewsId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !POSITIVE_INT4.test(raw)) return null
  const n = Number(raw)
  return n <= INT4_MAX ? n : null
}

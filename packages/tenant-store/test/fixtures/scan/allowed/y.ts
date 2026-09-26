// An allow-listed site: one call, one driver import.
import postgres from 'postgres'
import type { Sql } from 'postgres'

// postgres(url) in a comment is not a site
export const control: Sql = postgres(process.env.CONTROL_URL!)

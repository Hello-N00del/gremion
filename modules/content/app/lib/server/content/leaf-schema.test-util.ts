// Test helper: the migration files the content integration suites apply to their scratch
// database. The `content` schema is created by the content LEAF chain
// (modules/content/migrations, which squashes the old kernel 044-046), and `news_posts` by the
// content app block (modules/content/app/migrations); no file under gremion-ui/migrations
// carries either. The suites run from two working directories, so the module root is found
// by walking up from whichever one this is: the module lane starts inside modules/content,
// the kernel app lane (gremion-ui/, where the overlay copies these suites onto src/) finds it
// at modules/content under the repository root.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function moduleRoot(): string {
	const start = process.cwd()
	for (let dir = start; ; dir = dirname(dir)) {
		for (const candidate of [join(dir, 'modules', 'content'), dir]) {
			if (existsSync(join(candidate, 'migrations', '001_init.sql'))) return candidate
		}
		if (dirname(dir) === dir) break
	}
	throw new Error(`content module root not found from ${start}: no migrations/001_init.sql beside or above it`)
}

/** A file of the content leaf chain (modules/content/migrations), as text. */
export function contentLeafMigration(file: string): string {
	return readFileSync(join(moduleRoot(), 'migrations', file), 'utf-8')
}

/** A file of the content app block (modules/content/app/migrations), as text. */
export function contentAppMigration(file: string): string {
	return readFileSync(join(moduleRoot(), 'app', 'migrations', file), 'utf-8')
}

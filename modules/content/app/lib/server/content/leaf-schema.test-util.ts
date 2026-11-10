// Test helper: the migration files the content integration suites apply to their scratch
// database. The `content` schema is created by the content LEAF chain
// (modules/content/migrations, which squashes the old kernel 044-046), and `news_posts` by the
// content app block (modules/content/app/migrations); no file under gremion-ui/migrations
// carries either. The suites run from two working directories, so the module root is found
// from whichever one this is:
//   - the kernel app lane (gremion-ui/, where the overlay copies these suites onto src/):
//     the module sits next to it, at ../modules/content;
//   - the module lane (modules/content/): the working directory is the module root.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function moduleRoot(): string {
	const cwd = process.cwd()
	for (const candidate of [join(cwd, '..', 'modules', 'content'), cwd]) {
		if (existsSync(join(candidate, 'migrations', '001_init.sql'))) return candidate
	}
	throw new Error(`content module root not found from ${cwd}: no migrations/001_init.sql beside or above it`)
}

/** A file of the content leaf chain (modules/content/migrations), as text. */
export function contentLeafMigration(file: string): string {
	return readFileSync(join(moduleRoot(), 'migrations', file), 'utf-8')
}

/** A file of the content app block (modules/content/app/migrations), as text. */
export function contentAppMigration(file: string): string {
	return readFileSync(join(moduleRoot(), 'app', 'migrations', file), 'utf-8')
}

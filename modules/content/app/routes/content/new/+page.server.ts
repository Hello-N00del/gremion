// Content Engine — create a post, then redirect into its editor.
//
// The page renders a single title field; the `create` action requires the
// content.author capability (mirroring POST /api/content/posts), calls
// content-db.createPost (which generates a unique slug and inserts the 3
// channel rows via ensureChannels), then redirects to /content/[id]/edit.
import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'

export const load: PageServerLoad = async ({ locals }) => {
  // Only show the form to users who may actually author.
  requireContentAuthor(locals.user)
  return {}
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const user = requireContentAuthor(locals.user)

    const form = await request.formData()
    const title = String(form.get('title') ?? '').trim()
    if (!title) return fail(400, { error: 'Titel ist erforderlich.', title })

    const backend = resolveContentBackendForPage()
    const post = await backend.createPost({ title, created_by: user.id })
    throw redirect(303, `/content/${post.id}/edit`)
  },
}

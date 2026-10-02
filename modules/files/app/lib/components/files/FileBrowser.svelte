<script lang="ts">
  import { Alert } from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { DavEntry } from '$lib/server/files/nextcloud-client'
  import { goto } from '$app/navigation'
  import { isEditableFile, isViewableFile } from '$lib/files/editable-types'
  import { t } from '$lib/i18n'

  interface Props {
    rootPath: string
    readonly: boolean
  }

  let { rootPath, readonly }: Props = $props()

  let entries = $state<DavEntry[]>([])
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  // #194: set when the API reports the user has no Nextcloud account (guest).
  // Rendered as a calm "kein Dokumentenzugriff" empty state, not an error banner.
  let noAccess = $state(false)
  let uploadProgress = $state(new Map<string, number>())

  let showNewFolderDialog = $state(false)
  let newFolderName = $state('')
  let showDeleteDialog = $state(false)
  let deleteTarget = $state<DavEntry | null>(null)
  let renamingHref = $state<string | null>(null)
  let renameValue = $state('')

  async function loadEntries() {
    loading = true
    loadError = null
    noAccess = false
    try {
      const url = '/api/files/' + rootPath.replace(/^\/+/, '')
      const res = await fetch(url)
      if (res.status === 401) {
        // Session expired or Keycloak token refresh failed. The API now
        // returns 401 JSON (not an HTML login redirect), so bounce the user
        // through login and back rather than showing a dead error.
        goto('/auth/login?callbackUrl=' + encodeURIComponent('/files' + (rootPath ? '/' + rootPath.replace(/^\/+/, '') : '')))
        return
      }

      // Read the body as text first so a non-JSON response (#161: Nextcloud
      // returned an HTML login/error page where JSON was expected, surfaced by
      // the edge proxy as "<!DOCTYPE …") becomes a clean error state instead of
      // an uncaught "Unexpected token '<'" from res.json().
      const raw = await res.text()
      const looksHtml = /^\s*</.test(raw)
      const contentType = res.headers.get('content-type') ?? ''
      if (looksHtml || !contentType.includes('application/json')) {
        // Client-side diagnostic for the "<!DOCTYPE-instead-of-JSON" path (#161).
        // Pairs with the server `[files:nc-bearer-drop]` log so a real occurrence
        // can be correlated from both ends.
        // eslint-disable-next-line no-console
        console.error('[FileBrowser] non-JSON response from /api/files', {
          status: res.status,
          contentType,
          bodySnippet: raw.slice(0, 200),
        })
        loadError = $t('files.loadFailed')
        return
      }

      const json = JSON.parse(raw)
      // #194: guests have no Nextcloud account — render a calm no-access state.
      if (json.reason === 'no_document_access' || (res.status === 403 && json.error === 'no_document_access')) {
        noAccess = true
        return
      }
      if (!json.success) {
        // Typed server failure (e.g. nextcloud_unavailable, #161) → retry state.
        loadError = json.reason === 'nextcloud_unavailable'
          ? $t('files.loadFailed')
          : (json.error ?? `HTTP ${res.status}`)
        return
      }
      entries = (json.files as Array<{path: string; name: string; is_dir: boolean; etag: string; size: number; last_modified: string}>).map((f) => ({
        href: f.path,
        displayName: f.name,
        isCollection: f.is_dir,
        etag: f.etag || null,
        contentLength: f.size,
        lastModified: f.last_modified,
        contentType: null,
      }))
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[FileBrowser] loadEntries failed', e)
      loadError = e instanceof Error ? e.message : $t('files.loadFailed')
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void loadEntries()
  })

  function navigate(path: string) {
    goto('/files' + (path ? '/' + path.replace(/^\/+/, '') : ''))
  }

  function breadcrumbs(): { label: string; path: string }[] {
    const parts = rootPath.split('/').filter(Boolean)
    const crumbs: { label: string; path: string }[] = [{ label: $t('nav.files'), path: '' }]
    let accumulated = ''
    for (const p of parts) {
      accumulated = accumulated ? accumulated + '/' + p : p
      crumbs.push({ label: p, path: accumulated })
    }
    return crumbs
  }

  function formatSize(bytes: number | null): string {
    if (bytes === null) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  }

  function formatDate(raw: string): string {
    if (!raw) return '—'
    try {
      return new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(new Date(raw))
    } catch {
      return raw
    }
  }

  async function handleFileInput(event: Event) {
    const input = event.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    loadError = null
    try {
      for (const file of files) {
        const CHUNK_SIZE = 5 * 1024 * 1024 // 5 MB
        const filename = file.name
        const targetPath = (rootPath ? rootPath + '/' : '') + filename

        if (file.size < CHUNK_SIZE) {
          const res = await fetch('/api/files/' + targetPath, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
          })
          if (!res.ok) {
            // Surface the failure and stop — a silent small-file PUT failure
            // would just leave the file missing from the list with no feedback.
            loadError = $t('files.uploadFailed')
            break
          }
          await loadEntries()
        } else {
          const uploadId = crypto.randomUUID()
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
          let chunkFailed = false
          for (let i = 0; i < totalChunks; i++) {
            const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
            const params = new URLSearchParams({
              uploadId,
              chunkIndex: String(i),
              totalChunks: String(totalChunks),
              filename,
              finalPath: targetPath,
              totalSize: String(file.size)
            })
            const res = await fetch('/api/files/upload-chunk?' + params.toString(), {
              method: 'POST',
              body: chunk
            })
            if (!res.ok) {
              // Abort the chunk loop on first failure so we don't march the
              // progress bar to 100% over a server-side assembly that is broken.
              chunkFailed = true
              loadError = $t('files.uploadFailed')
              break
            }
            uploadProgress = new Map(uploadProgress.set(filename, Math.round(((i + 1) / totalChunks) * 100)))
          }
          // Clear the per-file progress row whether the upload finished or aborted.
          uploadProgress = new Map(uploadProgress)
          uploadProgress.delete(filename)
          if (chunkFailed) break
          await loadEntries()
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[FileBrowser] upload failed', e)
      loadError = $t('files.uploadFailed')
    } finally {
      input.value = ''
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const res = await fetch('/api/files/' + deleteTarget.href.replace(/^\/+/, ''), {
      method: 'DELETE'
    })
    if (res.ok) {
      entries = entries.filter((e) => e.href !== deleteTarget?.href)
    }
    showDeleteDialog = false
    deleteTarget = null
  }

  async function handleRename(entry: DavEntry) {
    if (!renameValue || renameValue === entry.displayName) {
      renamingHref = null
      return
    }
    // G-021b: send the full path (current dir + new basename) as the
    // rename destination. The server runs `buildWebdavPath(uname, destination)`
    // which treats `destination` as a path relative to the user's webdav
    // root. Sending just the basename would move the file to that root.
    // Pattern mirrors createFolder() above.
    const destination = (rootPath ? rootPath + '/' : '') + renameValue
    const res = await fetch('/api/files/' + entry.href.replace(/^\/+/, ''), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', destination })
    })
    if (res.ok) await loadEntries()
    renamingHref = null
  }

  async function createFolder() {
    if (!newFolderName) return
    const folderPath = (rootPath ? rootPath + '/' : '') + newFolderName
    const res = await fetch('/api/files/' + folderPath + '?mkdir=true', { method: 'PUT' })
    if (res.ok) await loadEntries()
    showNewFolderDialog = false
    newFolderName = ''
  }
</script>

<div class="fb-wrap">
  <!-- Breadcrumb -->
  <nav class="fb-breadcrumb">
    {#each breadcrumbs() as crumb, i (crumb.path)}
      {#if i > 0}<span class="fb-crumb-sep">/</span>{/if}
      <button class="fb-crumb" onclick={() => navigate(crumb.path)}>{crumb.label}</button>
    {/each}
  </nav>

  <!-- Toolbar -->
  {#if !readonly}
    <div class="fb-toolbar">
      <label class="btn btn-sm fb-upload-label">
        <Icon name="upload" size={14} />
        {$t('files.upload')}
        <input type="file" multiple class="fb-file-input" onchange={handleFileInput} />
      </label>
      <button class="btn btn-primary btn-sm" onclick={() => (showNewFolderDialog = true)}>
        <Icon name="plus" size={14} />
        {$t('files.newFolder')}
      </button>
    </div>
  {/if}

  <!-- Upload progress -->
  {#each [...uploadProgress.entries()] as [name, pct] (name)}
    <div class="fb-progress">{name}: {pct}%</div>
  {/each}

  {#if noAccess}
    <!-- #194: guest with no Nextcloud account — calm informational state, not an
         error. Guests should not normally reach /files (it is member-gated), but
         a stale link / direct hit lands here cleanly instead of on a parse error. -->
    <div class="empty-state">
      <div class="glyph"><Icon name="folder" size={22} /></div>
      <div class="ttl">{$t('files.noAccessTitle')}</div>
      <div class="fb-muted">{$t('files.noAccessBody')}</div>
    </div>
  {:else if loadError}
    <Alert variant="destructive">
      {loadError}
      <Button variant="ghost" size="sm" onclick={loadEntries}>{$t('files.retry')}</Button>
    </Alert>
  {:else if loading}
    <div class="fb-muted">{$t('files.loading')}</div>
  {:else if entries.length === 0}
    <div class="empty-state">
      <div class="glyph"><Icon name="folder" size={22} /></div>
      <div class="ttl">{$t('files.empty')}</div>
    </div>
  {:else}
    <div class="card fb-table">
      <div class="fb-head">
        <div></div>
        <div>{$t('files.col.name')}</div>
        <div>{$t('files.col.modified')}</div>
        <div>{$t('files.col.size')}</div>
        <div class="fb-col-action"></div>
      </div>
      {#each entries as entry (entry.href)}
        <div class="fb-row">
          {#if entry.isCollection}
            <Icon name="folder" size={18} class="fb-ext-icon" />
          {:else}
            <span class="fb-ext">{(entry.displayName.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</span>
          {/if}
          <div class="fb-name-cell">
            {#if renamingHref === entry.href}
              <Input
                value={renameValue}
                onchange={(e) => (renameValue = (e.target as HTMLInputElement).value)}
                onblur={() => handleRename(entry)}
                onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') handleRename(entry); if (e.key === 'Escape') renamingHref = null }}
                class="h-7 w-48"
              />
            {:else if entry.isCollection}
              <button
                class="fb-name fb-name-folder"
                ondblclick={() => { renamingHref = entry.href; renameValue = entry.displayName }}
                onclick={() => navigate(entry.href)}
              >
                {entry.displayName}
              </button>
            {:else}
              <a
                href={'/api/files/' + entry.href.replace(/^\/+/, '')}
                class="fb-name"
                ondblclick={() => { if (!readonly) { renamingHref = entry.href; renameValue = entry.displayName } }}
              >
                {entry.displayName}
              </a>
            {/if}
          </div>
          <div class="fb-mod">{formatDate(entry.lastModified)}</div>
          <div class="fb-size">{formatSize(entry.contentLength)}</div>
          <div class="fb-actions">
            {#if !entry.isCollection && isEditableFile(entry.displayName) && !readonly}
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => goto('/files/edit/' + entry.href.replace(/^\/+/, ''))}
                aria-label={$t('files.open')}
              >
                <Icon name="edit" size={13} /> {$t('files.open')}
              </button>
            {:else if !entry.isCollection && isViewableFile(entry.displayName)}
              <a
                href={'/api/files/' + entry.href.replace(/^\/+/, '') + '?inline=1'}
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-ghost btn-sm"
                aria-label={$t('files.open')}
              >
                <Icon name="external" size={13} /> {$t('files.open')}
              </a>
            {/if}
            {#if !readonly}
              <button
                class="btn btn-ghost btn-sm fb-delete"
                onclick={() => { deleteTarget = entry; showDeleteDialog = true }}
                aria-label={$t('files.delete')}
              >
                ✕
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* File browser rethemed against shared tokens. All file operations (upload,
     rename, delete, navigate, open-in-Collabora) and the data fetch are
     unchanged; only the table/toolbar chrome was restyled. Dialogs keep the
     shadcn primitives. Values resolve to tokens so .dark auto-switches. */
  .fb-wrap {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .fb-breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--ink-muted);
    flex-wrap: wrap;
  }
  .fb-crumb {
    background: none;
    border: none;
    color: var(--ink-muted);
    cursor: pointer;
    padding: 0;
    font-size: 13px;
  }
  .fb-crumb:hover {
    color: var(--ink);
    text-decoration: underline;
  }
  .fb-crumb-sep {
    color: var(--ink-faint);
  }
  .fb-toolbar {
    display: flex;
    gap: 8px;
  }
  .fb-upload-label {
    cursor: pointer;
  }
  .fb-file-input {
    display: none;
  }
  .fb-progress,
  .fb-muted {
    font-size: 13px;
    color: var(--ink-muted);
  }

  .fb-table {
    padding: 0;
    overflow: hidden;
  }
  .fb-head,
  .fb-row {
    display: grid;
    grid-template-columns: 22px 1fr 130px 100px 160px;
    gap: 14px;
    align-items: center;
    padding: 10px 14px;
  }
  .fb-head {
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink-muted);
  }
  .fb-col-action {
    text-align: right;
  }
  .fb-row {
    border-bottom: 1px solid var(--border);
    transition: background var(--d-fast);
  }
  .fb-row:last-child {
    border-bottom: none;
  }
  .fb-row:hover {
    background: var(--surface-2);
  }
  :global(.fb-ext-icon) {
    color: var(--ink-muted);
  }
  .fb-ext {
    display: inline-grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    width: 22px;
    height: 22px;
  }
  .fb-name-cell {
    min-width: 0;
  }
  .fb-name {
    font-size: 13.5px;
    color: var(--ink);
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    width: 100%;
  }
  .fb-name:hover {
    text-decoration: underline;
  }
  .fb-name-folder {
    font-weight: 500;
  }
  .fb-mod,
  .fb-size {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--ink-muted);
  }
  .fb-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
  .fb-delete:hover {
    color: var(--rust);
  }
</style>

<!-- New folder dialog -->
<Dialog open={showNewFolderDialog} onClose={() => (showNewFolderDialog = false)}>
  <DialogHeader>
    <DialogTitle>{$t('files.newFolder')}</DialogTitle>
  </DialogHeader>
  <div class="py-4">
    <Input
      bind:value={newFolderName}
      placeholder={$t('files.folderName')}
      onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') createFolder() }}
    />
  </div>
  <DialogFooter>
    <Button variant="outline" onclick={() => (showNewFolderDialog = false)}>{$t('files.cancel')}</Button>
    <Button onclick={createFolder} disabled={!newFolderName}>{$t('files.create')}</Button>
  </DialogFooter>
</Dialog>

<!-- Delete confirmation dialog -->
<Dialog open={showDeleteDialog} onClose={() => (showDeleteDialog = false)}>
  <DialogHeader>
    <DialogTitle>{$t('files.deleteConfirm')}</DialogTitle>
  </DialogHeader>
  <p class="py-4 text-sm">
    {$t('files.deleteBody')} <strong>{deleteTarget?.displayName}</strong>?
  </p>
  <DialogFooter>
    <Button variant="outline" onclick={() => (showDeleteDialog = false)}>{$t('files.cancel')}</Button>
    <Button variant="destructive" onclick={handleDelete}>{$t('files.delete')}</Button>
  </DialogFooter>
</Dialog>

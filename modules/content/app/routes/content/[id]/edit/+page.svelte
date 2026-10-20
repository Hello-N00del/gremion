<script lang="ts">
  // Content Engine editor — PLAIN, functional placeholder (the designer polishes
  // later). Title + RichTextComposer (debounced autosave via the PATCH route),
  // three channel toggle switches (setChannelEnabled via PATCH), and a live
  // preview pane per ENABLED channel:
  //   - email   → subject + sanitized body HTML in a sandboxed iframe
  //   - portal  → sanitized body HTML in a sandboxed iframe
  //   - instagram → slide PNGs (the /carousel/[index] endpoint) + composed
  //                 caption + any cap warnings shown prominently.
  // All preview models come from the channel derive() endpoints; warnings are
  // surfaced, never silent.
  import PageTitle from '$lib/components/PageTitle.svelte'
  import RichTextComposer from '$lib/components/news/RichTextComposer.svelte'
  import { untrack } from 'svelte'
  import type { PageData } from './$types'
  import type { ChannelId, ChannelStatus, MailingList } from '$lib/server/content/types'
  import type {
    EmailPreview,
    PortalPreview,
    InstagramPreview,
    PublishResult,
  } from '$lib/server/content/channels/types'

  let { data }: { data: PageData } = $props()

  const postId = data.post.id
  const CHANNELS: { id: ChannelId; label: string }[] = [
    { id: 'email', label: 'E-Mail' },
    { id: 'portal', label: 'Portal' },
    { id: 'instagram', label: 'Instagram' },
  ]

  let title = $state(untrack(() => data.post.title ?? ''))
  let body = $state(untrack(() => data.post.body_html ?? ''))
  let enabled = $state<Record<ChannelId, boolean>>(untrack(() => ({ ...data.channelEnabled })))
  let channelState = $state<Record<ChannelId, { status: ChannelStatus; scheduled_at: string | null }>>(
    untrack(() => ({ ...data.channelState })),
  )

  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // --- autosave (debounced PATCH of title/body) -----------------------------
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  async function patch(payload: Record<string, unknown>): Promise<boolean> {
    saveState = 'saving'
    try {
      const res = await fetch(`/api/content/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      saveState = 'saved'
      return true
    } catch {
      saveState = 'error'
      return false
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const ok = await patch({ title: title.trim() || 'Ohne Titel', body_html: body })
      // After a successful body save, refresh previews of enabled channels.
      if (ok) refreshEnabledPreviews()
    }, 800)
  }

  // Watch title/body and debounce a save. Skip the initial mount run so merely
  // OPENING an existing post does not fire a spurious PATCH (which would bump
  // updated_at and make it useless as a "last human edit" signal). untrack the
  // side-effecting call list so it is not itself a reactive dependency.
  let autosaveHydrated = false
  $effect(() => {
    // touch reactive deps
    void title
    void body
    if (!autosaveHydrated) {
      autosaveHydrated = true
      return
    }
    untrack(() => scheduleSave())
  })

  // --- channel toggles -------------------------------------------------------
  async function toggleChannel(ch: ChannelId) {
    const next = !enabled[ch]
    enabled[ch] = next
    const ok = await patch({ channel: ch, enabled: next })
    if (!ok) {
      enabled[ch] = !next // revert on failure
      return
    }
    if (next) loadPreview(ch)
  }

  // --- previews --------------------------------------------------------------
  let emailPreview = $state<EmailPreview | null>(null)
  let portalPreview = $state<PortalPreview | null>(null)
  let instagramPreview = $state<InstagramPreview | null>(null)
  // cache-buster so the <img> slide PNGs refetch after a body edit
  let slideRev = $state(0)

  async function loadPreview(ch: ChannelId) {
    try {
      const res = await fetch(`/api/content/posts/${postId}/preview/${ch}`)
      if (!res.ok) return
      const model = await res.json()
      if (ch === 'email') emailPreview = model as EmailPreview
      else if (ch === 'portal') portalPreview = model as PortalPreview
      else instagramPreview = model as InstagramPreview
    } catch {
      // preview is best-effort; leave the prior render in place
    }
  }

  function refreshEnabledPreviews() {
    slideRev += 1
    for (const { id } of CHANNELS) if (enabled[id]) loadPreview(id)
  }

  function slideSrc(index: number): string {
    return `/api/content/posts/${postId}/carousel/${index}?rev=${slideRev}`
  }

  // Initial preview load for already-enabled channels.
  $effect(() => {
    untrack(() => {
      for (const { id } of CHANNELS) if (enabled[id]) loadPreview(id)
    })
  })

  // --- publish / schedule ----------------------------------------------------
  // Per-channel transient publish feedback (the last PublishResult or an error).
  let publishing = $state<Record<ChannelId, boolean>>({
    email: false,
    portal: false,
    instagram: false,
  })
  let publishResult = $state<Record<ChannelId, PublishResult | null>>({
    email: null,
    portal: null,
    instagram: null,
  })
  let publishError = $state<Record<ChannelId, string>>({ email: '', portal: '', instagram: '' })

  async function publishNow(ch: ChannelId) {
    if (ch === 'instagram') return // L3 — not enabled
    publishing[ch] = true
    publishError[ch] = ''
    publishResult[ch] = null
    try {
      const res = await fetch(`/api/content/posts/${postId}/publish/${ch}`, { method: 'POST' })
      const result = (await res.json().catch(() => null)) as PublishResult | { message?: string } | null
      if (res.ok && result && 'status' in result) {
        publishResult[ch] = result as PublishResult
        channelState[ch] = { ...channelState[ch], status: (result as PublishResult).status }
      } else if (res.status === 422 && result && 'status' in result) {
        // SMTP unconfigured (email): surface the failed result with its detail.
        publishResult[ch] = result as PublishResult
        publishError[ch] = (result as PublishResult).detail ?? 'Versand fehlgeschlagen.'
      } else {
        publishError[ch] =
          (result && 'message' in result && result.message) || `Veröffentlichung fehlgeschlagen (HTTP ${res.status}).`
      }
    } catch {
      publishError[ch] = 'Netzwerkfehler bei der Veröffentlichung.'
    } finally {
      publishing[ch] = false
    }
  }

  // schedule control: a per-channel datetime-local value bound in the markup.
  let scheduleInput = $state<Record<ChannelId, string>>(
    untrack(() => ({
      email: toLocalInput(data.channelState.email.scheduled_at),
      portal: toLocalInput(data.channelState.portal.scheduled_at),
      instagram: toLocalInput(data.channelState.instagram.scheduled_at),
    })),
  )

  // ISO ↔ <input type=datetime-local> (the input has no timezone; treat as local).
  function toLocalInput(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  async function schedule(ch: ChannelId) {
    const v = scheduleInput[ch]
    if (!v) return
    const iso = new Date(v).toISOString()
    publishError[ch] = ''
    const ok = await patch({ channel: ch, scheduled_at: iso })
    if (ok) channelState[ch] = { status: 'scheduled', scheduled_at: iso }
    else publishError[ch] = 'Planung fehlgeschlagen.'
  }

  async function clearSchedule(ch: ChannelId) {
    publishError[ch] = ''
    const ok = await patch({ channel: ch, scheduled_at: null })
    if (ok) {
      channelState[ch] = { status: 'draft', scheduled_at: null }
      scheduleInput[ch] = ''
    } else publishError[ch] = 'Planung konnte nicht aufgehoben werden.'
  }

  function statusLabel(s: ChannelStatus): string {
    return s === 'draft'
      ? 'Entwurf'
      : s === 'scheduled'
        ? 'Geplant'
        : s === 'sent'
          ? 'Gesendet'
          : s === 'published'
            ? 'Veröffentlicht'
            : 'Fehlgeschlagen'
  }

  // --- email recipient picker -------------------------------------------------
  // Loaded lazily when the email channel is enabled: the pickable content
  // mailing lists + KC groups, plus the post's current selection. Selection is a
  // set of "list:<id>" / "group:<id>" keys; saved wholesale via PUT.
  let availableLists = $state<MailingList[]>([])
  let availableGroups = $state<{ id: string; name: string; path: string }[]>([])
  let selectedRecipients = $state<Set<string>>(new Set())
  let recipientsLoaded = $state(false)
  let recipientsSaving = $state(false)
  let recipientsSaved = $state(false)
  let groupIdInput = $state('')

  async function loadRecipients() {
    try {
      const res = await fetch(`/api/content/posts/${postId}/recipients`)
      if (!res.ok) return
      const d = (await res.json()) as {
        recipients: { mailing_list_id: string | null; keycloak_group_id: string | null }[]
        lists: MailingList[]
        groups: { id: string; name: string; path: string }[]
      }
      availableLists = d.lists
      availableGroups = d.groups
      const sel = new Set<string>()
      for (const r of d.recipients) {
        if (r.mailing_list_id) sel.add(`list:${r.mailing_list_id}`)
        else if (r.keycloak_group_id) sel.add(`group:${r.keycloak_group_id}`)
      }
      selectedRecipients = sel
      recipientsLoaded = true
    } catch {
      // best-effort; leave the picker empty
    }
  }

  function toggleRecipient(key: string) {
    const next = new Set(selectedRecipients)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selectedRecipients = next
    recipientsSaved = false
  }

  function addGroupById() {
    const id = groupIdInput.trim()
    if (!id) return
    toggleRecipient(`group:${id}`)
    // surface a manually-entered group id in the list so it can be unchecked
    if (!availableGroups.some((g) => g.id === id)) {
      availableGroups = [...availableGroups, { id, name: id, path: id }]
    }
    groupIdInput = ''
  }

  async function saveRecipients() {
    recipientsSaving = true
    recipientsSaved = false
    const recipients = [...selectedRecipients].map((key) => {
      const [kind, id] = key.split(/:(.*)/s)
      return kind === 'list' ? { mailing_list_id: id } : { keycloak_group_id: id }
    })
    try {
      const res = await fetch(`/api/content/posts/${postId}/recipients`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients }),
      })
      recipientsSaved = res.ok
      if (!res.ok) publishError.email = 'Empfänger konnten nicht gespeichert werden.'
    } catch {
      publishError.email = 'Netzwerkfehler beim Speichern der Empfänger.'
    } finally {
      recipientsSaving = false
    }
  }

  // Load the recipient picker once when email is (or becomes) enabled.
  $effect(() => {
    if (enabled.email && !recipientsLoaded) untrack(() => loadRecipients())
  })

  const saveLabel = $derived(
    saveState === 'saving'
      ? 'Wird gespeichert…'
      : saveState === 'saved'
        ? 'Gespeichert'
        : saveState === 'error'
          ? 'Fehler beim Speichern'
          : '',
  )
</script>

<PageTitle title={title || 'Inhalt bearbeiten'} />

{#snippet publishControls(ch: ChannelId)}
  <div class="publish">
    <div class="publish-row">
      <button class="btn-primary" onclick={() => publishNow(ch)} disabled={publishing[ch]}>
        {publishing[ch] ? 'Veröffentlicht…' : 'Jetzt veröffentlichen'}
      </button>
      <div class="sched">
        <input type="datetime-local" bind:value={scheduleInput[ch]} aria-label="Geplante Zeit" />
        <button class="btn-secondary" onclick={() => schedule(ch)} disabled={!scheduleInput[ch]}>
          Planen
        </button>
        {#if channelState[ch].status === 'scheduled'}
          <button class="btn-link" onclick={() => clearSchedule(ch)}>Aufheben</button>
        {/if}
      </div>
    </div>
    {#if channelState[ch].status === 'scheduled' && channelState[ch].scheduled_at}
      <p class="muted">Geplant für {new Date(channelState[ch].scheduled_at!).toLocaleString('de-DE')}.</p>
    {/if}
    {#if publishError[ch]}
      <p class="warn err-warn">{publishError[ch]}</p>
    {/if}
    {#if publishResult[ch]}
      {@const r = publishResult[ch]}
      <div class="result">
        <strong>{statusLabel(r!.status)}</strong>
        {#if r!.recipientCount !== undefined}
          <span> · {r!.recipientCount} Empfänger</span>
        {/if}
        {#if r!.detail}<span> · {r!.detail}</span>{/if}
        {#each r!.warnings as w (w)}
          <p class="warn">{w}</p>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="topbar">
  <a class="back" href="/content">← Inhalte</a>
  <span class="save" class:err={saveState === 'error'}>{saveLabel}</span>
</div>

<div class="layout">
  <!-- Authoring column -->
  <section class="editor">
    <label class="lbl" for="title">Titel</label>
    <input id="title" class="title-input" type="text" bind:value={title} placeholder="Titel" />

    <label class="lbl" for="body">Inhalt</label>
    <div class="composer">
      <RichTextComposer bind:value={body} ariaLabel="Inhalt bearbeiten" />
    </div>

    <fieldset class="channels">
      <legend>Kanäle</legend>
      {#each CHANNELS as ch (ch.id)}
        <label class="toggle">
          <input
            type="checkbox"
            checked={enabled[ch.id]}
            onchange={() => toggleChannel(ch.id)}
          />
          <span>{ch.label}</span>
        </label>
      {/each}
    </fieldset>
  </section>

  <!-- Preview column -->
  <section class="previews">
    <h2 class="prev-title">Vorschau</h2>

    {#if !enabled.email && !enabled.portal && !enabled.instagram}
      <p class="muted">Aktiviere einen Kanal, um die Vorschau zu sehen.</p>
    {/if}

    {#if enabled.email}
      <article class="prev-card">
        <header class="prev-head">
          E-Mail
          <span class="badge badge-{channelState.email.status}">{statusLabel(channelState.email.status)}</span>
        </header>
        {#if emailPreview}
          {#each emailPreview.warnings as w (w)}
            <p class="warn">{w}</p>
          {/each}
          <div class="prev-meta">Betreff: {emailPreview.subject}</div>
          <iframe class="prev-frame" title="E-Mail-Vorschau" sandbox="" srcdoc={emailPreview.html}
          ></iframe>
        {:else}
          <p class="muted">Lädt…</p>
        {/if}

        <!-- Recipient picker (email only) -->
        <div class="recipients">
          <div class="lbl">Empfänger</div>
          {#if !recipientsLoaded}
            <p class="muted">Lädt…</p>
          {:else}
            {#if availableLists.length === 0 && availableGroups.length === 0}
              <p class="muted">
                Keine Listen oder Gruppen. <a href="/content/lists">Verteilerliste anlegen →</a>
              </p>
            {/if}
            {#if availableLists.length > 0}
              <div class="pick-group">
                <div class="pick-head">Verteilerlisten</div>
                {#each availableLists as l (l.id)}
                  <label class="pick">
                    <input
                      type="checkbox"
                      checked={selectedRecipients.has(`list:${l.id}`)}
                      onchange={() => toggleRecipient(`list:${l.id}`)}
                    />
                    <span>{l.name}</span>
                  </label>
                {/each}
              </div>
            {/if}
            {#if availableGroups.length > 0}
              <div class="pick-group">
                <div class="pick-head">Keycloak-Gruppen</div>
                {#each availableGroups as g (g.id)}
                  <label class="pick">
                    <input
                      type="checkbox"
                      checked={selectedRecipients.has(`group:${g.id}`)}
                      onchange={() => toggleRecipient(`group:${g.id}`)}
                    />
                    <span>{g.name}</span>
                  </label>
                {/each}
              </div>
            {/if}
            <div class="group-add">
              <input type="text" bind:value={groupIdInput} placeholder="Gruppen-ID hinzufügen" />
              <button class="btn-secondary" onclick={addGroupById}>+</button>
            </div>
            <button class="btn-secondary" onclick={saveRecipients} disabled={recipientsSaving}>
              {recipientsSaving ? 'Speichert…' : 'Empfänger speichern'}
            </button>
            {#if recipientsSaved}<span class="ok-note">Gespeichert</span>{/if}
          {/if}
        </div>

        {@render publishControls('email')}
      </article>
    {/if}

    {#if enabled.portal}
      <article class="prev-card">
        <header class="prev-head">
          Portal
          <span class="badge badge-{channelState.portal.status}">{statusLabel(channelState.portal.status)}</span>
        </header>
        {#if portalPreview}
          {#each portalPreview.warnings as w (w)}
            <p class="warn">{w}</p>
          {/each}
          <div class="prev-meta">{portalPreview.title}</div>
          <iframe class="prev-frame" title="Portal-Vorschau" sandbox="" srcdoc={portalPreview.html}
          ></iframe>
        {:else}
          <p class="muted">Lädt…</p>
        {/if}
        {@render publishControls('portal')}
      </article>
    {/if}

    {#if enabled.instagram}
      <article class="prev-card">
        <header class="prev-head">
          Instagram
          <span class="badge badge-draft">L3</span>
        </header>
        <p class="muted ig-note">
          Instagram-Veröffentlichung ist noch nicht aktiv (L3). Vorschau und
          Bildunterschrift dienen der Vorbereitung.
        </p>
        {#if instagramPreview}
          {#each instagramPreview.warnings as w (w)}
            <p class="warn">{w}</p>
          {/each}
          <div class="slides">
            {#each instagramPreview.slides as slide (slide.index)}
              <figure class="slide">
                <img src={slideSrc(slide.index)} alt={`Slide ${slide.index + 1}`} loading="lazy" />
                <figcaption>{slide.index + 1}/{slide.total}</figcaption>
              </figure>
            {/each}
          </div>
          <div class="caption">
            <div class="lbl">Bildunterschrift</div>
            <pre>{instagramPreview.caption}</pre>
          </div>
        {:else}
          <p class="muted">Lädt…</p>
        {/if}

        <!-- Visibly-DISABLED publish control (design's "visibly-disabled
             toggle"): the Instagram publish path ships disabled-by-default, so
             the button is shown but inert with its reason, rather than hidden. -->
        <div class="publish ig-publish">
          <div class="publish-row">
            <button class="btn-primary" type="button" disabled aria-disabled="true">
              Jetzt veröffentlichen
            </button>
          </div>
          <p class="muted ig-disabled-reason">Instagram nicht konfiguriert</p>
        </div>
      </article>
    {/if}
  </section>
</div>

<style>
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .back { font-size: 13px; color: var(--ink-muted, #666); text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .save { font-size: 12px; color: var(--ink-muted, #888); }
  .save.err { color: var(--rust-ink, #b00); }

  .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }

  .lbl { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted, #666); margin: 14px 0 6px; }
  .lbl:first-child { margin-top: 0; }
  .title-input { width: 100%; padding: 9px 11px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 16px; background: var(--surface, #fff); color: inherit; }
  .composer { border: 1px solid var(--border, #ccc); border-radius: 6px; overflow: hidden; }

  .channels { margin-top: 18px; border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 12px 14px; display: flex; gap: 18px; flex-wrap: wrap; }
  .channels legend { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted, #666); padding: 0 4px; }
  .toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }

  .previews { position: sticky; top: 12px; }
  .prev-title { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted, #666); margin-bottom: 12px; }
  .prev-card { border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
  .prev-head { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .prev-meta { font-size: 13px; margin-bottom: 8px; }
  .prev-frame { width: 100%; height: 320px; border: 1px solid var(--border, #eee); border-radius: 6px; background: #fff; }
  .warn { font-size: 12px; padding: 6px 10px; border-radius: 6px; background: var(--amber-soft, #fff4d6); color: var(--amber-ink, #7a5a00); border: 1px solid var(--amber, #e8c66a); margin-bottom: 8px; }
  .muted { color: var(--ink-muted, #888); font-size: 13px; }

  .slides { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; }
  .slide { flex: 0 0 auto; width: 160px; text-align: center; }
  .slide img { width: 160px; height: 160px; object-fit: cover; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--surface-2, #f5f5f5); }
  .slide figcaption { font-size: 11px; color: var(--ink-muted, #888); margin-top: 4px; }
  .caption { margin-top: 12px; }
  .caption pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 12.5px; background: var(--surface-2, #f7f7f7); border: 1px solid var(--border, #eee); border-radius: 6px; padding: 10px; margin-top: 4px; }

  /* status badge + publish controls */
  .prev-head { display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border, #ccc); color: var(--ink-muted, #666); background: var(--surface-2, #f3f3f3); }
  .badge-scheduled { color: var(--amber-ink, #7a5a00); background: var(--amber-soft, #fff4d6); border-color: var(--amber, #e8c66a); }
  .badge-sent, .badge-published { color: #1b6b2f; background: #e6f4ea; border-color: #9bcfac; }
  .badge-failed { color: var(--rust-ink, #b00); background: var(--rust-soft, #fde8e8); border-color: var(--rust, #e0a0a0); }

  .ig-note { margin-top: 8px; }
  .ig-disabled-reason { margin-top: 8px; font-style: italic; }
  .publish { margin-top: 12px; border-top: 1px solid var(--border, #eee); padding-top: 12px; }
  .publish-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .sched { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sched input { padding: 6px 8px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 13px; background: var(--surface, #fff); color: inherit; }
  .btn-primary { padding: 7px 14px; border: 1px solid var(--accent, #345); border-radius: 6px; background: var(--accent, #345); color: var(--paper, #fff); font-size: 13px; cursor: pointer; }
  .btn-primary:disabled { opacity: 0.6; cursor: default; }
  .btn-secondary { padding: 6px 12px; border: 1px solid var(--border, #ccc); border-radius: 6px; background: var(--surface, #fff); color: inherit; font-size: 13px; cursor: pointer; }
  .btn-secondary:disabled { opacity: 0.5; cursor: default; }
  .btn-link { background: none; border: 0; color: var(--ink-muted, #666); font-size: 12px; cursor: pointer; text-decoration: underline; }
  .result { margin-top: 10px; font-size: 13px; }
  .err-warn { background: var(--rust-soft, #fde8e8); color: var(--rust-ink, #b00); border-color: var(--rust, #e0a0a0); }
  .ok-note { font-size: 12px; color: #1b6b2f; margin-left: 8px; }

  /* recipient picker */
  .recipients { margin-top: 12px; border-top: 1px solid var(--border, #eee); padding-top: 12px; }
  .pick-group { margin-bottom: 10px; }
  .pick-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-muted, #888); margin-bottom: 4px; }
  .pick { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 2px 0; cursor: pointer; }
  .group-add { display: flex; gap: 6px; margin: 8px 0; }
  .group-add input { flex: 1; padding: 6px 9px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 13px; background: var(--surface, #fff); color: inherit; }
</style>

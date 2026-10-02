<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { env } from '$env/dynamic/public'
  import { page } from '$app/state'
  import { invalidateAll } from '$app/navigation'
  import { resolveBrand } from '$lib/brand'
  import { t } from '$lib/i18n'
  import { Dialog } from '$lib/components/ui/dialog'
  import PollCreateForm from '$lib/components/polls/PollCreateForm.svelte'
  import type { PageData } from './$types'
  import type { VoteItem } from '$lib/votes/types'
  import type { VoteListItem, NormalVoteItem, DegradedVoteItem } from './+page.server'

  let { data }: { data: PageData } = $props()
  let brand = $derived(resolveBrand(page.data.brand))

  type FilterTab = 'all' | 'open' | 'planned' | 'closed'

  const heliosBase = env.PUBLIC_HELIOS_URL ?? ''

  // Narrowing helpers for the degraded/normal union (see +page.server.ts).
  // Degraded items are tracked Helios elections whose ballot is currently
  // unreachable — they carry no lifecycle/turnout, so every lifecycle-keyed
  // derivation below operates on the normal items only.
  function isNormal(v: VoteListItem): v is NormalVoteItem {
    return !v.degraded
  }

  // All list items (union). Normal items drive the filter tabs/detail; degraded
  // items render as a quiet, muted "extern" tail.
  let allItems = $derived<VoteListItem[]>(data.votes)
  let votes = $derived<NormalVoteItem[]>(allItems.filter(isNormal))
  let degradedItems = $derived<DegradedVoteItem[]>(
    allItems.filter((v): v is DegradedVoteItem => v.degraded),
  )
  let activeFilter = $state<FilterTab>('open')
  let selectedId = $state<string>('')
  let showNewDialog = $state(false)
  // Quick-poll create dialog (relocated from /polls, #197). Opened either from
  // the "Neue Schnellumfrage" head action or the kind-picker in the new-vote
  // dialog; on success we re-run the loader so the new poll appears in the list.
  let showPollCreate = $state(false)
  let copied = $state(false)

  // Cache poll options once fetched, keyed by VoteItem.id.
  let pollOptionsCache = $state<Record<string, { label: string; votes: number }[]>>({})
  let optionsLoading = $state<Record<string, boolean>>({})
  let optionsError = $state<Record<string, string>>({})

  // Pick the first open vote on first render; fall back to first available.
  $effect(() => {
    if (selectedId === '' && votes.length > 0) {
      const firstOpen = votes.find((v) => v.lifecycle === 'open')
      selectedId = (firstOpen ?? votes[0]!).id
    }
  })

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'open',    label: 'Laufend'  },
    { key: 'planned', label: 'Geplant'  },
    { key: 'closed',  label: 'Geschlossen' },
    { key: 'all',     label: 'Alle'     },
  ]

  let counts = $derived({
    open: votes.filter((v) => v.lifecycle === 'open').length,
    planned: votes.filter((v) => v.lifecycle === 'planned').length,
    closed: votes.filter((v) => v.lifecycle === 'closed').length,
    all: votes.length,
  })

  let filtered = $derived(
    activeFilter === 'all' ? votes : votes.filter((v) => v.lifecycle === activeFilter),
  )

  let selected = $derived<VoteItem | undefined>(
    votes.find((v) => v.id === selectedId) ?? filtered[0],
  )

  // Lazy-load poll options when a poll is selected.
  $effect(() => {
    if (!selected || selected.kind !== 'poll') return
    if (pollOptionsCache[selected.id] || optionsLoading[selected.id]) return
    const id = selected.id
    const numericId = Number(id.split(':')[1])
    if (!Number.isFinite(numericId)) return
    optionsLoading = { ...optionsLoading, [id]: true }
    fetch(`/api/polls/${numericId}/options`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { options: { label: string; votes: number }[] }
        pollOptionsCache = { ...pollOptionsCache, [id]: body.options }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : 'Optionen konnten nicht geladen werden'
        optionsError = { ...optionsError, [id]: msg }
      })
      .finally(() => {
        optionsLoading = { ...optionsLoading, [id]: false }
      })
  })

  // Surface the loaded options on the selected item without mutating the
  // source. $derived.by takes a getter — $derived alone would treat the arrow
  // as the value itself, breaking reactive re-evaluation when the cache fills.
  let selectedWithOptions = $derived.by(() => {
    if (!selected) return undefined
    if (selected.kind !== 'poll') return selected
    const cached = pollOptionsCache[selected.id]
    return cached ? { ...selected, options: cached } : selected
  })

  function fmt(d: string) {
    if (!d) return '—'
    return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
  }

  function lifecycleLabel(lc: VoteItem['lifecycle']) {
    return lc === 'open' ? 'Laufend' : lc === 'planned' ? 'Geplant' : 'Geschlossen'
  }

  function turnoutPct(v: VoteItem): number {
    if (v.voterCount > 0) return Math.round((v.castVotes / v.voterCount) * 100)
    return 0
  }
  function quorumLeft(v: VoteItem): number | null {
    if (v.quorum > 0 && v.voterCount > 0) return Math.round((v.quorum / v.voterCount) * 100)
    return null
  }

  // Helios ballot URL — the encrypted-ballot handoff target on the external
  // Helios instance (uuid is the part after the `helios:` namespace prefix).
  function ballotUrl(v: VoteItem): string {
    const uuid = v.id.replace('helios:', '')
    return heliosBase ? `${heliosBase.replace(/\/$/, '')}/helios/elections/${uuid}/vote` : `/elections/${uuid}`
  }

  async function copyBallotUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      copied = true
      setTimeout(() => (copied = false), 1800)
    } catch {
      copied = false
    }
  }

  let totalVotes = $derived.by(() => {
    const s = selectedWithOptions
    if (!s) return 0
    return s.options ? s.options.reduce((acc, o) => acc + o.votes, 0) : s.castVotes
  })
</script>

<PageTitle title="Abstimmungen" />

<div class="votes-page">
  <!-- Page head -->
  <div class="page-head">
    <div>
      <div class="eyebrow">Abstimmungen &amp; Wahlen</div>
      <h1 class="page-title">Wahl- und Meinungsbilder</h1>
      <div class="page-sub">
        {#if data.electionsEnabled}
          Zwei Stimmen-Arten: <b>Helios</b> für anonyme, verifizierbare Wahlen ·
          <b>Nextcloud Polls</b> für schnelle Meinungsbilder.
        {:else}
          <b>Nextcloud Polls</b> für schnelle Meinungsbilder.
        {/if}
      </div>
    </div>
    <div class="head-actions">
      <!-- D4: derived from the same backend probe as the degraded cards below
           (single reachability source) — success only when nothing degraded;
           warn (R2: Einschränkung) otherwise. Glyphs per the pill-icon contract. -->
      {#if data.heliosStatus}
        <span
          class="pill"
          class:pill-success={data.heliosStatus.tone === 'success'}
          class:pill-warn={data.heliosStatus.tone === 'warn'}
        ><Icon name={data.heliosStatus.icon} size={12} /> {data.heliosStatus.label}</span>
      {/if}
      {#if data.isManager}
        <button type="button" class="btn btn-sm" onclick={() => (showPollCreate = true)}>
          <Icon name="poll" size={14} /> {$t('votes.poll.new')}
        </button>
      {/if}
      <button type="button" class="btn btn-sm btn-primary" onclick={() => (showNewDialog = true)}>
        <Icon name="plus" size={14} /> Neue Abstimmung
      </button>
    </div>
  </div>

  <!-- Filter tabs + legend -->
  <div class="filter-bar">
    <div class="segmented">
      {#each TABS as tab (tab.key)}
        <button
          type="button"
          class="seg-btn"
          class:on={activeFilter === tab.key}
          onclick={() => {
            activeFilter = tab.key
            const f = votes.filter((v) => tab.key === 'all' || v.lifecycle === tab.key)
            if (f.length) selectedId = f[0]!.id
          }}
        >
          <span>{tab.label}</span>
          <span class="mono seg-n">{counts[tab.key]}</span>
        </button>
      {/each}
    </div>
    <div class="kind-legend">
      {#if data.electionsEnabled}
        <span class="legend-item"><span class="kind-dot helios" aria-hidden="true"></span> Helios</span>
      {/if}
      <span class="legend-item"><span class="kind-dot poll" aria-hidden="true"></span> Poll</span>
    </div>
  </div>

  {#if data.pollErrors}
    <div class="poll-error-banner">
      Umfragen konnten nicht geladen werden: {data.pollErrors}
    </div>
  {/if}

  <!-- Split layout -->
  <div class="votes-grid">
    <!-- List -->
    <div class="votes-list">
      {#each filtered as vote (vote.id)}
        {@const active = vote.id === selected?.id}
        {@const tp = turnoutPct(vote)}
        {@const ql = quorumLeft(vote)}
        <button
          type="button"
          class="vote-card"
          class:active
          onclick={() => (selectedId = vote.id)}
        >
          <div class="vote-card-top">
            {#if vote.kind === 'helios'}
              <span class="kind-badge helios"><Icon name="shield" size={11} /> HELIOS · E2E</span>
            {:else}
              <span class="kind-badge poll"><Icon name="poll" size={11} /> POLL</span>
            {/if}
            <span
              class="pill"
              class:pill-accent={vote.lifecycle === 'open'}
              class:pill-live={vote.lifecycle === 'open'}
              class:pill-warn={vote.lifecycle === 'planned'}
            >{lifecycleLabel(vote.lifecycle)}</span>
          </div>
          <div class="vote-card-title">{vote.title}</div>
          {#if vote.description}
            <div class="vote-card-sub">{vote.description}</div>
          {/if}
          <div class="vote-card-meta">
            <div class="vote-meta-col">
              <div class="vote-meta-label">Frist</div>
              <div class="vote-meta-val mono">{fmt(vote.closes)}</div>
            </div>
            <div class="vote-meta-col">
              <div class="vote-meta-label">Beteiligung</div>
              <div class="vote-meta-val mono">
                {vote.castVotes}{#if vote.voterCount > 0}<span class="dim">/{vote.voterCount}</span><span class="pct-tag">{tp}%</span>{/if}
              </div>
            </div>
          </div>
          {#if vote.voterCount > 0}
            <div class="turnout-track" title="Beteiligung {tp}%">
              <div class="turnout-fill" style="width: {tp}%;"></div>
              {#if ql !== null}
                <div class="turnout-quorum" style="left: {ql}%;" title="Quorum"></div>
              {/if}
            </div>
          {/if}
        </button>
      {:else}
        {#if degradedItems.length === 0}
          <div class="empty-card">
            <Icon name="vote" size={26} />
            <span>Keine Abstimmungen</span>
          </div>
        {/if}
      {/each}

      {#if degradedItems.length > 0}
        <!-- Tracked Helios elections whose Ballot derzeit nicht erreichbar ist.
             Bewusst nicht ausgeblendet: muted dargestellt, damit die Wahl
             sichtbar bleibt. -->
        <div class="degraded-divider">
          <Icon name="external-link" size={11} /> Extern · Helios derzeit nicht erreichbar
        </div>
        {#each degradedItems as vote (vote.id)}
          <div class="vote-card degraded" aria-disabled="true">
            <div class="vote-card-top">
              <span class="kind-badge helios muted"><Icon name="shield" size={11} /> HELIOS</span>
              <span class="pill pill-muted">Extern</span>
            </div>
            <div class="vote-card-title">
              {vote.committeeName ? `Wahl · ${vote.committeeName}` : 'Wahl angelegt'}
            </div>
            <div class="vote-card-sub">{vote.stateLabel}</div>
            <div class="vote-card-meta">
              <div class="vote-meta-col">
                <div class="vote-meta-label">Angelegt</div>
                <div class="vote-meta-val mono">{fmt(vote.createdAt)}</div>
              </div>
              <!-- A1: the Helios election id keeps two tracked elections of the
                   same committee tellable apart while both are unreachable. -->
              <div class="vote-meta-col vote-meta-trunc">
                <div class="vote-meta-label">Helios-ID</div>
                <div class="vote-meta-val mono" title={vote.heliosUuid}>{vote.heliosUuid}</div>
              </div>
            </div>
            <div class="degraded-note">
              Der Wahlschein liegt auf der externen Helios-Instanz und ist
              gerade nicht abrufbar. Die Wahl bleibt angelegt; Details werden
              angezeigt, sobald Helios wieder erreichbar ist.
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Detail -->
    <div class="votes-detail">
      {#if selected}
        {@const s = selectedWithOptions ?? selected}
        <div class="detail-head">
          <div>
            {#if s.kind === 'helios'}
              <span class="kind-badge helios lg"><Icon name="shield" size={13} /> HELIOS · E2E</span>
            {:else}
              <span class="kind-badge poll lg"><Icon name="poll" size={13} /> POLL</span>
            {/if}
            <h2 class="display detail-title">{s.title}</h2>
            <div class="detail-meta mono">
              {#if s.closes}<span><Icon name="clock" size={12} /> {fmt(s.closes)}</span>{/if}
              {#if s.quorum > 0}<span>Quorum {s.quorum} Stimmberechtigte</span>{/if}
            </div>
          </div>
          <span
            class="pill"
            class:pill-accent={s.lifecycle === 'open'}
            class:pill-live={s.lifecycle === 'open'}
            class:pill-warn={s.lifecycle === 'planned'}
          >{lifecycleLabel(s.lifecycle)}</span>
        </div>

        {#if s.description}
          <p class="detail-desc">{s.description}</p>
        {/if}

        {#if s.kind === 'helios'}
          <!-- E2E explainer strip -->
          <div class="helios-strip">
            <div class="helios-strip-col">
              <Icon name="key" size={14} />
              <div>
                <div class="helios-strip-label">Verschlüsselung</div>
                <div class="helios-strip-val mono">ElGamal · 4096 bit</div>
              </div>
            </div>
            <div class="helios-strip-col">
              <Icon name="shield" size={14} />
              <div>
                <div class="helios-strip-label">Anonym</div>
                <div class="helios-strip-val mono">RE-MIX · ZK-Proof</div>
              </div>
            </div>
            <div class="helios-strip-col">
              <Icon name="check" size={14} />
              <div>
                <div class="helios-strip-label">Verifizierbar</div>
                <div class="helios-strip-val mono">öffentliches Audit</div>
              </div>
            </div>
          </div>

          {#if s.lifecycle === 'open'}
            <!-- Encrypted ballot handoff -->
            <div class="ballot-handoff">
              <div class="ballot-handoff-head">
                <Icon name="lock" size={14} /> Verschlüsselter Wahlschein
              </div>
              <p class="ballot-handoff-body">
                Ihr Stimmzettel wird im Browser verschlüsselt, <b>bevor</b> er an den Server gesendet
                wird. {brand.product} sieht Ihre Stimme nicht.
              </p>
              <div class="ballot-url mono">
                <Icon name="external-link" size={12} />
                <span class="ballot-url-text">{ballotUrl(s)}</span>
                <button
                  type="button"
                  class="ballot-copy"
                  title="URL kopieren"
                  aria-label="Wahlschein-URL kopieren"
                  onclick={() => copyBallotUrl(ballotUrl(s))}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} />
                </button>
              </div>
            </div>

            <a class="btn btn-primary detail-cta" href="/elections/{s.id.replace('helios:', '')}">
              <Icon name="shield" size={14} /> Verschlüsselten Stimmzettel öffnen
            </a>
          {/if}
        {/if}

        {#if s.kind === 'poll'}
          <div class="poll-section">
            <div class="eyebrow">Antwortoptionen</div>

            {#if optionsLoading[s.id]}
              <div class="poll-note mono">Optionen werden geladen…</div>
            {:else if optionsError[s.id]}
              <div class="poll-note error">Optionen konnten nicht geladen werden: {optionsError[s.id]}</div>
            {:else if s.options && s.options.length > 0}
              {@const tv = totalVotes}
              <div class="poll-options">
                {#each s.options as opt (opt.label)}
                  {@const pct = tv > 0 ? Math.round((opt.votes / tv) * 100) : 0}
                  <div class="poll-opt cast">
                    <div class="poll-opt-fill" style="width: {pct}%;"></div>
                    <div class="poll-opt-row">
                      <div class="poll-opt-label">{opt.label}</div>
                      <div class="poll-opt-stats mono">
                        <span class="pct">{pct}%</span>
                        <span class="count">{opt.votes}</span>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="poll-note mono">Keine Optionen vorhanden.</div>
            {/if}

            <a class="btn detail-cta" href="/polls/{s.id.replace('poll:', '')}">
              <Icon name="arrow-right" size={14} /> Zur Umfrage
            </a>
          </div>
        {/if}

        <div class="detail-foot mono">
          {#if s.opens}<span>Öffnet {fmt(s.opens)}</span>{/if}
          {#if s.closes}<span>Schließt {fmt(s.closes)}</span>{/if}
          <span class="detail-foot-spacer"></span>
          <span class="dim">ID: {s.id}</span>
        </div>
      {:else}
        <div class="empty-card">
          <Icon name="vote" size={26} />
          <span>Keine Abstimmung ausgewählt</span>
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- New vote dialog -->
{#if showNewDialog}
  <div
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Neue Abstimmung erstellen"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) showNewDialog = false }}
    onkeydown={(e) => { if (e.key === 'Escape') showNewDialog = false }}
  >
    <div class="dialog">
      <div class="dialog-head">
        <div>
          <div class="eyebrow">Neue Abstimmung</div>
          <h3 class="dialog-title">Welche Art?</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showNewDialog = false)} aria-label="Schließen">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div class="dialog-choices">
        {#if data.electionsEnabled}
          <a href="/elections/new" class="dialog-choice">
            <div class="dialog-choice-icon helios"><Icon name="shield" size={18} /></div>
            <div class="dialog-choice-text">
              <div class="dialog-choice-title">Helios-Wahl</div>
              <div class="dialog-choice-sub">End-to-end verschlüsselt · anonym · öffentlich verifizierbar. Für Vorstandswahlen, Urabstimmungen, Satzung.</div>
            </div>
            <Icon name="arrow-right" size={14} />
          </a>
        {/if}
        <button
          type="button"
          class="dialog-choice"
          onclick={() => { showNewDialog = false; showPollCreate = true }}
        >
          <div class="dialog-choice-icon poll"><Icon name="poll" size={18} /></div>
          <div class="dialog-choice-text">
            <div class="dialog-choice-title">Nextcloud-Poll</div>
            <div class="dialog-choice-sub">Schnelle, nicht-anonyme Terminabstimmung oder Meinungsbild. Ergebnis live.</div>
          </div>
          <Icon name="arrow-right" size={14} />
        </button>
      </div>
      <div class="dialog-foot mono">
        <Icon name="info" size={12} />
        {#if data.electionsEnabled}
          <span>Nur <b>Vorstand</b> und <b>Wahlausschuss</b> dürfen Helios-Wahlen starten. Polls kann jedes Mitglied erstellen.</span>
        {:else}
          <span>Polls kann jedes Mitglied erstellen.</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Quick-poll create dialog — reuses the shared Dialog + PollCreateForm,
     relocated from the removed /polls page (#197). Posts to this page's
     ?/create action; on success we re-run the loader so the list refreshes. -->
<Dialog open={showPollCreate} onClose={() => (showPollCreate = false)}>
  <PollCreateForm
    action="?/create"
    oncreate={() => { showPollCreate = false; void invalidateAll() }}
    oncancel={() => (showPollCreate = false)}
  />
</Dialog>

<style>
  /* Abstimmungen & Wahlen (Task 3.1) — institutional restyle ported from the v5
     prototype (votes.jsx). Generic primitives (.btn, .pill, .eyebrow, .mono,
     .display) come from app.css; bespoke classes resolve to design tokens so
     .dark auto-switches. */
  .votes-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 20px;
    flex-wrap: wrap;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }
  .page-sub {
    font-size: 13px;
    color: var(--ink-muted);
    margin-top: 6px;
    max-width: 560px;
    line-height: 1.5;
  }
  .head-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    /* R25-FX (WCAG 1.4.10): a council admin sees a THIRD item here (the
       manager-only "Neue Schnellumfrage" button, alongside the Helios status
       pill and "Neue Abstimmung") whose combined min-content does not fit
       320/390 px once `.page-head` itself has already wrapped this row onto
       its own line below the title. */
    flex-wrap: wrap;
  }

  /* Filter bar */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .segmented {
    display: flex;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    overflow: hidden;
  }
  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 0;
    background: transparent;
    color: var(--ink-muted);
    font-size: 13px;
    cursor: pointer;
  }
  .seg-btn:hover {
    color: var(--ink);
  }
  .seg-btn.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .seg-n {
    font-size: 12px;
  }
  .kind-legend {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--ink-muted);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .kind-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .kind-dot.helios {
    background: var(--accent);
  }
  .kind-dot.poll {
    background: var(--pine);
  }

  .poll-error-banner {
    font-size: 12px;
    padding: 8px 12px;
    border-radius: var(--r-sm);
    background: var(--rust-soft);
    color: var(--rust-ink);
  }

  /* Kind badge */
  .kind-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 3px 7px;
    border-radius: 100px;
  }
  .kind-badge.lg {
    font-size: 10.5px;
    padding: 4px 9px;
  }
  .kind-badge.helios {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .kind-badge.poll {
    background: var(--pine-soft);
    color: var(--pine-ink);
  }

  /* Split grid */
  .votes-grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 18px;
    align-items: start;
  }
  @media (max-width: 860px) {
    .votes-grid {
      grid-template-columns: 1fr;
    }
  }

  .votes-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .vote-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
    cursor: pointer;
  }
  .vote-card:hover {
    border-color: var(--border-strong);
  }
  .vote-card.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* Degraded (tracked-but-unreachable) Helios election — muted/secondary so it
     stays visible without competing with the live elections above it. */
  .vote-card.degraded {
    cursor: default;
    background: var(--surface-2);
    border-style: dashed;
    opacity: 0.92;
  }
  .vote-card.degraded:hover {
    border-color: var(--border);
  }
  .vote-card.degraded .vote-card-title {
    color: var(--ink-2);
  }
  .degraded-divider {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-faint);
  }
  .degraded-note {
    font-size: 11.5px;
    color: var(--ink-muted);
    line-height: 1.45;
  }
  .kind-badge.helios.muted {
    background: var(--surface);
    color: var(--ink-muted);
    border: 1px solid var(--border);
  }
  .pill.pill-muted {
    background: var(--surface);
    color: var(--ink-muted);
    border: 1px solid var(--border);
  }
  .vote-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .vote-card-title {
    font-size: 14.5px;
    font-weight: 600;
    color: var(--ink);
    line-height: 1.25;
  }
  .vote-card-sub {
    font-size: 12px;
    color: var(--ink-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .vote-card-meta {
    display: flex;
    gap: 20px;
  }
  .vote-meta-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-faint);
  }
  .vote-meta-val {
    font-size: 12px;
    color: var(--ink-2);
    margin-top: 2px;
  }
  .vote-meta-val .dim {
    color: var(--ink-faint);
  }
  /* A1: full Helios uuid4s must not wrap the fixed-width card */
  .vote-meta-trunc {
    min-width: 0;
  }
  .vote-meta-trunc .vote-meta-val {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pct-tag {
    margin-left: 6px;
    color: var(--accent-ink);
  }

  /* Turnout track + quorum tick */
  .turnout-track {
    position: relative;
    height: 5px;
    border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .turnout-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
  }
  .turnout-quorum {
    position: absolute;
    top: -2px;
    width: 2px;
    height: 9px;
    background: var(--ember);
    transform: translateX(-50%);
  }

  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 20px;
    text-align: center;
    color: var(--ink-muted);
    border: 1px dashed var(--border);
    border-radius: var(--r-md);
    font-size: 13px;
  }

  /* Detail panel */
  .votes-detail {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
    padding: 22px 24px;
    min-width: 0;
  }
  .detail-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  .detail-title {
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-top: 8px;
    line-height: 1.15;
  }
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--ink-muted);
  }
  .detail-meta span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .detail-desc {
    font-size: 13.5px;
    color: var(--ink-2);
    line-height: 1.55;
    margin: 14px 0 0;
  }

  /* Helios E2E strip */
  .helios-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-top: 18px;
    padding: 14px 16px;
    border: 1px solid var(--accent-soft);
    border-radius: var(--r-md);
    background: var(--accent-faint);
  }
  @media (max-width: 520px) {
    .helios-strip {
      grid-template-columns: 1fr;
    }
  }
  .helios-strip-col {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    color: var(--accent-ink);
  }
  .helios-strip-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-muted);
  }
  .helios-strip-val {
    font-size: 12px;
    color: var(--ink);
    margin-top: 2px;
  }

  /* Ballot handoff card */
  .ballot-handoff {
    margin-top: 16px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .ballot-handoff-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--ink);
    color: var(--paper);
    font-size: 12.5px;
    font-weight: 600;
  }
  :global(.dark) .ballot-handoff-head {
    color: #0e0f10;
  }
  .ballot-handoff-body {
    font-size: 12.5px;
    color: var(--ink-2);
    line-height: 1.5;
    padding: 12px 14px 0;
    margin: 0;
  }
  .ballot-url {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 14px 14px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-2);
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .ballot-url-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ballot-copy {
    display: inline-flex;
    flex-shrink: 0;
    padding: 4px;
    border: 0;
    border-radius: var(--r-xs);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
  }
  .ballot-copy:hover {
    background: var(--surface);
    color: var(--ink);
  }

  .detail-cta {
    margin-top: 16px;
    width: 100%;
    justify-content: center;
  }

  /* Poll options */
  .poll-section {
    margin-top: 18px;
  }
  .poll-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
  }
  .poll-opt {
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    overflow: hidden;
    background: var(--surface);
  }
  .poll-opt-fill {
    position: absolute;
    inset: 0;
    background: var(--accent-faint);
    z-index: 0;
  }
  .poll-opt-row {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
  }
  .poll-opt-label {
    font-size: 13px;
    color: var(--ink);
  }
  .poll-opt-stats {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
  }
  .poll-opt-stats .pct {
    color: var(--accent-ink);
    font-weight: 600;
  }
  .poll-opt-stats .count {
    color: var(--ink-faint);
  }
  .poll-note {
    font-size: 12px;
    color: var(--ink-muted);
    margin-top: 8px;
  }
  .poll-note.error {
    color: var(--rust-ink);
  }

  .detail-foot {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--ink-muted);
  }
  .detail-foot-spacer {
    flex: 1;
  }
  .detail-foot .dim {
    color: var(--ink-faint);
  }

  /* New-vote dialog */
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: var(--scrim);
    padding: 20px;
  }
  .dialog {
    width: 100%;
    max-width: 460px;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
    padding: 20px 22px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  }
  .dialog-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .dialog-title {
    font-size: 18px;
    font-weight: 600;
    margin-top: 4px;
  }
  .dialog-choices {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 16px 0;
  }
  .dialog-choice {
    /* Rendered as either <a> (Helios) or <button> (Poll, #197); reset the
       native button chrome so both read identically. */
    width: 100%;
    text-align: left;
    font: inherit;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    text-decoration: none;
    color: inherit;
  }
  .dialog-choice:hover {
    border-color: var(--accent);
    background: var(--accent-faint);
  }
  .dialog-choice-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: var(--r-sm);
  }
  .dialog-choice-icon.helios {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .dialog-choice-icon.poll {
    background: var(--pine-soft);
    color: var(--pine-ink);
  }
  .dialog-choice-text {
    flex: 1;
    min-width: 0;
  }
  .dialog-choice-title {
    font-size: 14px;
    font-weight: 600;
  }
  .dialog-choice-sub {
    font-size: 12px;
    color: var(--ink-muted);
    margin-top: 2px;
    line-height: 1.45;
  }
  .dialog-foot {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 11px;
    color: var(--ink-muted);
    line-height: 1.5;
  }
</style>

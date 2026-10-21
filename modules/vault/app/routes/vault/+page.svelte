<script lang="ts">
  // Native Tresor (#405 design v11, prototype web/vault.jsx VaultScreen, NATIV
  // lane): one Fach per org-unit in scope, reveal-per-item with audit, honest
  // lock state. The lock mirrors the SERVER's step-up gate on ciphertext
  // delivery (401 STEP_UP_REQUIRED → locked); the one real unlock action is the
  // #164 flow (/auth/step-up?returnTo=/vault). The prototype's passkey button /
  // passphrase input are the E2E-Zielbild and deliberately NOT rendered — they
  // appear only as "geplant" in the lock-card hint.
  import { invalidateAll } from '$app/navigation'
  import { resolveBrand } from '$lib/brand'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { Dialog, DialogHeader, DialogTitle } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import {
    VAULT_AUTO_LOCK_MS,
    SECRET_AUTO_HIDE_MS,
    initialVaultLock,
    visibleUnits,
    generatePassphrase,
  } from '$lib/vault/vault-view'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  // Tenant brand — the create-dialog example placeholder derives its mail
  // domain from the per-tenant brand (§6-P2.2 brand neutralization: no
  // institution literal inline; the prototype's hardcoded example domain is
  // tenant identity, so it comes from config).
  const brand = $derived(resolveBrand(data.brand))

  // ── Compartments ──
  const itemsByUnit = $derived.by(() => {
    const map = new Map<string, typeof data.items>()
    for (const i of data.items) {
      const list = map.get(i.org_unit_id)
      if (list) list.push(i)
      else map.set(i.org_unit_id, [i])
    }
    return map
  })
  const counts = $derived(new Map([...itemsByUnit].map(([k, v]) => [k, v.length])))
  const units = $derived(visibleUnits(data.units, counts))

  // ── Lock state (honest #164 mapping; see vault-view.initialVaultLock) ──
  // Initialized ONCE per mount, deliberately capturing only the initial data:
  // returning from the step-up flow is a full navigation (fresh mount, fresh
  // loa2 → unlocked); a later invalidateAll never force-unlocks a vault the
  // user locked manually.
  // svelte-ignore state_referenced_locally
  let locked = $state(initialVaultLock(data.stepUpEnforced, data.stepUpOk))

  let errorMsg = $state('')
  // Revealed secrets live only in memory, keyed by item id, and only after the
  // server's scope+step-up-gated reveal endpoint returned them.
  let revealed = $state<Record<string, string>>({})
  let copied = $state<Record<string, boolean>>({})
  const hideTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function lock() {
    locked = true
    revealed = {}
    copied = {}
    for (const t of hideTimers.values()) clearTimeout(t)
    hideTimers.clear()
  }

  // Client-side auto-lock 5 min after (each) unlock.
  $effect(() => {
    if (locked) return
    const t = setTimeout(lock, VAULT_AUTO_LOCK_MS)
    return () => clearTimeout(t)
  })

  function hide(id: string) {
    const { [id]: _removed, ...rest } = revealed
    revealed = rest
    const t = hideTimers.get(id)
    if (t) clearTimeout(t)
    hideTimers.delete(id)
  }

  async function reveal(id: string) {
    errorMsg = ''
    const res = await fetch(`/api/vault/${id}/secret`)
    if (res.status === 401) {
      // STEP_UP_REQUIRED — the session's LoA 2 went stale server-side; flip the
      // page into the locked state instead of showing a raw error.
      const body = await res.json().catch(() => null)
      if (body?.error === 'STEP_UP_REQUIRED') {
        lock()
        return
      }
    }
    if (!res.ok) {
      errorMsg = 'Geheimnis konnte nicht angezeigt werden.'
      return
    }
    const json = await res.json()
    revealed = { ...revealed, [id]: json.data.secret }
    hideTimers.set(
      id,
      setTimeout(() => hide(id), SECRET_AUTO_HIDE_MS),
    )
    // Refresh the Zugriffsprotokoll card — this reveal was just audited.
    await invalidateAll()
  }

  async function copy(id: string) {
    const secret = revealed[id]
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      copied = { ...copied, [id]: true }
      setTimeout(() => (copied = { ...copied, [id]: false }), 1500)
    } catch {
      errorMsg = 'Kopieren nicht möglich — Zwischenablage nicht verfügbar.'
    }
  }

  // ── Löschen (plain confirm dialog — shared ui/dialog, not browser confirm) ──
  let deleteTarget = $state<{ id: string; name: string } | null>(null)
  let deleting = $state(false)
  async function confirmDelete() {
    if (!deleteTarget) return
    deleting = true
    errorMsg = ''
    try {
      const res = await fetch(`/api/vault/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) {
        errorMsg = 'Eintrag konnte nicht gelöscht werden.'
        return
      }
      hide(deleteTarget.id)
      deleteTarget = null
      await invalidateAll()
    } finally {
      deleting = false
    }
  }

  // ── Eintrag anlegen (prototype VaultCreate) ──
  let creating = $state(false)
  let cOrgUnit = $state('')
  let cName = $state('')
  let cUsername = $state('')
  let cSecret = $state('')
  let cShowSecret = $state(false)
  let cError = $state('')
  let submitting = $state(false)

  function openCreate() {
    cOrgUnit = data.units[0]?.id ?? ''
    cName = ''
    cUsername = ''
    cSecret = ''
    cShowSecret = false
    cError = ''
    creating = true
  }

  function generate() {
    cSecret = generatePassphrase()
    cShowSecret = true
  }

  async function createItem() {
    submitting = true
    cError = ''
    try {
      const res = await fetch('/api/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgUnitId: cOrgUnit,
          name: cName,
          secret: cSecret,
          username: cUsername.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        cError = body?.message ?? 'Eintrag konnte nicht angelegt werden.'
        return
      }
      creating = false
      await invalidateAll()
    } catch {
      cError = 'Eintrag konnte nicht angelegt werden.'
    } finally {
      submitting = false
    }
  }

  // ── Eintrag bearbeiten (PUT /api/vault/[id], #405) — closes the former
  //    "edit = delete + recreate" residual. Metadata is prefilled; the stored
  //    Geheimnis is NEVER fetched into the form — the optional "Neues
  //    Geheimnis" field maps onto the PUT contract (absent = keep), so an
  //    empty field leaves the ciphertext untouched. ──
  let editTarget = $state<{ id: string } | null>(null)
  let eOrgUnit = $state('')
  let eName = $state('')
  let eUsername = $state('')
  let eSecret = $state('')
  let eShowSecret = $state(false)
  let eError = $state('')
  let saving = $state(false)

  function openEdit(item: (typeof data.items)[number]) {
    eOrgUnit = item.org_unit_id
    eName = item.name
    eUsername = item.username ?? ''
    eSecret = ''
    eShowSecret = false
    eError = ''
    editTarget = { id: item.id }
  }

  function eGenerate() {
    eSecret = generatePassphrase()
    eShowSecret = true
  }

  async function saveEdit() {
    if (!editTarget) return
    const id = editTarget.id
    saving = true
    eError = ''
    try {
      const res = await fetch(`/api/vault/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgUnitId: eOrgUnit,
          name: eName,
          username: eUsername.trim() || null,
          // PUT semantics: absent = keep — an empty field never touches the
          // stored secret (min-length 1 server-side, so it MUST be omitted).
          ...(eSecret ? { secret: eSecret } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        eError = body?.message ?? 'Eintrag konnte nicht gespeichert werden.'
        return
      }
      // A replaced secret makes a currently revealed value stale — drop it.
      if (eSecret) hide(id)
      editTarget = null
      await invalidateAll()
    } catch {
      eError = 'Eintrag konnte nicht gespeichert werden.'
    } finally {
      saving = false
    }
  }

  // ── Zugriffsprotokoll — newest 8 + trivial "Mehr anzeigen" pagination ──
  let logVisible = $state(8)
</script>

<PageTitle title="Tresor" />

<div class="vt-wrap">
  <div class="vt-head">
    <div>
      <div class="eyebrow">Verwaltung · Tresor</div>
      <h1>Geteilte Zugangsdaten</h1>
      <p class="vt-sub">
        Je Referat ein Fach: sichtbar nur für Mitglieder der Einheit, jede Anzeige wird
        protokolliert. Bei der Amtsübergabe wandert der Zugriff mit der Rolle — nie das Geheimnis
        in ein Dokument.
      </p>
    </div>
    {#if units.length > 0 && !locked}
      <div class="vt-head-acts">
        <button
          type="button"
          class="btn"
          onclick={lock}
          title="Sperrt die Tresor-Ansicht — angezeigte Geheimnisse werden aus der Anzeige entfernt."
        >
          <Icon name="lock" size={13} /> Sperren
        </button>
        <button type="button" class="btn btn-primary" onclick={openCreate}>
          <Icon name="plus" size={14} /> Eintrag anlegen
        </button>
      </div>
    {/if}
  </div>

  <!-- Trust banner: the E2E-Zielbild is labelled as Zielbild; today's state is
       server-side AES-256-GCM — no claim the server cannot see plaintext. -->
  <div class="vt-notice">
    <Icon name="shield" size={14} />
    <span>
      <b>Serverseitig verschlüsselt, jede Anzeige protokolliert:</b> Einträge liegen mit
      AES-256-GCM verschlüsselt im Tresor-Dienst und sind nur für Mitglieder der jeweiligen
      Einheit sichtbar. Ein Geheimnis liefert der Server erst nach frischer 2FA-Stufe-hoch aus;
      jeder Abruf landet im Zugriffsprotokoll. <b>Zielbild (#405):</b> Ende-zu-Ende — ver- und
      entschlüsselt nur auf deinem Gerät (Passkey/WebAuthn), Wiederherstellung im
      Vier-Augen-Quorum statt Betreiber-Reset.
    </span>
    <span class="vt-notice-marker">E2E-Zielbild (#405) · heute: serverseitig AES-256-GCM — Design-ahead</span>
  </div>

  {#if errorMsg}
    <p class="vt-error" role="alert">{errorMsg}</p>
  {/if}

  {#if units.length === 0}
    <div class="card vt-empty-state">
      <Icon name="lock" size={22} />
      <strong>Kein Fach für dich sichtbar</strong>
      <p>
        Der Tresor zeigt nur Einträge deiner eigenen Referate und Gremien. Sobald du Mitglied
        einer Einheit bist, erscheint hier ihr Fach.
      </p>
    </div>
  {/if}

  <div class="vt-cols">
    <div class="vt-main">
      <!-- v11 sign-off A6c: the lock card lives in the main grid column, so the
           Zugriffsprotokoll card top-aligns with it instead of floating detached
           at the bottom right of an otherwise empty grid. -->
      {#if locked && units.length > 0}
        <div class="card vt-lock">
          <div class="vt-lock-icon"><Icon name="lock" size={22} /></div>
          <div style="min-width: 0; flex: 1;">
            <h2>Tresor gesperrt</h2>
            <p>
              Geheimnisse liefert der Server erst nach einer frischen Zwei-Faktor-Bestätigung aus
              (Keycloak-Stufe-hoch, 5 Minuten gültig). Die Bestätigung läuft über deinen bestehenden
              Authenticator-Code — kein neues Geheimnis.
            </p>
            <div class="vt-lock-row">
              <a class="btn btn-primary" href={`/auth/step-up?returnTo=${encodeURIComponent('/vault')}`}>
                <Icon name="shield" size={13} /> Mit 2FA entsperren (Stufe hoch)
              </a>
            </div>
            <div class="vt-lock-hint">
              Auto-Sperre nach 5 Minuten. Entsperren per Geräte-Passkey (WebAuthn) und eine
              Tresor-Passphrase für neue Geräte sind geplant (E2E-Zielbild #405) — heute gibt es
              genau einen Weg: die 2FA-Stufe-hoch.
            </div>
          </div>
        </div>
      {/if}
      {#if !locked}
        {#each units as u (u.id)}
          {@const items = itemsByUnit.get(u.id) ?? []}
          <div class="card vt-unit">
            <div class="vt-unit-head">
              <span class="vt-tile" style="--c-hue: {u.hue};">{u.abbr}</span>
              <strong>{u.name}</strong>
              <span class="mono vt-count">{items.length} {items.length === 1 ? 'Eintrag' : 'Einträge'}</span>
            </div>
            {#if items.length === 0}
              <div class="vt-none">Noch keine Einträge — dieses Fach ist leer.</div>
            {/if}
            {#each items as item (item.id)}
              <div class="vt-row">
                <div class="vt-row-main">
                  <strong>
                    {item.name}
                    {#each data.handoverRefs[item.id] ?? [] as track (track)}
                      <a
                        class="pill vt-ho"
                        href="/handover"
                        title="Im Übergabe-Playbook referenziert — Zugriff überträgt sich per Rollen-Zuweisung"
                      >
                        <Icon name="key" size={9} /> Übergabe · {track}
                      </a>
                    {/each}
                  </strong>
                  <div class="vt-meta mono">
                    {item.username ? `${item.username} · ` : ''}angelegt {item.created}{item.createdByName
                      ? ` · ${item.createdByName}`
                      : ''}
                  </div>
                  {#if revealed[item.id]}
                    <div class="vt-secret">
                      <span class="mono">{revealed[item.id]}</span>
                      <button type="button" class="btn btn-sm" onclick={() => copy(item.id)}>
                        <Icon name="copy" size={11} /> {copied[item.id] ? 'Kopiert' : 'Kopieren'}
                      </button>
                      <Pill icon="checklist" title="Dieser Abruf steht im Zugriffsprotokoll.">Protokolliert</Pill>
                    </div>
                  {/if}
                </div>
                <div class="vt-row-acts">
                  {#if revealed[item.id]}
                    <button type="button" class="btn btn-sm" onclick={() => hide(item.id)}>
                      <Icon name="eye" size={12} /> Verbergen
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="btn btn-sm"
                      onclick={() => reveal(item.id)}
                      title="Jede Anzeige wird mit Akteur, Eintrag und Zeitpunkt protokolliert."
                    >
                      <Icon name="eye" size={12} /> Anzeigen
                    </button>
                  {/if}
                  <button
                    type="button"
                    class="btn btn-sm"
                    onclick={() => openEdit(item)}
                    title="Eintrag bearbeiten — das gespeicherte Geheimnis bleibt unverändert, solange kein neues gesetzt wird."
                  >
                    <Icon name="edit" size={12} /> Bearbeiten
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onclick={() => (deleteTarget = { id: item.id, name: item.name })}
                    title="Eintrag löschen"
                  >
                    <Icon name="x" size={12} /> Löschen
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>

    <div class="vt-side">
      <div class="card vt-log-card">
        <div class="vt-sec-head">
          <strong>Zugriffsprotokoll</strong>
          <span class="sp"></span>
          <span class="vt-log-tag">access_log · append-only</span>
        </div>
        {#if data.log.length === 0}
          <div class="vt-none">Noch keine Anzeigen protokolliert.</div>
        {/if}
        {#each data.log.slice(0, logVisible) as r (r.id)}
          <div class="vt-log-row">
            <span class="mono vt-log-ts">{r.ts}</span>
            <span class="vt-log-line"><b>{r.actor}</b> → {r.itemName}</span>
          </div>
        {/each}
        {#if data.log.length > logVisible}
          <button type="button" class="btn btn-sm" onclick={() => (logVisible += 8)}>
            Mehr anzeigen
          </button>
        {/if}
        <div class="vt-log-foot">
          Jeder Abruf speichert Akteur, Eintrag, Einheit und Zeitpunkt — append-only. Ein Abruf
          ohne Akteur wird abgelehnt, bevor Daten fließen.{data.isIT
            ? ' Als IT-Administration siehst du alle Einheiten.'
            : ''}
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Löschen — plain confirm dialog (repo ui/dialog pattern) -->
<Dialog open={deleteTarget !== null} onClose={() => (deleteTarget = null)}>
  <DialogHeader>
    <DialogTitle>Eintrag löschen</DialogTitle>
  </DialogHeader>
  <p class="vt-hint">
    „{deleteTarget?.name}" wird endgültig aus dem Fach entfernt. Das Zugriffsprotokoll bleibt
    erhalten.
  </p>
  <div class="flex gap-2 justify-end mt-1">
    <button type="button" class="btn" onclick={() => (deleteTarget = null)}>Abbrechen</button>
    <button type="button" class="btn btn-danger" disabled={deleting} onclick={confirmDelete}>
      {deleting ? 'Wird gelöscht…' : 'Löschen'}
    </button>
  </div>
</Dialog>

<!-- Eintrag anlegen (prototype VaultCreate, honest helper text) -->
<Dialog open={creating} onClose={() => (creating = false)}>
  <DialogHeader>
    <DialogTitle>Eintrag anlegen</DialogTitle>
  </DialogHeader>
  <form
    class="flex flex-col gap-2.5"
    onsubmit={(e) => {
      e.preventDefault()
      createItem()
    }}
  >
    <label class="vt-lbl" for="vt-ou">Org-Einheit</label>
    <Select id="vt-ou" bind:value={cOrgUnit} required>
      {#each data.units as u (u.id)}
        <option value={u.id}>{u.name}</option>
      {/each}
    </Select>

    <label class="vt-lbl" for="vt-name">Name</label>
    <Input id="vt-name" bind:value={cName} required maxlength={200} placeholder={`z. B. Postfach kultur@${brand.domain}`} />

    <label class="vt-lbl" for="vt-user">
      Benutzername <span style="font-weight: 400; color: var(--ink-faint);">· optional</span>
    </label>
    <Input id="vt-user" bind:value={cUsername} maxlength={200} placeholder="Konto- oder Anmeldename" />

    <label class="vt-lbl" for="vt-secret">Geheimnis</label>
    <div class="flex gap-2">
      <Input
        id="vt-secret"
        bind:value={cSecret}
        required
        type={cShowSecret ? 'text' : 'password'}
        placeholder="••••••••"
        class="flex-1 font-mono"
      />
      <button type="button" class="btn btn-sm" onclick={generate}>
        <Icon name="refresh" size={12} /> Generieren
      </button>
    </div>
    <p class="vt-hint">
      Wird serverseitig verschlüsselt gespeichert (AES-256-GCM; Verschlüsselung im Browser ist
      das E2E-Zielbild). Sichtbar für Mitglieder der Einheit; jeder spätere Abruf wird
      protokolliert.
    </p>

    {#if cError}
      <p class="vt-error" role="alert">{cError}</p>
    {/if}

    <div class="flex gap-2 justify-end mt-1">
      <button type="button" class="btn" onclick={() => (creating = false)}>Abbrechen</button>
      <button type="submit" class="btn btn-primary" disabled={submitting}>
        {submitting ? 'Wird gespeichert…' : 'Verschlüsselt speichern'}
      </button>
    </div>
  </form>
</Dialog>

<!-- Eintrag bearbeiten (PUT /api/vault/[id] — Metadaten vorausgefüllt, Geheimnis optional) -->
<Dialog open={editTarget !== null} onClose={() => (editTarget = null)}>
  <DialogHeader>
    <DialogTitle>Eintrag bearbeiten</DialogTitle>
  </DialogHeader>
  <form
    class="flex flex-col gap-2.5"
    onsubmit={(e) => {
      e.preventDefault()
      saveEdit()
    }}
  >
    <label class="vt-lbl" for="vt-e-ou">Org-Einheit</label>
    <Select id="vt-e-ou" bind:value={eOrgUnit} required>
      {#each data.units as u (u.id)}
        <option value={u.id}>{u.name}</option>
      {/each}
    </Select>

    <label class="vt-lbl" for="vt-e-name">Name</label>
    <Input id="vt-e-name" bind:value={eName} required maxlength={200} placeholder={`z. B. Postfach kultur@${brand.domain}`} />

    <label class="vt-lbl" for="vt-e-user">
      Benutzername <span style="font-weight: 400; color: var(--ink-faint);">· optional</span>
    </label>
    <Input id="vt-e-user" bind:value={eUsername} maxlength={200} placeholder="Konto- oder Anmeldename" />

    <label class="vt-lbl" for="vt-e-secret">
      Neues Geheimnis <span style="font-weight: 400; color: var(--ink-faint);">· optional</span>
    </label>
    <div class="flex gap-2">
      <Input
        id="vt-e-secret"
        bind:value={eSecret}
        type={eShowSecret ? 'text' : 'password'}
        placeholder="Leer lassen — Geheimnis bleibt unverändert"
        class="flex-1 font-mono"
      />
      <button type="button" class="btn btn-sm" onclick={eGenerate}>
        <Icon name="refresh" size={12} /> Generieren
      </button>
    </div>
    <p class="vt-hint">
      Das gespeicherte Geheimnis wird hier nie angezeigt. Bleibt das Feld leer, bleibt es
      unverändert; ein neues Geheimnis ersetzt das alte und wird serverseitig verschlüsselt
      gespeichert.
    </p>

    {#if eError}
      <p class="vt-error" role="alert">{eError}</p>
    {/if}

    <div class="flex gap-2 justify-end mt-1">
      <button type="button" class="btn" onclick={() => (editTarget = null)}>Abbrechen</button>
      <button type="submit" class="btn btn-primary" disabled={saving}>
        {saving ? 'Wird gespeichert…' : 'Speichern'}
      </button>
    </div>
  </form>
</Dialog>

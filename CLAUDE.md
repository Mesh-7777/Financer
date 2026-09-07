# Paisa Ledger — project context

A shared household expense ledger for ~6 people. Static frontend on GitHub
Pages, Google sign-in and data on Firebase. No server, no build step, free tier.

`README.md` is the human setup guide. This file is working context: how it is
put together, what must not break, and what has already been tried.

---

## Hard constraints — do not break these

**No build step, no bundler, no npm dependencies at runtime.** `index.html`
loads `app.js` as a native ES module; Firebase comes from the gstatic CDN as
pinned URLs. GitHub Pages serves the repo verbatim, so anything requiring
compilation will not run. If you are tempted to add React/Vite/TypeScript,
that changes the hosting story entirely — raise it, don't just do it.

**`firestore.rules` is the security boundary, not the UI.** The app hides
controls the user can't use; the rules are what actually stop them. Any change
to who-can-do-what happens in the rules first, and the UI follows. Never
"fix" a permission error by loosening a rule to make the UI work.

**Free tier is a design constraint.** Firebase Spark: 50k reads/day, 20k
writes/day, 1 GiB. No Cloud Functions (that needs Blaze + a card). Anything
proposed as a background job has to run client-side instead — see the ledger
purge for the pattern.

**Stay on Firestore Standard edition.** The free quotas above are Standard.
Enterprise edition is a different, paid product.

---

## Deployment

| | |
|---|---|
| Firebase project | `todo-fb-631fb` (reused from an older to-do app) |
| Firestore database | `(default)`, Standard edition, `asia-south1` |
| Hosting | GitHub Pages, repo root |
| Auth | Google provider only |

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Local dev — **must** be over http, ES modules don't load from `file://`:

```bash
python3 -m http.server 8000   # then http://localhost:8000
```

`localhost` and the Pages domain both need to be in Firebase → Authentication
→ Settings → Authorized domains.

**When you change any file, bump `VERSION` in `sw.js`** (`paisa-v1` →
`paisa-v2`). The service worker caches the app shell; without the bump users
keep running the old build and you will debug a fix that already shipped.

---

## Files

```
index.html          shell: boot/auth screen, masthead, tabs, empty <main>
app.js              everything — auth, data, permissions, views, writes
styles.css          design tokens (light + dark), all component CSS
firebase-config.js  public project config; committed on purpose, not a secret
firestore.rules     the permission model — the real one
firestore.indexes.json   one single-field collection-group index
sw.js               offline app shell
manifest.webmanifest, icons/   installable PWA
```

`app.js` is one file in labelled sections: constants → state → helpers →
auth → access gate → ledgers → recurring engine → derived numbers →
insights → render/views → sheets → events → writes → export → theme/boot.
Keep that order; it is navigable by section comment.

---

## Data model

```
/allowed/{email}                  invite-only allowlist. Doc ID *is* the
                                  lowercased email. {seed:true} on the one
                                  bootstrap account.
/config/app                       {openInvites: bool}
/users/{uid}                      profile mirror: name, email, photo

/ledgers/{lid}                    {name, ownerUid, settings:{budget,
                                   catBudgets, cats, incomeCats},
                                   deletedAt?, deletedBy?}
  /members/{uid}                  {uid, role: owner|editor|viewer, email,
                                   name, photo}   ← doc ID AND uid field
  /invites/{email}                {email, role}   ← doc ID is the email
  /entries/{id}                   {amt, type: expense|income, cat, method,
                                   note, date "YYYY-MM-DD", uid, rec?, u}
  /goals/{id}                     {name, target, saved, by, hist[], uid, u}
  /recur/{id}                     {name, amt, day, kind, cat, method,
                                   start "YYYY-MM", count, auto, uid, u}
```

Notes that matter:

- `date` is a **string**, not a Timestamp. It sorts lexicographically and
  every month/day calculation slices it. Don't "improve" this to a Timestamp without
  rewriting `stats()`, `insights()` and the recurring engine.
- `uid` on entries/goals/recur is the author, and the rules require it to
  equal the caller on create. It is what makes "edit only your own" work.
- Auto-posted recurring entries use the deterministic ID
  `r_<recurId>_<YYYY-MM>` so two devices can't double-post.
- `u` is a plain `Date.now()` millisecond number used for last-writer-wins.

---

## Permission model

| | read | add | edit/delete own | edit/delete others' | budgets, members |
|---|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ |
| editor ("can add") | ✅ | ✅ | ✅ | ❌ | ❌ |
| viewer ("view only") | ✅ | ❌ | ❌ | ❌ | ❌ |
| not a member | ❌ | ❌ | ❌ | ❌ | ❌ |

Invariants that must survive any refactor:

1. **Authorship cannot be forged** — every create requires
   `request.resource.data.uid == request.auth.uid`.
2. **A live ledger always has exactly one owner** — the owner's membership
   can't be deleted or demoted, *except* while the ledger is soft-deleted
   (the purge needs to remove it last).
3. **The seed account is not a superuser** — it governs `/allowed` and
   `/config` only. No rule anywhere grants it ledger access.
4. **Invite-only** — creating a ledger requires an `/allowed/{email}` doc.
   Creating an invite enrols the invitee, so the invite flow is the only door.

---

## Traps already hit — don't rediscover these

**Collection-group rules must test the field, not the path wildcard.**
This one cost real time. For a *query*, Firestore proves safety from the
query's filters alone; it cannot relate a `{docId}` wildcard to a
`where("uid","==",…)` field filter, so it denies the whole query. Correct:

```
match /{path=**}/members/{docId} {
  allow read: if signedIn() && resource.data.uid == request.auth.uid;
}
```

Symptom of getting it wrong: sign-in succeeds, then "Missing or insufficient
permissions" and the ledger switcher stuck on "Loading…".

**The `members`/`uid` index is a *single-field* index, not composite.**
It goes in `fieldOverrides`, and in the console under Indexes → **Single
field** → Add exemption → Collection group scope: Ascending. The composite
tab rejects it as "not necessary". A `fieldOverride` *replaces* the whole
index set for that field, so the two COLLECTION-scope entries in
`firestore.indexes.json` must stay or you switch off the automatic ones.

**Firestore does not cascade-delete.** Deleting a ledger doc strands every
document beneath it — unreachable (the rules can't resolve an owner) but
still billed for storage. Hence the soft-delete + purge in `deleteLedger` /
`purgeLedger`: mark `deletedAt`, keep 30 days, then delete children by name
with the ledger record **last**, and the owner's own membership second-last.

**The database must be named `(default)`.** `initializeFirestore(app, …)`
targets `(default)`; a named database silently isn't the one the app talks
to. The CLI also tries to *create* `(default)` if absent, which fails with a
misleading "billing required" error — create it in the console instead.

**`firebase-config.js` holds only the exported object.** The console's npm
snippet includes `import … from "firebase/app"`, which is a bare specifier
that dies without a bundler and leaves the boot spinner hanging forever.
Copy from the console's **Config** radio button, not **npm**.

**The Add form re-renders on every chip tap**, so typed input is kept in
`ui.draft` and written back into the `value` attributes. If you add a field
to that form, add it to `ui.draft` too or it will silently clear.

---

## Testing

There is no test suite. What was used during the build was a throwaway
in-memory stub of the Firebase SDK (`initializeApp`/`getAuth`/Firestore
verbs backed by a `Map`) plus a hand-written mirror of the rules, driven
through Playwright to simulate owner / editor / viewer accounts in one page.

That caught every write-side violation (forged authorship, cross-user edits,
privilege escalation) and **missed the read-side rule bug above**, because
the stub let all reads through. If you rebuild that harness, simulate reads
and queries too — that is where the remaining risk is.

The real tool for this is the Firestore emulator:

```bash
firebase emulators:start --only firestore
```

Worth wiring up properly if the rules get more complex.

---

## Backlog, roughly in priority order

1. **Rules unit tests** with `@firebase/rules-unit-testing` against the
   emulator. The permission model is the product; it deserves real tests.
2. **Gate `/users/{uid}` writes on the allowlist** so a signed-out-of-luck
   stranger creates literally nothing. One-line rules change.
3. **Entry pagination.** `app.js` subscribes to the most recent 2,000 entries
   (`limit(2000)`). Fine for a household for years; the fix when it isn't is
   month-scoped queries plus per-month aggregate docs, not a bigger limit.
4. **Goal contribution history** lives in an array on the goal doc. Thousands
   of contributions would approach the 1 MB document cap; move to a
   subcollection if it ever matters.
5. **PWA update prompt** — currently a `sw.js` version bump updates silently
   on next load. A "new version available, reload?" toast would be kinder.
6. **Offline conflict UX** — last-writer-wins is invisible today. Fine for
   one-person-per-entry use; worth surfacing if two people ever edit one
   entry.

---

## Style

Vanilla JS, no framework. Views are template-literal functions returning
HTML strings, re-rendered wholesale by `render()`; events are delegated from
one document-level click handler keyed on `data-*` attributes. It is
deliberately boring and greppable. Match it rather than modernising it.

All money is INR, formatted with `Intl.NumberFormat("en-IN")` via the
`money()` / `money2()` helpers — never raw `toFixed`.

CSS is design tokens on `:root` with a `prefers-color-scheme` block and a
`[data-theme]` block. Any new colour goes in the token set for both themes;
never a literal hex in a component rule.

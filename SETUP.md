# Paisa Ledger

A shared household expense ledger. Static frontend on GitHub Pages, Google
sign-in and data on Firebase. No server to run, no monthly bill.

- Each person's own ledger is private to them
- Share a ledger by email at one of two levels: **can add** or **view only**
- People who can add may edit or delete **only their own** entries
- The ledger owner can change anything, including other people's entries
- Works offline; entries queue on the device and upload when you're back on

Access is enforced by Firestore security rules on the server, not by the UI.
A modified client cannot read or write anything the rules don't allow.

---

## What it costs

Nothing, at household scale.

| | Free tier | A family of four uses roughly |
|---|---|---|
| Firestore storage | 1 GiB | ~2 MB after 5 years |
| Document reads | 50,000 / day | a few hundred |
| Document writes | 20,000 / day | tens |
| Firebase Auth | unlimited Google sign-ins | — |
| GitHub Pages | 1 GB site, 100 GB/month bandwidth | a few MB |

The Firebase **Spark** plan needs no credit card, and it cannot bill you —
if you somehow exceeded the free quota, requests fail for the day rather
than charging you.

---

## Setup

Takes about fifteen minutes, once.

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and **Add project**.
   Name it anything (`paisa-ledger`). Google Analytics is not needed — turn it off.
2. In the left sidebar: **Build → Authentication → Get started → Sign-in method**.
   Enable **Google**, pick a support email, save.
3. **Build → Firestore Database → Create database.**
   Choose **Production mode** (the rules in this repo replace the defaults),
   and pick the `asia-south1` (Mumbai) region for the lowest latency from India.
   *The region cannot be changed later.*

### 2. Register the web app and copy the config

1. Project settings (gear icon) → **General** → scroll to **Your apps** → the `</>` web icon.
2. Nickname it, **don't** tick Firebase Hosting, register.
3. Copy the `firebaseConfig` object it shows you into `firebase-config.js`
   in this repo, replacing the placeholders.

> These values are not secrets. Every visitor's browser downloads them.
> Your data is protected by Google sign-in plus `firestore.rules`, not by
> hiding this file. Committing it to a public repo is fine and expected.

### 3. Deploy the security rules

The rules are the whole permission model, so this step is not optional.

**Option A — paste them in (no tools needed):**
Firestore Database → **Rules** tab → replace everything with the contents of
`firestore.rules` → **Publish**.

Then Firestore → **Indexes** → **Add index**:
- Collection ID `members`, query scope **Collection group**, field `uid` Ascending.

(If you skip the index, the app will show a console error with a one-click
link to create it — that works too.)

**Option B — the CLI:**

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick your project
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Publish the site on GitHub

```bash
git init
git add .
git commit -m "Paisa Ledger"
git branch -M main
git remote add origin https://github.com/<you>/paisa-ledger.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch →
`main` / `/ (root)` → Save.** The URL will be
`https://<you>.github.io/paisa-ledger/`.

### 5. Authorise the domain

Back in Firebase: **Authentication → Settings → Authorized domains → Add domain**
→ `<you>.github.io`.

Without this, sign-in fails with `auth/unauthorized-domain`.

### 6. Seed yourself (the app is invite-only)

Nobody can start a ledger until their email is on the allowlist, and the
list starts empty — so create the first entry by hand:

Firestore → **Data** → **Start collection** `allowed` → document ID
**your Gmail address, lowercased** → one field:

| Field | Type | Value |
|---|---|---|
| `seed` | boolean | `true` |

That's the whole bootstrap. It is a door key, not a role: `seed` only
governs the allowlist itself and the app-wide switch. It grants no access
to anyone's ledgers — no rule anywhere makes an exception for it.

From then on the app manages itself: inviting someone into a ledger enrols
them automatically, and you get a **Who can use this app** panel under Data
to add or remove people directly.

That's it. Open the URL, sign in with Google, and your personal ledger is
created automatically.

---

## Using it

**Install it on a phone.** Open the URL → Share → *Add to Home Screen*. It
then launches full-screen like an app and opens with no connection.

**Invite someone.** *People* tab → their Google email → choose access →
**Create invite** → send them the link it generates. They open the link,
sign in with **that same** Google account, and they're in. An invite for
`sister@gmail.com` cannot be claimed by any other account.

**Keep books separate.** Tap the ledger name at the top to switch or create
another. A common setup is one private ledger for yourself and one shared
"Household" ledger — invite people only to the second.

**Change someone's access** any time from the People tab, or remove them.
Entries they already added stay in the ledger; the owner can delete those.

---

## Who can use the app, and who manages that

There is no global admin screen, by design. Management sits in three places:

**Accounts** are Google's. You never create, store, or reset a password.

**Who's in a ledger** is the ledger owner's call — invite by email, switch
between *Can add* and *View only*, remove. Removal takes effect on the next
read, since every rule checks membership live. Removing someone leaves their
entries in the ledger, attributed to them; the owner can delete those
individually. Losing three months of household spending because somebody left
would be the worse default.

**Who can use the app at all** is the allowlist. An email must have a doc
under `/allowed` before it can start a ledger; anyone else signs in, is told
to ask for an invite, and gets nothing — no ledger, no quota consumed.
Creating an invite enrols the invitee, so the invite flow is the only door in.

The seed account sees a **Who can use this app** panel with the full list,
an add box, and one switch:

- **Anyone can invite new people** *(default on)* — any ledger owner enrols
  the people they invite. Self-maintaining.
- **Off** — only the seed account enrols anyone new. Ledger owners can still
  invite people already on the list. Tighter, but every new person goes
  through you.

### One thing to be honest with your family about

You own the Firebase project, and **the Firebase console bypasses security
rules entirely** — that is how it works for a project owner. So you can read
every document in the database, including a private ledger you were never
invited to.

That is inherent to hosting it, not something this app adds, and it would be
equally true on your own server. The rules protect people from each other,
not from whoever runs the database. Tell them rather than let them assume
otherwise. If someone wants real privacy from you, they can run their own
copy — fifteen minutes, their own free project, and then you are the one who
cannot see in.

---

## How the permissions actually work

`firestore.rules` is the source of truth. In summary, for every entry, goal
and recurring item in a ledger:

| | read | add | edit/delete own | edit/delete others' | budgets & members |
|---|---|---|---|---|---|
| **owner** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **can add** (editor) | ✅ | ✅ | ✅ | ❌ | ❌ |
| **view only** (viewer) | ✅ | ❌ | ❌ | ❌ | ❌ |
| not a member | ❌ | ❌ | ❌ | ❌ | ❌ |

Two details worth knowing:

- **Creating an entry as someone else is impossible.** The rules require
  `uid == request.auth.uid` on every create, so an entry's author can't be forged.
- **The owner can't be demoted or removed**, including by themselves — a
  ledger always has exactly one owner. Anyone else can leave whenever they like.
- **The seed account is not a superuser.** It can edit the allowlist and the
  app switch, nothing else. It cannot read a ledger it isn't a member of.

### Testing the rules

Worth doing once, before real data goes in:

```bash
firebase emulators:start --only firestore
```

Or the low-tech version: sign in as a second Google account with viewer
access and confirm the Add tab is read-only and the console rejects writes.

---

## Files

```
index.html              app shell
app.js                  everything: auth, data, views, permissions
styles.css              design tokens, light + dark
firebase-config.js      your project's public config — you fill this in
firestore.rules         the permission model (deploy this!)
firestore.indexes.json  the one composite index the app needs
firebase.json           so the CLI knows what to deploy
manifest.webmanifest    installable-app metadata
sw.js                   offline app shell
icons/                  home-screen icons
```

## Offline behaviour

Two independent layers:

1. **The app shell** (`sw.js`) — HTML, CSS, JS and the Firebase SDK are cached
   on first visit, so the app opens with no connection.
2. **Your data** — Firestore's IndexedDB cache holds everything you've loaded.
   Entries added offline are written locally and sync the moment you're back on.
   The dot in the header shows which state you're in.

If two people edit the same entry while offline, the later write wins. For a
household ledger where people add their own entries, that effectively never
comes up.

## Deleting a ledger

Firestore does not cascade-delete: removing a ledger document would leave
every entry underneath it stranded in the database — invisible, unreachable,
and still counted against your storage. So the app does it in stages
instead, with no server involved.

1. **Delete** marks the ledger `deletedAt: <today>`. It vanishes from
   everyone's switcher immediately, and the security rules stop non-owners
   reading it at all. Nothing is destroyed yet.
2. For the next **30 days** the owner sees it under *Data → Recently deleted*
   with **Restore** (it comes back untouched, entries and all) and
   **Clear now** (purge it immediately).
3. Once 30 days pass, the next time the owner opens the app it is purged for
   real — entries, goals, EMIs, invites and memberships deleted by name, then
   the ledger record last, so the rules can still resolve its owner while the
   rest is being cleared.

The owner is the only one who can purge, and the only one who sees it
waiting, so nothing rots quietly. If you want a copy first, export before
you delete — after the purge it is genuinely gone.

## Limits, honestly

- The app keeps the **most recent 2,000 entries** loaded. That's years for a
  household; beyond it, older months won't appear in History. Raise the
  `limit(2000)` in `app.js` if you ever get there.
- Goal contributions live in an array on the goal document. Thousands of
  contributions to one goal would eventually hit Firestore's 1 MB document
  limit. Not a real risk at monthly cadence.

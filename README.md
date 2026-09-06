# Criterion Amazing College — Attendance PWA (multi-device edition)

A geofenced, fingerprint/face-verified sign in/out system. Every teacher can
now use **their own phone** — everyone reads and writes the same shared
attendance record via a small backend, instead of one shared kiosk device.

## What it does

- **Geofencing on the real perimeter fence** — sign in/out are disabled
  unless the device's GPS places you inside the school's actual surveyed
  boundary (loaded from `Criterion_perimeter_fence.kml`). A small adjustable
  buffer (default 25m) absorbs normal GPS drift. This is checked **twice**:
  instantly on the phone for UI feedback, and again on the server for every
  submitted sign-in/out — the server check is the one that actually counts,
  since phones aren't school-controlled hardware anymore.
- **"You can now sign in/out" alert** — the moment a phone's location
  crosses into the perimeter, the app shows an on-screen alert (plus a
  notification/vibration if permitted).
- **Biometric verification, per person's own phone** — each teacher
  registers their own fingerprint/Face ID once, on their own device, via
  WebAuthn. That credential only ever works on that device (the private key
  never leaves it) — nobody else can sign someone in using their name.
- **Secure self-enrollment** — since there's no single kiosk an admin
  controls anymore, a teacher can't just pick anyone's name and register a
  fingerprint against it. Each staff member gets a one-time 6-digit code
  from the admin; they enter their Staff ID + that code on their own phone
  once, which unlocks the fingerprint/face registration step. The code is
  single-use and expires after 90 days if unused.
- **Shared, centralized records** — staff list, settings, and every
  attendance log now live in one Postgres database on Render, so the admin
  dashboard (from any device) sees everyone's sign-ins together, not just
  whoever's phone you're holding.
- **Late/early flagging**, **admin dashboard** (PIN-protected, staff/records/
  settings), **CSV export**, **installable PWA** — same as before.

## Architecture

```
Teacher's phone  ──┐
Teacher's phone  ──┼──►  Render Web Service (Express, server.js)  ──►  Render Postgres
Admin's device   ──┘         serves public/ (the PWA) + REST API
```

- `public/` — the frontend (same PWA, now calling the API instead of local
  IndexedDB).
- `server.js` — Express app: serves the frontend and the `/api/*` routes.
- `db.js` — Postgres connection, schema creation, first-run seeding.
- `geofence.js` — the perimeter-fence math, run server-side as the
  authoritative check.
- `seed-staff.json` — the initial staff roster (from `Staff_List.docx`).

Nothing is stored in the browser anymore except a temporary admin login
token (cleared when the tab/app is closed) — if a phone is lost, there's no
attendance data sitting on it.

## Deploying to Render + Neon

This needs a **Web Service** on Render plus a **Postgres database on Neon**
(neon.tech — free tier, and unlike Render's own free Postgres, Neon's free
tier doesn't expire after 90 days).

**1. Create the Neon database:**
1. Sign up at [neon.tech](https://neon.tech), create a new project.
2. On the project dashboard, copy the **connection string** (it looks like
   `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`).

**2. Deploy the web service on Render:**

*Option A — Blueprint:*
1. Push this folder to a GitHub/GitLab repo.
2. In Render: **New → Blueprint**, point it at the repo. It reads
   `render.yaml` and creates the web service, prompting you to paste in
   `DATABASE_URL` (your Neon connection string) during setup.

*Option B — Manual:*
1. **New → Web Service**, connect this repo.
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment → Add Environment Variable:** `DATABASE_URL` = your Neon
     connection string (paste it exactly, including `?sslmode=require`).
2. Deploy.

The server auto-detects Neon's connection string and enables SSL for you —
no extra config needed. Open the resulting `https://your-app.onrender.com`
URL once it's live.

> Why Neon instead of Render's own Postgres: Render's free Postgres tier
> expires after 90 days and needs recreating; Neon's free tier doesn't have
> that limit (it does have its own limits — storage cap and auto-suspend
> after inactivity — worth checking Neon's current free-tier terms if this
> becomes a long-term production deployment).

## First-time setup

1. **Open the URL on any phone**, add it to the home screen (Chrome: menu →
   "Add to Home screen"; Safari: Share → "Add to Home Screen").
2. **Set the admin PIN.** Tap the gear icon (top right) — the *first*
   PIN anyone enters becomes the admin PIN from then on. Do this yourself
   first, before handing the link to anyone else.
3. **Check the perimeter fence.** In Settings, the fence is already loaded
   from the survey. Walk around the compound with **"Test this device
   against the fence"** and nudge the GPS buffer if needed.
4. **Set resumption/closing time** in the same tab.
5. **Get everyone enrolled:**
   - The 18 names from `Staff_List.docx` are already seeded, each with a
     one-time enrollment code sitting in the Staff tab, waiting to be
     shared.
   - Go to the **Staff tab**, tap **"Get Code"** next to each person, and
     share their Staff ID + code with them (WhatsApp, printed slip,
     whatever's easiest).
   - Each teacher opens the app link on **their own phone**, taps
     **"New here or new phone? Register your fingerprint"** on the home
     screen, enters their Staff ID + code, then registers their own
     fingerprint/face right there.
   - Use **"+ Add Staff"** for anyone not on the original list.
6. Staff can now **Sign In / Sign Out** from their own phone, any time
   they're on-site.

## If someone gets a new phone, or loses one

Go to Staff tab → **"Reset Device"** next to their name. This clears their
old fingerprint registration and issues a fresh code — they self-enroll
again on the new device, exactly like the first time.

## Known limitations (worth knowing before you rely on this)

- **The WebAuthn ceremony isn't cryptographically re-verified by the
  server.** The server trusts that if a phone's browser reports "the
  fingerprint/face matched," it's genuine (this matches how the original
  single-kiosk version worked too). A stronger version of this would have
  the server independently verify the cryptographic signature on every
  sign-in (a "relying party" implementation) — a real hardening step worth
  doing before this is used for anything with legal or payroll
  consequences, but a materially bigger build than what's here now. Happy
  to add it if that matters for your use case.
- **The fence shape is fixed in code** (`SCHOOL_PERIMETER` in both
  `public/app.js` and `geofence.js`) — baked in from the KML survey. If the
  school's boundary changes, both copies need updating with new
  coordinates; there's no in-app map editor.
- **GPS accuracy indoors** can drift 10–30m. Test with real staff near the
  boundary before relying on a tight buffer.
- **Free Render Postgres expires after 90 days** — not applicable now that
  you're using Neon, which doesn't have that specific limit (check Neon's
  current free-tier terms for its own limits — storage cap, auto-suspend
  after inactivity).
- **Admin sessions are in-memory** — if the server restarts (free-tier
  services also spin down after inactivity), the admin just re-enters the
  PIN; nothing else is affected.

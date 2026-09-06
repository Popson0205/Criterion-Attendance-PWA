# Criterion Amazing College — Attendance PWA

A geofenced sign in/out system. Every teacher uses **their own phone** —
everyone reads and writes the same shared attendance record via a small
backend, instead of one shared kiosk device.

## What it does

- **Two separate pages, cleanly split:**
  - `/` — the staff-facing app. Clock, live boundary map, name dropdown,
    Sign In/Sign Out. **No admin UI of any kind lives here** — no gear
    icon, no hidden PIN screen, nothing.
  - `/admin` — a completely separate page: PIN login, then Records (view/
    filter/download CSV), Staff (add/remove), Settings (school name,
    times, geofence buffer, change PIN).
- **Geofencing on the real perimeter fence** — sign in/out are disabled
  unless the device's GPS places you inside the school's actual surveyed
  boundary (loaded from `Criterion_perimeter_fence.kml`). A small adjustable
  buffer (default 25m) absorbs normal GPS drift. Checked both instantly on
  the phone (for UI feedback) and again on the server for every submitted
  sign-in/out — the server check is the one that actually counts.
- **Live boundary map** — the home screen shows an embedded map (Leaflet +
  OpenStreetMap, no API key needed) with the fence outlined in green and a
  dot for your current position, updating live, colored by inside/outside.
- **Simple sign-in, with real protection against "signing in for a friend":**
  a teacher picks their name from a dropdown (Staff ID fills in
  automatically), enters their 4-digit PIN, then taps Sign In or Sign Out.
  The *first* phone that ever uses the correct PIN for a given name gets
  permanently bound to that name — after that, both the right PIN **and**
  that same phone are required. Someone can't just pick a colleague's name
  on their own phone anymore, even if they somehow knew the PIN.
- **Shared, centralized records** — staff list, settings, and every
  attendance log live in one Postgres database (Neon), so `/admin` sees
  everyone's sign-ins together, from any device.
- **Late/early flagging**, **CSV download of the full attendance list**,
  **add/remove staff and reset PINs from `/admin`**, **installable PWA**
  (staff side only).

### How the PIN + device-binding actually works

- When admin adds a staff member (or resets someone's PIN), the system
  generates a random 4-digit PIN and shows it **once** — admin shares it
  with that person however's convenient (WhatsApp, a printed slip, etc.).
  It's stored only as a hash from then on; nobody, including admin, can
  look it up again — only reset it.
- The first time that PIN is used successfully on a phone, that phone's
  browser generates a random ID (stored in `localStorage`, so it survives
  closing the app) and the server permanently ties it to that staff
  member.
- From then on, sign-in requires **both** the correct PIN **and** a
  request coming from that same bound phone. A different phone gets
  rejected even with the right PIN.
- **Lost or replaced phone:** admin → Staff tab → "Reset PIN" for that
  person. This clears the old binding and issues a new PIN — they enter it
  once on their new phone, which becomes the new bound device.
- **What this still doesn't stop:** someone handing over their own already
  signed-in, unlocked phone and PIN to a colleague deliberately. No
  software-only system can fully prevent that; at that point it's a
  policy/trust question, same as it would be with a physical sign-in
  sheet.

## Architecture

```
Teacher's phone (/)      ──┐
Admin's device (/admin)  ──┼──►  Render Web Service (Express, server.js)  ──►  Neon Postgres
```

- `public/index.html` + `public/app.js` — staff-facing page. No admin code
  at all in this bundle.
- `public/admin.html` + `public/admin.js` — admin page. PIN-gated, entirely
  separate script, only loaded when someone visits `/admin`.
- `public/common.js` — small shared helpers (fetch wrapper, formatting,
  screen switching) used by both pages.
- `server.js` — Express app: serves both pages plus the `/api/*` routes,
  and explicitly routes `/admin` to `admin.html`.
- `db.js` — Postgres connection, schema creation, first-run seeding.
- `geofence.js` — the perimeter-fence math, run server-side as the
  authoritative check.
- `seed-staff.json` — the initial staff roster (from `Staff_List.docx`).
- `public/sw.js` — the staff page's offline service worker. It explicitly
  excludes `/api/*` and everything under `/admin` from caching, so admin
  never sees a stale version and attendance data is always live.

Nothing is stored in the browser except a temporary admin login token
(cleared when the admin tab is closed).

## Deploying to Render + Neon

**1. Create the Neon database:**
1. Sign up at [neon.tech](https://neon.tech), create a new project.
2. Copy the **connection string** from the project dashboard (looks like
   `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`).

**2. Deploy the web service on Render:**

*Option A — Blueprint:*
1. Push this folder to a GitHub/GitLab repo.
2. Render: **New → Blueprint** → point it at the repo → it reads
   `render.yaml` and prompts you to paste in `DATABASE_URL` (your Neon
   connection string).

*Option B — Manual:*
1. **New → Web Service**, connect this repo.
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment variable:** `DATABASE_URL` = your Neon connection string.
2. Deploy.

The server auto-detects Neon's connection string and enables SSL — no
extra config needed. Open the resulting `https://your-app.onrender.com` URL.

## First-time setup

1. **Open the URL on any phone**, add it to the home screen.
2. **Set the admin PIN.** Go to `https://your-app.onrender.com/admin` — the
   *first* PIN anyone enters there becomes the admin PIN. Do this yourself
   first, and don't share the `/admin` link with staff.
3. **Check the perimeter fence.** In `/admin` → Settings, the fence is
   already loaded from the survey — the map on the staff home screen shows
   it too. Walk the compound with **"Test this device against the fence"**
   and adjust the GPS buffer if needed.
4. **Set resumption/closing time** in the same tab.
5. **Staff list is already seeded** from `Staff_List.docx`, but **none of
   them have a PIN yet** (they were added before this feature existed).
   Go to `/admin` → Staff tab → tap **"Set PIN"** next to each name, and
   share the generated PIN with that person (WhatsApp, printed slip,
   whatever's easiest). Do this for all seeded staff before telling them
   to start using the app.
6. Share the **main URL** (`/`, not `/admin`) with staff. They pick their
   name, enter the PIN you gave them, and tap Sign In — the first time
   only, this also locks their name to that phone.

## Admin day-to-day

Go to `/admin`, enter the PIN.

- **Add a new staff member:** Staff tab → "+ Add Staff" → name, Staff ID,
  role → a PIN is generated and shown once — share it with them.
- **Someone forgot their PIN or got a new phone:** Staff tab → "Reset PIN"
  next to their name → share the new PIN with them. Their old device is
  automatically un-bound; the next phone that uses the new PIN becomes the
  new bound device.
- **Remove someone:** Staff tab → Remove next to their name (their past
  attendance records are kept).
- **View today's/any day's attendance:** Records tab, filter by date and/or
  staff member.
- **Download the attendance list:** Records tab → "⬇ Download Attendance
  (CSV)".

## Known limitations (worth knowing before you rely on this)

- **`/admin` isn't secret, only PIN-protected** — the URL itself has a
  `noindex` tag so search engines won't list it, but anyone who guesses or
  is told the URL can reach the PIN screen (they still need the correct
  PIN to get past it). Don't treat the URL as a secret on its own.
- **Device binding relies on `localStorage`, which clears if someone clears
  their browser data** (or uses private/incognito mode every time). If
  that happens, the next sign-in attempt will look like a "new device" to
  the server and get rejected until admin resets that person's PIN. This
  is rare in normal day-to-day phone use but worth knowing.
- **See "what this still doesn't stop" above** — deliberate PIN/phone
  sharing between colleagues isn't something any software-only system can
  fully prevent.
- **The fence shape is fixed in code** (`SCHOOL_PERIMETER` in both
  `public/app.js` and `geofence.js`) — baked in from the KML survey. If the
  boundary changes, both copies need updating with new coordinates.
- **GPS accuracy indoors** can drift 10–30m — test with real staff near the
  boundary before relying on a tight buffer.
- **Admin sessions are in-memory** — if the server restarts (free-tier
  services spin down after inactivity), the admin just re-enters the PIN.
- **Neon's free tier** has its own limits (storage cap, auto-suspend after
  inactivity) — check Neon's current terms if this becomes a long-term
  production deployment.

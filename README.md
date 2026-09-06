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
- **Simple sign-in** — pick your name from a dropdown (Staff ID fills in
  automatically), tap Sign In or Sign Out. No fingerprint step.
- **Shared, centralized records** — staff list, settings, and every
  attendance log live in one Postgres database (Neon), so `/admin` sees
  everyone's sign-ins together, from any device.
- **Late/early flagging**, **CSV download of the full attendance list**,
  **add/remove staff from `/admin`**, **installable PWA** (staff side only).

> **Trade-off worth knowing:** dropping the fingerprint step means sign-in
> relies entirely on "this phone is inside the fence" rather than "this is
> provably that specific person." Anyone standing inside the fence with
> access to the app could pick someone else's name from the dropdown. If
> that risk matters for your use case (e.g. payroll depends on this data),
> the fix is re-adding a lightweight per-person check — even just a short
> PIN per staff member — without bringing back fingerprint/enrollment-code
> complexity. Say the word if you want it.

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
5. **Staff list is already seeded** from `Staff_List.docx`. Use **"+ Add
   Staff"** in `/admin` → Staff tab for anyone new — they'll appear in the
   dropdown on every phone within a moment (or after they reopen the app).
6. Share the **main URL** (`/`, not `/admin`) with staff. They pick their
   name and tap Sign In / Sign Out whenever they're inside the fence.

## Admin day-to-day

Go to `/admin`, enter the PIN.

- **Add a new staff member:** Staff tab → "+ Add Staff" → name, Staff ID,
  role. They show up in the dropdown immediately.
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
- **No per-person verification beyond the geofence** — see the trade-off
  note above. This is the main thing to weigh before treating this data as
  authoritative for pay or discipline.
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

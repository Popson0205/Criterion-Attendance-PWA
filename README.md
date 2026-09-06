# Criterion Amazing College — Attendance PWA

A geofenced sign in/out system. Every teacher uses **their own phone** —
everyone reads and writes the same shared attendance record via a small
backend, instead of one shared kiosk device.

## What it does

- **Geofencing on the real perimeter fence** — sign in/out are disabled
  unless the device's GPS places you inside the school's actual surveyed
  boundary (loaded from `Criterion_perimeter_fence.kml`). A small adjustable
  buffer (default 25m) absorbs normal GPS drift. This is checked **twice**:
  instantly on the phone for UI feedback, and again on the server for every
  submitted sign-in/out — the server check is the one that actually counts.
- **Live boundary map** — the home screen shows an embedded map (Leaflet +
  OpenStreetMap, no API key needed) with the fence outlined in green and a
  dot for your current position, so you can see exactly where you stand
  relative to the line before signing in or out. The dot turns green/red
  depending on whether you're inside.
- **Simple sign-in** — a teacher picks their name from a dropdown (their
  Staff ID fills in automatically), then taps Sign In or Sign Out. No
  fingerprint step, no per-device setup — the geofence is what gates it.
- **Shared, centralized records** — staff list, settings, and every
  attendance log live in one Postgres database (Neon), so the admin
  dashboard sees everyone's sign-ins together, from any device.
- **Late/early flagging**, **admin dashboard** (PIN-protected: Records /
  Staff / Settings), **CSV download of the full attendance list**,
  **add/remove staff from the dashboard**, **installable PWA**.

> **Trade-off worth knowing:** dropping the fingerprint step means sign-in
> relies entirely on "this phone is inside the fence" rather than "this is
> provably that specific person." Anyone standing inside the fence with
> access to the app could pick someone else's name from the dropdown. If
> that risk matters for your use case (e.g. payroll depends on this data),
> the fix is re-adding a lightweight per-person check — even just a short
> PIN per staff member — and I can build that back in without bringing back
> the fingerprint/enrollment-code complexity. Say the word if you want it.

## Architecture

```
Teacher's phone  ──┐
Teacher's phone  ──┼──►  Render Web Service (Express, server.js)  ──►  Neon Postgres
Admin's device   ──┘         serves public/ (the PWA) + REST API
```

- `public/` — the frontend (dropdown sign-in, live map, admin dashboard).
- `server.js` — Express app: serves the frontend and the `/api/*` routes.
- `db.js` — Postgres connection, schema creation, first-run seeding.
- `geofence.js` — the perimeter-fence math, run server-side as the
  authoritative check.
- `seed-staff.json` — the initial staff roster (from `Staff_List.docx`).

Nothing is stored in the browser except a temporary admin login token
(cleared when the tab/app is closed).

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
2. **Set the admin PIN.** Tap the gear icon (top right) — the *first* PIN
   anyone enters becomes the admin PIN. Do this yourself first.
3. **Check the perimeter fence.** In Settings, the fence is already loaded
   from the survey — the map on the home screen shows it too. Walk the
   compound with **"Test this device against the fence"** and adjust the
   GPS buffer if needed.
4. **Set resumption/closing time** in the same tab.
5. **Staff list is already seeded** from `Staff_List.docx`. Use **"+ Add
   Staff"** in the Staff tab for anyone new — they'll appear in the
   dropdown on every phone within a moment (or after they reopen the app).
6. Anyone can now **open the link on their own phone**, pick their name,
   and tap Sign In / Sign Out whenever they're inside the fence.

## Admin day-to-day

- **Add a new staff member:** Admin → Staff tab → "+ Add Staff" → name,
  Staff ID, role. They show up in the dropdown immediately.
- **Remove someone:** Staff tab → Remove next to their name (their past
  attendance records are kept).
- **Download the attendance list:** Admin → Records tab → filter by date
  and/or staff member → "⬇ Download Attendance (CSV)".

## Known limitations (worth knowing before you rely on this)

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

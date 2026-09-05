# Criterion Amazing College — Attendance PWA

A geofenced, fingerprint-verified sign in / sign out app for staff, branded for
Criterion Amazing College, Osogbo.

## How it's meant to be used

This is a **kiosk app**: install it on one shared device (a tablet or phone)
mounted at the school entrance/gate. Each staff member enrolls their own
fingerprint or face on that device once; from then on they walk up, pick
their name, and confirm with their fingerprint. It is **not** meant to be
installed on each teacher's personal phone, because:

- Fingerprint/face data never leaves the device — that's exactly what makes
  it trustworthy, but it also means a credential registered on one phone
  won't work on another.
- A shared kiosk gives you one clean, tamper-resistant record of everyone's
  actual arrival time in one place.

If you'd eventually like staff to sign in from their own personal phones,
that needs a small backend server (see "Scaling beyond one device" below).

## What it does

- **Geofencing on the real perimeter fence** — sign in/out are disabled
  unless the device's GPS places you inside the school's actual surveyed
  boundary (loaded from `Criterion_perimeter_fence.kml`), not just a rough
  circle. A small adjustable buffer (default 25m) absorbs normal GPS drift
  near the fence line.
- **"You can now sign in/out" alert** — the moment a staff member's device
  crosses into the perimeter, the app shows an on-screen alert (and a
  browser notification/vibration if permitted). Outside the fence, the
  Sign In / Sign Out buttons stay disabled — there's no way to sign in or
  out from off-site.
- **Biometric verification** — uses the device's built-in fingerprint/Face ID
  sensor via the WebAuthn standard, scoped per staff member, so someone can't
  sign in on another person's behalf without physically having their
  registered finger/face present on the device.
- **Staff list pre-loaded** — the 2026/2027 working team from `Staff_List.docx`
  is built into the app, so the roster is already there on first load. Each
  person still needs to register their own fingerprint/face once on the
  kiosk device (biometric data can't be pre-loaded — it has to be captured
  live from that person). The Staff tab flags anyone who hasn't done this
  yet with a "Needs fingerprint enrollment" badge and an **Enroll** button.
- **Late/early flagging** — set a resumption time and closing time; the app
  automatically tags each sign-in as "late" or sign-out as "early."
- **Admin dashboard** (PIN-protected) — enroll/remove staff, complete
  fingerprint enrollment for pre-loaded staff, browse and filter attendance
  records by date/staff, export to CSV, and configure the fence buffer,
  resumption/closing times, and admin PIN.
- **Installable PWA** — add to home screen, works full-screen, caches its
  shell for quick loads.

## Setting it up

1. **Host the files** (see "Deploying to Render" below, or any static host).
   WebAuthn (fingerprint/face) and precise geolocation both require a real
   secure origin — either `https://` or `localhost`. Render, GitHub Pages,
   Netlify, and Vercel all give you `https://` automatically.
2. **Open it on the kiosk device** and add it to the home screen
   (Chrome: menu → "Add to Home screen"; Safari: Share → "Add to Home Screen")
   so it opens full-screen like a native app.
3. **Check the perimeter fence.** Tap the gear icon (top right) — first
   time, it will ask you to set an admin PIN (pick anything 4–8 digits, and
   remember it). Go to Settings → the fence boundary is already loaded from
   the survey; tap **"Test this device against the fence"** while standing
   at different points around the compound to confirm it reads correctly,
   and nudge the GPS tolerance buffer up a little if it's too strict right
   at the gate.
4. **Set resumption/closing time** in the same Settings tab so late/early
   flags are accurate.
5. **Complete staff fingerprint enrollment.** Go to the Staff tab — everyone
   from the working team list is already there. For each person, tap
   **Enroll** next to their name and have them register their own
   fingerprint/face right there on the device. Use **"+ Enroll New Staff"**
   only for someone who isn't on the list yet.
6. Staff can now use **Sign In / Sign Out** from the home screen — the
   buttons unlock automatically as soon as they're inside the fence.

## Deploying to Render

This app is fully static (no backend, no build step) — Render's free
**Static Site** service is enough.

**Option A — Blueprint (one click):**
1. Push this `attendance-pwa` folder to a GitHub/GitLab repo (it can be the
   whole repo root, or a subfolder — see note below).
2. In Render, click **New → Blueprint**, point it at the repo. Render will
   read `render.yaml` and create the static site automatically.
3. If `attendance-pwa` is a *subfolder* of your repo rather than the repo
   root, edit the generated service's **Publish Directory** to
   `attendance-pwa` (the `render.yaml` included here assumes it's already
   the repo root).

**Option B — Manual:**
1. In Render, click **New → Static Site** and connect your repo.
2. **Build Command:** leave blank (or `echo "no build"`).
3. **Publish Directory:** `.` if this folder is the repo root, or
   `attendance-pwa` if it's nested.
4. Deploy. Render gives you a `https://your-app.onrender.com` URL — open
   that on the kiosk device and add it to the home screen.

Because everything is stored locally on the kiosk device (IndexedDB), the
Render site is just serving static files — there's nothing to configure
server-side, and no database to provision.

## Data and privacy

- All data (staff list, attendance logs, settings) is stored locally on the
  kiosk device using IndexedDB — nothing is sent to any server, including
  Anthropic's. Fingerprint/face data itself never leaves the device's secure
  hardware at all — the app only ever receives a cryptographic yes/no signal
  from WebAuthn, never the actual biometric.
- Because it's local to the device, **back up the device** and avoid
  clearing browser data/site storage for the app, or attendance history will
  be lost. For anything beyond a single kiosk, move to the backend version
  below, which is safer for records you can't afford to lose.

## Known limitations

- **One device = one source of truth.** If you want multiple entrances or
  staff signing in from personal phones, this version's local storage won't
  sync between devices.
- **WebAuthn support varies by device.** Most phones from the last ~5 years
  (Android with fingerprint/face unlock, iPhones with Face ID/Touch ID) work
  well in Chrome/Safari. Very old or budget devices without a biometric
  sensor won't support it — the app will tell staff clearly if that's the
  case rather than failing silently.
- **GPS accuracy indoors** can drift by 10–30m depending on the device and
  building. Test the fence with a couple of real staff members near the
  boundary before rolling it out, and raise the buffer a little rather than
  leaving it razor-thin.
- **The fence shape is fixed in code.** It's baked in from
  `Criterion_perimeter_fence.kml` as a set of coordinates in `app.js`
  (`SCHOOL_PERIMETER`). If the school's boundary ever changes (new gate,
  extended land), that constant needs updating with a new KML/coordinate
  export — there's no in-app map editor for it yet.

## Scaling beyond one device

If the school later wants: multiple entry points, staff signing in from
their own phones, or an admin dashboard viewable from the office without
touching the kiosk — that requires a small backend (e.g. a database +
API) so all devices read/write the same records instead of local storage.
The screens, geofencing logic, and WebAuthn flow in this app carry over
directly; only the storage layer would change. Happy to help build that
phase whenever you're ready.

## Files

```
attendance-pwa/
├── index.html      screens & markup
├── styles.css       school-branded styling
├── app.js           all logic: IndexedDB, geofencing, WebAuthn, UI
├── manifest.json     PWA install config
├── sw.js             offline shell caching
├── icons/            app icons generated from the school crest
└── README.md
```

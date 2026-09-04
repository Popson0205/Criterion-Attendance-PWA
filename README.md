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

- **Geofencing** — sign in/out buttons are disabled unless the device's GPS
  says you're inside the school compound (a center point + radius you set).
- **Biometric verification** — uses the device's built-in fingerprint/Face ID
  sensor via the WebAuthn standard, scoped per staff member, so someone can't
  sign in on another person's behalf without physically having their
  registered finger/face present on the device.
- **Late/early flagging** — set a resumption time and closing time; the app
  automatically tags each sign-in as "late" or sign-out as "early."
- **Admin dashboard** (PIN-protected) — enroll/remove staff, browse and
  filter attendance records by date/staff, export to CSV, and configure the
  geofence, resumption/closing times, and admin PIN.
- **Installable PWA** — add to home screen, works full-screen, caches its
  shell for quick loads.

## Setting it up

1. **Host the files.** WebAuthn (fingerprint/face) and precise geolocation
   both require a real secure origin — either `https://` or `localhost`.
   Free options: GitHub Pages, Netlify, Vercel, or your own web hosting.
   Just upload the whole `attendance-pwa` folder as-is (no build step).
2. **Open it on the kiosk device** and add it to the home screen
   (Chrome: menu → "Add to Home screen"; Safari: Share → "Add to Home Screen")
   so it opens full-screen like a native app.
3. **Set the geofence.** Tap the gear icon (top right) — first time, it will
   ask you to set an admin PIN (pick anything 4–8 digits, and remember it).
   Go to Settings, stand at the school gate, tap **"Set to my current
   location,"** choose a radius (start with 100–150m and adjust after
   testing), then **Save Settings**.
4. **Set resumption/closing time** in the same Settings tab so late/early
   flags are accurate.
5. **Enroll staff.** Go to the Staff tab → "Enroll New Staff." Each staff
   member should be the one to enter their details and register their own
   fingerprint/face, right there on the device.
6. Staff can now use **Sign In / Sign Out** from the home screen.

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
  building. Test the geofence radius with a couple of real staff members
  before rolling it out, and widen it a bit rather than making it razor-thin.

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

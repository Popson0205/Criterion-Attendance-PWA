/* ===================================================================
   Criterion Amazing College — Attendance PWA (staff-facing app)
   Sign in/out via name dropdown, gated by the live perimeter-fence
   geofence. All admin functionality lives entirely at /admin (admin.js)
   — this file has no admin code, no PIN gate, nothing hidden here.
   Relies on common.js being loaded first.
=================================================================== */

/* Surveyed school perimeter fence (same data as geofence.js on the
   server) — used here for instant UI feedback. The server independently
   re-checks this on every sign-in/out, since that's the authoritative
   check now that phones aren't school-controlled kiosk hardware. */
const SCHOOL_PERIMETER = [
  [7.831456071231706, 4.576847563576805],
  [7.831413785775986, 4.577172593085352],
  [7.832362344414676, 4.577344858839034],
  [7.832324496979382, 4.57696277909487]
];

const DEFAULT_SETTINGS = {
  schoolName: 'Criterion Amazing College',
  resumeTime: '08:00',
  closeTime: '15:00',
  geofenceBufferM: 25
};

let state = {
  settings: { ...DEFAULT_SETTINGS },
  staff: [],
  geo: { status: 'checking', lat: null, lng: null, distance: null },
  watchId: null
};

/* ---------------------- Polygon geofence ---------------------- */

function toLocalMeters(lat, lng, originLat) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(originLat * Math.PI / 180);
  return { x: lng * mPerDegLng, y: lat * mPerDegLat };
}
function polygonCentroid(poly) {
  const lat = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const lng = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return { lat, lng };
}
function pointInPolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1];
    const yj = poly[j][0], xj = poly[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointToSegmentDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx, cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}
function distanceToPolygonMeters(lat, lng, poly) {
  const origin = polygonCentroid(poly).lat;
  const p = toLocalMeters(lat, lng, origin);
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = toLocalMeters(poly[i][0], poly[i][1], origin);
    const b = toLocalMeters(poly[j][0], poly[j][1], origin);
    min = Math.min(min, pointToSegmentDist(p, a, b));
  }
  return min;
}
function evaluatePerimeter(lat, lng, bufferM) {
  const strictlyInside = pointInPolygon(lat, lng, SCHOOL_PERIMETER);
  const dist = distanceToPolygonMeters(lat, lng, SCHOOL_PERIMETER);
  const inside = strictlyInside || dist <= bufferM;
  return { inside, distance: strictlyInside ? 0 : dist };
}

function setGeoUI(status, text) {
  const pill = $('#geoStatus');
  pill.className = 'geo-pill geo-' + status;
  $('#geoStatusText').textContent = text;
  updateSignButtons();
}

/* ---------------------- Live boundary map (Leaflet, no API key) ---------------------- */

let fenceMap = null;
let fenceMarker = null;

function initFenceMap() {
  if (typeof L === 'undefined') return; // Leaflet failed to load (e.g. offline first load) — map just stays blank
  const center = polygonCentroid(SCHOOL_PERIMETER);
  fenceMap = L.map('fenceMap', { zoomControl: false, attributionControl: true, dragging: true, scrollWheelZoom: false })
    .setView([center.lat, center.lng], 19);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(fenceMap);
  const polygon = L.polygon(SCHOOL_PERIMETER, {
    color: '#0B3D24', weight: 2, fillColor: '#2E7D46', fillOpacity: 0.15
  }).addTo(fenceMap);
  fenceMap.fitBounds(polygon.getBounds(), { padding: [24, 24] });
  setTimeout(() => fenceMap && fenceMap.invalidateSize(), 250);
}

function updateFenceMap(lat, lng, inside) {
  if (!fenceMap) return;
  const color = inside ? '#1E8E3E' : '#C62828';
  if (!fenceMarker) {
    fenceMarker = L.circleMarker([lat, lng], {
      radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1
    }).addTo(fenceMap);
  } else {
    fenceMarker.setLatLng([lat, lng]);
    fenceMarker.setStyle({ fillColor: color });
  }
}

function evaluateGeofence(lat, lng) {
  const bufferM = state.settings.geofenceBufferM ?? DEFAULT_SETTINGS.geofenceBufferM;
  const { inside, distance } = evaluatePerimeter(lat, lng, bufferM);
  const prevStatus = state.geo.status;
  state.geo = { status: inside ? 'inside' : 'outside', lat, lng, distance };

  updateFenceMap(lat, lng, inside);

  if (inside) {
    setGeoUI('inside', 'You are within the school perimeter fence.');
    if (prevStatus !== 'inside') announceEnteredPerimeter();
  } else {
    setGeoUI('outside', `You're about ${Math.round(distance)}m from the school perimeter fence — move inside it to sign in or out.`);
  }
}

function announceEnteredPerimeter() {
  toast('✅ You are now within the school perimeter — you can sign in or sign out.', 4000);
  if ('vibrate' in navigator) { try { navigator.vibrate([60, 40, 60]); } catch (_) {} }
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(state.settings.schoolName, {
        body: 'You can now sign in or sign out — you\u2019re inside the school perimeter.',
        icon: 'icons/icon-192.png'
      });
    } catch (_) {}
  }
}

function startGeoWatch() {
  if (!('geolocation' in navigator)) {
    setGeoUI('outside', 'This device does not support location services.');
    return;
  }
  setGeoUI('checking', 'Checking your location…');
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => evaluateGeofence(pos.coords.latitude, pos.coords.longitude),
    (err) => {
      let msg = 'Could not read your location.';
      if (err.code === err.PERMISSION_DENIED) msg = 'Location access denied — enable it in your browser/device settings to sign in.';
      setGeoUI('outside', msg);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

/* ---------------------- Clock ---------------------- */

function tickClock() {
  const now = new Date();
  $('#clockTime').textContent = fmtTime(now);
  $('#clockDate').textContent = fmtDateLong(now);
}

/* ---------------------- Staff select + direct sign in/out ---------------------- */

async function loadStaffList() {
  state.staff = await api('/api/staff');
  populateStaffSelect();
}

function populateStaffSelect() {
  const select = $('#staffSelect');
  const current = select.value;
  const sorted = [...state.staff].sort((a, b) => a.name.localeCompare(b.name));
  select.innerHTML = '<option value="">Select your name…</option>' +
    sorted.map(s => `<option value="${escapeHtml(s.staffId)}">${escapeHtml(s.name)}</option>`).join('');
  if (sorted.some(s => s.staffId === current)) select.value = current;
  updateSignButtons();
}

function updateSignButtons() {
  const hasStaff = !!$('#staffSelect').value;
  const inFence = state.geo.status === 'inside';
  $('#btnSignIn').disabled = !(hasStaff && inFence);
  $('#btnSignOut').disabled = !(hasStaff && inFence);
}

$('#staffSelect').addEventListener('change', (e) => {
  const s = state.staff.find(x => x.staffId === e.target.value);
  $('#staffIdDisplay').value = s ? s.staffId : '';
  updateSignButtons();
});

$('#btnSignIn').addEventListener('click', () => attemptSignAction('in'));
$('#btnSignOut').addEventListener('click', () => attemptSignAction('out'));

async function attemptSignAction(type) {
  const staffId = $('#staffSelect').value;
  const staffMember = state.staff.find(s => s.staffId === staffId);
  if (!staffMember) { toast('Please select your name first.'); return; }
  if (state.geo.status !== 'inside') { toast('You need to be inside the school perimeter to sign in or out.'); return; }

  $('#btnSignIn').disabled = true;
  $('#btnSignOut').disabled = true;
  try {
    const record = await api('/api/attendance', {
      method: 'POST',
      body: JSON.stringify({ staffId: staffMember.staffId, type, lat: state.geo.lat, lng: state.geo.lng })
    });
    showResult(record);
    $('#staffSelect').value = '';
    $('#staffIdDisplay').value = '';
  } catch (err) {
    if (err.status === 403) {
      toast(err.message);
      startGeoWatch();
    } else {
      toast(err.message || 'Could not record attendance — check your connection and try again.');
    }
  } finally {
    updateSignButtons();
  }
}

function showResult(record) {
  const icon = $('#resultIcon');
  const badge = $('#resultBadge');
  icon.className = 'result-icon';
  icon.textContent = '✓';
  $('#resultTitle').textContent = record.type === 'in' ? 'Signed in' : 'Signed out';
  $('#resultSub').textContent = `Welcome, ${record.name.split(' ')[0]}`;
  $('#resultTime').textContent = fmtTime(new Date(record.timestamp));

  if (record.status === 'late') {
    badge.hidden = false; badge.className = 'result-badge'; badge.textContent = 'LATE ARRIVAL';
  } else if (record.status === 'early') {
    badge.hidden = false; badge.className = 'result-badge'; badge.textContent = 'LEFT EARLY';
  } else {
    badge.hidden = false; badge.className = 'result-badge ontime';
    badge.textContent = record.type === 'in' ? 'ON TIME' : 'ON SCHEDULE';
  }
  showScreen('result');
}

/* ---------------------- Today's log (public view) ---------------------- */

async function renderTodayLog() {
  const list = $('#todayLogList');
  list.innerHTML = '';
  try {
    const rows = await api('/api/logs/today');
    $('#todayLogEmpty').hidden = rows.length !== 0;
    rows.forEach(r => list.appendChild(buildLogRow(r)));
  } catch (err) {
    $('#todayLogEmpty').hidden = false;
    $('#todayLogEmpty').textContent = 'Could not load today\u2019s log — check your connection.';
  }
}

$('#btnTodayLog').addEventListener('click', async () => {
  showScreen('todaylog');
  await renderTodayLog();
});

/* ---------------------- Service worker ---------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------------------- Init ---------------------- */

async function init() {
  try {
    state.settings = { ...DEFAULT_SETTINGS, ...(await api('/api/settings/public')) };
  } catch (_) {
    toast('Could not reach the server — check your connection.');
  }
  try {
    await loadStaffList();
  } catch (_) { toast('Could not load staff list — check your connection.'); }

  $('.topbar-school').textContent = state.settings.schoolName.toUpperCase();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  tickClock();
  setInterval(tickClock, 1000 * 30);
  setInterval(() => { const c = $('#clockTime'); if (c) c.textContent = fmtTime(new Date()); }, 1000);

  initFenceMap();
  startGeoWatch();
  showScreen('home');

  // Refresh the staff list when the tab/app regains focus, so a name added
  // by the admin shows up without needing a full reload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadStaffList().catch(() => {});
  });
}

init();

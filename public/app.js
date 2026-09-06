/* ===================================================================
   Criterion Amazing College — Attendance PWA (multi-device edition)
   Vanilla JS. All data (staff, settings, attendance logs) now lives on
   the shared backend (Postgres via server.js) instead of per-device
   IndexedDB, so every teacher can use their own phone and everything
   shows up together on the admin dashboard.
   Geofencing and WebAuthn (fingerprint/face) still run locally on each
   device — that part doesn't need a server round trip.
=================================================================== */

/* ---------------------- API helper ---------------------- */

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.adminToken) headers['Authorization'] = `Bearer ${state.adminToken}`;
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

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
  watchId: null,
  adminToken: sessionStorage.getItem('cac_admin_token') || null
};

/* ---------------------- Utility ---------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

// Delegated, defensive modal-close handling — attached immediately so a
// Cancel/backdrop tap or Escape keypress always closes the Add Staff
// modal even if something later in this file throws.
function closeEnrollModal() {
  const modal = document.getElementById('modalEnroll');
  if (modal) modal.hidden = true;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnEnrollCancel')) { closeEnrollModal(); return; }
  if (e.target.id === 'modalEnroll') { closeEnrollModal(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeEnrollModal();
});

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');
}

function dateKeyOf(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtTime(d) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function fmtDateLong(d) {
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

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
  // Container may be measured before layout settles (fonts/webfont swap) — nudge Leaflet to re-check size.
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

function getOneShotPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
  });
}

/* ---------------------- Navigation ---------------------- */

function showScreen(id) {
  $all('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
}
$all('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
});

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

function buildLogRow(r) {
  const row = document.createElement('div');
  row.className = 'log-row';
  const flag = r.status === 'late' ? 'LATE' : r.status === 'early' ? 'EARLY' : '';
  row.innerHTML = `
    <span class="log-type-tag ${r.type}">${r.type === 'in' ? 'IN' : 'OUT'}</span>
    <span class="log-row-text">
      <span class="log-row-name">${escapeHtml(r.name)}</span>
      <span class="log-row-meta">${escapeHtml(r.staffId)}</span>
    </span>
    <span class="log-row-time">
      <strong>${fmtTime(new Date(r.timestamp))}</strong>
      ${flag ? `<span>${flag}</span>` : ''}
    </span>`;
  return row;
}

$('#btnTodayLog').addEventListener('click', async () => {
  showScreen('todaylog');
  await renderTodayLog();
});

/* ---------------------- Admin PIN gate ---------------------- */

$('#adminEntry').addEventListener('click', () => {
  $('#pinInput').value = '';
  $('#pinError').hidden = true;
  $('#pinFirstRunNote').hidden = true; // server tells us after attempting login
  showScreen('pin');
  setTimeout(() => $('#pinInput').focus(), 200);
});

$('#btnPinGo').addEventListener('click', submitPin);
$('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

async function submitPin() {
  const val = $('#pinInput').value.trim();
  if (val.length < 4) {
    $('#pinError').textContent = 'PIN must be at least 4 digits.';
    $('#pinError').hidden = false;
    return;
  }
  try {
    const res = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ pin: val }) });
    state.adminToken = res.token;
    sessionStorage.setItem('cac_admin_token', res.token);
    if (res.firstRun) toast('Admin PIN set.');
    enterAdmin();
  } catch (err) {
    $('#pinError').textContent = err.message || 'Incorrect PIN. Try again.';
    $('#pinError').hidden = false;
  }
}

function enterAdmin() {
  showScreen('admin');
  renderAdminAll();
}

/* ---------------------- Admin tabs ---------------------- */

$all('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $all('.admin-tab').forEach(t => t.classList.remove('active'));
    $all('.admin-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

async function renderAdminAll() {
  await renderRecordsTab();
  await renderStaffTab();
  await renderSettingsTab();
}

function handleAdminAuthError(err) {
  if (err && err.status === 401) {
    state.adminToken = null;
    sessionStorage.removeItem('cac_admin_token');
    toast('Your admin session expired — please log in again.');
    showScreen('pin');
    return true;
  }
  return false;
}

/* --- Records tab --- */

async function renderRecordsTab() {
  const dateInput = $('#recordDate');
  if (!dateInput.value) dateInput.value = dateKeyOf(new Date());

  const staffFilter = $('#recordStaffFilter');
  staffFilter.innerHTML = '<option value="">All staff</option>' +
    state.staff.map(s => `<option value="${escapeHtml(s.staffId)}">${escapeHtml(s.name)}</option>`).join('');

  await refreshRecordsList();
}

async function refreshRecordsList() {
  const date = $('#recordDate').value;
  const staffId = $('#recordStaffFilter').value;
  let rows = [];
  try {
    const qs = new URLSearchParams();
    if (date) qs.set('date', date);
    if (staffId) qs.set('staffId', staffId);
    rows = await api(`/api/admin/logs?${qs.toString()}`);
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    toast('Could not load records.');
  }

  const lateCount = rows.filter(r => r.status === 'late').length;
  $('#recordsSummary').textContent = `${rows.length} record${rows.length === 1 ? '' : 's'} · ${lateCount} late arrival${lateCount === 1 ? '' : 's'}`;

  const list = $('#recordsList');
  list.innerHTML = '';
  $('#recordsEmpty').hidden = rows.length !== 0;
  rows.forEach(r => list.appendChild(buildLogRow(r)));
}

$('#recordDate').addEventListener('change', refreshRecordsList);
$('#recordStaffFilter').addEventListener('change', refreshRecordsList);

$('#btnExportCsv').addEventListener('click', async () => {
  const date = $('#recordDate').value;
  const staffId = $('#recordStaffFilter').value;
  let rows;
  try {
    const qs = new URLSearchParams();
    if (date) qs.set('date', date);
    if (staffId) qs.set('staffId', staffId);
    rows = await api(`/api/admin/logs?${qs.toString()}`);
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    toast('Could not export — check your connection.');
    return;
  }
  if (!rows.length) { toast('No records to export.'); return; }

  rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const header = ['Staff ID', 'Name', 'Role', 'Type', 'Date', 'Time', 'Status', 'Distance from fence (m)'];
  const csvRows = rows.map(r => {
    const d = new Date(r.timestamp);
    return [r.staffId, r.name, r.role, r.type === 'in' ? 'Sign In' : 'Sign Out', r.dateKey, fmtTime(d), r.status, r.distance]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  const csv = [header.join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance_${date || 'all'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

/* --- Staff tab --- */

async function renderStaffTab() {
  let list;
  try {
    state.staff = await api('/api/admin/staff');
    list = state.staff;
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    toast('Could not load staff list.');
    return;
  }

  const container = $('#staffAdminList');
  container.innerHTML = '';
  [...list].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
    const row = document.createElement('div');
    row.className = 'staff-admin-row';
    row.innerHTML = `
      <span class="staff-avatar">${initials(s.name)}</span>
      <span class="staff-row-text">
        <span class="staff-row-name">${escapeHtml(s.name)}</span>
        <span class="staff-row-id">${escapeHtml(s.staffId)} · ${escapeHtml(s.role)}</span>
      </span>
      <button class="remove-staff-btn" data-id="${escapeHtml(s.staffId)}">Remove</button>`;

    row.querySelector('.remove-staff-btn').addEventListener('click', async () => {
      if (!confirm(`Remove ${s.name} from the staff list? Their past attendance records will be kept.`)) return;
      try {
        await api(`/api/admin/staff/${encodeURIComponent(s.staffId)}`, { method: 'DELETE' });
        toast('Staff removed.');
        renderStaffTab();
        renderRecordsTab();
        loadStaffList();
      } catch (err) {
        if (!handleAdminAuthError(err)) toast('Could not remove staff member.');
      }
    });

    container.appendChild(row);
  });
}

function openEnrollModal() {
  $('#enrollName').value = '';
  $('#enrollId').value = '';
  $('#enrollRole').value = 'Teaching Staff';
  $('#enrollError').hidden = true;
  $('#modalEnrollTitle').textContent = 'Add Staff';
  $('#modalEnroll').hidden = false;
}

$('#btnAddStaff').addEventListener('click', openEnrollModal);

$('#btnEnrollFingerprint').addEventListener('click', async () => {
  const name = $('#enrollName').value.trim();
  const staffId = $('#enrollId').value.trim();
  const role = $('#enrollRole').value;
  const errEl = $('#enrollError');
  errEl.hidden = true;

  if (!name || !staffId) {
    errEl.textContent = 'Please enter both name and staff ID.';
    errEl.hidden = false;
    return;
  }
  try {
    await api('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({ staffId, name, role })
    });
    toast(`${name} added.`);
    closeEnrollModal();
    await renderStaffTab();
    await loadStaffList();
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    errEl.textContent = err.message || 'Could not add staff member.';
    errEl.hidden = false;
  }
});

/* --- Settings tab --- */

async function renderSettingsTab() {
  let s;
  try {
    s = await api('/api/admin/settings');
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    toast('Could not load settings.');
    return;
  }
  $('#setSchoolName').value = s.schoolName;
  $('#setResumeTime').value = s.resumeTime;
  $('#setCloseTime').value = s.closeTime;
  $('#setBuffer').value = s.geofenceBufferM;
  $('#bufferVal').textContent = s.geofenceBufferM;
  $('#setNewPin').value = '';
  $('#settingsSaved').hidden = true;
  $('#geofenceCurrent').textContent =
    `Perimeter fence loaded from survey · ${SCHOOL_PERIMETER.length} boundary points · Criterion Amazing College, Osogbo.`;
  $('#geofenceTestResult').textContent = '';
}

$('#setBuffer').addEventListener('input', (e) => { $('#bufferVal').textContent = e.target.value; });

$('#btnTestGeofence').addEventListener('click', async () => {
  const btn = $('#btnTestGeofence');
  const out = $('#geofenceTestResult');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const pos = await getOneShotPosition();
    const bufferM = parseInt($('#setBuffer').value, 10);
    const { inside, distance } = evaluatePerimeter(pos.coords.latitude, pos.coords.longitude, bufferM);
    out.textContent = inside
      ? '✅ This device is currently inside the perimeter fence.'
      : `⚠️ This device is currently about ${Math.round(distance)}m outside the perimeter fence.`;
  } catch {
    out.textContent = 'Could not read location. Check location permissions.';
  } finally {
    btn.disabled = false;
    btn.textContent = '📍 Test this device against the fence';
  }
});

$('#btnSaveSettings').addEventListener('click', async () => {
  const payload = {
    schoolName: $('#setSchoolName').value.trim() || DEFAULT_SETTINGS.schoolName,
    resumeTime: $('#setResumeTime').value || DEFAULT_SETTINGS.resumeTime,
    closeTime: $('#setCloseTime').value || DEFAULT_SETTINGS.closeTime,
    geofenceBufferM: parseInt($('#setBuffer').value, 10)
  };
  const newPin = $('#setNewPin').value.trim();
  if (newPin) {
    if (newPin.length < 4) { toast('New PIN must be at least 4 digits.'); return; }
    payload.newPin = newPin;
  }
  try {
    const updated = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = { ...state.settings, ...updated };
    $('.topbar-school').textContent = state.settings.schoolName.toUpperCase();
    $('#settingsSaved').hidden = false;
    toast(newPin ? 'Settings and admin PIN updated.' : 'Settings saved.');
    startGeoWatch();
  } catch (err) {
    if (!handleAdminAuthError(err)) toast(err.message || 'Could not save settings.');
  }
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
  // by the admin on another phone shows up without needing a full reload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadStaffList().catch(() => {});
  });
}

init();

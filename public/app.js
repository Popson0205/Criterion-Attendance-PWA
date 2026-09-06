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
  pendingAction: null,     // 'in' | 'out'
  pendingStaff: null,
  watchId: null,
  adminToken: sessionStorage.getItem('cac_admin_token') || null,
  selfEnroll: { staffId: null, name: null, role: null, enrollToken: null }
};

/* ---------------------- Utility ---------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

let enrollTargetStaff = null; // reserved (unused in the API-backed flow, kept for clarity)

// Delegated, defensive modal-close handling — attached immediately so a
// Cancel/backdrop tap or Escape keypress always closes the Add Staff
// modal even if something later in this file throws.
function closeEnrollModal() {
  const modal = document.getElementById('modalEnroll');
  if (modal) modal.hidden = true;
  $('#addStaffForm').hidden = false;
  $('#addStaffCodePanel').hidden = true;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnEnrollCancel') || e.target.closest('#btnAddStaffDone')) { closeEnrollModal(); return; }
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

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64ToBuf(b64) {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
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
  const ready = status === 'inside';
  $('#btnSignIn').disabled = !ready;
  $('#btnSignOut').disabled = !ready;
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

/* ---------------------- Staff picker (Sign In / Out) ---------------------- */

async function loadStaffList() {
  state.staff = await api('/api/staff');
}

function renderStaffPicker(filter = '') {
  const list = $('#staffList');
  const q = filter.trim().toLowerCase();
  const items = state.staff.filter(s =>
    !q || s.name.toLowerCase().includes(q) || s.staffId.toLowerCase().includes(q)
  ).sort((a, b) => a.name.localeCompare(b.name));

  list.innerHTML = '';
  $('#pickerEmpty').hidden = items.length !== 0;

  items.forEach(s => {
    const row = document.createElement('button');
    row.className = 'staff-row';
    row.innerHTML = `
      <span class="staff-avatar">${initials(s.name)}</span>
      <span class="staff-row-text">
        <span class="staff-row-name">${escapeHtml(s.name)}</span>
        <span class="staff-row-id">${escapeHtml(s.staffId)} · ${escapeHtml(s.role)}${!s.hasCredential ? ' · fingerprint not set up' : ''}</span>
      </span>`;
    row.addEventListener('click', () => {
      if (!s.hasCredential) {
        toast(`${s.name.split(' ')[0]} hasn't registered a fingerprint/face yet. Use "Register your fingerprint" on the home screen with your Staff ID and admin code.`, 4500);
        return;
      }
      openVerify(s);
    });
    list.appendChild(row);
  });
}

$('#btnSignIn').addEventListener('click', async () => {
  state.pendingAction = 'in';
  $('#pickerTitle').textContent = 'Sign In';
  await refreshPicker();
});
$('#btnSignOut').addEventListener('click', async () => {
  state.pendingAction = 'out';
  $('#pickerTitle').textContent = 'Sign Out';
  await refreshPicker();
});
async function refreshPicker() {
  try {
    await loadStaffList();
  } catch (err) {
    toast('Could not load staff list — check your connection.');
  }
  renderStaffPicker('');
  $('#staffSearch').value = '';
  showScreen('picker');
}
$('#staffSearch').addEventListener('input', (e) => renderStaffPicker(e.target.value));

/* ---------------------- Verify (WebAuthn) — sign in/out ---------------------- */

function openVerify(staffMember) {
  state.pendingStaff = staffMember;
  $('#verifyAvatar').textContent = initials(staffMember.name);
  $('#verifyName').textContent = staffMember.name;
  $('#verifyRole').textContent = `${staffMember.staffId} · ${staffMember.role}`;
  $('#verifyHint').textContent = 'Tap below and use your fingerprint or face to confirm it\u2019s you.';
  $('#fpIcon').parentElement.className = 'fp-ring';
  $('#btnVerify').disabled = false;
  $('#btnVerify').textContent = 'Use Fingerprint / Face';
  showScreen('verify');
}

$('#btnVerify').addEventListener('click', async () => {
  const staffMember = state.pendingStaff;
  if (!staffMember) return;

  if (state.geo.status !== 'inside') {
    toast('You have left the school perimeter — move back inside to continue.');
    showScreen('home');
    return;
  }

  const ring = $('#fpIcon').parentElement;
  ring.className = 'fp-ring busy';
  $('#btnVerify').disabled = true;
  $('#btnVerify').textContent = 'Waiting for fingerprint / face…';

  try {
    if (!('credentials' in navigator) || !window.PublicKeyCredential) {
      throw new Error('unsupported');
    }
    const cred = await api(`/api/staff/${encodeURIComponent(staffMember.staffId)}/credential`);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: [{
          id: b64ToBuf(cred.credentialId),
          type: 'public-key',
          transports: ['internal']
        }]
      }
    });
    if (!assertion) throw new Error('cancelled');

    ring.className = 'fp-ring ok';
    await recordAttendance(staffMember, state.pendingAction);
  } catch (err) {
    ring.className = 'fp-ring fail';
    $('#btnVerify').disabled = false;
    $('#btnVerify').textContent = 'Try Again';
    if (err && err.message === 'unsupported') {
      $('#verifyHint').textContent = 'This device/browser does not support fingerprint or face verification. Try a recent phone browser (Chrome/Safari) with a fingerprint or face sensor enabled.';
    } else if (err && err.status === 404) {
      $('#verifyHint').textContent = 'No fingerprint/face is registered for this staff ID on any device yet.';
    } else {
      $('#verifyHint').textContent = 'That didn\u2019t match, or was cancelled. Please try again with your registered fingerprint or face.';
    }
  }
});

/* ---------------------- Attendance recording ---------------------- */

async function recordAttendance(staffMember, type) {
  try {
    const record = await api('/api/attendance', {
      method: 'POST',
      body: JSON.stringify({ staffId: staffMember.staffId, type, lat: state.geo.lat, lng: state.geo.lng })
    });
    showResult(record);
  } catch (err) {
    if (err.status === 403) {
      toast(err.message);
      showScreen('home');
      startGeoWatch();
    } else {
      $('#verifyHint').textContent = err.message || 'Could not record attendance — check your connection and try again.';
      $('#fpIcon').parentElement.className = 'fp-ring fail';
      $('#btnVerify').disabled = false;
      $('#btnVerify').textContent = 'Try Again';
    }
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

/* ---------------------- Self-enrollment (staff, own phone) ---------------------- */

$('#btnGoSelfEnroll').addEventListener('click', () => {
  $('#selfEnrollId').value = '';
  $('#selfEnrollCode').value = '';
  $('#selfEnrollError').hidden = true;
  $('#selfEnrollStep1').hidden = false;
  $('#selfEnrollStep2').hidden = true;
  showScreen('selfenroll');
});

$('#btnSelfEnrollVerify').addEventListener('click', async () => {
  const staffId = $('#selfEnrollId').value.trim();
  const code = $('#selfEnrollCode').value.trim();
  const errEl = $('#selfEnrollError');
  errEl.hidden = true;
  if (!staffId || code.length < 4) {
    errEl.textContent = 'Enter your Staff ID and the code your admin gave you.';
    errEl.hidden = false;
    return;
  }
  try {
    const res = await api(`/api/staff/${encodeURIComponent(staffId)}/self-enroll/start`, {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    state.selfEnroll = { staffId, name: res.name, role: res.role, enrollToken: res.enrollToken };
    $('#selfEnrollAvatar').textContent = initials(res.name);
    $('#selfEnrollName').textContent = res.name;
    $('#selfEnrollHint').textContent = 'Tap below and use your fingerprint or face.';
    $('#selfEnrollStep1').hidden = true;
    $('#selfEnrollStep2').hidden = false;
  } catch (err) {
    errEl.textContent = err.message || 'Could not verify code.';
    errEl.hidden = false;
  }
});

$('#btnSelfEnrollFingerprint').addEventListener('click', async () => {
  const { staffId, name, role, enrollToken } = state.selfEnroll;
  if (!staffId || !enrollToken) return;
  const btn = $('#btnSelfEnrollFingerprint');
  btn.disabled = true;
  btn.textContent = 'Waiting for fingerprint / face…';

  try {
    if (!window.PublicKeyCredential) throw new Error('unsupported');
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: state.settings.schoolName, id: location.hostname },
        user: { id: userId, name: staffId, displayName: name },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
        timeout: 60000,
        attestation: 'none'
      }
    });
    if (!cred) throw new Error('cancelled');

    await api(`/api/staff/${encodeURIComponent(staffId)}/credential`, {
      method: 'POST',
      body: JSON.stringify({
        credentialId: bufToB64(cred.rawId),
        userHandle: bufToB64(userId),
        enrollToken
      })
    });

    toast(`You're all set, ${name.split(' ')[0]} — you can sign in below whenever you're on-site.`, 4200);
    showScreen('home');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Try Again';
    if (err && err.message === 'unsupported') {
      $('#selfEnrollHint').textContent = 'This device/browser does not support fingerprint or face registration.';
    } else {
      $('#selfEnrollHint').textContent = err.message || 'That didn\u2019t work, or was cancelled. Please try again.';
    }
  }
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
    const codeActive = s.enrollCode && s.enrollCodeExpires && new Date(s.enrollCodeExpires) > new Date();
    row.innerHTML = `
      <span class="staff-avatar">${initials(s.name)}</span>
      <span class="staff-row-text">
        <span class="staff-row-name">${escapeHtml(s.name)}</span>
        <span class="staff-row-id">${escapeHtml(s.staffId)} · ${escapeHtml(s.role)}</span>
        ${!s.hasCredential ? '<span class="enroll-needed-badge">Needs fingerprint enrollment</span>' : ''}
        ${codeActive ? `<div class="staff-code-row">Code: <span class="staff-code-value">${escapeHtml(s.enrollCode)}</span></div>` : ''}
      </span>
      <span class="staff-row-actions">
        ${!s.hasCredential ? `<button class="mini-btn regen-code-btn" data-id="${escapeHtml(s.staffId)}">${codeActive ? 'New Code' : 'Get Code'}</button>` : `<button class="mini-btn reset-device-btn" data-id="${escapeHtml(s.staffId)}">Reset Device</button>`}
        <button class="remove-staff-btn" data-id="${escapeHtml(s.staffId)}">Remove</button>
      </span>`;

    const regenBtn = row.querySelector('.regen-code-btn');
    if (regenBtn) regenBtn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/staff/${encodeURIComponent(s.staffId)}/regenerate-code`, { method: 'POST' });
        toast('New code generated.');
        renderStaffTab();
      } catch (err) {
        if (!handleAdminAuthError(err)) toast('Could not generate a code.');
      }
    });

    const resetBtn = row.querySelector('.reset-device-btn');
    if (resetBtn) resetBtn.addEventListener('click', async () => {
      if (!confirm(`Reset ${s.name}'s registered device? They'll need to self-enroll again with a new code (use this if their phone was lost or replaced).`)) return;
      try {
        await api(`/api/admin/staff/${encodeURIComponent(s.staffId)}/reset-device`, { method: 'POST' });
        toast('Device reset — a new code has been generated.');
        renderStaffTab();
      } catch (err) {
        if (!handleAdminAuthError(err)) toast('Could not reset device.');
      }
    });

    row.querySelector('.remove-staff-btn').addEventListener('click', async () => {
      if (!confirm(`Remove ${s.name} from the staff list? Their past attendance records will be kept.`)) return;
      try {
        await api(`/api/admin/staff/${encodeURIComponent(s.staffId)}`, { method: 'DELETE' });
        toast('Staff removed.');
        renderStaffTab();
        renderRecordsTab();
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
  $('#addStaffForm').hidden = false;
  $('#addStaffCodePanel').hidden = true;
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
    const res = await api('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({ staffId, name, role })
    });
    $('#addStaffForm').hidden = true;
    $('#addStaffCodePanel').hidden = false;
    $('#addStaffCodeValue').textContent = res.enrollCode;
    await renderStaffTab();
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
    state.staff = await api('/api/staff');
  } catch (_) { /* picker will show empty and retry on open */ }

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
}

init();

/* ===================================================================
   Criterion Amazing College — Attendance PWA
   Vanilla JS, IndexedDB storage, Geolocation geofencing, WebAuthn
   biometric verification. No backend — designed to run as a single
   shared kiosk device (tablet/phone) mounted at the school entrance.
=================================================================== */

const DB_NAME = 'cac_attendance';
const DB_VERSION = 1;
let db;

/* Surveyed school perimeter fence (Criterion_perimeter_fence.kml),
   converted from KML's lon,lat order to [lat, lng] pairs. This is the
   real property boundary, not a circle — staff must be inside this
   polygon (plus a small GPS-accuracy buffer) to sign in/out. */
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
  geofenceBufferM: 25,   // tolerance in meters, to absorb GPS drift
  adminPinHash: null
};

/* Staff seeded from Staff_List.docx (2026/2027 session working team).
   No fingerprint/face credential yet — each person still enrolls their
   own biometric on the kiosk device on first use. */
const SEED_STAFF = [
  { staffId: 'CAC-001', name: 'Ibraheem K. Abiola', role: 'Coordinator, Senior Secondary School' },
  { staffId: 'CAC-002', name: 'Salahudeen Olawumi Mariam', role: 'Coordinator, Junior Secondary School' },
  { staffId: 'CAC-003', name: 'Babalola Saidat A.', role: 'Coordinator, Nursery and Primary School' },
  { staffId: 'CAC-004', name: 'Bolaji Sadiat Kikelomo', role: 'Teaching Staff' },
  { staffId: 'CAC-005', name: 'Yusuf Ganiyu Laja', role: 'Teaching Staff' },
  { staffId: 'CAC-006', name: 'Ibraheem Lukman Ademola', role: 'Teaching Staff' },
  { staffId: 'CAC-007', name: 'Mallam Adedokun Misbahudeen', role: 'Teaching Staff' },
  { staffId: 'CAC-008', name: 'Olawale Dolapo Narmat', role: 'Teaching Staff' },
  { staffId: 'CAC-009', name: 'Egbetokun Tawakalit', role: 'Teaching Staff' },
  { staffId: 'CAC-010', name: 'Adebayo Aliu Alade', role: 'Non-Teaching Staff' },
  { staffId: 'CAC-011', name: 'Jeyelaye Bolanle', role: 'Non-Teaching Staff' },
  { staffId: 'CAC-012', name: 'Amsat Balqees Olaitan', role: 'Teaching Staff' },
  { staffId: 'CAC-013', name: 'AbdulQudus Ayomide Abdulkareem', role: 'Non-Teaching Staff' },
  { staffId: 'CAC-014', name: 'Hassan Sofiyat', role: 'Non-Teaching Staff' },
  { staffId: 'CAC-015', name: 'Mrs Olatunji', role: 'Care Giver' },
  { staffId: 'CAC-016', name: 'Popoola Idris Bamigboye', role: 'Teaching Staff' },
  { staffId: 'CAC-017', name: 'Adebayo Ilyas Akinola', role: 'Teaching Staff' },
  { staffId: 'CAC-018', name: 'Adebayo Rasheed Olawale', role: 'Head of Administration' }
];

let state = {
  settings: { ...DEFAULT_SETTINGS },
  staff: [],
  geo: { status: 'checking', lat: null, lng: null, distance: null },
  pendingAction: null,   // 'in' | 'out'
  pendingStaff: null,
  pinPurpose: 'admin',   // 'admin' | 'setpin'
  watchId: null,
  enrollMode: 'new'      // 'new' | 'existing' (re-enrolling a seeded staff member's fingerprint)
};

/* ---------------------- IndexedDB helpers ---------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('staff')) {
        _db.createObjectStore('staff', { keyPath: 'staffId' });
      }
      if (!_db.objectStoreNames.contains('logs')) {
        const store = _db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        store.createIndex('byDate', 'dateKey');
        store.createIndex('byStaff', 'staffId');
      }
      if (!_db.objectStoreNames.contains('settings')) {
        _db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function loadSettings() {
  const rows = await idbGetAll('settings');
  const merged = { ...DEFAULT_SETTINGS };
  rows.forEach(r => { merged[r.key] = r.value; });
  state.settings = merged;
}

async function saveSettingKey(key, value) {
  await idbPut('settings', { key, value });
  state.settings[key] = value;
}

/* ---------------------- Utility ---------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

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

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------------------- Polygon geofence (perimeter fence) ---------------------- */

// Local flat-earth projection to meters, centered near the fence, good enough
// for a boundary a few hundred meters across.
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

// Ray-casting point-in-polygon test.
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

// Shortest distance in meters from a point to the polygon boundary (its
// nearest edge). Used to tell staff how far away they are when outside.
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

function pointToSegmentDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx, cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

// Combines the strict polygon test with a small buffer (meters) so normal
// GPS drift near the boundary doesn't lock people out right at the gate.
function evaluatePerimeter(lat, lng, bufferM) {
  const strictlyInside = pointInPolygon(lat, lng, SCHOOL_PERIMETER);
  const dist = distanceToPolygonMeters(lat, lng, SCHOOL_PERIMETER);
  const inside = strictlyInside || dist <= bufferM;
  return { inside, distance: strictlyInside ? 0 : dist };
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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

/* ---------------------- Geofencing ---------------------- */

function setGeoUI(status, text) {
  const pill = $('#geoStatus');
  pill.className = 'geo-pill geo-' + status;
  $('#geoStatusText').textContent = text;
  const ready = status === 'inside';
  $('#btnSignIn').disabled = !ready;
  $('#btnSignOut').disabled = !ready;
}

function evaluateGeofence(lat, lng) {
  const bufferM = state.settings.geofenceBufferM ?? DEFAULT_SETTINGS.geofenceBufferM;
  const { inside, distance } = evaluatePerimeter(lat, lng, bufferM);
  const prevStatus = state.geo.status;
  state.geo = { status: inside ? 'inside' : 'outside', lat, lng, distance };

  if (inside) {
    setGeoUI('inside', 'You are within the school perimeter fence.');
    // Fire the "you can now sign in/out" alert only on the transition into
    // the fence, not on every location update while already inside.
    if (prevStatus !== 'inside') {
      announceEnteredPerimeter();
    }
  } else {
    setGeoUI('outside', `You're about ${Math.round(distance)}m from the school perimeter fence — move inside it to sign in or out.`);
  }
}

function announceEnteredPerimeter() {
  toast('✅ You are now within the school perimeter — you can sign in or sign out.', 4000);
  if ('vibrate' in navigator) {
    try { navigator.vibrate([60, 40, 60]); } catch (_) {}
  }
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

/* ---------------------- Staff picker ---------------------- */

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
    const needsEnroll = !s.credentialId;
    row.innerHTML = `
      <span class="staff-avatar">${initials(s.name)}</span>
      <span class="staff-row-text">
        <span class="staff-row-name">${escapeHtml(s.name)}</span>
        <span class="staff-row-id">${escapeHtml(s.staffId)} · ${escapeHtml(s.role)}${needsEnroll ? ' · fingerprint not set up' : ''}</span>
      </span>`;
    row.addEventListener('click', () => {
      if (needsEnroll) {
        toast(`${s.name.split(' ')[0]} hasn't registered a fingerprint/face yet — see the admin (Staff tab) to set that up first.`, 4200);
        return;
      }
      openVerify(s);
    });
    list.appendChild(row);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

$('#btnSignIn').addEventListener('click', () => {
  state.pendingAction = 'in';
  $('#pickerTitle').textContent = 'Sign In';
  renderStaffPicker('');
  $('#staffSearch').value = '';
  showScreen('picker');
});
$('#btnSignOut').addEventListener('click', () => {
  state.pendingAction = 'out';
  $('#pickerTitle').textContent = 'Sign Out';
  renderStaffPicker('');
  $('#staffSearch').value = '';
  showScreen('picker');
});
$('#staffSearch').addEventListener('input', (e) => renderStaffPicker(e.target.value));

/* ---------------------- Verify (WebAuthn) ---------------------- */

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

async function webauthnSupported() {
  return window.PublicKeyCredential &&
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
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
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: [{
          id: b64ToBuf(staffMember.credentialId),
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
    } else {
      $('#verifyHint').textContent = 'That didn\u2019t match, or was cancelled. Please try again with your registered fingerprint or face.';
    }
  }
});

/* ---------------------- Attendance recording ---------------------- */

async function recordAttendance(staffMember, type) {
  const now = new Date();
  let status = 'ontime';
  if (type === 'in') {
    status = timeStr(now) > state.settings.resumeTime ? 'late' : 'ontime';
  } else {
    status = timeStr(now) < state.settings.closeTime ? 'early' : 'ontime';
  }

  const record = {
    staffId: staffMember.staffId,
    name: staffMember.name,
    role: staffMember.role,
    type,
    timestamp: now.toISOString(),
    dateKey: dateKeyOf(now),
    status,
    lat: state.geo.lat,
    lng: state.geo.lng,
    distance: Math.round(state.geo.distance || 0)
  };
  await idbPut('logs', record);
  showResult(record);
}

function timeStr(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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
    badge.hidden = false;
    badge.className = 'result-badge';
    badge.textContent = 'LATE ARRIVAL';
  } else if (record.status === 'early') {
    badge.hidden = false;
    badge.className = 'result-badge';
    badge.textContent = 'LEFT EARLY';
  } else {
    badge.hidden = false;
    badge.className = 'result-badge ontime';
    badge.textContent = record.type === 'in' ? 'ON TIME' : 'ON SCHEDULE';
  }
  showScreen('result');
}

/* ---------------------- Today's log (public view) ---------------------- */

async function renderTodayLog() {
  const all = await idbGetAll('logs');
  const todayKey = dateKeyOf(new Date());
  const rows = all.filter(r => r.dateKey === todayKey)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const list = $('#todayLogList');
  list.innerHTML = '';
  $('#todayLogEmpty').hidden = rows.length !== 0;
  rows.forEach(r => list.appendChild(buildLogRow(r)));
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
  await renderTodayLog();
  showScreen('todaylog');
});

/* ---------------------- Admin PIN gate ---------------------- */

$('#adminEntry').addEventListener('click', () => {
  $('#pinInput').value = '';
  $('#pinError').hidden = true;
  $('#pinFirstRunNote').hidden = !!state.settings.adminPinHash;
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
  const hash = await sha256Hex(val);

  if (!state.settings.adminPinHash) {
    await saveSettingKey('adminPinHash', hash);
    toast('Admin PIN set.');
    enterAdmin();
    return;
  }
  if (hash === state.settings.adminPinHash) {
    enterAdmin();
  } else {
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
  renderSettingsTab();
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
  const all = await idbGetAll('logs');
  const date = $('#recordDate').value;
  const staffId = $('#recordStaffFilter').value;
  const rows = all.filter(r => (!date || r.dateKey === date) && (!staffId || r.staffId === staffId))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

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
  const all = await idbGetAll('logs');
  const date = $('#recordDate').value;
  const staffId = $('#recordStaffFilter').value;
  const rows = all.filter(r => (!date || r.dateKey === date) && (!staffId || r.staffId === staffId))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (!rows.length) { toast('No records to export.'); return; }

  const header = ['Staff ID', 'Name', 'Role', 'Type', 'Date', 'Time', 'Status', 'Distance from gate (m)'];
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
  state.staff = await idbGetAll('staff');
  const list = $('#staffAdminList');
  list.innerHTML = '';
  state.staff.sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
    const row = document.createElement('div');
    row.className = 'staff-admin-row';
    const needsEnroll = !s.credentialId;
    row.innerHTML = `
      <span class="staff-avatar">${initials(s.name)}</span>
      <span class="staff-row-text">
        <span class="staff-row-name">${escapeHtml(s.name)}</span>
        <span class="staff-row-id">${escapeHtml(s.staffId)} · ${escapeHtml(s.role)}</span>
        ${needsEnroll ? '<span class="enroll-needed-badge">Needs fingerprint enrollment</span>' : ''}
      </span>
      ${needsEnroll ? `<button class="mini-btn enroll-staff-btn" data-id="${escapeHtml(s.staffId)}">Enroll</button>` : ''}
      <button class="remove-staff-btn" data-id="${escapeHtml(s.staffId)}">Remove</button>`;
    const enrollBtn = row.querySelector('.enroll-staff-btn');
    if (enrollBtn) {
      enrollBtn.addEventListener('click', () => openEnrollModal('existing', s));
    }
    row.querySelector('.remove-staff-btn').addEventListener('click', async () => {
      if (!confirm(`Remove ${s.name} from the staff list? Their past attendance records will be kept.`)) return;
      await idbDelete('staff', s.staffId);
      toast('Staff removed.');
      renderStaffTab();
      renderRecordsTab();
    });
    list.appendChild(row);
  });
}

let enrollTargetStaff = null; // set when re-enrolling an existing (seeded) staff member's fingerprint

function openEnrollModal(mode, staffMember) {
  state.enrollMode = mode;
  const isExisting = mode === 'existing';
  enrollTargetStaff = isExisting ? staffMember : null;
  $('#enrollName').value = isExisting ? staffMember.name : '';
  $('#enrollId').value = isExisting ? staffMember.staffId : '';
  // The role <select> only offers 3 preset options, which may not match a
  // seeded staff member's real role (e.g. "Coordinator, ..."), so for
  // existing staff we keep their role text as-is (see enrollTargetStaff)
  // rather than forcing the dropdown to a mismatched value.
  $('#enrollRole').value = isExisting ? 'Teaching Staff' : 'Teaching Staff';
  $('#enrollName').disabled = isExisting;
  $('#enrollId').disabled = isExisting;
  $('#enrollRole').disabled = isExisting;
  $('#modalEnrollTitle').textContent = isExisting ? `Enroll Fingerprint — ${staffMember.name}` : 'Enroll New Staff';
  $('#enrollError').hidden = true;
  $('#modalEnroll').hidden = false;
}

$('#btnAddStaff').addEventListener('click', () => openEnrollModal('new'));
$('#btnEnrollCancel').addEventListener('click', () => {
  $('#modalEnroll').hidden = true;
  $('#enrollName').disabled = false;
  $('#enrollId').disabled = false;
  $('#enrollRole').disabled = false;
  enrollTargetStaff = null;
});

$('#btnEnrollFingerprint').addEventListener('click', async () => {
  const name = $('#enrollName').value.trim();
  const staffId = $('#enrollId').value.trim();
  const isExisting = state.enrollMode === 'existing';
  const role = isExisting && enrollTargetStaff ? enrollTargetStaff.role : $('#enrollRole').value;
  const errEl = $('#enrollError');
  errEl.hidden = true;

  if (!name || !staffId) {
    errEl.textContent = 'Please enter both name and staff ID.';
    errEl.hidden = false;
    return;
  }
  const existing = state.staff.find(s => s.staffId.toLowerCase() === staffId.toLowerCase());
  if (existing && !isExisting) {
    errEl.textContent = 'A staff member with this ID already exists.';
    errEl.hidden = false;
    return;
  }
  if (!window.PublicKeyCredential) {
    errEl.textContent = 'This device/browser does not support fingerprint or face enrollment.';
    errEl.hidden = false;
    return;
  }

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: state.settings.schoolName, id: location.hostname },
        user: { id: userId, name: staffId, displayName: name },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required'
        },
        timeout: 60000,
        attestation: 'none'
      }
    });
    if (!cred) throw new Error('cancelled');

    const staffMember = {
      staffId,
      name,
      role,
      credentialId: bufToB64(cred.rawId),
      userHandle: bufToB64(userId),
      createdAt: new Date().toISOString()
    };
    await idbPut('staff', staffMember);
    $('#modalEnroll').hidden = true;
    $('#enrollName').disabled = false;
    $('#enrollId').disabled = false;
    $('#enrollRole').disabled = false;
    toast(isExisting ? `${name}'s fingerprint/face is now registered.` : `${name} enrolled successfully.`);
    enrollTargetStaff = null;
    await renderStaffTab();
    await renderRecordsTab();
  } catch (err) {
    errEl.textContent = 'Fingerprint/face registration failed or was cancelled. Please try again.';
    errEl.hidden = false;
  }
});

/* --- Settings tab --- */

function renderSettingsTab() {
  $('#setSchoolName').value = state.settings.schoolName;
  $('#setResumeTime').value = state.settings.resumeTime;
  $('#setCloseTime').value = state.settings.closeTime;
  $('#setBuffer').value = state.settings.geofenceBufferM ?? DEFAULT_SETTINGS.geofenceBufferM;
  $('#bufferVal').textContent = $('#setBuffer').value;
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
  await saveSettingKey('schoolName', $('#setSchoolName').value.trim() || DEFAULT_SETTINGS.schoolName);
  await saveSettingKey('resumeTime', $('#setResumeTime').value || DEFAULT_SETTINGS.resumeTime);
  await saveSettingKey('closeTime', $('#setCloseTime').value || DEFAULT_SETTINGS.closeTime);
  await saveSettingKey('geofenceBufferM', parseInt($('#setBuffer').value, 10));

  const newPin = $('#setNewPin').value.trim();
  if (newPin) {
    if (newPin.length < 4) {
      toast('New PIN must be at least 4 digits.');
    } else {
      await saveSettingKey('adminPinHash', await sha256Hex(newPin));
      toast('Settings and admin PIN updated.');
    }
  } else {
    toast('Settings saved.');
  }

  $('#topbarSchoolName') && ($('#topbarSchoolName').textContent = state.settings.schoolName);
  $('.topbar-school').textContent = state.settings.schoolName.toUpperCase();
  $('#settingsSaved').hidden = false;
  startGeoWatch();
});

/* ---------------------- Service worker ---------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------------------- Init ---------------------- */

async function seedStaffIfEmpty() {
  const existing = await idbGetAll('staff');
  if (existing.length > 0) return;
  for (const s of SEED_STAFF) {
    await idbPut('staff', {
      staffId: s.staffId,
      name: s.name,
      role: s.role,
      credentialId: null,   // not yet enrolled — they register their own fingerprint/face on first visit
      userHandle: null,
      createdAt: new Date().toISOString()
    });
  }
}

async function init() {
  db = await openDb();
  await loadSettings();
  await seedStaffIfEmpty();
  state.staff = await idbGetAll('staff');

  $('.topbar-school').textContent = state.settings.schoolName.toUpperCase();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  tickClock();
  setInterval(tickClock, 1000 * 30);
  setInterval(() => { const c = $('#clockTime'); if (c) c.textContent = fmtTime(new Date()); }, 1000);

  startGeoWatch();
  showScreen('home');
}

init();

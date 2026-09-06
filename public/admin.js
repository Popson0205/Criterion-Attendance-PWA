/* ===================================================================
   Criterion Amazing College — Admin Dashboard (admin.html only)
   PIN-gated: Records (view/filter/download CSV), Staff (add/remove),
   Settings (school name, times, geofence buffer, admin PIN).
   Relies on common.js being loaded first.
=================================================================== */

const DEFAULT_SETTINGS = {
  schoolName: 'Criterion Amazing College',
  resumeTime: '08:00',
  closeTime: '15:00',
  geofenceBufferM: 25
};

// Same perimeter data as app.js/geofence.js — only used here for the
// "test this device against the fence" button in Settings.
const SCHOOL_PERIMETER = [
  [7.831456071231706, 4.576847563576805],
  [7.831413785775986, 4.577172593085352],
  [7.832362344414676, 4.577344858839034],
  [7.832324496979382, 4.57696277909487]
];

let state = {
  settings: { ...DEFAULT_SETTINGS },
  staff: [],
  adminToken: sessionStorage.getItem('cac_admin_token') || null
};

function adminApi(path, opts = {}) {
  return api(path, opts, state.adminToken);
}

/* ---------------------- Geofence math (for the test button) ---------------------- */

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
function getOneShotPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
  });
}

/* ---------------------- Modal (Add Staff) close handling ---------------------- */

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

/* ---------------------- PIN gate ---------------------- */

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

/* ---------------------- Tabs ---------------------- */

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
    rows = await adminApi(`/api/admin/logs?${qs.toString()}`);
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
    rows = await adminApi(`/api/admin/logs?${qs.toString()}`);
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
    state.staff = await adminApi('/api/admin/staff');
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
        await adminApi(`/api/admin/staff/${encodeURIComponent(s.staffId)}`, { method: 'DELETE' });
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
    await adminApi('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({ staffId, name, role })
    });
    toast(`${name} added.`);
    closeEnrollModal();
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
    s = await adminApi('/api/admin/settings');
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    toast('Could not load settings.');
    return;
  }
  state.settings = { ...state.settings, ...s };
  $('#setSchoolName').value = s.schoolName;
  $('#setResumeTime').value = s.resumeTime;
  $('#setCloseTime').value = s.closeTime;
  $('#setBuffer').value = s.geofenceBufferM;
  $('#bufferVal').textContent = s.geofenceBufferM;
  $('#setNewPin').value = '';
  $('#settingsSaved').hidden = true;
  $('.topbar-school').textContent = s.schoolName.toUpperCase();
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
    const updated = await adminApi('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = { ...state.settings, ...updated };
    $('.topbar-school').textContent = state.settings.schoolName.toUpperCase();
    $('#settingsSaved').hidden = false;
    toast(newPin ? 'Settings and admin PIN updated.' : 'Settings saved.');
  } catch (err) {
    if (!handleAdminAuthError(err)) toast(err.message || 'Could not save settings.');
  }
});

/* ---------------------- Init ---------------------- */

async function init() {
  $('#pinInput').value = '';
  $('#pinError').hidden = true;

  if (state.adminToken) {
    // Already have a session this tab — skip straight to the dashboard,
    // but fall back to the PIN screen if the token turns out to be stale.
    try {
      await adminApi('/api/admin/settings');
      enterAdmin();
      return;
    } catch (_) {
      state.adminToken = null;
      sessionStorage.removeItem('cac_admin_token');
    }
  }
  showScreen('pin');
  setTimeout(() => $('#pinInput').focus(), 150);
}

init();

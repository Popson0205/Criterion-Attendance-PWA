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
  $('#addStaffForm').hidden = false;
  $('#addStaffPinPanel').hidden = true;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnEnrollCancel') || e.target.closest('#btnAddStaffDone')) { closeEnrollModal(); return; }
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
  startRecordsPolling();
}

/* ---------------------- Tabs ---------------------- */

$all('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $all('.admin-tab').forEach(t => t.classList.remove('active'));
    $all('.admin-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'analytics') refreshAnalytics();
    if (tab.dataset.tab === 'staff') renderStaffTab();
    if (tab.dataset.tab === 'records') refreshRecordsList();
  });
});

async function renderAdminAll() {
  await renderRecordsTab();
  await renderStaffTab();
  await renderSettingsTab();
  initAnalyticsDefaults();
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

/* --- Records tab: live attendance sheet --- */

function statusTag(r) {
  if (r.status === 'late') return '<span class="sheet-tag late">LATE</span>';
  if (r.status === 'early') return '<span class="sheet-tag early">EARLY</span>';
  return '<span class="sheet-tag ontime">ON TIME</span>';
}

async function renderRecordsTab() {
  const dateInput = $('#recordDate');
  if (!dateInput.value) dateInput.value = dateKeyOf(new Date());

  const staffFilter = $('#recordStaffFilter');
  staffFilter.innerHTML = '<option value="">All staff</option>' +
    state.staff.map(s => `<option value="${escapeHtml(s.staffId)}">${escapeHtml(s.name)}</option>`).join('');

  await refreshRecordsList();
}

async function refreshRecordsList() {
  // Only bother hitting the network if the Records tab is actually visible.
  if (!document.getElementById('tab-records').classList.contains('active')) return;

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
    return;
  }

  const lateCount = rows.filter(r => r.status === 'late').length;
  $('#recordsSummary').textContent = `${rows.length} record${rows.length === 1 ? '' : 's'} · ${lateCount} late arrival${lateCount === 1 ? '' : 's'}`;

  const body = $('#recordsTableBody');
  body.innerHTML = '';
  $('#recordsEmpty').hidden = rows.length !== 0;
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(new Date(r.timestamp))}</td>
      <td>${escapeHtml(r.staffId)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td><span class="sheet-tag ${r.type}">${r.type === 'in' ? 'IN' : 'OUT'}</span></td>
      <td>${statusTag(r)}</td>`;
    body.appendChild(tr);
  });
}

let recordsPollTimer = null;
function startRecordsPolling() {
  if (recordsPollTimer) clearInterval(recordsPollTimer);
  recordsPollTimer = setInterval(() => refreshRecordsList().catch(() => {}), 15000);
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

/* --- Analytics tab: comparative dashboard + per-teacher score card --- */

let analyticsLogs = []; // raw logs for the currently selected range, reused by the scorecard

function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function initAnalyticsDefaults() {
  if (!$('#analyticsFrom').value) $('#analyticsFrom').value = dateKeyOf(firstOfMonth(new Date()));
  if (!$('#analyticsTo').value) $('#analyticsTo').value = dateKeyOf(new Date());
}

$('#analyticsFrom').addEventListener('change', refreshAnalytics);
$('#analyticsTo').addEventListener('change', refreshAnalytics);

// Average time-of-day across a list of ISO timestamps, using each
// timestamp's local (browser) time — consistent with how times are shown
// everywhere else in the app.
function averageTimeOfDay(isoTimestamps) {
  if (!isoTimestamps.length) return null;
  const totalMinutes = isoTimestamps.reduce((sum, iso) => {
    const d = new Date(iso);
    return sum + d.getHours() * 60 + d.getMinutes();
  }, 0);
  const avgMinutes = Math.round(totalMinutes / isoTimestamps.length);
  const h = Math.floor(avgMinutes / 60) % 24;
  const m = avgMinutes % 60;
  const ref = new Date();
  ref.setHours(h, m, 0, 0);
  return fmtTime(ref);
}

function summarizeStaff(staffMember, logsForRange) {
  const mine = logsForRange.filter(l => l.staffId === staffMember.staffId);
  const ins = mine.filter(l => l.type === 'in');
  const outs = mine.filter(l => l.type === 'out');
  const daysIn = new Set(ins.map(l => l.dateKey)).size;
  const onTime = ins.filter(l => l.status === 'ontime').length;
  const late = ins.filter(l => l.status === 'late').length;
  const early = outs.filter(l => l.status === 'early').length;
  const avgResume = averageTimeOfDay(ins.map(l => l.timestamp));
  return { staffMember, daysIn, onTime, late, early, avgResume, records: mine };
}

async function refreshAnalytics() {
  initAnalyticsDefaults();
  const from = $('#analyticsFrom').value;
  const to = $('#analyticsTo').value;
  try {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    analyticsLogs = await adminApi(`/api/admin/logs?${qs.toString()}`);
  } catch (err) {
    if (handleAdminAuthError(err)) return;
    toast('Could not load analytics.');
    return;
  }

  const summaries = state.staff.map(s => summarizeStaff(s, analyticsLogs))
    .sort((a, b) => a.staffMember.name.localeCompare(b.staffMember.name));

  const body = $('#analyticsTableBody');
  body.innerHTML = '';
  $('#analyticsEmpty').hidden = summaries.length !== 0;

  summaries.forEach(sum => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.innerHTML = `
      <td>${escapeHtml(sum.staffMember.name)}</td>
      <td>${sum.daysIn}</td>
      <td>${sum.onTime}</td>
      <td>${sum.late > 0 ? `<span class="sheet-tag late">${sum.late}</span>` : '0'}</td>
      <td>${sum.avgResume || '—'}</td>`;
    tr.addEventListener('click', () => openScorecard(sum));
    body.appendChild(tr);
  });
}

function openScorecard(sum) {
  $('#scorecardName').textContent = sum.staffMember.name;
  $('#scorecardMeta').textContent = `${sum.staffMember.staffId} · ${sum.staffMember.role}`;
  $('#scDaysIn').textContent = sum.daysIn;
  $('#scOnTime').textContent = sum.onTime;
  $('#scLate').textContent = sum.late;
  $('#scEarly').textContent = sum.early;
  $('#scAvgResume').textContent = sum.avgResume || '—';

  const recent = $('#scorecardRecent');
  recent.innerHTML = '';
  const sorted = [...sum.records].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 15);
  if (!sorted.length) {
    recent.innerHTML = '<p class="empty-note">No records in this range.</p>';
  } else {
    sorted.forEach(r => {
      const row = document.createElement('div');
      row.className = 'log-row';
      row.innerHTML = `
        <span class="log-type-tag ${r.type}">${r.type === 'in' ? 'IN' : 'OUT'}</span>
        <span class="log-row-text">
          <span class="log-row-name">${r.dateKey}</span>
        </span>
        <span class="log-row-time">
          <strong>${fmtTime(new Date(r.timestamp))}</strong>
          ${r.status !== 'ontime' ? `<span>${r.status.toUpperCase()}</span>` : ''}
        </span>`;
      recent.appendChild(row);
    });
  }
  $('#modalScorecard').hidden = false;
}

function closeScorecard() { $('#modalScorecard').hidden = true; }
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnScorecardClose')) { closeScorecard(); return; }
  if (e.target.id === 'modalScorecard') { closeScorecard(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeScorecard();
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
        ${!s.hasPin ? '<span class="enroll-needed-badge">No PIN set yet</span>' : (!s.hasDevice ? '<span class="enroll-needed-badge">PIN set, no phone bound yet</span>' : '')}
      </span>
      <span class="staff-row-actions">
        <button class="mini-btn reset-pin-btn" data-id="${escapeHtml(s.staffId)}">${s.hasPin ? 'Reset PIN' : 'Set PIN'}</button>
        <button class="remove-staff-btn" data-id="${escapeHtml(s.staffId)}">Remove</button>
      </span>`;

    row.querySelector('.reset-pin-btn').addEventListener('click', async () => {
      if (s.hasPin && !confirm(`Generate a new PIN for ${s.name}? Their old PIN will stop working and their phone will need to be re-bound (they'll enter the new PIN once, on whichever phone they use next).`)) return;
      try {
        const res = await adminApi(`/api/admin/staff/${encodeURIComponent(s.staffId)}/reset-pin`, { method: 'POST' });
        toast(`New PIN generated for ${s.name}.`, 4000);
        let panel = row.querySelector('.staff-code-row');
        if (!panel) {
          panel = document.createElement('div');
          panel.className = 'staff-code-row';
          row.querySelector('.staff-row-text').appendChild(panel);
        }
        panel.innerHTML = `New PIN: <span class="staff-code-value">${escapeHtml(res.pin)}</span> — share this now, it won't be shown again.`;
      } catch (err) {
        if (!handleAdminAuthError(err)) toast('Could not reset PIN.');
      }
    });

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
  $('#addStaffForm').hidden = false;
  $('#addStaffPinPanel').hidden = true;
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
    const res = await adminApi('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({ staffId, name, role })
    });
    $('#addStaffForm').hidden = true;
    $('#addStaffPinPanel').hidden = false;
    $('#addStaffPinValue').textContent = res.pin;
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

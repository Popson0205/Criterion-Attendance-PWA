/* ===================================================================
   server.js — Criterion Amazing College Attendance backend.
   Serves the PWA frontend (./public) and a small REST API backed by
   Postgres, so every teacher's own phone reads/writes the same shared
   records instead of local-only storage.
=================================================================== */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { pool, init, randomCode, DEFAULT_SETTINGS } = require('./db');
const { evaluatePerimeter } = require('./geofence');

const app = express();
app.use(express.json());

/* ---------------------- Admin sessions (in-memory) ---------------------- */
// Simple bearer-token sessions. Fine for a small admin dashboard used from
// one or two devices; sessions reset if the server restarts (admin just
// re-enters the PIN).
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> expiresAt

function issueSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expires = token && sessions.get(token);
  if (!token || !expires || expires < Date.now()) {
    return res.status(401).json({ error: 'Not authenticated. Please log in again.' });
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS); // sliding expiry
  next();
}
// Periodically clear expired sessions.
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 60 * 60 * 1000).unref();

/* ---------------------- Settings helpers ---------------------- */
async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : undefined;
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}
async function getPublicSettings() {
  const keys = ['schoolName', 'resumeTime', 'closeTime', 'geofenceBufferM'];
  const out = { ...DEFAULT_SETTINGS };
  for (const k of keys) {
    const v = await getSetting(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function dateKeyOf(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function timeStrOf(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ======================================================================
   PUBLIC API — used by every teacher's own phone
====================================================================== */

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/settings/public', async (req, res) => {
  try {
    res.json(await getPublicSettings());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

// Staff list for the picker — never includes credentialId/userHandle here.
app.get('/api/staff', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT staff_id, name, role, (credential_id IS NOT NULL) AS has_credential
       FROM staff ORDER BY name ASC`
    );
    res.json(rows.map(r => ({
      staffId: r.staff_id, name: r.name, role: r.role, hasCredential: r.has_credential
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load staff list.' });
  }
});

// Fetch the WebAuthn credential reference for one staff member, needed
// client-side right before calling navigator.credentials.get(). A
// credentialId is a public identifier, not a secret — the private key
// never leaves that person's own device — so this is safe to expose.
app.get('/api/staff/:id/credential', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT credential_id, user_handle FROM staff WHERE staff_id = $1', [req.params.id]
    );
    if (!rows.length || !rows[0].credential_id) {
      return res.status(404).json({ error: 'No fingerprint/face registered for this staff ID yet.' });
    }
    res.json({ credentialId: rows[0].credential_id, userHandle: rows[0].user_handle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load credential.' });
  }
});

// Step 1 of self-enrollment: staff member enters their Staff ID + the
// one-time code the admin gave them. This is what stops a random person
// on their own phone from registering a fingerprint against someone
// else's name, now that there's no single admin-controlled kiosk.
app.post('/api/staff/:id/self-enroll/start', async (req, res) => {
  try {
    const { code } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM staff WHERE staff_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Staff ID not found.' });
    const s = rows[0];
    if (!s.enroll_code || !s.enroll_code_expires || new Date(s.enroll_code_expires) < new Date()) {
      return res.status(400).json({ error: 'No active enrollment code — ask the admin for a new one.' });
    }
    if (String(code || '').trim() !== s.enroll_code) {
      return res.status(400).json({ error: 'Incorrect code.' });
    }
    const enrollToken = crypto.randomBytes(24).toString('hex');
    const tokenExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await pool.query(
      'UPDATE staff SET enroll_token = $1, enroll_token_expires = $2 WHERE staff_id = $3',
      [enrollToken, tokenExpires, req.params.id]
    );
    res.json({ enrollToken, name: s.name, role: s.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start enrollment.' });
  }
});

// Step 2: after the WebAuthn ceremony succeeds on the device, save the
// resulting credential reference, guarded by the short-lived enrollToken.
app.post('/api/staff/:id/credential', async (req, res) => {
  try {
    const { credentialId, userHandle, enrollToken } = req.body || {};
    if (!credentialId || !userHandle || !enrollToken) {
      return res.status(400).json({ error: 'Missing enrollment data.' });
    }
    const { rows } = await pool.query('SELECT * FROM staff WHERE staff_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Staff ID not found.' });
    const s = rows[0];
    if (s.enroll_token !== enrollToken || !s.enroll_token_expires || new Date(s.enroll_token_expires) < new Date()) {
      return res.status(400).json({ error: 'Enrollment session expired — start again with the code.' });
    }
    await pool.query(
      `UPDATE staff SET credential_id = $1, user_handle = $2,
        enroll_code = NULL, enroll_code_expires = NULL,
        enroll_token = NULL, enroll_token_expires = NULL
       WHERE staff_id = $3`,
      [credentialId, userHandle, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save credential.' });
  }
});

// Record a sign-in/out. The server independently re-checks the perimeter
// fence and the resumption/closing time — the authoritative check, since
// this now runs over the internet from personal phones instead of one
// device the school physically controls.
app.post('/api/attendance', async (req, res) => {
  try {
    const { staffId, type, lat, lng } = req.body || {};
    if (!staffId || (type !== 'in' && type !== 'out') || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Missing or invalid sign-in data.' });
    }
    const { rows } = await pool.query('SELECT * FROM staff WHERE staff_id = $1', [staffId]);
    if (!rows.length) return res.status(404).json({ error: 'Staff member not found.' });
    const staffMember = rows[0];
    if (!staffMember.credential_id) {
      return res.status(400).json({ error: 'This staff member has not completed fingerprint/face enrollment.' });
    }

    const bufferM = (await getSetting('geofenceBufferM')) ?? DEFAULT_SETTINGS.geofenceBufferM;
    const { inside, distance } = evaluatePerimeter(lat, lng, bufferM);
    if (!inside) {
      return res.status(403).json({
        error: `You're about ${Math.round(distance)}m outside the school perimeter fence — move inside it to sign in or out.`,
        distance: Math.round(distance)
      });
    }

    const resumeTime = (await getSetting('resumeTime')) ?? DEFAULT_SETTINGS.resumeTime;
    const closeTime = (await getSetting('closeTime')) ?? DEFAULT_SETTINGS.closeTime;
    const now = new Date();
    const status = type === 'in'
      ? (timeStrOf(now) > resumeTime ? 'late' : 'ontime')
      : (timeStrOf(now) < closeTime ? 'early' : 'ontime');

    const insert = await pool.query(
      `INSERT INTO logs (staff_id, name, role, type, ts, date_key, status, lat, lng, distance_m)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [staffMember.staff_id, staffMember.name, staffMember.role, type, now, dateKeyOf(now), status, lat, lng, Math.round(distance)]
    );
    res.json(rowToLog(insert.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record attendance.' });
  }
});

function rowToLog(r) {
  return {
    id: r.id, staffId: r.staff_id, name: r.name, role: r.role, type: r.type,
    timestamp: r.ts, dateKey: r.date_key, status: r.status,
    lat: r.lat, lng: r.lng, distance: r.distance_m
  };
}

// Public "today's sign-ins" board — matches the original app's un-gated view.
app.get('/api/logs/today', async (req, res) => {
  try {
    const todayKey = dateKeyOf(new Date());
    const { rows } = await pool.query(
      'SELECT * FROM logs WHERE date_key = $1 ORDER BY ts DESC', [todayKey]
    );
    res.json(rows.map(rowToLog));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load today\u2019s log.' });
  }
});

/* ======================================================================
   ADMIN API — PIN-protected
====================================================================== */

app.post('/api/admin/login', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || String(pin).trim().length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 digits.' });
    }
    const currentHash = await getSetting('adminPinHash');
    if (!currentHash) {
      // First run — this PIN becomes the admin PIN.
      const hash = await bcrypt.hash(String(pin), 10);
      await setSetting('adminPinHash', hash);
      return res.json({ token: issueSession(), firstRun: true });
    }
    const ok = await bcrypt.compare(String(pin), currentHash);
    if (!ok) return res.status(401).json({ error: 'Incorrect PIN.' });
    res.json({ token: issueSession(), firstRun: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const pub = await getPublicSettings();
    const hasPinSet = !!(await getSetting('adminPinHash'));
    res.json({ ...pub, hasPinSet });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { schoolName, resumeTime, closeTime, geofenceBufferM, newPin } = req.body || {};
    if (schoolName) await setSetting('schoolName', schoolName.trim());
    if (resumeTime) await setSetting('resumeTime', resumeTime);
    if (closeTime) await setSetting('closeTime', closeTime);
    if (Number.isFinite(geofenceBufferM)) await setSetting('geofenceBufferM', geofenceBufferM);
    if (newPin) {
      if (String(newPin).trim().length < 4) {
        return res.status(400).json({ error: 'New PIN must be at least 4 digits.' });
      }
      await setSetting('adminPinHash', await bcrypt.hash(String(newPin), 10));
    }
    res.json(await getPublicSettings());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

// Full staff list for the admin Staff tab, including enrollment codes so
// the admin can hand them out (or re-share) to staff who haven't self-
// enrolled yet.
app.get('/api/admin/staff', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff ORDER BY name ASC');
    res.json(rows.map(r => ({
      staffId: r.staff_id,
      name: r.name,
      role: r.role,
      hasCredential: !!r.credential_id,
      enrollCode: r.enroll_code,
      enrollCodeExpires: r.enroll_code_expires
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load staff list.' });
  }
});

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  try {
    const { staffId, name, role } = req.body || {};
    if (!staffId || !name || !role) {
      return res.status(400).json({ error: 'Please provide staff ID, name, and role.' });
    }
    const existing = await pool.query('SELECT 1 FROM staff WHERE staff_id = $1', [staffId]);
    if (existing.rows.length) {
      return res.status(400).json({ error: 'A staff member with this ID already exists.' });
    }
    const code = randomCode();
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90);
    await pool.query(
      `INSERT INTO staff (staff_id, name, role, enroll_code, enroll_code_expires)
       VALUES ($1,$2,$3,$4,$5)`,
      [staffId, name, role, code, expires]
    );
    res.json({ staffId, name, role, hasCredential: false, enrollCode: code, enrollCodeExpires: expires });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add staff member.' });
  }
});

// Give someone a fresh self-enrollment code (e.g. it expired, or they
// need to redo it).
app.post('/api/admin/staff/:id/regenerate-code', requireAdmin, async (req, res) => {
  try {
    const code = randomCode();
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90);
    const { rows } = await pool.query(
      `UPDATE staff SET enroll_code = $1, enroll_code_expires = $2
       WHERE staff_id = $3 RETURNING *`,
      [code, expires, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff member not found.' });
    res.json({ enrollCode: code, enrollCodeExpires: expires });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not generate a new code.' });
  }
});

// Lost/replaced phone: clear the old credential and issue a new code so
// the person can re-enroll on their new device.
app.post('/api/admin/staff/:id/reset-device', requireAdmin, async (req, res) => {
  try {
    const code = randomCode();
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90);
    const { rows } = await pool.query(
      `UPDATE staff SET credential_id = NULL, user_handle = NULL,
        enroll_code = $1, enroll_code_expires = $2
       WHERE staff_id = $3 RETURNING *`,
      [code, expires, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff member not found.' });
    res.json({ enrollCode: code, enrollCodeExpires: expires });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reset device.' });
  }
});

app.delete('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE staff_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove staff member.' });
  }
});

app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const { date, staffId } = req.query;
    const clauses = [];
    const params = [];
    if (date) { params.push(date); clauses.push(`date_key = $${params.length}`); }
    if (staffId) { params.push(staffId); clauses.push(`staff_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM logs ${where} ORDER BY ts DESC`, params);
    res.json(rows.map(rowToLog));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load records.' });
  }
});

/* ---------------------- Static frontend ---------------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------------------- Boot ---------------------- */
const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    app.listen(PORT, () => console.log(`Criterion Attendance server listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

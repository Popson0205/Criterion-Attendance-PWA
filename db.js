/* ===================================================================
   db.js — Postgres connection, schema setup, and first-run seeding.
   Uses Render's own managed Postgres (DATABASE_URL env var) — no other
   accounts needed.
=================================================================== */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Create a Postgres instance on Render and ' +
    'attach its connection string to this service\'s environment variables.'
  );
}

// Neon (and most managed Postgres providers) require SSL. Render's own
// Postgres over its internal network doesn't. This detects common
// managed-provider hosts and enables SSL automatically; PGSSL env var can
// still force it either way if a connection ever fails unexpectedly.
const connStr = process.env.DATABASE_URL || '';
const looksManaged = /neon\.tech|render\.com|supabase\.co|amazonaws\.com/.test(connStr);
const useSSL = process.env.PGSSL === 'true'
  ? { rejectUnauthorized: false }
  : process.env.PGSSL === 'false'
    ? false
    : looksManaged
      ? { rejectUnauthorized: false }
      : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      staff_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      credential_id TEXT,
      user_handle TEXT,
      enroll_code TEXT,
      enroll_code_expires TIMESTAMPTZ,
      enroll_token TEXT,
      enroll_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      staff_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('in','out')),
      ts TIMESTAMPTZ NOT NULL,
      date_key TEXT NOT NULL,
      status TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      distance_m INTEGER
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_staff ON logs(staff_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
}

function randomCode() {
  // 6-digit numeric code, e.g. "042817"
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function seedStaffIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM staff');
  if (rows[0].n > 0) return;

  const seedPath = path.join(__dirname, 'seed-staff.json');
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90); // 90 days
  for (const s of seed) {
    await pool.query(
      `INSERT INTO staff (staff_id, name, role, enroll_code, enroll_code_expires)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (staff_id) DO NOTHING`,
      [s.staffId, s.name, s.role, randomCode(), expires]
    );
  }
  console.log(`Seeded ${seed.length} staff records.`);
}

const DEFAULT_SETTINGS = {
  schoolName: 'Criterion Amazing College',
  resumeTime: '08:00',
  closeTime: '15:00',
  geofenceBufferM: 25
};

async function seedSettingsIfMissing() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
  // adminPinHash starts unset (null) — first admin login sets it.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('adminPinHash', 'null'::jsonb)
     ON CONFLICT (key) DO NOTHING`
  );
}

async function init() {
  await initSchema();
  await seedStaffIfEmpty();
  await seedSettingsIfMissing();
}

module.exports = { pool, init, randomCode, DEFAULT_SETTINGS };

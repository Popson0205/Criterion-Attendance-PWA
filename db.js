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
      pin_hash TEXT,
      device_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Additive migration for databases created before PIN/device-binding existed.
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash TEXT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS device_token TEXT;`);
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

async function seedStaffIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM staff');
  if (rows[0].n > 0) return;

  const seedPath = path.join(__dirname, 'seed-staff.json');
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  for (const s of seed) {
    await pool.query(
      `INSERT INTO staff (staff_id, name, role) VALUES ($1, $2, $3)
       ON CONFLICT (staff_id) DO NOTHING`,
      [s.staffId, s.name, s.role]
    );
  }
  console.log(`Seeded ${seed.length} staff records. Remember: each still needs a PIN set from /admin before they can sign in.`);
}

function randomPin() {
  // 4-digit numeric PIN, e.g. "0427". Zero-padded so it's always 4 digits.
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
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

module.exports = { pool, init, DEFAULT_SETTINGS, randomPin };

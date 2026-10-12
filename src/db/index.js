const fs = require('fs');
const path = require('path');
const Client = require('pg-native');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL belum diset. Tambahkan connection string PostgreSQL Supabase di Environment Variables Render.');
}

// Compatibility adapter for the existing synchronous SQLite-style call sites.
// IMPORTANT: pg-native synchronous queries block Node's event loop. This keeps the
// current application compatible for a low-volume POS while a future async refactor
// can replace this adapter without changing the database schema.
const client = new Client();
const connectionString = process.env.DATABASE_URL.includes('sslmode=')
  ? process.env.DATABASE_URL
  : `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes('?') ? '&' : '?'}sslmode=require`;
client.connectSync(connectionString);

function bindSql(sql, args) {
  let values = [];
  let out = sql;
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const obj = args[0];
    const seen = new Map();
    out = out.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key) => {
      if (!seen.has(key)) { seen.set(key, values.length + 1); values.push(obj[key] ?? null); }
      return `$${seen.get(key)}`;
    });
  } else {
    values = args;
    let i = 0;
    out = out.replace(/\?/g, () => `$${++i}`);
  }

  out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/ig, 'INSERT INTO');
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(out)) {
    // The clause is appended later by run(), immediately before RETURNING if needed.
    out += ' ON CONFLICT DO NOTHING';
  }
  out = out.replace(/datetime\('now'\)/ig, 'CURRENT_TIMESTAMP::text');
  out = out.replace(/GROUP_CONCAT\((.*?),\s*'([^']*)'\)/ig, "STRING_AGG($1, '$2')");
  out = out.replace(/CAST\(strftime\('%Y',\s*period_end\)\s+AS\s+INTEGER\)/ig, 'CAST(EXTRACT(YEAR FROM period_end::date) AS INTEGER)');
  return { sql: out, values };
}

function withReturning(sql, kind) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (/\bRETURNING\b/i.test(trimmed)) return trimmed;
  // Key/value and join tables do not have a serial id column.
  if (/\bsettings\b/i.test(trimmed) || /\brole_permissions\b/i.test(trimmed)) return trimmed;
  if (kind === 'run-insert') return `${trimmed} RETURNING id`;
  if (kind === 'run-update') return `${trimmed} RETURNING id`;
  if (kind === 'run-delete') return `${trimmed} RETURNING id`;
  return trimmed;
}

function prepare(sql) {
  return {
    get(...args) {
      const q = bindSql(sql, args);
      const rows = client.querySync(q.sql, q.values);
      return rows[0];
    },
    all(...args) {
      const q = bindSql(sql, args);
      return client.querySync(q.sql, q.values);
    },
    run(...args) {
      const q = bindSql(sql, args);
      const normalized = q.sql.trim().replace(/;\s*$/, '');
      let kind = 'run-other';
      if (/^INSERT\b/i.test(normalized)) kind = 'run-insert';
      else if (/^UPDATE\b/i.test(normalized)) kind = 'run-update';
      else if (/^DELETE\b/i.test(normalized)) kind = 'run-delete';
      const finalSql = withReturning(q.sql, kind);
      const rows = client.querySync(finalSql, q.values);
      return { changes: rows.length, lastInsertRowid: rows[0]?.id, rows };
    },
  };
}

let transactionDepth = 0;
const db = {
  prepare,
  pragma() {},
  exec(sql) {
    // Execute DDL one statement at a time because libpq's extended protocol does not
    // accept multiple parameterized statements in one call.
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      client.querySync(statement);
    }
  },
  transaction(fn) {
    return (...args) => {
      const depth = transactionDepth;
      const savepoint = `maha_tx_${depth}`;
      client.querySync(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      transactionDepth += 1;
      try {
        const result = fn(...args);
        transactionDepth -= 1;
        client.querySync(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        transactionDepth -= 1;
        try {
          if (depth === 0) client.querySync('ROLLBACK');
          else { client.querySync(`ROLLBACK TO SAVEPOINT ${savepoint}`); client.querySync(`RELEASE SAVEPOINT ${savepoint}`); }
        } catch (_) {}
        throw error;
      }
    };
  },
};

const schema = fs.readFileSync(path.join(__dirname, 'schema.postgres.sql'), 'utf8');
db.exec(schema);
// Safe additive migrations for Supabase projects that may already contain earlier tables.
db.exec(`
  ALTER TABLE utilities ADD COLUMN IF NOT EXISTS employee_id BIGINT REFERENCES employees(id);
  ALTER TABLE utilities ADD COLUMN IF NOT EXISTS payroll_id BIGINT REFERENCES payroll(id);
  ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit_price DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS utilities_deduction_total DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qris_contract_id TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qris_qr_url TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qris_qr_content TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qris_expires_at TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qris_paid_at TEXT;
`);
// Add-on catalog, per-menu eligibility, and transaction-time snapshots.
db.exec(`
  CREATE TABLE IF NOT EXISTS addons (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
    price DOUBLE PRECISION NOT NULL DEFAULT 2000,
    quantity_per_addon DOUBLE PRECISION NOT NULL DEFAULT 1,
    unit TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS menu_addons (
    menu_id BIGINT NOT NULL REFERENCES menu(id), addon_id BIGINT NOT NULL REFERENCES addons(id),
    PRIMARY KEY (menu_id, addon_id)
  );
  CREATE TABLE IF NOT EXISTS transaction_item_addons (
    id BIGSERIAL PRIMARY KEY, transaction_item_id BIGINT NOT NULL REFERENCES transaction_items(id),
    addon_id BIGINT REFERENCES addons(id), addon_name TEXT NOT NULL, quantity INTEGER NOT NULL,
    unit_price DOUBLE PRECISION NOT NULL, inventory_item_id BIGINT REFERENCES inventory_items(id),
    quantity_per_addon DOUBLE PRECISION NOT NULL DEFAULT 1, unit TEXT NOT NULL
  );
`);

  // Seed the four standard Add Ons from inventory formulas; associate new defaults with all active menus.
  const addonDefaults = [
    { name: 'Mozzarella', inventoryName: 'Keju Mozzarella', quantity: 1, price: 2000 },
    { name: 'Nori', inventoryName: 'Nori', quantity: 1, price: 2000 },
    { name: 'Saus Pedas', inventoryName: 'Saus Pedas', quantity: 0.015, price: 2000 },
    { name: 'Chili Oil', inventoryName: 'Chili Oil', quantity: 15, price: 2000 },
  ];
  for (const a of addonDefaults) {
    const inventory = db.prepare('SELECT * FROM inventory_items WHERE LOWER(name)=LOWER(?) AND active=1').get(a.inventoryName);
    if (!inventory) continue;
    let addon = db.prepare('SELECT * FROM addons WHERE LOWER(name)=LOWER(?)').get(a.name);
    if (!addon) {
      const info = db.prepare('INSERT INTO addons (name, inventory_item_id, price, quantity_per_addon, unit, active) VALUES (?,?,?,?,?,1)')
        .run(a.name, inventory.id, a.price, a.quantity, inventory.unit);
      addon = db.prepare('SELECT * FROM addons WHERE id=?').get(info.lastInsertRowid);
      for (const menu of db.prepare('SELECT id FROM menu WHERE active=1').all()) {
        db.prepare('INSERT INTO menu_addons (menu_id, addon_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(menu.id, addon.id);
      }
    }
  }

// Create this index only after the additive migration above, so older Supabase
// projects whose utilities table predates payroll_id can start safely.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_utilities_payroll_recovery ON utilities(payroll_id) WHERE payroll_id IS NOT NULL');

const DEFAULT_SETTINGS = {
  OPENING_TIME: '14:00', CLOSING_TIME: '22:00', BONUS_THRESHOLD_PCS: '150', BONUS_AMOUNT: '25000',
  OVERTIME_RATE_PER_HOUR: '5000', MINIMUM_OVERTIME_MINUTES: '60', LATE_DEDUCTION_METHOD: 'PER_MINUTE',
  LATE_DEDUCTION_RATE: '500', MINIMUM_WORK_HOURS_PER_DAY: '8', ATTENDANCE_RADIUS_METERS: '150',
  ATTENDANCE_LAT: '-6.200000', ATTENDANCE_LNG: '106.816666',
  // Recipe-consumption settings: fixed sauce amount per package; mentai/garlic per dimsum piece.
  CHILI_OIL_GRAMS_PER_4PCS: '15', CHILI_OIL_GRAMS_PER_6PCS: '15',
  SAUCE_PEDAS_GRAMS_PER_4PCS: '15', SAUCE_PEDAS_GRAMS_PER_6PCS: '15',
  SAUCE_MENTAI_GRAMS_PER_PORTION: '30', SAUCE_GARLIC_GRAMS_PER_PORTION: '30',
  QRIS_STATIC_PAYLOAD: '00020101021126740024ID.CO.SPEEDCASH.MERCHANT01189360081530004565900215ID102600456590303UKE51440014ID.CO.QRIS.WWW0215ID10265372041290303UKE5204581253033605802ID5910MAHADIMSUM6008KARAWANG61054137162410509S442602920117202609181941504260703A0163047BA2',
  QRIS_MERCHANT_ID: 'ID1026537204129', QRIS_MERCHANT_NAME: 'MAHADIMSUM', QRIS_CHANNEL_ID: '0002',
  QRIS_TERMINAL_ID: 'A01', QRIS_EXPIRY_SECONDS: '300', QRIS_POLL_INTERVAL_SECONDS: '4', QRIS_RECONCILE_SECONDS: '20',
  QRIS_INTERACTIVE_BASE_URL: 'https://merchant.qris.interactive.co.id', QRIS_INTERACTIVE_USERNAME: '',
  QRIS_INTERACTIVE_PASSWORD: '', QRIS_INTERACTIVE_APP_EMAIL: '', QRIS_INTERACTIVE_APP_PIN: '',
  QRIS_INTERACTIVE_APP_MID: '', QRIS_INTERACTIVE_MERCHANT_ID: '', QRIS_INTERACTIVE_LOGIN_PATH: '/v2/m/login.php',
  QRIS_INTERACTIVE_MERCHANT_PATH: '/api/merchant', QRIS_INTERACTIVE_TRANSACTION_PATH: '/api/transaction',
  QRIS_INTERACTIVE_SESSION_FILE: 'data/qris-interactive-session.json', QRIS_INTERACTIVE_AUTO_RECONCILE: 'true',
};
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value);
}
db.prepare(`DELETE FROM settings WHERE key IN (
  'SAUCE_ML_PER_PORTION_MENTAI','SAUCE_ML_PER_PORTION_PEDAS', 'CHILI_OIL_ML_PER_4PCS','CHILI_OIL_ML_PER_6PCS',
  'QRIS_BASE_URL','QRIS_PARTNER_ID','QRIS_PRIVATE_KEY_PEM','QRIS_PUBLIC_KEY_PEM',
  'QRIS_WINPAY_PUBLIC_KEY_PEM','QRIS_NOTIFY_VERIFY_SIGNATURE'
)`).run();
const legacyMerchant = db.prepare('SELECT value FROM settings WHERE key = ?').get('QRIS_MERCHANT_ID');
if (legacyMerchant && legacyMerchant.value === 'ID1026610181392') {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('ID1026537204129', 'QRIS_MERCHANT_ID');
}
// One-time compatibility migration from previous default recipe quantities.
for (const [key, oldValue, newValue] of [
  ['CHILI_OIL_GRAMS_PER_4PCS', null, '15'], ['CHILI_OIL_GRAMS_PER_6PCS', null, '15'],
  ['SAUCE_PEDAS_GRAMS_PER_4PCS', '40', '15'], ['SAUCE_PEDAS_GRAMS_PER_6PCS', '50', '15'],
]) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && oldValue !== null && String(row.value) === oldValue) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(newValue, key);
}
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`).run(key, String(value));
}
function getAllSettings() { return db.prepare('SELECT key, value, description FROM settings').all(); }
module.exports = { db, getSetting, setSetting, getAllSettings };

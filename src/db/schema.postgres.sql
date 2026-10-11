-- MAHADIMSUM POS PostgreSQL schema for Supabase
CREATE TABLE IF NOT EXISTS roles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS permissions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles(id),
  permission_id BIGINT NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  base_salary DOUBLE PRECISION NOT NULL DEFAULT 50000,
  meal_rate DOUBLE PRECISION NOT NULL DEFAULT 10000,
  transport_rate DOUBLE PRECISION NOT NULL DEFAULT 10000,
  overtime_rate DOUBLE PRECISION NOT NULL DEFAULT 5000,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id BIGINT NOT NULL REFERENCES roles(id),
  employee_id BIGINT REFERENCES employees(id),
  active INTEGER NOT NULL DEFAULT 1,
  allow_negative_stock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS schedules (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  day_of_week INTEGER NOT NULL,
  focus TEXT NOT NULL DEFAULT 'JUALAN',
  start_time TEXT NOT NULL DEFAULT '14:00',
  end_time TEXT NOT NULL DEFAULT '22:00'
);
CREATE TABLE IF NOT EXISTS menu (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  price DOUBLE PRECISION NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  photo TEXT,
  description TEXT,
  unit TEXT NOT NULL DEFAULT 'porsi',
  pcs_per_unit INTEGER NOT NULL DEFAULT 0,
  counts_for_bonus INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS inventory_items (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  minimum_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  restock_frequency TEXT NOT NULL DEFAULT 'WEEKLY',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS recipes (
  id BIGSERIAL PRIMARY KEY,
  menu_id BIGINT NOT NULL REFERENCES menu(id),
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS recipe_items (
  id BIGSERIAL PRIMARY KEY,
  recipe_id BIGINT NOT NULL REFERENCES recipes(id),
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  quantity DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  trx_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  cashier_id BIGINT REFERENCES users(id),
  subtotal DOUBLE PRECISION NOT NULL,
  discount DOUBLE PRECISION NOT NULL DEFAULT 0,
  grand_total DOUBLE PRECISION NOT NULL,
  payment_method TEXT NOT NULL,
  paid_amount DOUBLE PRECISION,
  change_amount DOUBLE PRECISION,
  qris_reference TEXT,
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  type TEXT NOT NULL DEFAULT 'POS',
  manual_entry INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  qris_contract_id TEXT,
  qris_qr_url TEXT,
  qris_qr_content TEXT,
  qris_expires_at TEXT,
  qris_paid_at TEXT
);
CREATE TABLE IF NOT EXISTS transaction_items (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  menu_id BIGINT NOT NULL REFERENCES menu(id),
  recipe_id BIGINT REFERENCES recipes(id),
  quantity INTEGER NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  type TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  before_stock DOUBLE PRECISION NOT NULL,
  after_stock DOUBLE PRECISION NOT NULL,
  reference_id TEXT,
  note TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS attendance (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  check_in TEXT,
  check_out TEXT,
  check_in_lat DOUBLE PRECISION,
  check_in_lng DOUBLE PRECISION,
  check_in_photo TEXT,
  check_in_note TEXT,
  check_out_lat DOUBLE PRECISION,
  check_out_lng DOUBLE PRECISION,
  check_out_photo TEXT,
  check_out_note TEXT,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PRESENT',
  UNIQUE(employee_id, date)
);
CREATE TABLE IF NOT EXISTS payroll (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  base_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  meal_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  transport_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  late_deduction_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  utilities_deduction_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_pay DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  approved_by BIGINT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS utilities (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  type TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  employee_id BIGINT REFERENCES employees(id),
  created_by BIGINT REFERENCES users(id),
  payroll_id BIGINT REFERENCES payroll(id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  module TEXT NOT NULL,
  record_id TEXT,
  old_value TEXT,
  new_value TEXT,
  timestamp TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_trx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_stockmov_item ON stock_movements(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_utilities_date ON utilities(date);

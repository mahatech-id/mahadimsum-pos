// Keep all server-side operational dates/times (POS, attendance, payroll) on WIB.
process.env.TZ = 'Asia/Jakarta';

const express = require('express');
const session = require('express-session');
const path = require('path');
const { db } = require('./db');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const inventoryRoutes = require('./routes/inventory');
const posRoutes = require('./routes/pos');
const attendanceRoutes = require('./routes/attendance');
const adminRoutes = require('./routes/admin');
const { requireAuth } = require('./middleware/rbac');
const { purgeOldYearPayroll } = require('./services/payroll');
const { purgeAuditLogsOlderThanCurrentWeek } = require('./services/audit');
const { startQrisReconciler } = require('./services/qris-sync');


// Production bootstrap: when Render starts with a brand-new/empty PostgreSQL database,
// run the full seed automatically. This makes the deployed app immediately usable
// without opening Render Shell or manually running `npm run seed`.
function ensureProductionData() {
  try {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (Number(userCount) > 0) return;

    const { execFileSync } = require('child_process');
    const seedPath = path.join(__dirname, '..', 'seed', 'seed.js');
    console.log('[bootstrap] Empty database detected. Running production seed...');
    execFileSync(process.execPath, [seedPath], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    console.log('[bootstrap] Production seed completed.');
  } catch (error) {
    console.error('[bootstrap] Failed to initialize production data:', error);
    process.exit(1);
  }
}

ensureProductionData();

const app = express();
purgeOldYearPayroll(); // purge any payroll (and thus payslips) left over from a prior year on startup
purgeAuditLogsOlderThanCurrentWeek(); // keep audit history for the current operational week only
setInterval(() => purgeAuditLogsOlderThanCurrentWeek(), 60 * 60 * 1000).unref();
app.use(express.json({ limit: '25mb' })); // camera photo base64 can be sizeable
app.use(session({
  secret: process.env.SESSION_SECRET || 'mahadimsum-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8h session expiry
}));

app.use('/api/auth', authRoutes);
app.use('/api/menu', requireAuth, menuRoutes);
app.use('/api/inventory', requireAuth, inventoryRoutes);
app.use('/api/pos', requireAuth, posRoutes);
app.use('/api/attendance', requireAuth, attendanceRoutes);
app.use('/api/admin', requireAuth, adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

startQrisReconciler(); // auto-marks QRIS payments PAID from Interactive mutation data, even if the cashier closes the page

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MAHADIMSUM POS & Operations running on http://localhost:${PORT}`));

module.exports = app;

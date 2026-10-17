// Keep all server-side operational dates/times (POS, attendance, payroll) on WIB.
process.env.TZ = 'Asia/Jakarta';

const express = require('express');
const session = require('express-session');
const path = require('path');
const { db } = require('./db');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const addonRoutes = require('./routes/addons');
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

// Keep the live POS catalog aligned with the approved cashier flowchart.
// Existing transaction history is preserved; only active catalog names/categories/prices are synced.
function syncFlowchartMenuCatalog() {
  const catalog = [
    ['Dimsum Satuan','Regular',4000,1],
    ['Dimsum 4pcs','Regular',15000,4], ['Dimsum 6pcs','Regular',22000,6],
    ['Mentai Original 4pcs','Mentai Series',20000,4], ['Mentai Original 6pcs','Mentai Series',28000,6],
    ['Mentai Mozza 4pcs','Mentai Series',25000,4], ['Mentai Mozza 6pcs','Mentai Series',34000,6],
    ['Mentai Nori 4pcs','Mentai Series',25000,4], ['Mentai Nori 6pcs','Mentai Series',34000,6],
    ['Garlic Original 4pcs','Garlic Series',20000,4], ['Garlic Original 6pcs','Garlic Series',28000,6],
    ['Garlic Mozza 4pcs','Garlic Series',25000,4], ['Garlic Mozza 6pcs','Garlic Series',34000,6],
    ['Garlic Nori 4pcs','Garlic Series',25000,4], ['Garlic Nori 6pcs','Garlic Series',34000,6],
    ['Mix Mentai Garlic Original 4pcs','Mix Series',20000,4], ['Mix Mentai Garlic Original 6pcs','Mix Series',28000,6],
    ['Mix Mentai Garlic Mozza 4pcs','Mix Series',25000,4], ['Mix Mentai Garlic Mozza 6pcs','Mix Series',34000,6],
    ['Mix Mentai Garlic Nori 4pcs','Mix Series',25000,4], ['Mix Mentai Garlic Nori 6pcs','Mix Series',34000,6],
    ['Kuah Keju 4pcs','Kuah Keju',20000,4], ['Kuah Keju 6pcs','Kuah Keju',30000,6],
  ];
  try {
    const run = db.transaction(() => {
      for (const [name, category, price, pcs] of catalog) {
        let row = db.prepare('SELECT id FROM menu WHERE LOWER(name)=LOWER(?)').get(name);
        if (!row) {
          const info = db.prepare(`INSERT INTO menu (name,category,price,unit,pcs_per_unit,counts_for_bonus,description,active)
            VALUES (?,?,?,'porsi',?,1,NULL,1)`).run(name,category,price,pcs);
          row = { id: info.lastInsertRowid };
        } else {
          db.prepare('UPDATE menu SET category=?, price=?, pcs_per_unit=?, active=1 WHERE id=?').run(category,price,pcs,row.id);
        }
        // Keep existing standard add-ons selectable on all catalog items.
        db.prepare(`INSERT INTO menu_addons (menu_id,addon_id)
          SELECT ?, id FROM addons WHERE active=1 AND LOWER(name) IN ('mozzarella','nori','saus pedas','chili oil')
          ON CONFLICT DO NOTHING`).run(row.id);
      }
      // Remove duplicate legacy catalog entries while preserving historical transaction rows.
      db.prepare("UPDATE menu SET active=0 WHERE LOWER(name) IN ('dimsum original 4pcs','dimsum original 6pcs')").run();
      // Flowchart defines each of the four optional add-ons at Rp2.000 per quantity.
      db.prepare("UPDATE addons SET price=2000 WHERE active=1 AND LOWER(name) IN ('mozzarella','nori','saus pedas','chili oil')").run();
      // Normalize the old names into the new category labels without renaming historical references.
      db.prepare("UPDATE menu SET category='Regular' WHERE LOWER(name) IN ('dimsum 4pcs','dimsum 6pcs')").run();
      db.prepare("UPDATE menu SET category='Mentai Series', active=0 WHERE LOWER(name) IN ('dimsum mentai original','dimsum mozza','dimsum nori')").run();
      db.prepare("UPDATE menu SET category='Garlic Series', active=0 WHERE LOWER(name)='dimsum garlic original'").run();
      db.prepare("UPDATE menu SET category='Mix Series', active=0 WHERE LOWER(name) LIKE 'dimsum mix mentai garlic%'").run();
      db.prepare("UPDATE menu SET category='Kuah Keju', active=0 WHERE LOWER(name)='dimsum kuah keju'").run();
    });
    run();
  } catch (error) { console.error('[catalog-sync] Flowchart catalog sync failed:', error.message); }
}
syncFlowchartMenuCatalog();

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
app.use('/api/addons', requireAuth, addonRoutes);
app.use('/api/inventory', requireAuth, inventoryRoutes);
app.use('/api/pos', requireAuth, posRoutes);
app.use('/api/attendance', requireAuth, attendanceRoutes);
app.use('/api/admin', requireAuth, adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

startQrisReconciler(); // auto-marks QRIS payments PAID from Interactive mutation data, even if the cashier closes the page

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MAHADIMSUM POS & Operations running on http://localhost:${PORT}`));

module.exports = app;

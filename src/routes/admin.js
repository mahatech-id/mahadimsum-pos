const express = require('express');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { db, getAllSettings, setSetting, getSetting } = require('../db');
const { requirePermission, requireAuth } = require('../middleware/rbac');
const { computePayrollForEmployee, savePayroll, approvePayroll, markPaid, deletePayroll, purgeOldYearPayroll, attendanceSummaryForPeriod } = require('../services/payroll');
const { logAudit } = require('../services/audit');
const { parseCsv } = require('../services/csv');
const { sendSingleSheetXlsx, sendMultiSheetXlsx, readExcelRows, sendTemplateXlsx } = require('../services/excel');
const { streamPayslipPdf } = require('../services/payslip');

const router = express.Router();

// ---- Employees ----
router.get('/employees', requirePermission('employees.manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM employees ORDER BY name').all());
});
router.post('/employees', requirePermission('employees.manage'), (req, res) => {
  const { name, base_salary, meal_rate, transport_rate, overtime_rate } = req.body;
  const info = db.prepare(`INSERT INTO employees (name, base_salary, meal_rate, transport_rate, overtime_rate) VALUES (?,?,?,?,?)`)
    .run(name, base_salary || 50000, meal_rate || 10000, transport_rate || 10000, overtime_rate || 5000);
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'employees', recordId: info.lastInsertRowid, newValue: req.body });
  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid));
});
router.put('/employees/:id', requirePermission('employees.manage'), (req, res) => {
  const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  const fields = ['name', 'base_salary', 'meal_rate', 'transport_rate', 'overtime_rate', 'active'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  const after = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'employees', recordId: req.params.id, oldValue: before, newValue: after });
  res.json(after);
});

// ---- Users & Roles ----
router.get('/users', requirePermission('users.manage'), (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.username, u.active, u.employee_id, r.name as role FROM users u JOIN roles r ON r.id = u.role_id`).all());
});
router.post('/users', requirePermission('users.manage'), (req, res) => {
  const { username, password, role_id, employee_id } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, role_id, employee_id) VALUES (?,?,?,?)')
    .run(username, hash, role_id, employee_id || null);
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'users', recordId: info.lastInsertRowid, newValue: { username, role_id } });
  res.json({ id: info.lastInsertRowid, username });
});
router.put('/users/:id', requirePermission('users.manage'), (req, res) => {
  const { username, password, role_id, active, allow_negative_stock } = req.body;
  if (username) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.params.id);
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  if (role_id !== undefined) db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(role_id, req.params.id);
  if (active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, req.params.id);
  if (allow_negative_stock !== undefined) db.prepare('UPDATE users SET allow_negative_stock = ? WHERE id = ?').run(allow_negative_stock, req.params.id);
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'users', recordId: req.params.id, newValue: req.body });
  res.json({ ok: true });
});

router.delete('/users/:id', requirePermission('users.manage'), (req, res) => {
  const id = req.params.id;
  if (Number(id) === req.session.userId) return res.status(400).json({ error: 'Tidak bisa menghapus akun yang sedang login.' });
  const usedInTrx = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE cashier_id = ?').get(id).c;
  const usedInAudit = db.prepare('SELECT COUNT(*) as c FROM audit_log WHERE actor_id = ?').get(id).c;
  if (usedInTrx > 0 || usedInAudit > 0) {
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'users', recordId: id, newValue: { softDelete: true } });
    return res.json({ ok: true, softDeleted: true, message: 'User dinonaktifkan (memiliki riwayat transaksi/aktivitas, tidak bisa dihapus permanen).' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'users', recordId: id, newValue: { hardDelete: true } });
  res.json({ ok: true, softDeleted: false });
});

router.get('/roles', requirePermission('roles.manage'), (req, res) => {
  const roles = db.prepare('SELECT * FROM roles').all();
  res.json(roles.map(r => ({
    ...r,
    permissions: db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`).all(r.id).map(x => x.code),
  })));
});
router.get('/permissions', requirePermission('roles.manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM permissions ORDER BY code').all());
});
router.put('/roles/:id/permissions', requirePermission('roles.manage'), (req, res) => {
  const { permissionCodes } = req.body;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?');
    for (const code of permissionCodes) ins.run(req.params.id, code);
  });
  run();
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'roles', recordId: req.params.id, newValue: permissionCodes });
  res.json({ ok: true });
});

// ---- Utilities (pengeluaran/pemasukan harian) ----
// employee_id (optional) links an entry to one employee — a DEBIT entry (e.g. kasbon)
// is automatically deducted from that employee's gapok the next time payroll is computed.
router.get('/utilities', requirePermission('utilities.view'), (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT u.*, e.name as employee_name FROM utilities u LEFT JOIN employees e ON e.id = u.employee_id WHERE 1=1`;
  const params = [];
  if (from && to) { sql += ' AND u.date BETWEEN ? AND ?'; params.push(from, to); }
  sql += ' ORDER BY u.date DESC, u.id DESC';
  res.json(db.prepare(sql).all(...params));
});
router.post('/utilities', requirePermission('utilities.manage'), (req, res) => {
  const { date, description, category, type, amount, employee_id } = req.body;
  if (!date || !description || !type || !amount) return res.status(400).json({ error: 'Tanggal, deskripsi, tipe, dan nominal wajib diisi.' });
  if (!['DEBIT', 'KREDIT'].includes(type)) return res.status(400).json({ error: 'Tipe harus DEBIT atau KREDIT.' });
  const info = db.prepare(`INSERT INTO utilities (date, description, category, type, amount, employee_id, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(date, description, category || null, type, Number(amount), employee_id || null, req.session.userId);
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'utilities', recordId: info.lastInsertRowid, newValue: req.body });
  res.json(db.prepare('SELECT * FROM utilities WHERE id = ?').get(info.lastInsertRowid));
});
router.put('/utilities/:id', requirePermission('utilities.manage'), (req, res) => {
  const before = db.prepare('SELECT * FROM utilities WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Data tidak ditemukan.' });
  const fields = ['date', 'description', 'category', 'type', 'amount', 'employee_id'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f] === '' ? null : req.body[f]); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE utilities SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  const after = db.prepare('SELECT * FROM utilities WHERE id = ?').get(req.params.id);
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'utilities', recordId: req.params.id, oldValue: before, newValue: after });
  res.json(after);
});
router.delete('/utilities/:id', requirePermission('utilities.manage'), (req, res) => {
  db.prepare('DELETE FROM utilities WHERE id = ?').run(req.params.id);
  logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'utilities', recordId: req.params.id });
  res.json({ ok: true });
});

router.get('/utilities/bulk/template.xlsx', requirePermission('utilities.manage'), async (req, res) => {
  try {
    await sendTemplateXlsx(res, 'template_bulk_utilities.xlsx', 'Utilities', [
      { header: 'date', key: 'date', width: 14 }, { header: 'description', key: 'description', width: 30 },
      { header: 'category', key: 'category', width: 20 }, { header: 'type', key: 'type', width: 12 },
      { header: 'amount', key: 'amount', width: 16 }, { header: 'employee_name', key: 'employee_name', width: 24 }
    ]);
  } catch (e) { res.status(500).json({ error: 'Gagal membuat template: ' + e.message }); }
});

// Bulk upload utilities via Excel: date,description,category,type,amount,employee_name
router.post('/utilities/bulk', requirePermission('utilities.manage'), async (req, res) => {
  const { csv, xlsxBase64 } = req.body;
  if (!csv && !xlsxBase64) return res.status(400).json({ error: 'File Excel kosong.' });
  let rows;
  try { rows = xlsxBase64 ? await readExcelRows(xlsxBase64) : parseCsv(csv).rows; }
  catch (e) { return res.status(400).json({ error: 'File Excel tidak valid: ' + e.message }); }
  const created = [];
  const errors = [];
  const insert = db.prepare(`INSERT INTO utilities (date, description, category, type, amount, employee_id, created_by) VALUES (?,?,?,?,?,?,?)`);
  const getEmpByName = db.prepare('SELECT id FROM employees WHERE LOWER(name) = LOWER(?)');
  rows.forEach((r, idx) => {
    try {
      const date = r.date, description = r.description, category = r.category || null;
      const type = (r.type || '').toUpperCase();
      const amount = Number(r.amount);
      if (!date || !description || !['DEBIT', 'KREDIT'].includes(type) || !Number.isFinite(amount) || amount <= 0) {
        throw new Error('Data tidak lengkap/valid (date, description, type DEBIT/KREDIT, amount > 0).');
      }
      let employeeId = null;
      if (r.employee_name) {
        const emp = getEmpByName.get(r.employee_name);
        if (!emp) throw new Error(`Karyawan "${r.employee_name}" tidak ditemukan.`);
        employeeId = emp.id;
      }
      const info = insert.run(date, description, category, type, amount, employeeId, req.session.userId);
      created.push(info.lastInsertRowid);
    } catch (e) {
      errors.push({ row: idx + 2, error: e.message });
    }
  });
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'utilities_bulk', newValue: { createdCount: created.length, errorsCount: errors.length } });
  res.json({ createdCount: created.length, errors });
});

// ---- Payroll ----
router.post('/payroll/compute', requirePermission('payroll.manage'), (req, res) => {
  const { employeeId, userIdForSales, periodStart, periodEnd } = req.body;
  try {
    const result = computePayrollForEmployee({ employeeId, userIdForSales, periodStart, periodEnd });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/payroll/save', requirePermission('payroll.manage'), (req, res) => {
  res.json(savePayroll(req.body, req.session.userId));
});
router.post('/payroll/:id/approve', requirePermission('payroll.approve'), (req, res) => {
  try { res.json(approvePayroll({ payrollId: req.params.id, actorId: req.session.userId })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/payroll/:id/mark-paid', requirePermission('payroll.approve'), (req, res) => {
  try { res.json(markPaid({ payrollId: req.params.id, actorId: req.session.userId })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/payroll', requirePermission('payroll.view'), (req, res) => {
  purgeOldYearPayroll(); // defensive: purge previous-year payroll even if server has been running since before New Year
  res.json(db.prepare(`SELECT p.*, e.name as employee_name FROM payroll p JOIN employees e ON e.id = p.employee_id ORDER BY p.id DESC`).all());
});

router.delete('/payroll/:id', requirePermission('payroll.manage'), (req, res) => {
  try {
    res.json(deletePayroll({ payrollId: req.params.id, actorId: req.session.userId }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Staff: list only MY OWN payslips that an admin has already approved/paid (current year —
// payroll from a previous year is auto-purged, see purgeOldYearPayroll).
router.get('/payroll/mine', requirePermission('payroll.view_own'), (req, res) => {
  purgeOldYearPayroll();
  if (!req.session.employeeId) return res.json([]);
  res.json(db.prepare(`SELECT * FROM payroll WHERE employee_id = ? AND status IN ('APPROVED','PAID') ORDER BY period_start DESC`)
    .all(req.session.employeeId));
});

// Payslip PDF — attendance summary, late deduction detail, illustrative utilities
// deduction (total DEBIT utilities in the period split evenly across active employees,
// shown only as an example since utilities aren't tied to individual employees), and
// full earnings breakdown (gapok, uang makan, uang transport, bonus, lembur).
// Accessible by: admin (payroll.view), or the employee themselves viewing their own
// already-approved/paid payslip (payroll.view_own).
router.get('/payroll/:id/payslip', requireAuth, (req, res) => {
  const payroll = db.prepare('SELECT * FROM payroll WHERE id = ?').get(req.params.id);
  if (!payroll) return res.status(404).json({ error: 'Payroll tidak ditemukan.' });

  const perms = db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .all(req.session.roleId).map(r => r.code);
  const isAdmin = perms.includes('payroll.view');
  const isOwnApproved = perms.includes('payroll.view_own') && payroll.employee_id === req.session.employeeId
    && ['APPROVED', 'PAID'].includes(payroll.status);
  if (!isAdmin && !isOwnApproved) return res.status(403).json({ error: 'Tidak memiliki akses ke payslip ini.' });

  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(payroll.employee_id);
  const { workedDays, totalLateMinutes, totalWorkMinutes, totalOvertimeMinutes, overtimePaidMinutes } = attendanceSummaryForPeriod(payroll.employee_id, payroll.period_start, payroll.period_end);
  const utilityDeductionItems = db.prepare(`SELECT date, description, amount FROM utilities
    WHERE employee_id = ? AND type = 'DEBIT' AND date BETWEEN ? AND ?
    ORDER BY date ASC, id ASC`).all(payroll.employee_id, payroll.period_start, payroll.period_end);

  try {
    streamPayslipPdf(res, {
      employeeName: employee.name,
      periodStart: payroll.period_start, periodEnd: payroll.period_end,
      workedDays, totalLateMinutes, totalWorkMinutes, totalOvertimeMinutes, overtimePaidMinutes,
      baseTotal: payroll.base_total, mealTotal: payroll.meal_total, transportTotal: payroll.transport_total,
      bonusTotal: payroll.bonus_total, overtimeTotal: payroll.overtime_total,
      lateDeductionTotal: payroll.late_deduction_total,
      utilitiesDeductionTotal: payroll.utilities_deduction_total,
      utilityDeductionItems,
      netPay: payroll.net_pay,
    });
  } catch (e) {
    res.status(500).json({ error: 'Gagal membuat PDF: ' + e.message });
  }
});

// ---- Settings ----
const RECIPE_CONSUMPTION_SETTINGS = {
  SAUCE_MENTAI_GRAMS_PER_PORTION: { label: 'Saus Mentai — per pcs dimsum', unit: 'g', item: 'Saus Mentai', menus: ['Dimsum Mentai Original'], factor: 0.001, menuMultipliers: { 'Dimsum Mix Mentai Garlic 4pcs': 2, 'Dimsum Mix Mentai Garlic 6pcs': 3 } },
  SAUCE_GARLIC_GRAMS_PER_PORTION: { label: 'Saus Garlic — per pcs dimsum', unit: 'g', item: 'Saus Garlic', menus: ['Dimsum Garlic Original'], factor: 0.001, menuMultipliers: { 'Dimsum Mix Mentai Garlic 4pcs': 2, 'Dimsum Mix Mentai Garlic 6pcs': 3 } },
};
router.get('/settings', requirePermission('settings.manage'), (req, res) => {
  // Never ship QRIS login secrets back to the browser. Recipe config is explicitly labeled with user-facing units.
  const settings = getAllSettings().filter(r => !['SAUCE_ML_PER_PORTION_MENTAI','SAUCE_ML_PER_PORTION_PEDAS', 'CHILI_OIL_GRAMS_PER_4PCS','CHILI_OIL_GRAMS_PER_6PCS','SAUCE_PEDAS_GRAMS_PER_4PCS','SAUCE_PEDAS_GRAMS_PER_6PCS'].includes(r.key));
  const byKey = new Map(settings.map(r => [r.key, r]));
  const recipeSettings = Object.entries(RECIPE_CONSUMPTION_SETTINGS).map(([key, meta]) => ({
    key, value: byKey.get(key)?.value ?? (key.includes('6PCS') ? '15' : key.includes('MENTAI') || key.includes('GARLIC') ? '30' : '15'),
    description: `${meta.label} (${meta.unit})`, label: meta.label, unit: meta.unit, category: 'recipe-consumption'
  }));
  const safeSettings = settings.map(r => ['QRIS_INTERACTIVE_PASSWORD','QRIS_INTERACTIVE_APP_PIN'].includes(r.key) && r.value
    ? { ...r, value: '', configured: true } : r);
  res.json([...recipeSettings, ...safeSettings]);
});
router.put('/settings/:key', requirePermission('settings.manage'), (req, res) => {
  const key = req.params.key;
  const rawValue = String(req.body.value ?? '').trim();
  if (!rawValue || !Number.isFinite(Number(rawValue)) || Number(rawValue) <= 0) {
    if (RECIPE_CONSUMPTION_SETTINGS[key]) return res.status(400).json({ error: 'Takaran harus berupa angka lebih besar dari 0.' });
  }
  // Blank submit on the (masked) private key field must not wipe the stored key.
  if (['QRIS_INTERACTIVE_PASSWORD','QRIS_INTERACTIVE_APP_PIN'].includes(key) && !rawValue) {
    return res.status(400).json({ error: 'Field rahasia kosong — nilai tersimpan tidak dihapus. Masukkan nilai baru untuk menggantinya.' });
  }
  if (RECIPE_CONSUMPTION_SETTINGS[key]) {
    const meta = RECIPE_CONSUMPTION_SETTINGS[key];
    const displayQty = Number(rawValue);
    const storedQty = displayQty * meta.factor;
    const menuPlaceholders = meta.menus.map(() => '?').join(',');
    // Settings is the source of truth: update active recipe BOM rows too, so sales deduction uses the saved value.
    db.prepare(`UPDATE recipe_items SET quantity = ? WHERE inventory_item_id = (SELECT id FROM inventory_items WHERE name = ?) AND recipe_id IN (
      SELECT r.id FROM recipes r JOIN menu m ON m.id = r.menu_id WHERE r.active = 1 AND m.name IN (${menuPlaceholders})
    )`).run(storedQty, meta.item, ...meta.menus);
    for (const [menuName, multiplier] of Object.entries(meta.menuMultipliers || {})) {
      db.prepare(`UPDATE recipe_items SET quantity = ? WHERE inventory_item_id = (SELECT id FROM inventory_items WHERE name = ?) AND recipe_id IN (
        SELECT r.id FROM recipes r JOIN menu m ON m.id = r.menu_id WHERE r.active = 1 AND m.name = ?
      )`).run(storedQty * multiplier, meta.item, menuName);
    }
  }
  setSetting(key, rawValue);
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'settings', recordId: key, newValue: ['QRIS_INTERACTIVE_PASSWORD','QRIS_INTERACTIVE_APP_PIN'].includes(key) ? '[redacted]' : rawValue });
  res.json({ ok: true });
});

// ---- Audit log ----
router.get('/audit-log', requirePermission('audit.view'), (req, res) => {
  // Resolve each activity to its user account and linked employee, including staff accounts.
  res.json(db.prepare(`SELECT a.*, u.username AS actor_username, r.name AS actor_role, e.name AS actor_employee_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN employees e ON e.id = u.employee_id
    ORDER BY a.id DESC LIMIT 500`).all());
});

// ---- Dashboard KPIs (supports optional ?from=&to= date range filter) ----
router.get('/dashboard', requirePermission('dashboard.view'), (req, res) => {
  const today = dayjs().format('YYYY-MM-DD');
  let { from, to } = req.query;
  if (!from || !to) { from = today; to = today; }

  const sumSales = (method) => {
    let sql = `SELECT COALESCE(SUM(grand_total),0) as total, COUNT(*) as cnt FROM transactions WHERE payment_status = 'PAID' AND date BETWEEN ? AND ?`;
    const params = [from, to];
    if (method) { sql += ' AND payment_method = ?'; params.push(method); }
    return db.prepare(sql).get(...params);
  };

  const salesRange = sumSales(null);
  const cashRange = sumSales('CASH').total;
  const qrisRange = sumSales('QRIS').total;

  // Total pcs dimsum terjual — hanya kategori "Dimsum" (Section 5: bonus dihitung dari kategori Dimsum)
  const totalPcs = db.prepare(`SELECT COALESCE(SUM(ti.quantity * m.pcs_per_unit),0) as pcs
    FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id JOIN menu m ON m.id = ti.menu_id
    WHERE t.payment_status='PAID' AND t.date BETWEEN ? AND ? AND m.category = 'Dimsum'`).get(from, to).pcs;

  // Utilities: sum of DEBIT - KREDIT within range
  const utilDebit = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM utilities WHERE type='DEBIT' AND date BETWEEN ? AND ?`).get(from, to).total;
  const utilKredit = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM utilities WHERE type='KREDIT' AND date BETWEEN ? AND ?`).get(from, to).total;

  // Payroll paid whose period overlaps the selected range
  const payrollPaid = db.prepare(`SELECT COALESCE(SUM(net_pay),0) as total FROM payroll
    WHERE status = 'PAID' AND period_start <= ? AND period_end >= ?`).get(to, from).total;

  const totalUtilities = (utilDebit - utilKredit) + payrollPaid;
  const pendapatanBersih = (cashRange + qrisRange) - totalUtilities;

  const bestSellers = db.prepare(`SELECT m.name, SUM(ti.quantity) as qty FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id JOIN menu m ON m.id = ti.menu_id
    WHERE t.payment_status='PAID' AND t.date BETWEEN ? AND ? GROUP BY m.id ORDER BY qty DESC LIMIT 5`).all(from, to);

  const worstSellers = db.prepare(`SELECT m.name, COALESCE(SUM(ti.quantity),0) as qty FROM menu m
    LEFT JOIN transaction_items ti ON ti.menu_id = m.id
    LEFT JOIN transactions t ON t.id = ti.transaction_id AND t.payment_status='PAID' AND t.date BETWEEN ? AND ?
    WHERE m.active = 1 GROUP BY m.id ORDER BY qty ASC LIMIT 5`).all(from, to);

  const { lowStockItems, suggestedRestock } = require('../services/inventory');

  res.json({
    from, to,
    pendapatanBersih, totalUtilities,
    cashTotal: cashRange, qrisTotal: qrisRange, totalPcs,
    salesRange,
    // Backward-compatible fields for existing UI:
    salesToday: sumSales(null), salesWeek: sumSales(null), salesMonth: sumSales(null),
    cashToday: cashRange, qrisToday: qrisRange, totalPcsToday: totalPcs,
    bestSellers, worstSellers,
    lowStock: lowStockItems(),
    restockSuggestions: suggestedRestock(),
  });
});

// ---- Reports ----
router.get('/reports/sales', requirePermission('reports.view'), (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parameter from dan to wajib diisi.' });
  try {
    const rows = db.prepare(`SELECT date, COUNT(*)::int as transactions, COALESCE(SUM(grand_total),0) as revenue
      FROM transactions WHERE payment_status='PAID' AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`).all(from, to);
    res.json(rows);
  } catch (e) { console.error('[reports/sales]', e); res.status(500).json({ error: 'Gagal memuat laporan penjualan.' }); }
});
router.get('/reports/products', requirePermission('reports.view'), (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parameter from dan to wajib diisi.' });
  try {
    const rows = db.prepare(`SELECT m.name, SUM(ti.quantity)::numeric as qty, SUM(ti.quantity*ti.price) as revenue
      FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id JOIN menu m ON m.id=ti.menu_id
      WHERE t.payment_status='PAID' AND t.date BETWEEN ? AND ? GROUP BY m.id, m.name ORDER BY revenue DESC`).all(from, to);
    res.json(rows);
  } catch (e) { console.error('[reports/products]', e); res.status(500).json({ error: 'Gagal memuat laporan produk.' }); }
});

// Profit estimate from active recipe cost and inventory unit prices. Recipe cost reflects current
// unit prices; historical unit prices are not stored on each transaction.
router.get('/reports/profit', requirePermission('reports.view'), (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parameter from dan to wajib diisi.' });
  try {
    const rows = db.prepare(`WITH latest_recipe AS (
        SELECT DISTINCT ON (menu_id) menu_id, id FROM recipes WHERE active = 1 ORDER BY menu_id, version DESC
      ), recipe_cost AS (
        SELECT lr.menu_id, COALESCE(SUM(ri.quantity * COALESCE(ii.unit_price,0)),0) AS unit_hpp
        FROM latest_recipe lr LEFT JOIN recipe_items ri ON ri.recipe_id=lr.id
        LEFT JOIN inventory_items ii ON ii.id=ri.inventory_item_id GROUP BY lr.menu_id
      )
      SELECT m.id AS menu_id, m.name, SUM(ti.quantity)::numeric AS qty,
        SUM(ti.quantity*ti.price) AS revenue, COALESCE(MAX(rc.unit_hpp),0) AS unit_hpp,
        SUM(ti.quantity*COALESCE(rc.unit_hpp,0)) AS total_hpp,
        SUM(ti.quantity*ti.price)-SUM(ti.quantity*COALESCE(rc.unit_hpp,0)) AS gross_profit
      FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id JOIN menu m ON m.id=ti.menu_id
      LEFT JOIN recipe_cost rc ON rc.menu_id=m.id
      WHERE t.payment_status='PAID' AND t.date BETWEEN ? AND ?
      GROUP BY m.id,m.name ORDER BY revenue DESC`).all(from, to);
    const summary = rows.reduce((a, r) => {
      a.qty += Number(r.qty || 0); a.revenue += Number(r.revenue || 0);
      a.hpp += Number(r.total_hpp || 0); a.grossProfit += Number(r.gross_profit || 0);
      return a;
    }, { qty: 0, revenue: 0, hpp: 0, grossProfit: 0 });
    const utilities = db.prepare(`SELECT COALESCE(category, description, 'Lain-lain') AS category,
        SUM(CASE WHEN type='DEBIT' THEN amount ELSE -amount END) AS net_amount
      FROM utilities WHERE date BETWEEN ? AND ? GROUP BY COALESCE(category, description, 'Lain-lain') ORDER BY net_amount DESC`).all(from,to);
    summary.operatingExpenses = utilities.reduce((sum, row) => sum + Number(row.net_amount || 0), 0);
    summary.netProfit = summary.grossProfit - summary.operatingExpenses;
    summary.margin = summary.revenue ? summary.grossProfit / summary.revenue : 0;
    summary.netMargin = summary.revenue ? summary.netProfit / summary.revenue : 0;
    res.json({ rows, summary, utilities });
  } catch (e) { console.error('[reports/profit]', e); res.status(500).json({ error: 'Gagal menghitung HPP/profit. Pastikan migration harga stock sudah berjalan.' }); }
});

router.get('/reports/transactions', requirePermission('reports.view'), (req, res) => {
  const { from, to, paymentMethod, paymentStatus, cashierId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parameter from dan to wajib diisi.' });
  try {
    let sql = `SELECT t.id, t.trx_no, t.date, t.time, u.username as cashier_name, t.grand_total, t.payment_status, t.payment_method, t.type,
        STRING_AGG(m.name || ' x' || ti.quantity::text, ', ' ORDER BY ti.id) as menu_summary
      FROM transactions t LEFT JOIN users u ON u.id=t.cashier_id
      LEFT JOIN transaction_items ti ON ti.transaction_id=t.id LEFT JOIN menu m ON m.id=ti.menu_id
      WHERE t.date BETWEEN ? AND ?`;
    const params = [from, to];
    if (paymentMethod) { sql += ' AND t.payment_method = ?'; params.push(paymentMethod); }
    if (paymentStatus) { sql += ' AND t.payment_status = ?'; params.push(paymentStatus); }
    if (cashierId) { sql += ' AND t.cashier_id = ?'; params.push(cashierId); }
    sql += ' GROUP BY t.id, u.username ORDER BY t.id DESC';
    const rows = db.prepare(sql).all(...params);
    const totalRevenue = rows.filter(r => r.payment_status === 'PAID').reduce((sum, r) => sum + Number(r.grand_total || 0), 0);
    res.json({ rows, summary: { count: rows.length, totalRevenue } });
  } catch (e) { console.error('[reports/transactions]', e); res.status(500).json({ error: 'Gagal memuat detail transaksi.' }); }
});

router.get('/reports/export', requirePermission('reports.view'), async (req, res) => {
  const { from, to, paymentMethod, paymentStatus, cashierId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parameter from dan to wajib diisi.' });
  try {
    const sales = db.prepare(`SELECT date, COUNT(*)::int as transactions, COALESCE(SUM(grand_total),0) as revenue
      FROM transactions WHERE payment_status='PAID' AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`).all(from, to);
    const products = db.prepare(`SELECT m.name, SUM(ti.quantity)::numeric as qty, SUM(ti.quantity*ti.price) as revenue
      FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id JOIN menu m ON m.id=ti.menu_id
      WHERE t.payment_status='PAID' AND t.date BETWEEN ? AND ? GROUP BY m.id,m.name ORDER BY revenue DESC`).all(from, to);
    const profit = db.prepare(`WITH latest_recipe AS (
        SELECT DISTINCT ON (menu_id) menu_id,id FROM recipes WHERE active=1 ORDER BY menu_id,version DESC
      ), recipe_cost AS (
        SELECT lr.menu_id, COALESCE(SUM(ri.quantity*COALESCE(ii.unit_price,0)),0) AS unit_hpp
        FROM latest_recipe lr LEFT JOIN recipe_items ri ON ri.recipe_id=lr.id
        LEFT JOIN inventory_items ii ON ii.id=ri.inventory_item_id GROUP BY lr.menu_id
      )
      SELECT m.name, SUM(ti.quantity)::numeric AS qty, SUM(ti.quantity*ti.price) AS revenue,
        COALESCE(MAX(rc.unit_hpp),0) AS unit_hpp, SUM(ti.quantity*COALESCE(rc.unit_hpp,0)) AS total_hpp,
        SUM(ti.quantity*ti.price)-SUM(ti.quantity*COALESCE(rc.unit_hpp,0)) AS gross_profit
      FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id JOIN menu m ON m.id=ti.menu_id
      LEFT JOIN recipe_cost rc ON rc.menu_id=m.id WHERE t.payment_status='PAID' AND t.date BETWEEN ? AND ?
      GROUP BY m.id,m.name ORDER BY revenue DESC`).all(from,to);
    const utilities = db.prepare(`SELECT date,description,category,type,amount,
        CASE WHEN type='DEBIT' THEN amount ELSE -amount END AS net_amount
      FROM utilities WHERE date BETWEEN ? AND ? ORDER BY date,id`).all(from,to);
    let trxSql = `SELECT t.trx_no,t.date,t.time,u.username AS cashier_name,
      STRING_AGG(m.name || ' x' || ti.quantity::text, ', ' ORDER BY ti.id) AS menu_summary,
      t.payment_method,t.payment_status,t.grand_total FROM transactions t
      LEFT JOIN users u ON u.id=t.cashier_id LEFT JOIN transaction_items ti ON ti.transaction_id=t.id
      LEFT JOIN menu m ON m.id=ti.menu_id WHERE t.date BETWEEN ? AND ?`;
    const trxParams = [from,to];
    if (paymentMethod) { trxSql += ' AND t.payment_method=?'; trxParams.push(paymentMethod); }
    if (paymentStatus) { trxSql += ' AND t.payment_status=?'; trxParams.push(paymentStatus); }
    if (cashierId) { trxSql += ' AND t.cashier_id=?'; trxParams.push(cashierId); }
    trxSql += ' GROUP BY t.id,u.username ORDER BY t.id DESC';
    const trxGrid = db.prepare(trxSql).all(...trxParams);
    const totalRevenue = trxGrid.filter(r => r.payment_status==='PAID').reduce((sum,r)=>sum+Number(r.grand_total||0),0);
    const summaryRevenue = sales.reduce((sum,r)=>sum+Number(r.revenue||0),0);
    const summaryHpp = profit.reduce((sum,r)=>sum+Number(r.total_hpp||0),0);
    const summaryGrossProfit = profit.reduce((sum,r)=>sum+Number(r.gross_profit||0),0);
    const summaryOpex = utilities.reduce((sum,r)=>sum+Number(r.net_amount||0),0);
    const summaryNetProfit = summaryGrossProfit - summaryOpex;
    trxGrid.push({ trx_no:'',date:'',time:'',cashier_name:'',menu_summary:'TOTAL PENDAPATAN (PAID)',payment_method:'',payment_status:'',grand_total:totalRevenue });
    await sendMultiSheetXlsx(res, `report-${from}_to_${to}.xlsx`, [
      { name: 'Ringkasan', columns: [
        { header: 'Indikator', key: 'metric', width: 34 }, { header: 'Nilai', key: 'value', width: 22 }
      ], rows: [
        { metric: 'Periode Mulai', value: from }, { metric: 'Periode Akhir', value: to },
        { metric: 'Total Penjualan PAID', value: summaryRevenue }, { metric: 'Total HPP Estimasi', value: summaryHpp },
        { metric: 'Profit Kotor Estimasi', value: summaryGrossProfit }, { metric: 'Biaya Operasional (net)', value: summaryOpex },
        { metric: 'Profit Bersih Estimasi', value: summaryNetProfit },
        { metric: 'Margin Kotor', value: summaryRevenue ? summaryGrossProfit/summaryRevenue : 0 },
        { metric: 'Margin Bersih', value: summaryRevenue ? summaryNetProfit/summaryRevenue : 0 },
      ] },
      { name: 'Sales per Hari', columns: [
        { header: 'Tanggal', key: 'date', width: 14 }, { header: 'Jumlah Transaksi', key: 'transactions', width: 18 }, { header: 'Revenue', key: 'revenue', width: 16 }
      ], rows: sales },
      { name: 'Per Produk', columns: [
        { header: 'Menu', key: 'name', width: 26 }, { header: 'Qty', key: 'qty', width: 10 }, { header: 'Revenue', key: 'revenue', width: 16 }
      ], rows: products },
      { name: 'Profit & HPP', columns: [
        { header: 'Menu', key: 'name', width: 28 }, { header: 'Qty', key: 'qty', width: 10 }, { header: 'Revenue', key: 'revenue', width: 16 },
        { header: 'HPP/Satuan', key: 'unit_hpp', width: 16 }, { header: 'Total HPP', key: 'total_hpp', width: 16 }, { header: 'Profit Kotor', key: 'gross_profit', width: 16 }
      ], rows: profit },
      { name: 'Biaya Operasional', columns: [
        { header: 'Tanggal', key: 'date', width: 14 }, { header: 'Deskripsi', key: 'description', width: 30 },
        { header: 'Kategori', key: 'category', width: 20 }, { header: 'Tipe', key: 'type', width: 12 },
        { header: 'Nominal', key: 'amount', width: 16 }, { header: 'Dampak Netto', key: 'net_amount', width: 16 }
      ], rows: utilities },
      { name: 'Detail Transaksi', columns: [
        { header: 'No Transaksi', key: 'trx_no', width: 20 }, { header: 'Tanggal', key: 'date', width: 14 }, { header: 'Waktu', key: 'time', width: 12 },
        { header: 'Kasir', key: 'cashier_name', width: 16 }, { header: 'Menu Dibeli', key: 'menu_summary', width: 40 },
        { header: 'Metode Bayar', key: 'payment_method', width: 14 }, { header: 'Status', key: 'payment_status', width: 12 }, { header: 'Total', key: 'grand_total', width: 14 }
      ], rows: trxGrid },
    ]);
  } catch (e) {
    console.error('[reports/export]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat file Excel. Periksa log server untuk detail.' });
  }
});

module.exports = router;

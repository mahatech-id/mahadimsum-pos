const express = require('express');
const { db, getSetting } = require('../db');
const { requirePermission } = require('../middleware/rbac');
const { createTransaction, updateQrisStatus, voidTransaction } = require('../services/pos');
const { parseCsv } = require('../services/csv');
const { sendSingleSheetXlsx, readExcelRows, sendTemplateXlsx } = require('../services/excel');
const { logAudit } = require('../services/audit');
const qris = require('../services/qris');
const { syncFromProvider, settle } = require('../services/qris-sync');

const router = express.Router();

router.post('/checkout', requirePermission('pos.use'), (req, res) => {
  const { items, payment, discount, idempotencyKey } = req.body;
  const user = db.prepare('SELECT allow_negative_stock FROM users WHERE id = ?').get(req.session.userId);
  try {
    const { transaction, idempotent } = createTransaction({
      items, payment, discount, idempotencyKey,
      cashierId: req.session.userId,
      allowNegativeStock: !!user.allow_negative_stock,
    });
    res.json({ transaction, idempotent });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_STOCK') return res.status(409).json({ error: e.message, shortages: e.shortages });
    if (e.code === 'INSUFFICIENT_PAYMENT') return res.status(400).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Admin: manual transaction entry, optionally back-dated or future-dated
router.post('/manual', requirePermission('transactions.manual'), (req, res) => {
  const { items, payment, discount, idempotencyKey, transactionDate, transactionTime } = req.body;
  try {
    const { transaction } = createTransaction({
      items, payment, discount, idempotencyKey, type: 'MANUAL',
      cashierId: req.session.userId, allowNegativeStock: true,
      transactionDate, transactionTime,
    });
    res.json(transaction);
  } catch (e) {
    if (e.code === 'INSUFFICIENT_PAYMENT') return res.status(400).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

router.get('/manual/bulk/template.xlsx', requirePermission('transactions.manual'), async (req, res) => {
  try {
    await sendTemplateXlsx(res, 'template_bulk_transaksi_manual.xlsx', 'Transaksi Manual', [
      { header: 'date', key: 'date', width: 14 }, { header: 'time', key: 'time', width: 12 },
      { header: 'menu_name', key: 'menu_name', width: 30 }, { header: 'quantity', key: 'quantity', width: 12 },
      { header: 'payment_method', key: 'payment_method', width: 16 }, { header: 'paid_amount', key: 'paid_amount', width: 16 },
      { header: 'notes', key: 'notes', width: 30 }
    ]);
  } catch (e) { res.status(500).json({ error: 'Gagal membuat template: ' + e.message }); }
});

// Bulk manual transaction upload via Excel: date,time,menu_name,quantity,payment_method,paid_amount,notes
// Each CSV row creates one separate transaction (single menu item). time/paid_amount optional.
router.post('/manual/bulk', requirePermission('transactions.manual'), async (req, res) => {
  const { csv, xlsxBase64 } = req.body;
  if (!csv && !xlsxBase64) return res.status(400).json({ error: 'File Excel kosong.' });
  let rows;
  try { rows = xlsxBase64 ? await readExcelRows(xlsxBase64) : parseCsv(csv).rows; }
  catch (e) { return res.status(400).json({ error: 'File Excel tidak valid: ' + e.message }); }
  const created = [];
  const errors = [];
  const getMenuByName = db.prepare('SELECT * FROM menu WHERE LOWER(name) = LOWER(?) AND active = 1');

  rows.forEach((r, idx) => {
    try {
      const date = r.date || undefined;
      const time = r.time || undefined;
      const menuName = r.menu_name || r.menu;
      const quantity = Number(r.quantity);
      const method = (r.payment_method || 'CASH').toUpperCase() === 'QRIS' ? 'QRIS' : 'CASH';
      const notes = r.notes || undefined;
      if (!menuName || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('menu_name dan quantity (>0) wajib diisi.');
      }
      const menu = getMenuByName.get(menuName);
      if (!menu) throw new Error(`Menu "${menuName}" tidak ditemukan/aktif.`);

      let payment = { method, status: 'PAID' };
      if (method === 'CASH') {
        const subtotal = menu.price * quantity;
        const paidAmount = r.paid_amount ? Number(r.paid_amount) : subtotal;
        if (!Number.isFinite(paidAmount) || paidAmount < subtotal) {
          throw new Error(`paid_amount (${paidAmount}) kurang dari total (${subtotal}).`);
        }
        payment.paid_amount = paidAmount;
      }
      const { transaction } = createTransaction({
        items: [{ menu_id: menu.id, quantity, notes }],
        payment, type: 'MANUAL', cashierId: req.session.userId, allowNegativeStock: true,
        transactionDate: date, transactionTime: time,
      });
      created.push(transaction.trx_no);
    } catch (e) {
      errors.push({ row: idx + 2, error: e.message });
    }
  });
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'transactions_bulk', newValue: { createdCount: created.length, errorsCount: errors.length } });
  res.json({ createdCount: created.length, errors });
});

router.post('/qris-callback', requirePermission('pos.use'), (req, res) => {
  const { transactionId, status, qrisReference } = req.body;
  try {
    res.json(updateQrisStatus({ transactionId, status, qrisReference, actorId: req.session.userId }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- QRIS dynamic QR (local Static -> Dynamic) ----
// Generate a dynamic QR for an existing PENDING QRIS transaction — the amount is baked into
// the QR itself, so the customer never types a nominal manually. The QR (url/content,
// contractId, expiry) is stored on the transaction: calling this again while the QR is
// still valid returns the SAME locally generated QR instead of rebuilding it.
router.post('/:id/qris/generate', requirePermission('pos.use'), async (req, res) => {
  const trx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!trx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  if (trx.payment_method !== 'QRIS') return res.status(400).json({ error: 'Transaksi ini bukan QRIS.' });
  if (trx.payment_status !== 'PENDING') return res.status(400).json({ error: 'QR hanya bisa dibuat untuk transaksi yang masih PENDING.' });
  try {
    const merchantName = getSetting('QRIS_MERCHANT_NAME');
    if (trx.qris_contract_id && (trx.qris_qr_url || trx.qris_qr_content) && trx.qris_expires_at) {
      const msLeft = new Date(trx.qris_expires_at).getTime() - Date.now();
      if (msLeft > 5000) {
        return res.json({ qrUrl: trx.qris_qr_url, qrContent: trx.qris_qr_content,
          expiresInSeconds: Math.floor(msLeft / 1000), merchantName, reused: true });
      }
      return res.status(409).json({ error: 'QR sudah kadaluarsa. Buat transaksi baru.', code: 'QRIS_EXPIRED' });
    }
    const result = await qris.generateQr({ amount: trx.grand_total, partnerReferenceNo: trx.trx_no });
    db.prepare(`UPDATE transactions SET qris_contract_id = ?, qris_qr_url = ?, qris_qr_content = ?, qris_expires_at = ?,
        qris_reference = COALESCE(?, qris_reference) WHERE id = ?`)
      .run(result.invoiceId || result.contractId, result.qrUrl, result.qrContent, result.expiresAtIso, result.refNo || result.contractId, trx.id);
    logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'qris_generate', recordId: trx.id, newValue: { trxNo: trx.trx_no, contractId: result.contractId } });
    res.json({ qrUrl: result.qrUrl, qrContent: result.qrContent, expiresInSeconds: result.expiresInSeconds, merchantName: result.merchantName || merchantName, invoiceId: result.invoiceId, refNo: result.refNo });
  } catch (e) {
    res.status(e.code === 'QRIS_NOT_CONFIGURED' || e.code === 'QRIS_INTERACTIVE_NOT_CONFIGURED' ? 409 : 502).json({ error: e.message, code: e.code, providerResponse: e.providerResponse });
  }
});

// Poll QRIS Interactive mutation data. When a matching successful payment is found,
// the local transaction flips to PAID and stock is deducted exactly once.
router.get('/:id/qris/status', requirePermission('pos.use'), async (req, res) => {
  const trx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!trx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  if (trx.payment_status !== 'PENDING') return res.json({ transaction: trx, provider: null });
  try {
    const { transaction, provider } = await syncFromProvider(trx.id, { actorId: req.session.userId, source: 'poll' });
    res.json({ transaction, provider });
  } catch (e) {
    // Provider hiccup: report the current local state so the cashier UI keeps waiting
    // (the webhook / reconciler may still mark it PAID in the meantime).
    const current = db.prepare('SELECT * FROM transactions WHERE id = ?').get(trx.id);
    if (current.payment_status !== 'PENDING') return res.json({ transaction: current, provider: null });
    res.status(e.code === 'QRIS_NOT_CONFIGURED' || e.code === 'QRIS_INTERACTIVE_NOT_CONFIGURED' ? 409 : 502).json({ error: e.message, code: e.code });
  }
});

// Cashier cancels a still-unpaid local QR and stops waiting for mutation.
router.post('/:id/qris/cancel', requirePermission('pos.use'), async (req, res) => {
  const trx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!trx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  if (trx.payment_status !== 'PENDING') return res.json(trx); // already PAID/finalized — don't error, don't change it
  // Last-second check: if the customer paid just before the cashier pressed cancel, keep it as PAID.
  try {
    const { transaction } = await syncFromProvider(trx.id, { actorId: req.session.userId, source: 'cancel-check' });
    if (transaction && transaction.payment_status !== 'PENDING') return res.json(transaction);
  } catch (e) { /* provider unreachable — proceed with cancel */ }
  res.json(settle(trx.id, { status: 'CANCELLED', actorId: req.session.userId, source: 'cashier-cancel' }));
});

router.post('/:id/void', requirePermission('transactions.void'), (req, res) => {
  try {
    res.json(voidTransaction({ transactionId: req.params.id, actorId: req.session.userId, reason: req.body.reason }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Staff sees only their own transactions; Admin (has transactions.manual) sees all.
// Supports filters: date / from+to, payment_method, payment_status, cashierId (admin only).
// Returns { rows, summary: { count, totalRevenue } } — totalRevenue sums grand_total of PAID rows only.
router.get('/transactions', requirePermission('transactions.view'), (req, res) => {
  const { date, from, to, cashierId, paymentMethod, paymentStatus } = req.query;
  const perms = db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .all(req.session.roleId).map(r => r.code);
  const isAdminLike = perms.includes('transactions.manual');

  let sql = `SELECT t.*, u.username as cashier_name FROM transactions t
    LEFT JOIN users u ON u.id = t.cashier_id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND t.date = ?'; params.push(date); }
  if (from && to) { sql += ' AND t.date BETWEEN ? AND ?'; params.push(from, to); }
  if (paymentMethod) { sql += ' AND t.payment_method = ?'; params.push(paymentMethod); }
  if (paymentStatus) { sql += ' AND t.payment_status = ?'; params.push(paymentStatus); }
  if (!isAdminLike) { sql += ' AND t.cashier_id = ?'; params.push(req.session.userId); }
  else if (cashierId) { sql += ' AND t.cashier_id = ?'; params.push(cashierId); }
  sql += ' ORDER BY t.id DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  const totalRevenue = rows.filter(r => r.payment_status === 'PAID').reduce((s, r) => s + r.grand_total, 0);
  res.json({ rows, summary: { count: rows.length, totalRevenue } });
});

// Export transactions to .xlsx — respects same visibility rule and filters as GET /transactions
// (must be declared BEFORE /transactions/:id so Express doesn't treat "export" as an :id)
router.get('/transactions/export', requirePermission('transactions.view'), async (req, res) => {
  try {
  const { date, from, to, cashierId, paymentMethod, paymentStatus } = req.query;
  const perms = db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .all(req.session.roleId).map(r => r.code);
  const isAdminLike = perms.includes('transactions.manual');

  let sql = `SELECT t.trx_no, t.date, t.time, u.username as cashier_name, t.payment_method, t.payment_status, t.type,
      STRING_AGG(m.name || ' x' || ti.quantity::text, ', ' ORDER BY ti.id) as menu_summary,
      t.subtotal, t.discount, t.grand_total, t.paid_amount, t.change_amount
    FROM transactions t
    LEFT JOIN users u ON u.id = t.cashier_id
    LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
    LEFT JOIN menu m ON m.id = ti.menu_id
    WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND t.date = ?'; params.push(date); }
  if (from && to) { sql += ' AND t.date BETWEEN ? AND ?'; params.push(from, to); }
  if (paymentMethod) { sql += ' AND t.payment_method = ?'; params.push(paymentMethod); }
  if (paymentStatus) { sql += ' AND t.payment_status = ?'; params.push(paymentStatus); }
  if (!isAdminLike) { sql += ' AND t.cashier_id = ?'; params.push(req.session.userId); }
  else if (cashierId) { sql += ' AND t.cashier_id = ?'; params.push(cashierId); }
  sql += ' GROUP BY t.id, u.username ORDER BY t.id DESC';
  const rows = db.prepare(sql).all(...params);
  const totalRevenue = rows.filter(r => r.payment_status === 'PAID').reduce((s, r) => s + r.grand_total, 0);
  rows.push({
    trx_no: '', date: '', time: '', cashier_name: '', payment_method: '', payment_status: '', type: '',
    menu_summary: 'TOTAL PENDAPATAN (PAID)', subtotal: '', discount: '', grand_total: totalRevenue, paid_amount: '', change_amount: '',
  });

    await sendSingleSheetXlsx(res, `transactions-${date || (from + '_to_' + to) || 'all'}.xlsx`, 'Transactions', [
      { header: 'No Transaksi', key: 'trx_no', width: 20 },
      { header: 'Tanggal', key: 'date', width: 14 },
      { header: 'Waktu', key: 'time', width: 12 },
      { header: 'Kasir', key: 'cashier_name', width: 16 },
      { header: 'Menu Dibeli', key: 'menu_summary', width: 40 },
      { header: 'Subtotal', key: 'subtotal', width: 14 },
      { header: 'Diskon', key: 'discount', width: 12 },
      { header: 'Total', key: 'grand_total', width: 14 },
      { header: 'Dibayar', key: 'paid_amount', width: 14 },
      { header: 'Kembalian', key: 'change_amount', width: 14 },
      { header: 'Metode Bayar', key: 'payment_method', width: 14 },
      { header: 'Status', key: 'payment_status', width: 12 },
      { header: 'Tipe', key: 'type', width: 10 },
    ], rows);
  } catch (e) {
    console.error('[transactions/export]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat file Excel. Periksa log server untuk detail.' });
  }
});

router.get('/transactions/:id', requirePermission('transactions.view'), (req, res) => {
  const trx = db.prepare(`SELECT t.*, u.username as cashier_name FROM transactions t
    LEFT JOIN users u ON u.id = t.cashier_id WHERE t.id = ?`).get(req.params.id);
  if (!trx) return res.status(404).json({ error: 'Tidak ditemukan.' });
  const perms = db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .all(req.session.roleId).map(r => r.code);
  const isAdminLike = perms.includes('transactions.manual');
  if (!isAdminLike && trx.cashier_id !== req.session.userId) {
    return res.status(403).json({ error: 'Anda hanya bisa melihat transaksi Anda sendiri.' });
  }
  const items = db.prepare(`SELECT ti.*, m.name as menu_name FROM transaction_items ti
    JOIN menu m ON m.id = ti.menu_id WHERE ti.transaction_id = ?`).all(req.params.id);
  const itemsWithAddons = items.map(item => ({ ...item, addons: db.prepare('SELECT * FROM transaction_item_addons WHERE transaction_item_id=? ORDER BY addon_name').all(item.id) }));
  res.json({ ...trx, items: itemsWithAddons });
});

router.get('/menu-active', requirePermission('pos.use'), (req, res) => {
  const menus = db.prepare('SELECT * FROM menu WHERE active = 1 ORDER BY category, name').all();
  res.json(menus.map(m => ({ ...m, addons: db.prepare(`SELECT a.id, a.name, a.price, a.quantity_per_addon, a.unit, a.inventory_item_id FROM addons a JOIN menu_addons ma ON ma.addon_id=a.id WHERE ma.menu_id=? AND a.active=1 ORDER BY a.name`).all(m.id) })));
});

// Lightweight cashier list for the transaction filter dropdown (admin-like users only)
router.get('/cashiers', requirePermission('transactions.view'), (req, res) => {
  const perms = db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .all(req.session.roleId).map(r => r.code);
  if (!perms.includes('transactions.manual')) return res.json([]); // staff don't need this
  res.json(db.prepare(`SELECT DISTINCT u.id, u.username FROM users u
    JOIN transactions t ON t.cashier_id = u.id ORDER BY u.username`).all());
});

module.exports = router;

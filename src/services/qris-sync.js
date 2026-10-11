/**
 * Reconciles local QRIS transactions against QRIS Interactive mutation data.
 * There is intentionally NO Winpay/SpeedCash API call in this file.
 */
const { db, getSetting } = require('../db');
const qrisInteractive = require('./qris-interactive');
const { updateQrisStatus } = require('./pos');
const { logAudit } = require('./audit');

function getTrx(id) { return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id); }
function sameAmount(providerValue, expected) {
  const a = Number(providerValue);
  return Number.isFinite(a) && Math.round(a) === Math.round(Number(expected));
}

function settle(trxId, { status, referenceNo, amount, actorId = null, source }) {
  const trx = getTrx(trxId);
  if (!trx || trx.payment_status !== 'PENDING') return trx;
  if (status === 'PAID') {
    if (amount !== undefined && amount !== null && !sameAmount(amount, trx.grand_total)) {
      logAudit({ actorId, action: 'UPDATE', module: 'qris_amount_mismatch', recordId: trx.id,
        newValue: { source, expected: trx.grand_total, providerAmount: amount, referenceNo } });
      return trx;
    }
    try {
      const updated = updateQrisStatus({ transactionId: trx.id, status: 'PAID', qrisReference: referenceNo || null, actorId });
      db.prepare("UPDATE transactions SET qris_paid_at = datetime('now') WHERE id = ?").run(trx.id);
      logAudit({ actorId, action: 'UPDATE', module: 'qris_paid', recordId: trx.id, newValue: { source, referenceNo } });
      return updated;
    } catch { return getTrx(trxId); }
  }
  if (status === 'FAILED' || status === 'CANCELLED') {
    try { return updateQrisStatus({ transactionId: trx.id, status, qrisReference: referenceNo || null, actorId }); }
    catch { return getTrx(trxId); }
  }
  return trx;
}

async function syncFromProvider(trxId, { actorId = null, source = 'poll' } = {}) {
  const trx = getTrx(trxId);
  if (!trx || trx.payment_status !== 'PENDING' || trx.payment_method !== 'QRIS') return { transaction: trx, provider: null };
  if (!trx.qris_qr_content) return { transaction: trx, provider: null };

  let result = null;
  // Provider-generated dynamic invoice: verify this exact invoice/refNo, never match
  // a different transaction merely because it has the same amount.
  if (trx.qris_contract_id && trx.qris_reference) {
    const checked = await qrisInteractive.checkAppInvoicePayment(trx.qris_contract_id, trx.qris_reference, getSetting('QRIS_INTERACTIVE_APP_MID') || getSetting('QRIS_INTERACTIVE_MERCHANT_ID'));
    if (checked && checked.paid) result = { rrn: checked.referenceNo, invoice_id: checked.invoiceId, amount: checked.amount, transaction_id: checked.referenceNo, status: 'success', raw: checked.raw };
    else return { transaction: trx, provider: checked ? checked.raw : null };
  } else {
    result = await qrisInteractive.findSuccessfulPayment({ amount: trx.grand_total, createdAt: trx.created_at, expiresAt: trx.qris_expires_at });
  }
  if (result) {
    const referenceNo = result.rrn || result.invoice_id || result.transaction_id || trx.trx_no;
    // Never let the same provider mutation settle two POS transactions.
    const claimed = db.prepare(`SELECT id FROM transactions
      WHERE payment_status = 'PAID' AND qris_reference = ? AND id <> ? LIMIT 1`).get(String(referenceNo), trx.id);
    if (claimed) return { transaction: trx, provider: null };
    const transaction = settle(trx.id, {
      status: 'PAID',
      referenceNo: String(referenceNo),
      amount: result.amount,
      actorId,
      source,
    });
    return { transaction, provider: result };
  }
  return { transaction: trx, provider: null };
}

let reconcilerRunning = false;
async function reconcilePendingQris() {
  if (reconcilerRunning) return;
  reconcilerRunning = true;
  try {
    if (!getSetting('QRIS_INTERACTIVE_APP_EMAIL')) return;
    const graceSeconds = 120;
    const rows = db.prepare(`SELECT id, qris_expires_at FROM transactions
      WHERE payment_method = 'QRIS' AND payment_status = 'PENDING'
        AND qris_qr_content IS NOT NULL AND created_at >= datetime('now', '-1 day')`).all();
    for (const row of rows) {
      try {
        const { transaction, provider } = await syncFromProvider(row.id, { source: 'reconciler' });
        if (transaction && transaction.payment_status === 'PENDING' && row.qris_expires_at && !provider) {
          const expired = Date.now() > new Date(row.qris_expires_at).getTime() + graceSeconds * 1000;
          if (expired) settle(row.id, { status: 'CANCELLED', source: 'reconciler-expired' });
        }
      } catch (e) {
        logAudit({ actorId: null, action: 'UPDATE', module: 'qris_reconcile_error', recordId: row.id, newValue: { message: e.message } });
      }
    }
  } finally { reconcilerRunning = false; }
}

function startQrisReconciler() {
  const seconds = Math.max(10, Number(getSetting('QRIS_RECONCILE_SECONDS')) || 20);
  const timer = setInterval(() => { reconcilePendingQris().catch(() => {}); }, seconds * 1000);
  timer.unref();
  return timer;
}

module.exports = { settle, syncFromProvider, reconcilePendingQris, startQrisReconciler, sameAmount };

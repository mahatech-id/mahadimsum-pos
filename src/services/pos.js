const { db, getSetting } = require('../db');
const dayjs = require('dayjs');
const { getActiveRecipe, checkSufficientStock, deductForSale, restoreForVoid, applyStockChange } = require('./inventory');
const { logAudit } = require('./audit');

function nextTrxNo() {
  const today = dayjs().format('YYYYMMDD');
  const row = db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE trx_no LIKE ?`).get(`TRX-${today}-%`);
  const seq = String(row.c + 1).padStart(4, '0');
  return `TRX-${today}-${seq}`;
}

const insertTrx = db.prepare(`INSERT INTO transactions
  (trx_no, date, time, cashier_id, subtotal, discount, grand_total, payment_method,
   paid_amount, change_amount, qris_reference, payment_status, type, manual_entry, idempotency_key)
  VALUES (@trx_no,@date,@time,@cashier_id,@subtotal,@discount,@grand_total,@payment_method,
   @paid_amount,@change_amount,@qris_reference,@payment_status,@type,@manual_entry,@idempotency_key)`);

const insertItem = db.prepare(`INSERT INTO transaction_items
  (transaction_id, menu_id, recipe_id, quantity, price, notes)
  VALUES (@transaction_id,@menu_id,@recipe_id,@quantity,@price,@notes)`);

const getMenu = db.prepare('SELECT * FROM menu WHERE id = ?');
const getTrxByIdem = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?');
const insertTrxAddon = db.prepare(`INSERT INTO transaction_item_addons (transaction_item_id, addon_id, addon_name, quantity, unit_price, inventory_item_id, quantity_per_addon, unit) VALUES (?,?,?,?,?,?,?,?)`);
function deductItemAddons(itemId, referenceId, actorId, allowNegative = false) {
  for (const a of db.prepare('SELECT * FROM transaction_item_addons WHERE transaction_item_id=?').all(itemId)) applyStockChange({ inventoryItemId:a.inventory_item_id, type:'SALE', quantity:-(a.quantity*a.quantity_per_addon), referenceId, note:`Add On ${a.addon_name} x${a.quantity}`, actorId, allowNegative });
}
function parseVariants(notes) {
  const match = String(notes || '').match(/\[\[VARIANTS:([^\]]+)\]\]/);
  if (!match) return { variants: [], notes: notes || null };
  try { return { variants: JSON.parse(decodeURIComponent(match[1])), notes: String(notes).replace(match[0], '').trim() || null }; }
  catch { return { variants: [], notes: notes || null }; }
}
function getVariantInventory(name) {
  return db.prepare('SELECT * FROM inventory_items WHERE lower(trim(name)) = lower(?) AND active = 1 ORDER BY id LIMIT 1').get(name);
}
function deductVariants(variants, referenceId, actorId, allowNegative = false) {
  for (const v of variants || []) {
    const qty = Number(v.quantity || 0); if (!Number.isInteger(qty) || qty < 1) continue;
    const inv = getVariantInventory(v.name);
    if (!inv) throw new Error(`Item stok varian \"${v.name}\" belum tersedia di menu Stock.`);
    applyStockChange({ inventoryItemId: inv.id, type:'SALE', quantity:-qty, referenceId, note:`Varian terjual: ${v.name} x${qty}`, actorId, allowNegative });
  }
}

function restoreVariants(variants, referenceId, actorId) {
  for (const v of variants || []) {
    const qty = Number(v.quantity || 0); if (!Number.isInteger(qty) || qty < 1) continue;
    const inv = getVariantInventory(v.name); if (!inv) continue;
    applyStockChange({ inventoryItemId: inv.id, type:'RETURN', quantity:qty, referenceId, note:`Void varian: ${v.name} x${qty}`, actorId, allowNegative:true });
  }
}
function restoreItemAddons(itemId, referenceId, actorId) {
  for (const a of db.prepare('SELECT * FROM transaction_item_addons WHERE transaction_item_id=?').all(itemId)) applyStockChange({ inventoryItemId:a.inventory_item_id, type:'RETURN', quantity:(a.quantity*a.quantity_per_addon), referenceId, note:`Void Add On ${a.addon_name} x${a.quantity}`, actorId, allowNegative:true });
}

/**
 * Create + pay a transaction atomically.
 * items: [{ menu_id, quantity, notes }]
 * payment: { method: 'CASH'|'QRIS', paid_amount?, qris_reference?, status? }
 * transactionDate/transactionTime: optional override (for MANUAL back/forward-dated entries).
 * Rejects if stock insufficient, unless actor has ALLOW_NEGATIVE_STOCK.
 * Rejects CASH payment if paid_amount is less than grand total.
 */
function createTransaction({ items, payment, cashierId, type = 'POS', discount = 0, idempotencyKey, allowNegativeStock = false, transactionDate, transactionTime }) {
  if (idempotencyKey) {
    const existing = getTrxByIdem.get(idempotencyKey);
    if (existing) return { transaction: existing, idempotent: true };
  }
  if (!items || !items.length) throw new Error('Transaksi harus memiliki minimal 1 item.');

  const run = db.transaction(() => {
    // Resolve recipe + price for each item, pinned at sale time (recipe versioning)
    const resolved = items.map(it => {
      const menu = getMenu.get(it.menu_id);
      if (!menu || !menu.active) throw new Error(`Menu ${it.menu_id} tidak tersedia.`);
      const recipe = getActiveRecipe(menu.id);
      const quantity = Number(it.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantity menu harus berupa bilangan bulat minimal 1.');
      const requested = Array.isArray(it.addons) ? it.addons : [];
      const addons = requested.filter(a => Number(a.quantity) > 0).map(a => {
        const q = Number(a.quantity); if (!Number.isInteger(q) || q < 1 || q > 4) throw new Error('Qty setiap Add On maksimal 4.');
        const addon = db.prepare(`SELECT a.* FROM addons a JOIN menu_addons ma ON ma.addon_id=a.id WHERE a.id=? AND ma.menu_id=? AND a.active=1`).get(a.addon_id, menu.id);
        if (!addon) throw new Error(`Add On tidak tersedia untuk menu ${menu.name}.`);
        return { ...addon, quantity: q };
      });
      // All ingredient consumption, including sauces and packaging, is controlled only by the active Recipes BOM.
      // Add Ons are deducted only when the cashier explicitly selects them.
      const allAddons = addons;
      const variants = Array.isArray(it.variants) ? it.variants.filter(v => Number(v.quantity) > 0).map(v => ({ name: String(v.name || ''), quantity: Number(v.quantity) })) : [];
      if (variants.some(v => !['Dimsum','Ekado','Lumpia'].includes(v.name) || !Number.isInteger(v.quantity) || v.quantity < 1)) throw new Error('Pilihan varian Dimsum/Ekado/Lumpia tidak valid.');
      const isSingleMenu = /dimsum satuan/i.test(menu.name);
      if (isSingleMenu && variants.reduce((sum, v) => sum + v.quantity, 0) !== quantity) throw new Error('Total varian Dimsum/Ekado/Lumpia harus sama dengan quantity Dimsum Satuan.');
      const cleanNotes = it.notes || null;
      const savedNotes = `${variants.length ? `[[VARIANTS:${encodeURIComponent(JSON.stringify(variants))}]]` : ''}${isSingleMenu ? ' [[SINGLE_UNIT]]' : ''}${cleanNotes ? ` ${cleanNotes}` : ''}`.trim() || null;
      return { menu, recipe, quantity, notes: savedNotes, addons: allAddons, variants };
    });

    // Stock sufficiency check BEFORE any mutation (unless negative stock allowed)
    if (!allowNegativeStock) {
      for (const r of resolved) {
        if (!r.recipe) continue;
        const shortages = checkSufficientStock(r.recipe.id, r.quantity).filter(s => !/^(dimsum|ekado|lumpia)$/i.test(s.item.trim()));
        if (shortages.length) {
          const s = shortages[0];
          const err = new Error(`Stock ${s.item} tidak mencukupi.`);
          err.code = 'INSUFFICIENT_STOCK';
          err.shortages = shortages;
          throw err;
        }
      }
    }

    if (!allowNegativeStock) {
      const needs = {};
      for (const r of resolved) for (const v of r.variants) needs[v.name] = (needs[v.name] || 0) + v.quantity * (/dimsum satuan/i.test(r.menu.name) ? 1 : r.quantity);
      for (const [name, need] of Object.entries(needs)) {
        const inv = getVariantInventory(name);
        if (!inv) throw new Error(`Item stok varian \"${name}\" belum tersedia di menu Stock.`);
        if (Number(inv.current_stock) < need) { const err = new Error(`Stock ${name} tidak mencukupi (tersedia ${inv.current_stock}, dibutuhkan ${need}).`); err.code='INSUFFICIENT_STOCK'; err.shortages=[{item:name,available:inv.current_stock,need}]; throw err; }
      }
    }

    const subtotal = resolved.reduce((s, r) => s + r.menu.price * r.quantity + r.addons.reduce((a,x)=>a+x.price*x.quantity*r.quantity,0), 0);
    const grandTotal = subtotal - (discount || 0);
    const status = payment.status || (payment.method === 'CASH' ? 'PAID' : 'PENDING');

    // Cash payment validation: paid amount must cover the grand total
    if (payment.method === 'CASH' && status === 'PAID') {
      const paid = Number(payment.paid_amount);
      if (!Number.isFinite(paid) || paid < grandTotal) {
        const err = new Error(`Nominal cash (${paid || 0}) tidak boleh kurang dari total tagihan (${grandTotal}).`);
        err.code = 'INSUFFICIENT_PAYMENT';
        throw err;
      }
    }

    const trxNo = nextTrxNo();
    const now = dayjs();
    const dateStr = transactionDate || now.format('YYYY-MM-DD');
    const timeStr = transactionTime || now.format('HH:mm:ss');
    const info = insertTrx.run({
      trx_no: trxNo,
      date: dateStr,
      time: timeStr,
      cashier_id: cashierId || null,
      subtotal, discount: discount || 0, grand_total: grandTotal,
      payment_method: payment.method,
      paid_amount: payment.paid_amount ?? null,
      change_amount: payment.method === 'CASH' ? (payment.paid_amount - grandTotal) : null,
      qris_reference: payment.qris_reference || null,
      payment_status: status,
      type,
      manual_entry: type === 'MANUAL' ? 1 : 0,
      idempotency_key: idempotencyKey || null,
    });
    const trxId = info.lastInsertRowid;

    for (const r of resolved) {
      const itemInfo = insertItem.run({
        transaction_id: trxId, menu_id: r.menu.id, recipe_id: r.recipe ? r.recipe.id : null,
        quantity: r.quantity, price: r.menu.price, notes: r.notes,
      });
      const trxItemId = itemInfo.lastInsertRowid;
      for (const a of r.addons) insertTrxAddon.run(trxItemId, a.id, a.name, a.quantity * r.quantity, a.price, a.inventory_item_id, a.quantity_per_addon, a.unit);
      // Deduct stock only when transaction becomes PAID (Section 12)
      if (status === 'PAID' && r.recipe) {
        deductForSale({ recipeId: r.recipe.id, qtySold: r.quantity, referenceId: trxNo, actorId: cashierId, allowNegative: allowNegativeStock });
      }
      if (status === 'PAID') {
        deductVariants(r.variants.map(v => ({...v, quantity: v.quantity * (/dimsum satuan/i.test(r.menu.name) ? 1 : r.quantity)})), trxNo, cashierId, allowNegativeStock);
      }
      if (status === 'PAID') deductItemAddons(trxItemId, trxNo, cashierId, allowNegativeStock);
    }

    logAudit({ actorId: cashierId, action: 'CREATE', module: 'transactions', recordId: trxId, newValue: { trxNo, grandTotal, status } });
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(trxId);
  });

  const transaction = run();
  return { transaction, idempotent: false };
}

/** Mark a PENDING QRIS transaction as PAID (deducts stock now) or FAILED/CANCELLED. */
function updateQrisStatus({ transactionId, status, qrisReference, actorId }) {
  const trx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!trx) throw new Error('Transaksi tidak ditemukan.');
  if (trx.payment_status !== 'PENDING') throw new Error('Transaksi ini sudah difinalisasi.');

  const run = db.transaction(() => {
    db.prepare('UPDATE transactions SET payment_status = ?, qris_reference = COALESCE(?, qris_reference) WHERE id = ?')
      .run(status, qrisReference, transactionId);
    if (status === 'PAID') {
      const items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(transactionId);
      for (const it of items) {
        if (it.recipe_id) deductForSale({ recipeId: it.recipe_id, qtySold: it.quantity, referenceId: trx.trx_no, actorId });
        deductVariants(parseVariants(it.notes).variants.map(v => ({...v, quantity: v.quantity * (String(it.notes||'').includes('[[SINGLE_UNIT]]') ? 1 : it.quantity)})), trx.trx_no, actorId, true);
        deductItemAddons(it.id, trx.trx_no, actorId);
      }
    }
    logAudit({ actorId, action: 'UPDATE', module: 'transactions', recordId: transactionId, oldValue: { status: trx.payment_status }, newValue: { status } });
  });
  run();
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
}

/** Void a PAID transaction: restores stock, marks VOID. Idempotent (can't double-void). */
function voidTransaction({ transactionId, actorId, reason }) {
  const trx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!trx) throw new Error('Transaksi tidak ditemukan.');
  if (trx.payment_status === 'VOID') return trx; // idempotent no-op
  if (trx.payment_status !== 'PAID') throw new Error('Hanya transaksi PAID yang dapat di-void.');

  const run = db.transaction(() => {
    const items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(transactionId);
    for (const it of items) {
      if (it.recipe_id) restoreForVoid({ recipeId: it.recipe_id, qtySold: it.quantity, referenceId: trx.trx_no, actorId });
      restoreVariants(parseVariants(it.notes).variants.map(v => ({...v, quantity: v.quantity * (String(it.notes||'').includes('[[SINGLE_UNIT]]') ? 1 : it.quantity)})), trx.trx_no, actorId);
      restoreItemAddons(it.id, trx.trx_no, actorId);
    }
    db.prepare('UPDATE transactions SET payment_status = ? WHERE id = ?').run('VOID', transactionId);
    logAudit({ actorId, action: 'VOID', module: 'transactions', recordId: transactionId, oldValue: { status: 'PAID' }, newValue: { status: 'VOID', reason } });
  });
  run();
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
}

module.exports = { createTransaction, updateQrisStatus, voidTransaction };

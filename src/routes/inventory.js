const express = require('express');
const { db } = require('../db');
const { requirePermission } = require('../middleware/rbac');
const { applyStockChange, suggestedRestock, lowStockItems } = require('../services/inventory');
const { logAudit } = require('../services/audit');
const { parseCsv } = require('../services/csv');
const { readExcelRows, sendTemplateXlsx } = require('../services/excel');

const router = express.Router();

router.get('/', requirePermission('inventory.view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory_items ORDER BY category, name').all());
});

router.post('/', requirePermission('inventory.adjust'), (req, res) => {
  const { name, category, unit, unit_price, current_stock, minimum_stock, target_stock, restock_frequency } = req.body;
  const info = db.prepare(`INSERT INTO inventory_items (name, category, unit, unit_price, current_stock, minimum_stock, target_stock, restock_frequency)
    VALUES (?,?,?,?,?,?,?,?)`).run(name, category, unit, Number(unit_price || 0), current_stock || 0, minimum_stock || 0, target_stock || 0, restock_frequency || 'WEEKLY');
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'inventory', recordId: info.lastInsertRowid, newValue: req.body });
  res.json(db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/bulk/template.xlsx', requirePermission('inventory.adjust'), async (req, res) => {
  try {
    await sendTemplateXlsx(res, 'template_bulk_stock.xlsx', 'Stock', [
      { header: 'name', key: 'name', width: 28 }, { header: 'category', key: 'category', width: 18 },
      { header: 'unit', key: 'unit', width: 12 }, { header: 'unit_price', key: 'unit_price', width: 16 },
      { header: 'current_stock', key: 'current_stock', width: 16 }, { header: 'minimum_stock', key: 'minimum_stock', width: 16 },
      { header: 'target_stock', key: 'target_stock', width: 16 }, { header: 'restock_frequency', key: 'restock_frequency', width: 20 }
    ]);
  } catch (e) { res.status(500).json({ error: 'Gagal membuat template: ' + e.message }); }
});

// Bulk upload/update stock via Excel: name,category,unit,unit_price,current_stock,minimum_stock,target_stock,restock_frequency
// Existing item (matched by name, case-insensitive) is updated in place; stock difference is
// recorded as an audited ADJUSTMENT movement. New names create a new inventory item.
router.post('/bulk', requirePermission('inventory.adjust'), async (req, res) => {
  const { csv, xlsxBase64 } = req.body;
  if (!csv && !xlsxBase64) return res.status(400).json({ error: 'File Excel kosong.' });
  let rows;
  try { rows = xlsxBase64 ? await readExcelRows(xlsxBase64) : parseCsv(csv).rows; }
  catch (e) { return res.status(400).json({ error: 'File Excel tidak valid: ' + e.message }); }
  const created = [];
  const updated = [];
  const errors = [];
  const getByName = db.prepare('SELECT * FROM inventory_items WHERE LOWER(name) = LOWER(?)');
  const insertItem = db.prepare(`INSERT INTO inventory_items (name, category, unit, unit_price, current_stock, minimum_stock, target_stock, restock_frequency)
    VALUES (?,?,?,?,?,?,?,?)`);

  rows.forEach((r, idx) => {
    try {
      const name = r.name;
      const category = r.category || null;
      const unit = r.unit;
      const unitPrice = Number(r.unit_price || 0);
      const currentStock = Number(r.current_stock);
      const minimumStock = Number(r.minimum_stock || 0);
      const targetStock = Number(r.target_stock || 0);
      const restockFrequency = (r.restock_frequency || 'WEEKLY').toUpperCase();
      if (!name || !unit || !Number.isFinite(currentStock) || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error('name, unit, dan current_stock wajib diisi dengan benar.');
      }
      const existing = getByName.get(name);
      if (existing) {
        db.prepare(`UPDATE inventory_items SET category = ?, unit = ?, unit_price = ?, minimum_stock = ?, target_stock = ?, restock_frequency = ? WHERE id = ?`)
          .run(category, unit, unitPrice, minimumStock, targetStock, restockFrequency, existing.id);
        const diff = currentStock - existing.current_stock;
        if (diff !== 0) {
          applyStockChange({
            inventoryItemId: existing.id, type: 'ADJUSTMENT', quantity: diff,
            note: 'Bulk upload update', actorId: req.session.userId, allowNegative: true,
          });
        }
        updated.push(name);
      } else {
        const info = insertItem.run(name, category, unit, unitPrice, currentStock, minimumStock, targetStock, restockFrequency);
        created.push(name);
      }
    } catch (e) {
      errors.push({ row: idx + 2, error: e.message });
    }
  });
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'inventory_bulk', newValue: { createdCount: created.length, updatedCount: updated.length, errorsCount: errors.length } });
  res.json({ createdCount: created.length, updatedCount: updated.length, errors });
});

router.put('/:id', requirePermission('inventory.adjust'), (req, res) => {
  const before = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Item tidak ditemukan.' });
  const fields = ['name', 'category', 'unit', 'unit_price', 'minimum_stock', 'target_stock', 'restock_frequency', 'active'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE inventory_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  const after = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'inventory', recordId: req.params.id, oldValue: before, newValue: after });
  res.json(after);
});

// Manual stock adjustment (Admin) — always audited
router.post('/:id/adjust', requirePermission('inventory.adjust'), (req, res) => {
  const { quantity, type, note } = req.body; // type: ADJUSTMENT|WASTE|CORRECTION|PURCHASE
  try {
    const result = applyStockChange({
      inventoryItemId: req.params.id, type: type || 'ADJUSTMENT', quantity: Number(quantity),
      note, actorId: req.session.userId, allowNegative: true,
    });
    logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'inventory_adjustment', recordId: req.params.id, oldValue: { before: result.before }, newValue: { after: result.after, quantity, type, note } });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requirePermission('inventory.adjust'), (req, res) => {
  const id = req.params.id;
  const usedInRecipe = db.prepare('SELECT COUNT(*) as c FROM recipe_items WHERE inventory_item_id = ?').get(id).c;
  const usedInMovement = db.prepare('SELECT COUNT(*) as c FROM stock_movements WHERE inventory_item_id = ?').get(id).c;
  if (usedInRecipe > 0 || usedInMovement > 0) {
    db.prepare('UPDATE inventory_items SET active = 0 WHERE id = ?').run(id);
    logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'inventory', recordId: id, newValue: { softDelete: true } });
    return res.json({ ok: true, softDeleted: true, message: 'Item dinonaktifkan (sudah dipakai di recipe/pergerakan stock, tidak bisa dihapus permanen).' });
  }
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
  logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'inventory', recordId: id, newValue: { hardDelete: true } });
  res.json({ ok: true, softDeleted: false });
});

router.get('/low-stock', requirePermission('inventory.view'), (req, res) => {
  res.json(lowStockItems());
});

router.get('/movements/:itemId', requirePermission('inventory.view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM stock_movements WHERE inventory_item_id = ? ORDER BY created_at DESC LIMIT 200').all(req.params.itemId));
});

// ---- Restock (Friday Restock Day) ----
router.get('/restock/suggested', requirePermission('restock.view'), (req, res) => {
  res.json(suggestedRestock());
});

router.post('/restock/confirm', requirePermission('restock.manage'), (req, res) => {
  // items: [{ inventory_item_id, quantity }]
  const { items } = req.body;
  const results = items.map(it => applyStockChange({
    inventoryItemId: it.inventory_item_id, type: 'PURCHASE', quantity: Number(it.quantity),
    note: 'Friday restock confirm', actorId: req.session.userId, allowNegative: true,
  }));
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'restock', newValue: items });
  res.json({ ok: true, results });
});

module.exports = router;

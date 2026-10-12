const express = require('express');
const { db } = require('../db');
const { requirePermission } = require('../middleware/rbac');
const { logAudit } = require('../services/audit');
const router = express.Router();

router.get('/', requirePermission('menu.view'), (req, res) => {
  const rows = db.prepare(`SELECT a.*, ii.name AS inventory_name, ii.current_stock, ii.unit AS inventory_unit
    FROM addons a JOIN inventory_items ii ON ii.id=a.inventory_item_id ORDER BY a.name`).all();
  res.json(rows.map(a => ({ ...a, menu_ids: db.prepare('SELECT menu_id FROM menu_addons WHERE addon_id=? ORDER BY menu_id').all(a.id).map(x => x.menu_id) })));
});
router.post('/', requirePermission('menu.manage'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const inventoryItemId = req.body.inventory_item_id;
  const price = Number(req.body.price ?? 2000);
  const quantity = Number(req.body.quantity_per_addon ?? 1);
  const unit = String(req.body.unit || '').trim();
  const menuIds = Array.isArray(req.body.menu_ids) ? req.body.menu_ids : [];
  if (!name || !inventoryItemId || !unit || !Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({error:'Nama, bahan stok, satuan, harga, dan formula harus valid.'});
  const inv = db.prepare('SELECT * FROM inventory_items WHERE id=? AND active=1').get(inventoryItemId);
  if (!inv) return res.status(400).json({error:'Bahan stok tidak ditemukan atau tidak aktif.'});
  if (unit.toLowerCase() !== String(inv.unit).toLowerCase()) return res.status(400).json({error:`Satuan formula harus sama dengan satuan inventory (${inv.unit}).`});
  try {
    const run = db.transaction(() => {
      const info = db.prepare('INSERT INTO addons (name, inventory_item_id, price, quantity_per_addon, unit) VALUES (?,?,?,?,?)').run(name, inventoryItemId, price, quantity, unit);
      for (const mid of menuIds) db.prepare('INSERT INTO menu_addons (menu_id, addon_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(mid, info.lastInsertRowid);
      return info.lastInsertRowid;
    });
    const id = run(); logAudit({actorId:req.session.userId, action:'CREATE', module:'addon', recordId:id, newValue:req.body});
    res.json(db.prepare('SELECT * FROM addons WHERE id=?').get(id));
  } catch (e) { res.status(400).json({error:e.message.includes('unique') ? 'Nama Add On sudah digunakan.' : 'Gagal menyimpan Add On: '+e.message}); }
});
router.put('/:id', requirePermission('menu.manage'), (req, res) => {
  const id = req.params.id; const before = db.prepare('SELECT * FROM addons WHERE id=?').get(id);
  if (!before) return res.status(404).json({error:'Add On tidak ditemukan.'});
  const name = String(req.body.name ?? before.name).trim();
  const inventoryItemId = req.body.inventory_item_id ?? before.inventory_item_id;
  const price = Number(req.body.price ?? before.price); const quantity = Number(req.body.quantity_per_addon ?? before.quantity_per_addon);
  const unit = String(req.body.unit ?? before.unit).trim(); const active = req.body.active === undefined ? before.active : (req.body.active ? 1 : 0);
  const menuIds = Array.isArray(req.body.menu_ids) ? req.body.menu_ids : null;
  const inv = db.prepare('SELECT * FROM inventory_items WHERE id=? AND active=1').get(inventoryItemId);
  if (!inv) return res.status(400).json({error:'Bahan stok tidak ditemukan atau tidak aktif.'});
  if (unit.toLowerCase() !== String(inv.unit).toLowerCase()) return res.status(400).json({error:`Satuan formula harus sama dengan satuan inventory (${inv.unit}).`});
  if (!name || !inventoryItemId || !unit || !Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({error:'Data Add On tidak valid.'});
  try {
    const run = db.transaction(() => {
      db.prepare('UPDATE addons SET name=?, inventory_item_id=?, price=?, quantity_per_addon=?, unit=?, active=? WHERE id=?').run(name, inventoryItemId, price, quantity, unit, active, id);
      if (menuIds) {
        db.prepare('DELETE FROM menu_addons WHERE addon_id=?').run(id);
        for (const mid of menuIds) db.prepare('INSERT INTO menu_addons (menu_id, addon_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(mid, id);
      }
    }); run();
    const after = db.prepare('SELECT * FROM addons WHERE id=?').get(id);
    logAudit({actorId:req.session.userId, action:'UPDATE', module:'addon', recordId:id, oldValue:before, newValue:req.body}); res.json(after);
  } catch (e) { res.status(400).json({error:'Gagal memperbarui Add On: '+e.message}); }
});
module.exports = router;

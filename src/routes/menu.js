const express = require('express');
const { db } = require('../db');
const { requirePermission } = require('../middleware/rbac');
const { logAudit } = require('../services/audit');

const router = express.Router();

router.get('/', requirePermission('menu.view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM menu ORDER BY category, name').all());
});

router.post('/', requirePermission('menu.manage'), (req, res) => {
  const { name, category, price, description, unit, pcs_per_unit, counts_for_bonus, photo } = req.body;
  const info = db.prepare(`INSERT INTO menu (name, category, price, description, unit, pcs_per_unit, counts_for_bonus, photo)
    VALUES (?,?,?,?,?,?,?,?)`).run(name, category, price, description || null, unit || 'porsi', pcs_per_unit || 0, counts_for_bonus == null ? 1 : counts_for_bonus, photo || null);
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'menu', recordId: info.lastInsertRowid, newValue: req.body });
  res.json(db.prepare('SELECT * FROM menu WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', requirePermission('menu.manage'), (req, res) => {
  const before = db.prepare('SELECT * FROM menu WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Menu tidak ditemukan.' });
  const fields = ['name', 'category', 'price', 'active', 'photo', 'description', 'unit', 'pcs_per_unit', 'counts_for_bonus'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE menu SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const after = db.prepare('SELECT * FROM menu WHERE id = ?').get(req.params.id);
  logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'menu', recordId: req.params.id, oldValue: before, newValue: after });
  res.json(after);
});

router.delete('/:id', requirePermission('menu.manage'), (req, res) => {
  const menuId = req.params.id;
  const usedInTrx = db.prepare('SELECT COUNT(*) as c FROM transaction_items WHERE menu_id = ?').get(menuId).c;
  if (usedInTrx > 0) {
    // Menu already used in transactions — soft delete only, to preserve transaction history integrity
    db.prepare('UPDATE menu SET active = 0 WHERE id = ?').run(menuId);
    logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'menu', recordId: menuId, newValue: { softDelete: true } });
    return res.json({ ok: true, softDeleted: true, message: 'Menu dinonaktifkan (sudah pernah dipakai di transaksi, tidak bisa dihapus permanen).' });
  }
  const run = db.transaction(() => {
    const recipeIds = db.prepare('SELECT id FROM recipes WHERE menu_id = ?').all(menuId).map(r => r.id);
    for (const rid of recipeIds) db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(rid);
    db.prepare('DELETE FROM recipes WHERE menu_id = ?').run(menuId);
    db.prepare('DELETE FROM menu WHERE id = ?').run(menuId);
  });
  run();
  logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'menu', recordId: menuId, newValue: { hardDelete: true } });
  res.json({ ok: true, softDeleted: false });
});

// ---- Recipes (versioned) ----
router.get('/:id/recipes', requirePermission('recipe.view'), (req, res) => {
  const recipes = db.prepare('SELECT * FROM recipes WHERE menu_id = ? ORDER BY version DESC').all(req.params.id);
  const withItems = recipes.map(r => ({
    ...r,
    items: db.prepare(`SELECT ri.*, ii.name as item_name FROM recipe_items ri
      JOIN inventory_items ii ON ii.id = ri.inventory_item_id WHERE ri.recipe_id = ?`).all(r.id),
  }));
  res.json(withItems);
});

// Create a NEW version of a recipe (old transactions keep referencing the old version)
router.post('/:id/recipes', requirePermission('recipe.manage'), (req, res) => {
  const { items } = req.body; // [{ inventory_item_id, quantity, unit }]
  const menuId = req.params.id;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Recipe harus memiliki minimal satu bahan.' });
  for (const it of items) {
    const inv = db.prepare('SELECT id, name, unit, active FROM inventory_items WHERE id = ?').get(Number(it.inventory_item_id));
    if (!inv || Number(inv.active) !== 1) return res.status(400).json({ error: 'Pilih bahan inventory yang aktif.' });
    if (/^(dimsum|ekado|lumpia)$/i.test(String(inv.name || '').trim())) return res.status(400).json({ error: 'Dimsum, Ekado, dan Lumpia diatur dari pilihan varian saat transaksi, bukan dari Recipes.' });
    if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return res.status(400).json({ error: 'Takaran bahan recipe harus lebih besar dari nol.' });
  }
  const run = db.transaction(() => {
    const last = db.prepare('SELECT MAX(version) as v FROM recipes WHERE menu_id = ?').get(menuId);
    const newVersion = (last.v || 0) + 1;
    db.prepare('UPDATE recipes SET active = 0 WHERE menu_id = ?').run(menuId);
    const info = db.prepare('INSERT INTO recipes (menu_id, version, active) VALUES (?,?,1)').run(menuId, newVersion);
    const recipeId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO recipe_items (recipe_id, inventory_item_id, quantity, unit) VALUES (?,?,?,?)');
    for (const it of items) insertItem.run(recipeId, it.inventory_item_id, it.quantity, it.unit);
    return recipeId;
  });
  const recipeId = run();
  logAudit({ actorId: req.session.userId, action: 'CREATE', module: 'recipe', recordId: recipeId, newValue: req.body });
  res.json(db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId));
});

router.delete('/recipes/:recipeId', requirePermission('recipe.manage'), (req, res) => {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.recipeId);
  if (!recipe) return res.status(404).json({ error: 'Recipe tidak ditemukan.' });
  if (Number(recipe.active) === 1) return res.status(400).json({ error: 'Recipe aktif tidak dapat dihapus. Edit recipe aktif untuk membuat versi baru terlebih dahulu.' });
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(req.params.recipeId);
    db.prepare('DELETE FROM recipes WHERE id = ? AND active = 0').run(req.params.recipeId);
  });
  remove();
  logAudit({ actorId: req.session.userId, action: 'DELETE', module: 'recipe', recordId: req.params.recipeId, oldValue: recipe });
  res.json({ ok: true, deleted: true });
});

module.exports = router;

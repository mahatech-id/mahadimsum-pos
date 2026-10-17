const { db } = require('../db');
const { logAudit } = require('./audit');

const getItem = db.prepare('SELECT * FROM inventory_items WHERE id = ?');
const updateStock = db.prepare('UPDATE inventory_items SET current_stock = ? WHERE id = ?');
const insertMovement = db.prepare(`INSERT INTO stock_movements
  (inventory_item_id, type, quantity, before_stock, after_stock, reference_id, note, created_by)
  VALUES (@inventory_item_id, @type, @quantity, @before_stock, @after_stock, @reference_id, @note, @created_by)`);

/**
 * Apply a signed quantity change to an inventory item, recording a StockMovement.
 * quantity: negative = deduction (sale), positive = addition (restock/return).
 * Enforces negative-stock protection unless allowNegative=true (must be audited by caller).
 */
function applyStockChange({ inventoryItemId, type, quantity, referenceId, note, actorId, allowNegative = false }) {
  const item = getItem.get(inventoryItemId);
  if (!item) throw new Error(`Inventory item ${inventoryItemId} tidak ditemukan`);
  const before = item.current_stock;
  const after = before + quantity;
  if (after < 0 && !allowNegative) {
    const err = new Error(`Stock ${item.name} tidak mencukupi (tersedia ${before} ${item.unit}).`);
    err.code = 'INSUFFICIENT_STOCK';
    throw err;
  }
  updateStock.run(after, inventoryItemId);
  insertMovement.run({
    inventory_item_id: inventoryItemId,
    type,
    quantity,
    before_stock: before,
    after_stock: after,
    reference_id: referenceId || null,
    note: note || null,
    created_by: actorId || null,
  });
  if (after < 0 && allowNegative) {
    logAudit({
      actorId, action: 'ALLOW_NEGATIVE_STOCK', module: 'inventory', recordId: inventoryItemId,
      oldValue: { before }, newValue: { after },
    });
  }
  return { before, after };
}

function getActiveRecipe(menuId) {
  return db.prepare(`SELECT * FROM recipes WHERE menu_id = ? AND active = 1
    ORDER BY version DESC LIMIT 1`).get(menuId);
}

function getRecipeItems(recipeId) {
  return db.prepare(`SELECT ri.*, ii.name as item_name, ii.unit as item_unit
    FROM recipe_items ri JOIN inventory_items ii ON ii.id = ri.inventory_item_id
    WHERE ri.recipe_id = ?`).all(recipeId);
}

/**
 * Deduct stock for one transaction_item's quantity sold, using the recipe
 * that was pinned to that transaction_item at sale time (recipe versioning:
 * old transactions keep using the recipe version they were created with).
 */
function deductForSale({ recipeId, qtySold, referenceId, actorId, allowNegative }) {
  const items = getRecipeItems(recipeId);
  for (const ri of items) {
    if (/^(dimsum|ekado|lumpia)$/i.test(String(ri.item_name || '').trim())) continue;
    applyStockChange({
      inventoryItemId: ri.inventory_item_id,
      type: 'SALE',
      quantity: -(ri.quantity * qtySold),
      referenceId,
      note: `Sale deduction (recipe #${recipeId})`,
      actorId,
      allowNegative,
    });
  }
}

function restoreForVoid({ recipeId, qtySold, referenceId, actorId }) {
  const items = getRecipeItems(recipeId);
  for (const ri of items) {
    if (/^(dimsum|ekado|lumpia)$/i.test(String(ri.item_name || '').trim())) continue;
    applyStockChange({
      inventoryItemId: ri.inventory_item_id,
      type: 'RETURN',
      quantity: (ri.quantity * qtySold),
      referenceId,
      note: `Void restore (recipe #${recipeId})`,
      actorId,
      allowNegative: true, // restoring stock never fails
    });
  }
}

/** Check (without mutating) whether enough stock exists for a recipe x qty. */
function checkSufficientStock(recipeId, qty) {
  const items = getRecipeItems(recipeId);
  const shortages = [];
  for (const ri of items) {
    const item = getItem.get(ri.inventory_item_id);
    const need = ri.quantity * qty;
    if (item.current_stock - need < 0) {
      shortages.push({ item: item.name, available: item.current_stock, need });
    }
  }
  return shortages;
}

function lowStockItems() {
  return db.prepare(`SELECT * FROM inventory_items WHERE active = 1
    AND current_stock <= minimum_stock ORDER BY (current_stock - minimum_stock) ASC`).all();
}

function suggestedRestock() {
  return lowStockItems().map(i => ({
    ...i,
    suggested_purchase: Math.max(0, i.target_stock - i.current_stock),
  }));
}

module.exports = {
  applyStockChange, getActiveRecipe, getRecipeItems, deductForSale,
  restoreForVoid, checkSufficientStock, lowStockItems, suggestedRestock,
};

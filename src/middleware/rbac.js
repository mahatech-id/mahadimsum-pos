const { db } = require('../db');

// Canonical permission codes (Section 3: Roles / RBAC granular)
const PERMISSIONS = [
  'dashboard.view',
  'pos.use',
  'transactions.view', 'transactions.manual', 'transactions.void',
  'menu.view', 'menu.manage',
  'recipe.view', 'recipe.manage',
  'inventory.view', 'inventory.adjust', 'inventory.allow_negative_stock',
  'restock.view', 'restock.manage',
  'employees.manage',
  'schedule.view', 'schedule.manage',
  'attendance.self', 'attendance.correct',
  'payroll.view', 'payroll.manage', 'payroll.approve', 'payroll.view_own',
  'users.manage',
  'roles.manage',
  'reports.view',
  'settings.manage',
  'audit.view',
  'export.data',
  'utilities.view', 'utilities.manage',
];

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Belum login.' });
  }
  next();
}

function requirePermission(code) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Belum login.' });
    }
    const perms = db.prepare(`
      SELECT p.code FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?`).all(req.session.roleId).map(r => r.code);
    if (!perms.includes(code)) {
      return res.status(403).json({ error: `Tidak memiliki izin: ${code}` });
    }
    next();
  };
}

module.exports = { PERMISSIONS, requireAuth, requirePermission };

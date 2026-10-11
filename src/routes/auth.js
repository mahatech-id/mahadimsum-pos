const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { logAudit } = require('../services/audit');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah.' });
  }
  req.session.userId = user.id;
  req.session.roleId = user.role_id;
  req.session.employeeId = user.employee_id;
  const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(user.role_id);
  req.session.roleName = role.name;
  logAudit({ actorId: user.id, action: 'LOGIN', module: 'auth', recordId: user.id, ip: req.ip });
  res.json({ id: user.id, username: user.username, role: role.name, employeeId: user.employee_id });
});

router.post('/logout', (req, res) => {
  const uid = req.session.userId;
  logAudit({ actorId: uid, action: 'LOGOUT', module: 'auth', recordId: uid, ip: req.ip });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Belum login.' });
  const user = db.prepare('SELECT id, username, role_id, employee_id FROM users WHERE id = ?').get(req.session.userId);
  const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(user.role_id);
  const perms = db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .all(user.role_id).map(r => r.code);
  res.json({ ...user, role: role.name, permissions: perms });
});

module.exports = router;

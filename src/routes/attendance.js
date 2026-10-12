const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/rbac');
const { checkIn, checkOut, correctAttendance, manualEntry } = require('../services/attendance');

const router = express.Router();

router.post('/check-in', requirePermission('attendance.self'), (req, res) => {
  const { lat, lng, photo, note } = req.body;
  const employeeId = req.session.employeeId;
  if (!employeeId) return res.status(400).json({ error: 'User ini tidak terhubung ke data karyawan.' });
  if (!photo) return res.status(400).json({ error: 'Pastikan permission kamera telah diberikan.' });
  try {
    res.json(checkIn({ employeeId, actorId: req.session.userId, lat, lng, photo, note }));
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

router.post('/check-out', requirePermission('attendance.self'), (req, res) => {
  const { lat, lng, photo, note } = req.body;
  const employeeId = req.session.employeeId;
  try {
    res.json(checkOut({ employeeId, actorId: req.session.userId, lat, lng, photo, note }));
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

router.get('/mine', requirePermission('attendance.self'), (req, res) => {
  const rows = db.prepare('SELECT * FROM attendance WHERE employee_id = ? ORDER BY date DESC LIMIT 60').all(req.session.employeeId);
  res.json(rows);
});

router.get('/', requirePermission('attendance.correct'), (req, res) => {
  const { from, to, employeeId } = req.query;
  let sql = `SELECT a.*, e.name as employee_name FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE 1=1`;
  const params = [];
  if (from && to) { sql += ' AND a.date BETWEEN ? AND ?'; params.push(from, to); }
  if (employeeId) { sql += ' AND a.employee_id = ?'; params.push(employeeId); }
  sql += ' ORDER BY a.date DESC';
  res.json(db.prepare(sql).all(...params));
});

router.put('/:id/correct', requirePermission('attendance.correct'), (req, res) => {
  try {
    res.json(correctAttendance({ attendanceId: req.params.id, patch: req.body, actorId: req.session.userId }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Admin manual entry — for an employee who forgot to check in/out. Photo and GPS optional.
router.post('/manual', requirePermission('attendance.correct'), (req, res) => {
  const { employeeId, date, checkIn: checkInTime, checkOut: checkOutTime,
    checkInPhoto, checkOutPhoto, checkInLat, checkInLng, checkOutLat, checkOutLng, note } = req.body;
  try {
    res.json(manualEntry({
      employeeId, date, checkIn: checkInTime, checkOut: checkOutTime,
      checkInPhoto, checkOutPhoto, checkInLat, checkInLng, checkOutLat, checkOutLng,
      note, actorId: req.session.userId,
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Schedule (Admin-editable) ----
router.get('/schedule', requirePermission('schedule.view'), (req, res) => {
  res.json(db.prepare(`SELECT s.*, e.name as employee_name FROM schedules s JOIN employees e ON e.id = s.employee_id ORDER BY day_of_week`).all());
});

router.post('/schedule', requirePermission('schedule.manage'), (req, res) => {
  const { employee_id, day_of_week, focus, start_time, end_time } = req.body;
  const info = db.prepare(`INSERT INTO schedules (employee_id, day_of_week, focus, start_time, end_time) VALUES (?,?,?,?,?)`)
    .run(employee_id, day_of_week, focus || 'JUALAN', start_time || '14:00', end_time || '22:00');
  res.json(db.prepare('SELECT * FROM schedules WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/schedule/:id', requirePermission('schedule.manage'), (req, res) => {
  const before = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  const { employee_id, day_of_week, focus, start_time, end_time } = req.body;
  db.prepare(`UPDATE schedules SET employee_id=COALESCE(?,employee_id), day_of_week=COALESCE(?,day_of_week),
    focus=COALESCE(?,focus), start_time=COALESCE(?,start_time), end_time=COALESCE(?,end_time) WHERE id=?`)
    .run(employee_id, day_of_week, focus, start_time, end_time, req.params.id);
  const after = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  require('../services/audit').logAudit({ actorId: req.session.userId, action: 'UPDATE', module: 'schedule', recordId: req.params.id, oldValue: before, newValue: after });
  res.json(after);
});

router.delete('/schedule/:id', requirePermission('schedule.manage'), (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

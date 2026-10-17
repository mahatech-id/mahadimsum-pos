const { db, getSetting } = require('../db');
const dayjs = require('dayjs');
const { logAudit } = require('./audit');
const { calculateOvertimeMinutes } = require('./attendance-time');
const { computePayrollForEmployee } = require('./payroll');

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function assertWithinRadius(lat, lng) {
  const radius = Number(getSetting('ATTENDANCE_RADIUS_METERS'));
  const storeLat = Number(getSetting('ATTENDANCE_LAT'));
  const storeLng = Number(getSetting('ATTENDANCE_LNG'));
  const dist = haversineMeters(lat, lng, storeLat, storeLng);
  if (dist > radius) {
    const err = new Error('Anda berada di luar area absensi.');
    err.code = 'OUT_OF_RANGE';
    throw err;
  }
}

function checkIn({ employeeId, actorId, lat, lng, photo, note }) {
  if (lat == null || lng == null) {
    const err = new Error('Pastikan Location/GPS aktif lalu coba kembali.');
    err.code = 'GPS_UNAVAILABLE';
    throw err;
  }
  assertWithinRadius(lat, lng);
  const date = dayjs().format('YYYY-MM-DD');
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
  if (existing && existing.check_in) throw new Error('Sudah check-in hari ini.');

  const scheduled = db.prepare('SELECT * FROM schedules WHERE employee_id = ? AND day_of_week = ?')
    .get(employeeId, dayjs().day());
  const now = dayjs();
  let lateMinutes = 0;
  if (scheduled) {
    // CLOCK_IN_TIME is the lateness threshold (13:30 by default); OPENING_TIME
    // is the schedule label shown to staff and is not the lateness threshold.
    const threshold = String(getSetting('CLOCK_IN_TIME') || '13:30').slice(0, 5);
    const [h, m] = threshold.split(':').map(Number);
    const thresholdMoment = dayjs().hour(h).minute(m).second(0).millisecond(0);
    lateMinutes = Math.max(0, now.diff(thresholdMoment, 'minute'));
  }
  const status = lateMinutes > 0 ? 'LATE' : 'PRESENT';

  if (existing) {
    db.prepare(`UPDATE attendance SET check_in=?, check_in_lat=?, check_in_lng=?, check_in_photo=?, check_in_note=?, late_minutes=?, status=? WHERE id=?`)
      .run(now.format('HH:mm:ss'), lat, lng, photo || null, note || null, lateMinutes, status, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance (employee_id, date, check_in, check_in_lat, check_in_lng, check_in_photo, check_in_note, late_minutes, status)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(employeeId, date, now.format('HH:mm:ss'), lat, lng, photo || null, note || null, lateMinutes, status);
  }
  logAudit({ actorId: actorId || null, action: 'CHECK_IN', module: 'attendance', recordId: employeeId, newValue: { employeeId, date, lateMinutes, note } });
  return db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
}

function checkOut({ employeeId, actorId, lat, lng, photo, note }) {
  const date = dayjs().format('YYYY-MM-DD');
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
  if (!existing || !existing.check_in) throw new Error('Belum check-in hari ini.');
  if (existing.check_out) throw new Error('Sudah check-out hari ini.');

  const now = dayjs();
  const schedule = db.prepare('SELECT * FROM schedules WHERE employee_id = ? AND day_of_week = ?')
    .get(employeeId, now.day());
  const overtimeMinutes = calculateOvertimeMinutes({
    date,
    checkOutTime: now.format('HH:mm:ss'),
    scheduledEndTime: schedule && schedule.end_time,
    closingTime: getSetting('CLOSING_TIME'),
    minimumOvertimeMinutes: Number(getSetting('MINIMUM_OVERTIME_MINUTES')),
  });

  db.prepare(`UPDATE attendance SET check_out=?, check_out_lat=?, check_out_lng=?, check_out_photo=?, check_out_note=?, overtime_minutes=? WHERE id=?`)
    .run(now.format('HH:mm:ss'), lat, lng, photo || null, note || null, overtimeMinutes, existing.id);
  logAudit({ actorId: actorId || null, action: 'CHECK_OUT', module: 'attendance', recordId: employeeId, newValue: { employeeId, date, overtimeMinutes, note } });
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
}

/**
 * Admin manual attendance entry — for when an employee forgot to check in/out.
 * Photo and GPS are both optional here (unlike the employee's own self check-in/out,
 * which require them). Auto-computes late/overtime minutes from the schedule the same
 * way the normal check-in/check-out flow does, when the relevant time is provided.
 * Creates the row if it doesn't exist yet for that employee+date, otherwise updates it.
 */
function manualEntry({ employeeId, date, checkIn: checkInTime, checkOut: checkOutTime,
  checkInPhoto, checkOutPhoto, checkInLat, checkInLng, checkOutLat, checkOutLng, note, actorId }) {
  if (!employeeId || !date) throw new Error('Karyawan dan tanggal wajib diisi.');
  const d = dayjs(date);
  if (!d.isValid()) throw new Error('Tanggal tidak valid.');

  let lateMinutes = 0;
  if (checkInTime) {
    const scheduled = db.prepare('SELECT * FROM schedules WHERE employee_id = ? AND day_of_week = ?').get(employeeId, d.day());
    if (scheduled) {
      const threshold = String(getSetting('CLOCK_IN_TIME') || '13:30').slice(0, 5);
      const actual = dayjs(`${date} ${checkInTime}`);
      const [h, m] = threshold.split(':').map(Number);
      const thresholdTime = dayjs(date).hour(h).minute(m).second(0);
      lateMinutes = Math.max(0, actual.diff(thresholdTime, 'minute'));
    }
  }
  let overtimeMinutes = 0;
  if (checkOutTime) {
    const schedule = db.prepare('SELECT * FROM schedules WHERE employee_id = ? AND day_of_week = ?')
      .get(employeeId, d.day());
    overtimeMinutes = calculateOvertimeMinutes({
      date,
      checkOutTime,
      scheduledEndTime: schedule && schedule.end_time,
      closingTime: getSetting('CLOSING_TIME'),
      minimumOvertimeMinutes: Number(getSetting('MINIMUM_OVERTIME_MINUTES')),
    });
  }
  const status = checkInTime ? (lateMinutes > 0 ? 'LATE' : 'PRESENT') : 'ABSENT';

  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
  if (existing) {
    db.prepare(`UPDATE attendance SET
      check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out),
      check_in_photo = COALESCE(?, check_in_photo), check_out_photo = COALESCE(?, check_out_photo),
      check_in_lat = COALESCE(?, check_in_lat), check_in_lng = COALESCE(?, check_in_lng),
      check_out_lat = COALESCE(?, check_out_lat), check_out_lng = COALESCE(?, check_out_lng),
      check_in_note = COALESCE(?, check_in_note), late_minutes = ?, overtime_minutes = ?, status = ?
      WHERE id = ?`)
      .run(checkInTime || null, checkOutTime || null, checkInPhoto || null, checkOutPhoto || null,
        checkInLat ?? null, checkInLng ?? null, checkOutLat ?? null, checkOutLng ?? null,
        note || null, lateMinutes, overtimeMinutes, status, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance
      (employee_id, date, check_in, check_out, check_in_photo, check_out_photo,
       check_in_lat, check_in_lng, check_out_lat, check_out_lng, check_in_note, late_minutes, overtime_minutes, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(employeeId, date, checkInTime || null, checkOutTime || null, checkInPhoto || null, checkOutPhoto || null,
        checkInLat ?? null, checkInLng ?? null, checkOutLat ?? null, checkOutLng ?? null,
        note || null, lateMinutes, overtimeMinutes, status);
  }
  const row = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
  logAudit({ actorId, action: existing ? 'UPDATE' : 'CREATE', module: 'attendance_manual', recordId: row.id, newValue: row });
  return row;
}

/**
 * Purge attendance rows from before the current calendar month. Called at server
 * startup and defensively on each admin attendance list fetch, so a long-running
 * server still purges correctly across a month boundary without a restart.
 * Note: this only removes raw attendance rows — payroll already computed and saved
 * for a past month lives in its own `payroll` table and is unaffected.
 */
function purgeOldMonthAttendance() {
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const oldRows = db.prepare('SELECT id FROM attendance WHERE date < ?').all(monthStart);
  if (!oldRows.length) return 0;
  const del = db.prepare('DELETE FROM attendance WHERE id = ?');
  for (const r of oldRows) del.run(r.id);
  logAudit({ actorId: null, action: 'DELETE', module: 'attendance_month_purge', newValue: { purgedCount: oldRows.length, monthStart } });
  return oldRows.length;
}

function correctAttendance({ attendanceId, patch, actorId }) {
  const before = db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);
  if (!before) throw new Error('Data absensi tidak ditemukan.');

  // A time correction must recalculate derived attendance fields, rather than
  // leaving stale status/late/OT values from the original check-in.
  const checkInTime = patch.check_in !== undefined ? patch.check_in : before.check_in;
  const checkOutTime = patch.check_out !== undefined ? patch.check_out : before.check_out;
  const date = before.date;
  const schedule = db.prepare('SELECT * FROM schedules WHERE employee_id = ? AND day_of_week = ?')
    .get(before.employee_id, dayjs(date).day());
  let lateMinutes = Number(before.late_minutes || 0);
  if (patch.check_in !== undefined) {
    lateMinutes = 0;
    if (checkInTime && schedule) {
      const threshold = String(getSetting('CLOCK_IN_TIME') || '13:30').slice(0, 5);
      const [h, m] = threshold.split(':').map(Number);
      const actual = dayjs(`${date} ${checkInTime}`);
      const thresholdTime = dayjs(date).hour(h).minute(m).second(0);
      lateMinutes = Math.max(0, actual.diff(thresholdTime, 'minute'));
    }
  }
  let overtimeMinutes = Number(before.overtime_minutes || 0);
  if (patch.check_out !== undefined || patch.check_in !== undefined) {
    overtimeMinutes = calculateOvertimeMinutes({
      date,
      checkOutTime,
      scheduledEndTime: schedule && schedule.end_time,
      closingTime: getSetting('CLOSING_TIME'),
      minimumOvertimeMinutes: Number(getSetting('MINIMUM_OVERTIME_MINUTES')),
    });
  }
  const status = checkInTime ? (lateMinutes > 0 ? 'LATE' : 'PRESENT') : 'ABSENT';
  const sets = ['late_minutes = ?', 'overtime_minutes = ?', 'status = ?'];
  const vals = [lateMinutes, overtimeMinutes, status];
  if (patch.check_in !== undefined) { sets.push('check_in = ?'); vals.push(checkInTime || null); }
  if (patch.check_out !== undefined) { sets.push('check_out = ?'); vals.push(checkOutTime || null); }
  vals.push(attendanceId);
  db.prepare(`UPDATE attendance SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const after = db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);

  // Refresh saved, unpaid payroll periods covering this attendance date so a
  // corrected late/OT value flows through to the payslip without changing PAID payroll.
  const payrollRows = db.prepare(`SELECT * FROM payroll WHERE employee_id = ? AND period_start <= ? AND period_end >= ? AND status <> 'PAID'`)
    .all(before.employee_id, date, date);
  const employeeUser = db.prepare('SELECT id FROM users WHERE employee_id = ? ORDER BY id LIMIT 1').get(before.employee_id);
  for (const payrollRow of payrollRows) {
    const result = computePayrollForEmployee({
      employeeId: before.employee_id,
      userIdForSales: employeeUser && employeeUser.id,
      periodStart: payrollRow.period_start,
      periodEnd: payrollRow.period_end,
    });
    db.prepare(`UPDATE payroll SET overtime_total = ?, late_deduction_total = ?, net_pay = ? WHERE id = ? AND status <> 'PAID'`)
      .run(result.overtimeTotal, result.lateDeductionTotal, result.netPay, payrollRow.id);
  }

  logAudit({ actorId, action: 'UPDATE', module: 'attendance', recordId: attendanceId, oldValue: before, newValue: after });
  return after;
}

module.exports = { checkIn, checkOut, correctAttendance, manualEntry, purgeOldMonthAttendance, haversineMeters };

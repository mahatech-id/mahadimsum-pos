const { db, getSetting } = require('../db');
const dayjs = require('dayjs');
const { logAudit } = require('./audit');
const { scheduledShiftMinutes, isLateDeductionApplicable } = require('./attendance-time');

/** Total pcs dimsum sold by an employee (cashier) on one date — only menu with category = 'Dimsum' counts toward bonus. */
function dimsumPcsForDate(employeeUserId, date) {
  const rows = db.prepare(`
    SELECT ti.quantity, m.pcs_per_unit
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    JOIN menu m ON m.id = ti.menu_id
    WHERE t.cashier_id = ? AND t.date = ? AND t.payment_status = 'PAID' AND m.category = 'Dimsum'`).all(employeeUserId, date);
  return rows.reduce((sum, r) => sum + r.quantity * r.pcs_per_unit, 0);
}

/** Shared attendance aggregation for a period — used by payroll calc and the payslip PDF. */
function attendanceSummaryForPeriod(employeeId, periodStart, periodEnd) {
  const attendanceRows = db.prepare(`SELECT * FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?`)
    .all(employeeId, periodStart, periodEnd);
  const workedDays = attendanceRows.filter(a => a.check_in).length;
  const totalLateMinutes = attendanceRows.reduce((s, a) => s + (a.late_minutes || 0), 0);
  // Payroll counts only full 60-minute overtime blocks, including legacy/manual attendance records.
  const totalOvertimeMinutes = attendanceRows.reduce((s, a) => s + Math.floor(Math.max(0, Number(a.overtime_minutes || 0)) / 60) * 60, 0);
  // Total minutes actually worked = (check_out - check_in) summed across days with both timestamps present.
  const totalWorkMinutes = attendanceRows.reduce((sum, a) => {
    if (!a.check_in || !a.check_out) return sum;
    const start = dayjs(`${a.date}T${a.check_in}`);
    let end = dayjs(`${a.date}T${a.check_out}`);
    if (end.isBefore(start)) end = end.add(1, 'day');
    const actualMinutes = Math.max(0, end.diff(start, 'minute'));
    const regularMinutesAfterOvertime = Math.max(0, actualMinutes - Number(a.overtime_minutes || 0));
    const schedule = db.prepare('SELECT start_time, end_time FROM schedules WHERE employee_id = ? AND day_of_week = ?')
      .get(employeeId, dayjs(a.date).day());
    // Report regular working time separately from overtime, capped at the scheduled
    // shift duration (e.g. 14:30-23:30 = 8 regular hours + 1 overtime hour).
    const scheduledMinutes = schedule
      ? scheduledShiftMinutes(schedule.start_time, schedule.end_time)
      : Number(getSetting('MINIMUM_WORK_HOURS_PER_DAY') || 8) * 60;
    return sum + Math.min(regularMinutesAfterOvertime, scheduledMinutes);
  }, 0);
  return { attendanceRows, workedDays, totalLateMinutes, totalOvertimeMinutes, totalWorkMinutes };
}

/** Net utilities effect tied directly to one employee (e.g. kasbon/advance deducted from gapok). */
function employeeUtilitiesDeduction(employeeId, periodStart, periodEnd) {
  const rows = db.prepare(`SELECT amount FROM utilities WHERE employee_id = ? AND type = 'DEBIT' AND date BETWEEN ? AND ?`)
    .all(employeeId, periodStart, periodEnd);
  return rows.reduce((sum, u) => sum + Number(u.amount || 0), 0);
}

/**
 * Compute weekly payroll for one employee over [periodStart, periodEnd] (inclusive, YYYY-MM-DD).
 * Business rules pulled from settings (never hardcoded) per Section 53/54.
 */
function computePayrollForEmployee({ employeeId, userIdForSales, periodStart, periodEnd }) {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) throw new Error('Employee tidak ditemukan.');

  const { attendanceRows, workedDays, totalLateMinutes, totalWorkMinutes } = attendanceSummaryForPeriod(employeeId, periodStart, periodEnd);
  const baseTotal = employee.base_salary * workedDays;
  const mealTotal = employee.meal_rate * workedDays;
  const transportTotal = employee.transport_rate * workedDays;

  const overtimeRatePerHour = employee.overtime_rate || Number(getSetting('OVERTIME_RATE_PER_HOUR'));
  const overtimeTotal = attendanceRows.reduce((sum, a) => sum + Math.floor(Math.max(0, Number(a.overtime_minutes || 0)) / 60) * overtimeRatePerHour, 0);

  // Late deduction: rate is derived from the employee's own gapok/hari (base_salary)
  // divided by the minimum work hours per day — i.e. gapok / (jam_kerja * 60) = Rp per minute.
  // Example: gapok Rp50.000/hari, 8 jam kerja -> Rp50.000 / 480 menit = Rp104,17/menit telat.
  const lateMethod = getSetting('LATE_DEDUCTION_METHOD');
  const minWorkHours = Number(getSetting('MINIMUM_WORK_HOURS_PER_DAY')) || 8;
  const perMinuteRateFromGapok = employee.base_salary / (minWorkHours * 60);
  const flatRate = Number(getSetting('LATE_DEDUCTION_RATE'));
  // Keep the actual late_minutes recorded in attendance, but waive the salary
  // deduction for a day where elapsed clock-in-to-clock-out time reaches the
  // minimum daily work target (e.g. 14:30-22:30 or 14:30-23:00 = at least 8h).
  // If checkout is missing, the target cannot be verified and the normal deduction applies.
  const minimumWorkMinutes = minWorkHours * 60;
  const deductionEligibleLateRows = attendanceRows.filter(a =>
    Number(a.late_minutes || 0) > 0 && isLateDeductionApplicable({
      checkInTime: a.check_in,
      checkOutTime: a.check_out,
      minimumWorkMinutes,
    })
  );
  const deductibleLateMinutes = deductionEligibleLateRows.reduce((sum, a) => sum + Math.max(0, Number(a.late_minutes || 0)), 0);
  let lateDeductionTotal = 0;
  if (lateMethod === 'PER_MINUTE') lateDeductionTotal = deductibleLateMinutes * perMinuteRateFromGapok;
  else if (lateMethod === 'FLAT') lateDeductionTotal = deductionEligibleLateRows.length * flatRate;

  const bonusThreshold = Number(getSetting('BONUS_THRESHOLD_PCS'));
  const bonusAmount = Number(getSetting('BONUS_AMOUNT'));
  let bonusTotal = 0;
  const bonusDays = [];
  for (const a of attendanceRows) {
    const pcs = userIdForSales ? dimsumPcsForDate(userIdForSales, a.date) : 0;
    if (pcs >= bonusThreshold) { bonusTotal += bonusAmount; bonusDays.push({ date: a.date, pcs }); }
  }

  // Utilities tied to this employee (e.g. kasbon/pengeluaran lewat sistem) auto-deduct from gapok.
  const utilitiesDeductionTotal = employeeUtilitiesDeduction(employeeId, periodStart, periodEnd);

  const netPay = baseTotal + mealTotal + transportTotal + bonusTotal + overtimeTotal - lateDeductionTotal - utilitiesDeductionTotal;

  return {
    employeeId, periodStart, periodEnd, workedDays,
    baseTotal, mealTotal, transportTotal, bonusTotal, overtimeTotal, lateDeductionTotal,
    utilitiesDeductionTotal, netPay, bonusDays, totalLateMinutes, totalWorkMinutes,
    lateDeductionRatePerMinute: perMinuteRateFromGapok,
  };
}

function savePayroll(result, actorId) {
  const info = db.prepare(`INSERT INTO payroll
    (employee_id, period_start, period_end, base_total, meal_total, transport_total, bonus_total, overtime_total, late_deduction_total, utilities_deduction_total, net_pay, status)
    VALUES (@employee_id,@period_start,@period_end,@base_total,@meal_total,@transport_total,@bonus_total,@overtime_total,@late_deduction_total,@utilities_deduction_total,@net_pay,'PENDING_APPROVAL')`)
    .run({
      employee_id: result.employeeId, period_start: result.periodStart, period_end: result.periodEnd,
      base_total: result.baseTotal, meal_total: result.mealTotal, transport_total: result.transportTotal,
      bonus_total: result.bonusTotal, overtime_total: result.overtimeTotal, late_deduction_total: result.lateDeductionTotal,
      utilities_deduction_total: result.utilitiesDeductionTotal || 0,
      net_pay: result.netPay,
    });
  logAudit({ actorId, action: 'CREATE', module: 'payroll', recordId: info.lastInsertRowid, newValue: result });
  return db.prepare('SELECT * FROM payroll WHERE id = ?').get(info.lastInsertRowid);
}

function approvePayroll({ payrollId, actorId }) {
  const row = db.prepare('SELECT * FROM payroll WHERE id = ?').get(payrollId);
  if (!row) throw new Error('Payroll tidak ditemukan.');
  if (row.status === 'PAID') throw new Error('Payroll yang sudah PAID terkunci dari edit.');
  db.prepare(`UPDATE payroll SET status = 'APPROVED', approved_by = ? WHERE id = ?`).run(actorId, payrollId);
  logAudit({ actorId, action: 'APPROVE', module: 'payroll', recordId: payrollId, oldValue: { status: row.status }, newValue: { status: 'APPROVED' } });
  return db.prepare('SELECT * FROM payroll WHERE id = ?').get(payrollId);
}

const markPaid = db.transaction(({ payrollId, actorId }) => {
  const row = db.prepare('SELECT * FROM payroll WHERE id = ?').get(payrollId);
  if (!row) throw new Error('Payroll tidak ditemukan.');
  if (row.status !== 'APPROVED') throw new Error('Payroll harus di-approve dahulu.');

  db.prepare(`UPDATE payroll SET status = 'PAID' WHERE id = ?`).run(payrollId);

  // Record recovery of employee kasbon/advances in Utilities only when salary is actually paid.
  // payroll_id + a unique index prevents duplicate credits for the same payroll.
  const deduction = Number(row.utilities_deduction_total || 0);
  if (deduction > 0) {
    const paidDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date());
    db.prepare(`INSERT INTO utilities
      (date, description, category, type, amount, employee_id, created_by, payroll_id)
      VALUES (?, ?, ?, 'KREDIT', ?, ?, ?, ?)
      ON CONFLICT (payroll_id) DO NOTHING`)
      .run(paidDate, `Pengembalian kasbon/potongan gaji (${row.period_start} s.d. ${row.period_end})`,
        'Pengembalian Kasbon Gaji', deduction, row.employee_id, actorId || null, row.id);
  }

  logAudit({ actorId, action: 'UPDATE', module: 'payroll', recordId: payrollId,
    oldValue: { status: 'APPROVED' }, newValue: { status: 'PAID', utilitiesRecoveryCredit: deduction > 0 ? deduction : 0 } });
  return db.prepare('SELECT * FROM payroll WHERE id = ?').get(payrollId);
});

/** Delete a payroll record regardless of status (PENDING_APPROVAL, APPROVED, or PAID). */
function deletePayroll({ payrollId, actorId }) {
  const row = db.prepare('SELECT * FROM payroll WHERE id = ?').get(payrollId);
  if (!row) throw new Error('Payroll tidak ditemukan.');
  db.prepare('DELETE FROM payroll WHERE id = ?').run(payrollId);
  logAudit({ actorId, action: 'DELETE', module: 'payroll', recordId: payrollId, oldValue: row });
  return { ok: true };
}

/**
 * Purge payroll records (and therefore their payslips) belonging to a year before
 * the current one. Called at server startup and defensively on each payroll list
 * fetch, so a long-running server still purges correctly across a New Year boundary
 * without needing a restart.
 */
function purgeOldYearPayroll() {
  const currentYear = new Date().getFullYear();
  const oldRows = db.prepare(`SELECT id FROM payroll WHERE CAST(strftime('%Y', period_end) AS INTEGER) < ?`).all(currentYear);
  if (!oldRows.length) return 0;
  const del = db.prepare('DELETE FROM payroll WHERE id = ?');
  for (const r of oldRows) del.run(r.id);
  logAudit({ actorId: null, action: 'DELETE', module: 'payroll_year_purge', newValue: { purgedCount: oldRows.length, currentYear } });
  return oldRows.length;
}

module.exports = {
  computePayrollForEmployee, savePayroll, approvePayroll, markPaid, deletePayroll,
  purgeOldYearPayroll, dimsumPcsForDate, attendanceSummaryForPeriod, employeeUtilitiesDeduction,
};

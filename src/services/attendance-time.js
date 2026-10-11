// Overtime starts at the scheduled shift end. A full 60 minutes beyond the shift
// end qualifies for one paid overtime hour (subject to MINIMUM_OVERTIME_MINUTES).
const OVERTIME_GRACE_MINUTES = 0;

function minutesFromTime(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function actualWorkedMinutes(checkInTime, checkOutTime) {
  if (!checkInTime || !checkOutTime) return null;
  let start = minutesFromTime(checkInTime);
  let end = minutesFromTime(checkOutTime);
  if (end < start) end += 24 * 60; // overnight shift
  return Math.max(0, end - start);
}

// Late minutes remain recorded for attendance transparency, but are not deducted
// when the employee's elapsed clock-in-to-clock-out time reaches the daily target.
function isLateDeductionApplicable({ checkInTime, checkOutTime, minimumWorkMinutes = 480 }) {
  if (!checkInTime || !checkOutTime) return true; // missing checkout cannot prove target was met
  const worked = actualWorkedMinutes(checkInTime, checkOutTime);
  return worked < Math.max(0, Number(minimumWorkMinutes) || 0);
}

function scheduledShiftMinutes(startTime, endTime) {
  let duration = minutesFromTime(endTime) - minutesFromTime(startTime);
  if (duration < 0) duration += 24 * 60;
  return Math.max(0, duration);
}

function calculateOvertimeMinutes({ checkOutTime, scheduledEndTime, closingTime, minimumOvertimeMinutes = 60 }) {
  if (!checkOutTime) return 0;
  const shiftEndMinutes = minutesFromTime(scheduledEndTime || closingTime || '22:00');
  let checkoutMinutes = minutesFromTime(checkOutTime);
  // Support checkout after midnight while rejecting an ordinary early checkout.
  if (checkoutMinutes < shiftEndMinutes) {
    if (shiftEndMinutes - checkoutMinutes < 12 * 60) return 0;
    checkoutMinutes += 24 * 60;
  }
  const overtimeStartMinutes = shiftEndMinutes + OVERTIME_GRACE_MINUTES;
  const eligibleMinutes = Math.max(0, checkoutMinutes - overtimeStartMinutes);
  const minimumMinutes = Math.max(0, Number(minimumOvertimeMinutes) || 0);
  if (eligibleMinutes < minimumMinutes || eligibleMinutes < 60) return 0;
  // Pay only complete 60-minute blocks; discard any remaining minutes.
  return Math.floor(eligibleMinutes / 60) * 60;
}

module.exports = { OVERTIME_GRACE_MINUTES, minutesFromTime, actualWorkedMinutes, isLateDeductionApplicable, scheduledShiftMinutes, calculateOvertimeMinutes };

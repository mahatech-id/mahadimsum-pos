const assert = require('assert');
const { calculateOvertimeMinutes, scheduledShiftMinutes, actualWorkedMinutes, isLateDeductionApplicable } = require('../src/services/attendance-time');

const base = { date: '2026-10-12', scheduledEndTime: '22:00', closingTime: '22:00', minimumOvertimeMinutes: 60 };
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '23:30' }), 60,
  'Checkout 23:30 yields 90 elapsed overtime minutes, paid as one complete hour');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '23:00' }), 60,
  'Checkout 23:00 is 60 minutes after scheduled end and qualifies for one overtime hour');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '22:30' }), 0,
  'Checkout at scheduled shift end does not qualify for overtime');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '21:00' }), 0,
  'Checkout before scheduled shift end is not treated as next-day overtime');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '23:45' }), 60,
  'Checkout 23:45 yields 105 elapsed overtime minutes but only 60 payable minutes');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '00:00' }), 120,
  'Checkout midnight yields 120 elapsed overtime minutes and pays only 120 minutes');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '00:30' }), 120,
  'Checkout 00:30 yields 150 elapsed overtime minutes and pays two full hours');
assert.strictEqual(calculateOvertimeMinutes({ ...base, checkOutTime: '01:00' }), 180,
  'Checkout 01:00 yields 180 elapsed overtime minutes and pays three full hours');
assert.strictEqual(scheduledShiftMinutes('14:00', '22:00'), 480,
  'Scheduled 14:00-22:00 shift is 8 hours');

assert.strictEqual(actualWorkedMinutes('14:30', '22:30'), 480,
  '14:30-22:30 equals 8 actual working hours');
assert.strictEqual(isLateDeductionApplicable({ checkInTime: '14:30', checkOutTime: '22:00', minimumWorkMinutes: 480 }), true,
  '14:30-22:00 works only 7.5 hours, so late deduction applies');
assert.strictEqual(isLateDeductionApplicable({ checkInTime: '14:30', checkOutTime: '22:30', minimumWorkMinutes: 480 }), false,
  '14:30-22:30 reaches 8 hours, so late deduction is waived');
assert.strictEqual(isLateDeductionApplicable({ checkInTime: '14:30', checkOutTime: '23:00', minimumWorkMinutes: 480 }), false,
  '14:30-23:00 exceeds 8 hours, so late deduction is waived even without payable overtime');
assert.strictEqual(isLateDeductionApplicable({ checkInTime: '14:30', checkOutTime: '23:30', minimumWorkMinutes: 480 }), false,
  '14:30-23:30 reaches 9 elapsed hours, so late deduction is waived');
assert.strictEqual(isLateDeductionApplicable({ checkInTime: '14:30', checkOutTime: null, minimumWorkMinutes: 480 }), true,
  'Missing checkout cannot qualify for the late-deduction waiver');
assert.strictEqual(actualWorkedMinutes('22:00', '06:00'), 480,
  'Overnight shift duration is calculated correctly');

console.log('PASS overtime full-hour blocks and late-deduction waiver policy tests.');

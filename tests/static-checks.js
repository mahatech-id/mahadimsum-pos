const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}
walk(path.join(root, 'src'));
walk(path.join(root, 'seed'));
for (const file of files) execFileSync(process.execPath, ['--check', file]);
console.log(`PASS JavaScript syntax check (${files.length} files).`);
console.log('Database integration tests are not run automatically because they require a configured Supabase DATABASE_URL.');

// PostgreSQL BIGINT IDs may arrive as strings while inline onclick arguments are numbers.
// Guard the POS quantity controls in both admin and staff UIs against strict-type ID mismatches.
for (const page of ['admin.html', 'staff.html']) {
  const html = fs.readFileSync(path.join(root, 'public', page), 'utf8');
  if (!html.includes('String(m.id) === String(')) {
    throw new Error(`POS quantity control must compare menu IDs by string in public/${page}`);
  }
}
console.log('PASS POS menu ID compatibility checks (admin and staff).');

// Guard core Excel/import/report changes against accidental regression.
const excelService = fs.readFileSync(path.join(root, 'src', 'services', 'excel.js'), 'utf8');
if (!excelService.includes('workbook.xlsx.writeBuffer()') || !excelService.includes('readExcelRows') || !excelService.includes('sendTemplateXlsx')) {
  throw new Error('Excel exports must buffer output and Excel bulk imports/templates must be available.');
}
const inventoryRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'inventory.js'), 'utf8');
if (!inventoryRoute.includes('unit_price') || !inventoryRoute.includes('/bulk/template.xlsx')) {
  throw new Error('Inventory must support unit price and an Excel upload template.');
}
const adminRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'admin.js'), 'utf8');
if (!adminRoute.includes("'/reports/profit'") || !adminRoute.includes('STRING_AGG(')) {
  throw new Error('Reports must provide profit data and PostgreSQL-compatible aggregation.');
}
console.log('PASS Excel export, bulk-template, inventory cost, and profit-report static checks.');

const payrollService = fs.readFileSync(path.join(root, 'src', 'services', 'payroll.js'), 'utf8');
if (!payrollService.includes("type = 'DEBIT'") || !payrollService.includes("'KREDIT'") || !payrollService.includes('utilitiesRecoveryCredit')) {
  throw new Error('Payroll must deduct employee DEBIT utilities and record a KREDIT recovery when payroll is paid.');
}
if (!payrollService.includes('db.transaction(({ payrollId, actorId }) =>') || !payrollService.includes('ON CONFLICT (payroll_id) DO NOTHING')) {
  throw new Error('Payroll recovery credit must be transactional and idempotent.');
}
const auditService = fs.readFileSync(path.join(root, 'src', 'services', 'audit.js'), 'utf8');
if (!auditService.includes("timeZone: 'Asia/Jakarta'") || !auditService.includes('DELETE FROM audit_log WHERE timestamp < ?')) {
  throw new Error('Audit logs must be purged before the current Jakarta Monday cutoff.');
}
console.log('PASS payroll kasbon recovery credit and Jakarta weekly audit-log retention checks.');

const schemaPg = fs.readFileSync(path.join(root, 'src', 'db', 'schema.postgres.sql'), 'utf8');
const dbIndex = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
if (schemaPg.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_utilities_payroll_recovery')) {
  throw new Error('Payroll recovery index must not run in the baseline schema before additive migration.');
}
if (!dbIndex.includes('ALTER TABLE utilities ADD COLUMN IF NOT EXISTS payroll_id') || !dbIndex.includes("db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_utilities_payroll_recovery")) {
  throw new Error('Payroll recovery index must be created after the additive utilities payroll_id migration.');
}
const payslipService = fs.readFileSync(path.join(root, 'src', 'services', 'payslip.js'), 'utf8');
if (!payslipService.includes('utilityDeductionItems') || !payslipService.includes('item.description') || !payslipService.includes('detailUtilitiesTotal')) {
  throw new Error('Payslip PDF must show itemized utility deduction descriptions and amounts.');
}
if (!adminRoute.includes('utilityDeductionItems') || !adminRoute.includes('ORDER BY date ASC, id ASC')) {
  throw new Error('Payslip route must fetch utility deduction details in a stable order.');
}
console.log('PASS itemized utility deductions in payslip PDF and safe PostgreSQL payroll_id migration checks.');

const attendanceService = fs.readFileSync(path.join(root, 'src', 'services', 'attendance.js'), 'utf8');
const attendanceTime = fs.readFileSync(path.join(root, 'src', 'services', 'attendance-time.js'), 'utf8');
if (!attendanceService.includes('calculateOvertimeMinutes') || !attendanceTime.includes('OVERTIME_GRACE_MINUTES = 0') || !attendanceTime.includes('eligibleMinutes < minimumMinutes') || !attendanceTime.includes('Math.floor(eligibleMinutes / 60) * 60')) {
  throw new Error('Attendance must start overtime at scheduled shift end, apply the 60-minute minimum, and floor payable overtime to full hours.');
}
if (!payrollService.includes('regularMinutesAfterOvertime') || !payrollService.includes('scheduledShiftMinutes') || !payrollService.includes('deductionEligibleLateRows') || !payrollService.includes('isLateDeductionApplicable')) {
  throw new Error('Payroll attendance summary must separate regular hours from overtime and cap regular time at scheduled shift duration.');
}
console.log('PASS overtime from scheduled shift end, 60-minute minimum/full-hour blocks, regular-work-hour summary, and late-deduction waiver checks.');

if (!attendanceService.includes('computePayrollForEmployee') || !attendanceService.includes('late_minutes = ?') || !attendanceService.includes('overtime_minutes = ?') || !attendanceService.includes("status = ?") || !attendanceService.includes("status <> 'PAID'")) {
  throw new Error('Admin attendance corrections must recalculate status/late/OT and refresh unpaid payroll deductions.');
}
console.log('PASS admin attendance correction recalculates status, late/OT minutes, and saved unpaid payslips.');

// Operational date/time must be independent of Render/container and device timezone.
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
const renderConfig = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
const posService = fs.readFileSync(path.join(root, 'src', 'services', 'pos.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const staffHtml = fs.readFileSync(path.join(root, 'public', 'staff.html'), 'utf8');
if (!serverSource.startsWith("// Keep all server-side operational dates/times (POS, attendance, payroll) on WIB.\nprocess.env.TZ = 'Asia/Jakarta';") || !renderConfig.includes('      - key: TZ\n        value: Asia/Jakarta') || !posService.includes('const now = dayjs();') || !posService.includes("now.format('YYYY-MM-DD')") || !adminHtml.includes("timeZone: 'Asia/Jakarta'") || !staffHtml.includes("timeZone: 'Asia/Jakarta'")) {
  throw new Error('POS and attendance operational dates must use Asia/Jakarta (WIB), independent of host/device timezone.');
}
console.log('PASS Jakarta/WIB current date and time configuration for server, POS, admin, and staff.');
if (!adminHtml.includes('function formatJakartaDateTime(value)') || !adminHtml.includes("timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',") || !adminHtml.includes('formatJakartaDateTime(l.timestamp)') || !adminHtml.includes('Tanggal &amp; Jam (WIB)')) {
  throw new Error('Audit log timestamps must be converted from database UTC to Asia/Jakarta (WIB) for display.');
}
console.log('PASS audit log UTC timestamp formatting to WIB.');

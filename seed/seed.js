const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const { PERMISSIONS } = require('../src/middleware/rbac');
const { createTransaction } = require('../src/services/pos');

console.log('Seeding MAHADIMSUM database...');

const run = db.transaction(() => {
  // ---- Permissions ----
  const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (code) VALUES (?)');
  for (const p of PERMISSIONS) insertPerm.run(p);

  // ---- Roles ----
  db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('ADMIN');
  db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('STAFF');
  const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('ADMIN');
  const staffRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('STAFF');

  // Admin gets ALL permissions
  const linkPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?');
  for (const p of PERMISSIONS) linkPerm.run(adminRole.id, p);

  // Staff gets default limited set (Section 3)
  const staffPerms = ['dashboard.view', 'pos.use', 'transactions.view', 'attendance.self', 'schedule.view', 'payroll.view_own'];
  for (const p of staffPerms) linkPerm.run(staffRole.id, p);

  // ---- Employees + Users ----
  // Demo employee requested for September attendance/payroll testing.
  const empIki = db.prepare(`INSERT INTO employees
    (name, base_salary, meal_rate, transport_rate, overtime_rate)
    VALUES (?,?,?,?,?)`).run('Iki', 50000, 10000, 10000, 5000);

  const insertUser = db.prepare('INSERT INTO users (username, password_hash, role_id, employee_id) VALUES (?,?,?,?)');
  insertUser.run('admin', bcrypt.hashSync('admin123', 10), adminRole.id, null);
  insertUser.run('Iki', bcrypt.hashSync('Iki123', 10), staffRole.id, empIki.lastInsertRowid);

  // ---- Schedule: Iki works 14:00-22:00 every day (0=Sun..6=Sat) ----
  const insertSchedule = db.prepare(
    'INSERT INTO schedules (employee_id, day_of_week, focus, start_time, end_time) VALUES (?,?,?,?,?)'
  );
  for (let day = 0; day <= 6; day++) {
    insertSchedule.run(empIki.lastInsertRowid, day, 'JUALAN', '14:00', '22:00');
  }

  // ---- Inventory items (Section 14 formulas) ----
  const inv = {};
  const insertInv = db.prepare(`INSERT INTO inventory_items (name, category, unit, current_stock, minimum_stock, target_stock, restock_frequency) VALUES (?,?,?,?,?,?,?)`);
  function addInv(name, category, unit, stock, min, target, freq) {
    const info = insertInv.run(name, category, unit, stock, min, target, freq);
    inv[name] = info.lastInsertRowid;
  }
  addInv('Dimsum', 'Bahan Utama', 'pcs', 200, 100, 400, 'WEEKLY'); // stock tracked in pcs to match recipe consumption
  addInv('Plastic Ziplock Kecil', 'Packaging', 'pcs', 500, 100, 1000, 'AS_NEEDED');
  addInv('Chili Oil', 'Saus', 'g', 3000, 500, 5000, 'WEEKLY');
  addInv('Saus Pedas', 'Saus', 'kg', 4, 1, 4, 'WEEKLY');
  addInv('Saus Mentai', 'Saus', 'kg', 4, 1, 4, 'WEEKLY');
  addInv('Saus Garlic', 'Saus', 'kg', 1, 1, 4, 'WEEKLY');
  addInv('Keju Mozzarella', 'Topping', 'portion', 24, 12, 60, 'WEEKLY'); // stored directly in portions (1 slice = 6 portions)
  addInv('Nori', 'Topping', 'pcs', 100, 20, 200, 'WEEKLY');
  addInv('Kuah Keju', 'Saus', 'ml', 2000, 500, 4000, 'WEEKLY');
  addInv('Sumpit/Tusuk Gigi', 'Packaging', 'pcs', 500, 100, 1000, 'AS_NEEDED');
  addInv('Kantong Plastik', 'Packaging', 'pcs', 500, 100, 1000, 'AS_NEEDED');
  addInv('Styrofoam Box', 'Packaging', 'pcs', 300, 50, 500, 'AS_NEEDED');
  addInv('Aluminium Foil', 'Packaging', 'pcs', 300, 50, 500, 'AS_NEEDED');
  addInv('Paper Bowl 650ml', 'Packaging', 'pcs', 200, 50, 400, 'AS_NEEDED');
  addInv('Plastic Kuah (air panas)', 'Packaging', 'pcs', 200, 50, 400, 'AS_NEEDED');
  addInv('Sendok Plastik', 'Packaging', 'pcs', 300, 50, 500, 'AS_NEEDED');

  // ---- Menu (Section 6) ----
  const menu = {};
  const insertMenu = db.prepare(`INSERT INTO menu (name, category, price, unit, pcs_per_unit, counts_for_bonus, description) VALUES (?,?,?,?,?,?,?)`);
  function addMenu(name, category, price, pcsPerUnit, countsForBonus, desc) {
    const info = insertMenu.run(name, category, price, 'porsi', pcsPerUnit, countsForBonus ? 1 : 0, desc || null);
    menu[name] = info.lastInsertRowid;
  }
  addMenu('Dimsum 4pcs', 'Dimsum', 15000, 4, true);
  addMenu('Dimsum 6pcs', 'Dimsum', 20000, 6, true);
  addMenu('Dimsum Mentai Original', 'Dimsum', 18000, 4, true);
  addMenu('Dimsum Garlic Original', 'Dimsum', 18000, 4, true);
  addMenu('Dimsum Mix Mentai Garlic 4pcs', 'Dimsum', 18000, 4, true, '2 pcs Mentai + 2 pcs Garlic');
  addMenu('Dimsum Mix Mentai Garlic 6pcs', 'Dimsum', 26000, 6, true, '3 pcs Mentai + 3 pcs Garlic');
  addMenu('Dimsum Mozza', 'Dimsum', 20000, 4, true);
  addMenu('Dimsum Nori', 'Dimsum', 18000, 4, true);
  addMenu('Dimsum Kuah Keju', 'Dimsum', 22000, 4, true);
  addMenu('Ekado', 'Lainnya', 12000, 4, false); // tidak dihitung bonus
  addMenu('Lumpia', 'Lainnya', 10000, 3, false); // tidak dihitung bonus

  // ---- Recipes (version 1 for each menu) ----
  const insertRecipe = db.prepare('INSERT INTO recipes (menu_id, version, active) VALUES (?,1,1)');
  const insertRI = db.prepare('INSERT INTO recipe_items (recipe_id, inventory_item_id, quantity, unit) VALUES (?,?,?,?)');
  function addRecipe(menuName, items) {
    const rid = insertRecipe.run(menu[menuName]).lastInsertRowid;
    for (const [itemName, qty, unit] of items) insertRI.run(rid, inv[itemName], qty, unit);
    return rid;
  }

  // Dimsum 4pcs: 1 ziplock chili oil + chili oil, 1 ziplock saus pedas + saus pedas, sumpit, kantong, styrofoam
  addRecipe('Dimsum 4pcs', [
    ['Dimsum', 4, 'pcs'],
    ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'],
    ['Saus Pedas', 0.015, 'kg'],
    ['Sumpit/Tusuk Gigi', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
    ['Styrofoam Box', 1, 'pcs'],
  ]);

  // Dimsum 6pcs: same but Aluminium Foil instead of Styrofoam
  addRecipe('Dimsum 6pcs', [
    ['Dimsum', 6, 'pcs'],
    ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'],
    ['Saus Pedas', 0.015, 'kg'],
    ['Sumpit/Tusuk Gigi', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
    ['Aluminium Foil', 1, 'pcs'],
  ]);

  // Dimsum Mentai: base dimsum 4pcs formula + Saus Mentai
  addRecipe('Dimsum Mentai Original', [
    ['Dimsum', 4, 'pcs'],
    ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'],
    ['Saus Mentai', 0.12, 'kg'], // 30 g per dimsum piece x 4 pcs
    ['Sumpit/Tusuk Gigi', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
    ['Styrofoam Box', 1, 'pcs'],
  ]);

  addRecipe('Dimsum Garlic Original', [
    ['Dimsum', 4, 'pcs'],
    ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'],
    ['Saus Garlic', 0.12, 'kg'],
    ['Sumpit/Tusuk Gigi', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
    ['Styrofoam Box', 1, 'pcs'],
  ]);

  // Mix Mentai Garlic: sauce usage follows composition; chili oil and spicy sauce stay fixed per package.
  addRecipe('Dimsum Mix Mentai Garlic 4pcs', [
    ['Dimsum', 4, 'pcs'], ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'], ['Saus Pedas', 0.015, 'kg'],
    ['Saus Mentai', 0.06, 'kg'], ['Saus Garlic', 0.06, 'kg'],
    ['Sumpit/Tusuk Gigi', 1, 'pcs'], ['Kantong Plastik', 1, 'pcs'], ['Styrofoam Box', 1, 'pcs'],
  ]);
  addRecipe('Dimsum Mix Mentai Garlic 6pcs', [
    ['Dimsum', 6, 'pcs'], ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'], ['Saus Pedas', 0.015, 'kg'],
    ['Saus Mentai', 0.09, 'kg'], ['Saus Garlic', 0.09, 'kg'],
    ['Sumpit/Tusuk Gigi', 1, 'pcs'], ['Kantong Plastik', 1, 'pcs'], ['Aluminium Foil', 1, 'pcs'],
  ]);

  // Dimsum Mozza — fractional slice: 4pcs = 4/6 slice = 4 portions (1 slice = 6 portions)
  addRecipe('Dimsum Mozza', [
    ['Dimsum', 4, 'pcs'],
    ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'],
    ['Saus Pedas', 0.015, 'kg'],
    ['Keju Mozzarella', 4, 'portion'], // 4 portions out of 6 per slice
    ['Sumpit/Tusuk Gigi', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
    ['Styrofoam Box', 1, 'pcs'],
  ]);

  addRecipe('Dimsum Nori', [
    ['Dimsum', 4, 'pcs'],
    ['Plastic Ziplock Kecil', 2, 'pcs'],
    ['Chili Oil', 15, 'g'],
    ['Saus Pedas', 0.015, 'kg'],
    ['Nori', 2, 'pcs'],
    ['Sumpit/Tusuk Gigi', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
    ['Styrofoam Box', 1, 'pcs'],
  ]);

  // Dimsum Kuah Keju: no sumpit/styrofoam/foil; uses paper bowl, plastic kuah, sendok plastik
  addRecipe('Dimsum Kuah Keju', [
    ['Dimsum', 4, 'pcs'],
    ['Kuah Keju', 150, 'ml'],
    ['Plastic Kuah (air panas)', 1, 'pcs'],
    ['Sendok Plastik', 1, 'pcs'],
    ['Paper Bowl 650ml', 1, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
  ]);

  addRecipe('Ekado', [
    ['Dimsum', 4, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
  ]);

  addRecipe('Lumpia', [
    ['Dimsum', 3, 'pcs'],
    ['Kantong Plastik', 1, 'pcs'],
  ]);

  console.log('Base data seeded.');
});

run();

// ---- September 2026 demo data for Iki ----
try {
  const { computePayrollForEmployee, savePayroll } = require('../src/services/payroll');
  const iki = db.prepare("SELECT e.* FROM employees e JOIN users u ON u.employee_id = e.id WHERE u.username = 'Iki'").get();
  const ikiUser = db.prepare("SELECT * FROM users WHERE username = 'Iki'").get();
  const adminUser = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();

  const menuIds = {};
  for (const row of db.prepare('SELECT id, name FROM menu').all()) menuIds[row.name] = row.id;

  // 12 Sep: 40 x Dimsum 4pcs = 160 dimsum pcs, meeting the 150 pcs/day bonus threshold.
  createTransaction({
    cashierId: ikiUser.id,
    items: [{ menu_id: menuIds['Dimsum 4pcs'], quantity: 40 }],
    payment: { method: 'CASH', paid_amount: 600000 },
    type: 'MANUAL',
    transactionDate: '2026-09-12',
    transactionTime: '18:00:00',
    idempotencyKey: 'SEPTEMBER-2026-IKI-160PCS',
  });
  console.log('12 Sep transaction injected: 160 dimsum pcs (40 x Dimsum 4pcs), PAID.');

  // Attendance: 14:00-22:00 every day, except 13 Sep absent and 15 Sep late 30 minutes.
  const insertAtt = db.prepare(`INSERT INTO attendance
    (employee_id, date, check_in, check_out, check_in_lat, check_in_lng,
     check_out_lat, check_out_lng, late_minutes, overtime_minutes, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (employee_id, date) DO UPDATE SET
      check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out,
      check_in_lat = EXCLUDED.check_in_lat, check_in_lng = EXCLUDED.check_in_lng,
      check_out_lat = EXCLUDED.check_out_lat, check_out_lng = EXCLUDED.check_out_lng,
      late_minutes = EXCLUDED.late_minutes, overtime_minutes = EXCLUDED.overtime_minutes, status = EXCLUDED.status`);

  for (let d = 1; d <= 30; d++) {
    const dateStr = `2026-09-${String(d).padStart(2, '0')}`;

    if (d === 13) {
      insertAtt.run(
        iki.id, dateStr, null, null, null, null, null, null,
        0, 0, 'ABSENT'
      );
      continue;
    }

    const late = d === 15 ? 30 : 0;
    insertAtt.run(
      iki.id, dateStr,
      late ? '14:30:00' : '14:00:00',
      '22:00:00',
      -6.2, 106.8166,
      -6.2, 106.8166,
      late, 0,
      late ? 'LATE' : 'PRESENT'
    );
  }

  // Calculate and persist September payroll so the 12 Sep achievement bonus is visible.
  const payrollResult = computePayrollForEmployee({
    employeeId: iki.id,
    userIdForSales: ikiUser.id,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  });

  savePayroll(payrollResult, adminUser.id);

  console.log('September 2026 attendance injected for Iki:');
  console.log('  - 29 worked days, 13 Sep ABSENT');
  console.log('  - 15 Sep check-in 14:30 (30 minutes late)');
  console.log('  - Other days check-in 14:00 and check-out 22:00');
  console.log(`  - Bonus days: ${JSON.stringify(payrollResult.bonusDays)}`);
  console.log(`  - Payroll: gapok ${payrollResult.baseTotal} + makan ${payrollResult.mealTotal} + transport ${payrollResult.transportTotal} + bonus ${payrollResult.bonusTotal} - late ${payrollResult.lateDeductionTotal} = NET ${payrollResult.netPay}`);
} catch (e) {
  console.error('September 2026 demo data injection failed:', e);
  throw e;
}

console.log('\nSeed complete. Login credentials:');
console.log('  Admin    -> username: admin       password: admin123');
console.log('  Iki       -> username: Iki          password: Iki123');

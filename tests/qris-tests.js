const assert = require('assert');
const { db, getSetting, setSetting } = require('../src/db');
const qris = require('../src/services/qris');
const sync = require('../src/services/qris-sync');

(async () => {
  const staticPayload = getSetting('QRIS_STATIC_PAYLOAD');
  assert.ok(staticPayload.includes('ID.CO.SPEEDCASH.MERCHANT'));
  const normalized = qris.getStaticPayload();
  assert.doesNotThrow(() => qris.parseTlv(normalized));
  assert.strictEqual(qris.verifyCrc(normalized), true);
  assert.ok(staticPayload.includes('ID1026537204129'));
  assert.strictEqual(getSetting('QRIS_MERCHANT_ID'), 'ID1026537204129');
  assert.strictEqual(getSetting('QRIS_MERCHANT_NAME'), 'MAHADIMSUM');
  console.log('PASS merchant static QRIS settings');

  const qr = qris.generateDynamicQr({ amount: 25000, partnerReferenceNo: 'TRX-QRIS-TEST' });
  assert.ok(qr.qrContent);
  assert.ok(qr.qrContent.includes('010212'));
  assert.ok(qr.qrContent.includes('540825000.00'));
  assert.strictEqual(qr.qrContent.slice(-8, -4), '6304');
  assert.doesNotThrow(() => qris.parseTlv(qr.qrContent));
  assert.strictEqual(qris.verifyCrc(qr.qrContent), true);
  assert.strictEqual(qris.crc16CcittFalse(qr.qrContent.slice(0, -4)), qr.qrContent.slice(-4));
  console.log('PASS static -> dynamic QRIS: POI=12, amount=25000.00, CRC valid');

  db.prepare("DELETE FROM transactions WHERE trx_no LIKE 'TRX-QRIS-TEST-%'").run();
  const info = db.prepare(`INSERT INTO transactions (trx_no,date,time,subtotal,discount,grand_total,payment_method,payment_status,type,qris_qr_content,qris_expires_at)
    VALUES ('TRX-QRIS-TEST-0001','2026-10-08','20:00:00',25000,0,25000,'QRIS','PENDING','POS',?,(CURRENT_TIMESTAMP + INTERVAL '5 minutes')::text)`).run(qr.qrContent);
  const trx = db.prepare('SELECT * FROM transactions WHERE id=?').get(info.lastInsertRowid);
  assert.strictEqual(trx.payment_status, 'PENDING');

  // Direct settle guard: wrong amount never becomes PAID.
  let r = sync.settle(trx.id, { status: 'PAID', amount: 1000, source: 'test' });
  assert.strictEqual(r.payment_status, 'PENDING');
  console.log('PASS wrong amount blocked');

  // Correct mutation result can settle exactly once.
  r = sync.settle(trx.id, { status: 'PAID', amount: 25000, referenceNo: 'RRN-TEST-1', source: 'mutation-test' });
  assert.strictEqual(r.payment_status, 'PAID');
  assert.strictEqual(r.qris_reference, 'RRN-TEST-1');
  assert.ok(db.prepare('SELECT qris_paid_at FROM transactions WHERE id=?').get(trx.id).qris_paid_at);
  console.log('PASS mutation success -> PAID and stock settlement path invoked');

  console.log('\nALL LOCAL QRIS CHECKS PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

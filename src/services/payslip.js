const PDFDocument = require('pdfkit');

function formatRupiah(n) {
  return 'Rp' + Math.round(n || 0).toLocaleString('id-ID');
}

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545; // A4 width 595.28 - 50 margin
const LABEL_WIDTH = 350; // label column: 50 -> 400
const VALUE_X = 400;
const VALUE_WIDTH = PAGE_RIGHT - VALUE_X; // 145pt for the amount column

/**
 * Draw one "label ........ value" row as two independent (non-continued) text
 * calls pinned to the same y, then advance the cursor manually. This avoids
 * pdfkit's `continued: true` + absolute-x second call combination, which does
 * NOT reliably place the second call where you tell it to -- it was pushing
 * amount values off the right edge of the page (invisible / looked "cut off").
 */
function row(doc, label, value, { bold = false, labelColor = '#000', valueColor = '#000', fontSize = 10 } = {}) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(labelColor);
  const labelHeight = doc.heightOfString(label, { width: LABEL_WIDTH });
  doc.text(label, PAGE_LEFT, y, { width: LABEL_WIDTH });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(valueColor);
  doc.text(value, VALUE_X, y, { width: VALUE_WIDTH, align: 'right' });
  doc.y = y + Math.max(labelHeight, fontSize * 1.3) + 2;
  doc.x = PAGE_LEFT;
}

/**
 * Stream a payslip PDF (A4) for one saved payroll record directly to an HTTP response.
 * data: {
 *   employeeName, periodStart, periodEnd, workedDays, totalLateMinutes, totalWorkMinutes,
 *   baseTotal, mealTotal, transportTotal, bonusTotal, overtimeTotal,
 *   lateDeductionTotal, utilitiesDeductionTotal, utilityDeductionItems, netPay,
 * }
 */
function streamPayslipPdf(res, data) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${data.employeeName.replace(/\s+/g, '_')}-${data.periodStart}_${data.periodEnd}.pdf"`);
  doc.pipe(res);

  // Header
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#d9480f').text('MAHADIMSUM');
  doc.fontSize(12).font('Helvetica').fillColor('#333').text('Slip Gaji / Payslip');
  doc.moveDown(0.5);
  doc.strokeColor('#d9480f').lineWidth(2).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown();

  // Employee & period info (plain single-column lines -- no column split needed here)
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
    .text(`Nama Karyawan: ${data.employeeName}`, PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT });
  doc.text(`Periode: ${data.periodStart} s/d ${data.periodEnd}`, PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT });
  doc.moveDown();

  // Attendance summary
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#d9480f').text('Ringkasan Kehadiran', PAGE_LEFT, doc.y);
  doc.fontSize(10).font('Helvetica').fillColor('#000');
  doc.text(`Total Hari Kerja (Hadir): ${data.workedDays} hari`, PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT });
  const totalWorkMinutes = Math.max(0, Number(data.totalWorkMinutes || 0));
  doc.text(`Total Jam Kerja: ${Math.floor(totalWorkMinutes / 60)} jam ${totalWorkMinutes % 60} menit`, PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT });
  doc.text(`Total Menit Terlambat: ${data.totalLateMinutes} menit`, PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT });
  doc.moveDown();

  // Earnings table
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#d9480f').text('Pendapatan', PAGE_LEFT, doc.y);
  doc.moveDown(0.2);
  const earningsRows = [
    ['Gaji Pokok (Gapok)', data.baseTotal],
    ['Uang Makan', data.mealTotal],
    ['Uang Transport', data.transportTotal],
    ['Bonus', data.bonusTotal],
    [`Lembur (Overtime — ${Number(data.totalOvertimeMinutes || 0)} menit${Number(data.overtimePaidMinutes || 0) !== Number(data.totalOvertimeMinutes || 0) ? `; ${Number(data.overtimePaidMinutes || 0)} menit dibayar` : ''})`, data.overtimeTotal],
  ];
  let totalEarnings = 0;
  for (const [label, value] of earningsRows) {
    totalEarnings += value;
    row(doc, label, formatRupiah(value));
  }
  doc.moveDown(0.2);
  row(doc, 'Subtotal Pendapatan', formatRupiah(totalEarnings), { bold: true });
  doc.moveDown(0.6);

  // Deductions table
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#d9480f').text('Potongan', PAGE_LEFT, doc.y);
  doc.moveDown(0.2);
  const utilityItems = Array.isArray(data.utilityDeductionItems) ? data.utilityDeductionItems : [];
  const detailUtilitiesTotal = utilityItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const utilityTotal = Number(data.utilitiesDeductionTotal || 0);
  const deductionRows = [
    ['Potongan Keterlambatan', data.lateDeductionTotal],
  ];
  let totalDeductions = 0;
  for (const [label, value] of deductionRows) {
    totalDeductions += Number(value || 0);
    row(doc, label, formatRupiah(value));
  }

  // Show each utility deduction as a separate line so employees can audit the payslip.
  row(doc, 'Potongan Utilities', formatRupiah(utilityTotal), { bold: true });
  if (utilityItems.length) {
    for (const item of utilityItems) {
      const label = `• ${item.description || 'Utilitas'}${item.date ? ` (${item.date})` : ''}`;
      const amount = Number(item.amount || 0);
      row(doc, label, formatRupiah(amount), { fontSize: 9, labelColor: '#444' });
    }
    // Keep the payroll-calculated total authoritative, while ensuring the displayed subtotal
    // includes the utilities line even if legacy rows do not reconcile perfectly.
  } else if (utilityTotal > 0) {
    row(doc, '• Rincian utilitas tidak tersedia pada data periode ini', formatRupiah(utilityTotal), { fontSize: 9, labelColor: '#444' });
  } else {
    row(doc, '• Tidak ada potongan utilitas', formatRupiah(0), { fontSize: 9, labelColor: '#444' });
  }
  totalDeductions += utilityTotal;
  doc.moveDown(0.2);
  row(doc, 'Subtotal Potongan', formatRupiah(totalDeductions), { bold: true });
  doc.moveDown(0.6);

  // Net pay
  doc.strokeColor('#ddd').lineWidth(1).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.5);
  row(doc, 'GAJI BERSIH (NET PAY)', formatRupiah(data.netPay), {
    bold: true, labelColor: '#d9480f', valueColor: '#d9480f', fontSize: 13,
  });

  doc.moveDown(2);
  doc.fontSize(8).font('Helvetica').fillColor('#888').text(
    'Dokumen ini dibuat otomatis oleh sistem MAHADIMSUM POS & Operations.',
    PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT, align: 'left' }
  );

  doc.end();
}

module.exports = { streamPayslipPdf };

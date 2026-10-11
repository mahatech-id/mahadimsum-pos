const ExcelJS = require('exceljs');

/** Build a single-sheet workbook and write it to the response as .xlsx download. */
async function sendSingleSheetXlsx(res, filename, sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const buffer = await workbook.xlsx.writeBuffer();
  res.status(200).send(Buffer.from(buffer));
}

/** Build a multi-sheet workbook: sheets = [{ name, columns, rows }] */
async function sendMultiSheetXlsx(res, filename, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = workbook.addWorksheet(s.name);
    sheet.columns = s.columns;
    sheet.getRow(1).font = { bold: true };
    for (const row of s.rows) sheet.addRow(row);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const buffer = await workbook.xlsx.writeBuffer();
  res.status(200).send(Buffer.from(buffer));
}


async function readExcelRows(base64) {
  if (!base64) throw new Error('File Excel tidak ditemukan.');
  const clean = String(base64).replace(/^data:.*?;base64,/, '');
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length) throw new Error('File Excel kosong.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook tidak memiliki sheet.');
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cell.value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {};
    let nonEmpty = false;
    headers.forEach((header, col) => {
      if (!header) return;
      const cell = row.getCell(col);
      let value = cell.value;
      if (value && typeof value === 'object') {
        if (value instanceof Date) {
          value = header === 'time'
            ? `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`
            : `${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
        } else if (value.text !== undefined) value = value.text;
        else if (value.result !== undefined) value = value.result;
        else value = String(value);
      }
      if (value instanceof Date) value = header === 'time'
        ? `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`
        : `${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
      if (value !== null && value !== undefined && String(value).trim() !== '') nonEmpty = true;
      item[header] = value === null || value === undefined ? '' : String(value).trim();
    });
    if (nonEmpty) rows.push(item);
  });
  return rows;
}

async function sendTemplateXlsx(res, filename, sheetName, columns, sampleRows = []) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
  sampleRows.forEach(row => sheet.addRow(row));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columns.length)}1` };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(Buffer.from(buffer));
}

module.exports = { sendSingleSheetXlsx, sendMultiSheetXlsx, readExcelRows, sendTemplateXlsx };


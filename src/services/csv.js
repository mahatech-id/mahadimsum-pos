/**
 * Minimal CSV parser: handles comma-separated values, optional header row,
 * trims whitespace, skips blank lines. Not built for quoted-commas edge cases —
 * fine for simple numeric/text bulk upload templates.
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim());
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] !== undefined ? cells[i] : ''; });
    return obj;
  });
  return { header, rows };
}

module.exports = { parseCsv };

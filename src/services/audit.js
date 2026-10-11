const { db } = require('../db');
const dayjs = require('dayjs');

const insertAudit = db.prepare(`INSERT INTO audit_log
  (actor_id, action, module, record_id, old_value, new_value, ip)
  VALUES (@actor_id, @action, @module, @record_id, @old_value, @new_value, @ip)`);

function logAudit({ actorId, action, module, recordId, oldValue, newValue, ip }) {
  insertAudit.run({
    actor_id: actorId || null,
    action,
    module,
    record_id: recordId != null ? String(recordId) : null,
    old_value: oldValue != null ? JSON.stringify(oldValue) : null,
    new_value: newValue != null ? JSON.stringify(newValue) : null,
    ip: ip || null,
  });
}



/**
 * Keep only the audit entries from the current Monday-Sunday week.
 * This prevents the operational audit table from growing indefinitely.
 */
function purgeAuditLogsOlderThanCurrentWeek() {
  // Business week follows Asia/Jakarta: Monday 00:00 through Sunday 23:59:59.
  const jakartaDate = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [year, month, day] = jakartaDate.split('-').map(Number);
  const localMidnight = new Date(Date.UTC(year, month - 1, day));
  const weekday = localMidnight.getUTCDay(); // Sunday=0
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const mondayJakarta = new Date(localMidnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  // Jakarta is UTC+7, so Monday 00:00 Jakarta is Sunday 17:00 UTC.
  const cutoffUtc = new Date(mondayJakarta.getTime() - 7 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const cutoff = `${cutoffUtc.getUTCFullYear()}-${pad(cutoffUtc.getUTCMonth() + 1)}-${pad(cutoffUtc.getUTCDate())} ${pad(cutoffUtc.getUTCHours())}:${pad(cutoffUtc.getUTCMinutes())}:${pad(cutoffUtc.getUTCSeconds())}+00`;
  const result = db.prepare(`DELETE FROM audit_log WHERE timestamp < ?`).run(cutoff);
  return { deleted: result.changes, cutoff };
}

module.exports = { logAudit, purgeAuditLogsOlderThanCurrentWeek };

/* Custom popup dialogs — replaces native window.prompt/confirm/alert with
   an in-app modal that matches the MAHADIMSUM look (see <uploaded screenshot>
   of the ugly native "localhost:3000 says" browser dialog we're replacing). */

function ensureDialogRoot() {
  if (document.getElementById('dlgOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'dlgOverlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div id="dlgBox" style="background:#fff;width:92%;max-width:400px;border-radius:14px;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.25);">
      <div id="dlgTitle" style="font-weight:700;font-size:16px;margin-bottom:10px;"></div>
      <div id="dlgFields"></div>
      <div id="dlgError" class="error" style="display:none;"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button type="button" class="secondary" id="dlgCancelBtn" style="flex:1;">Batal</button>
        <button type="button" id="dlgOkBtn" style="flex:1;">OK</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.style.display = 'none';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) resolveDialog(null); });
}

function toggleDialogPassword(id, button) { const input = document.getElementById(id); if (!input) return; input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? 'Lihat' : 'Sembunyikan'; }

let _dlgResolve = null;
function resolveDialog(value) {
  const overlay = document.getElementById('dlgOverlay');
  if (overlay) overlay.style.display = 'none';
  if (_dlgResolve) { const r = _dlgResolve; _dlgResolve = null; r(value); }
}

function showDialogBox({ title, fieldsHtml, okLabel, cancelLabel, onOk }) {
  ensureDialogRoot();
  const overlay = document.getElementById('dlgOverlay');
  document.getElementById('dlgTitle').textContent = title || '';
  document.getElementById('dlgFields').innerHTML = fieldsHtml || '';
  document.getElementById('dlgError').style.display = 'none';
  document.getElementById('dlgError').textContent = '';
  const okBtn = document.getElementById('dlgOkBtn');
  const cancelBtn = document.getElementById('dlgCancelBtn');
  okBtn.textContent = okLabel || 'OK';
  cancelBtn.textContent = cancelLabel || 'Batal';
  cancelBtn.style.display = cancelLabel === '' ? 'none' : 'block';
  overlay.style.display = 'flex';
  okBtn.onclick = onOk;
  cancelBtn.onclick = () => resolveDialog(null);
  return overlay;
}

/**
 * Show a form-style popup asking for one or more fields.
 * fields: [{ name, label, type='text', value='', options:[{value,label}] (for type='select') }]
 * Resolves with an object { name: value, ... } or null if cancelled.
 */
function promptDialog(title, fields) {
  return new Promise((resolve) => {
    _dlgResolve = resolve;
    const fieldsHtml = fields.map(f => {
      const id = `dlgf_${f.name}`;
      if (f.type === 'select') {
        return `<label>${f.label}</label><select id="${id}">${f.options.map(o =>
          `<option value="${o.value}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
      }
      if (f.type === 'textarea') {
        return `<label>${f.label}</label><textarea id="${id}" rows="4">${f.value ?? ''}</textarea>`;
      }
      if (f.type === 'password') {
        return `<label>${f.label}</label><div style="display:flex;gap:8px;align-items:center;"><input id="${id}" type="password" value="${f.value ?? ''}" ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} style="flex:1;min-width:0;margin:0;"><button type="button" class="secondary" onclick="toggleDialogPassword('${id}',this)">Lihat</button></div>`;
      }
      return `<label>${f.label}</label><input id="${id}" type="${f.type || 'text'}" value="${f.value ?? ''}" ${f.placeholder ? `placeholder="${f.placeholder}"` : ''}>`;
    }).join('');
    showDialogBox({
      title, fieldsHtml,
      onOk: () => {
        const result = {};
        for (const f of fields) result[f.name] = document.getElementById(`dlgf_${f.name}`).value;
        resolveDialog(result);
      },
    });
  });
}

/** Simple single-value prompt, mirrors window.prompt(message, defaultValue) but as a popup. */
function promptSingle(message, defaultValue, type) {
  return promptDialog(message, [{ name: 'value', label: '', value: defaultValue ?? '', type: type || 'text' }])
    .then(r => r ? r.value : null);
}

/** Confirm popup — resolves true/false. */
function confirmDialog(message) {
  return new Promise((resolve) => {
    _dlgResolve = resolve;
    showDialogBox({
      title: message, fieldsHtml: '',
      onOk: () => resolveDialog(true),
    });
    document.getElementById('dlgCancelBtn').onclick = () => resolveDialog(false);
  });
}

/** Alert popup — resolves when dismissed. */
function alertDialog(message) {
  return new Promise((resolve) => {
    _dlgResolve = resolve;
    showDialogBox({
      title: message, fieldsHtml: '', cancelLabel: '',
      onOk: () => resolveDialog(true),
    });
  });
}


/** Cash payment popup with realtime change calculation. */
function promptCashPayment(grandTotal) {
  return new Promise((resolve) => {
    _dlgResolve = resolve;
    ensureDialogRoot();
    const total = Number(grandTotal) || 0;
    const fieldsHtml = `
      <div class="muted" style="font-size:13px;margin-bottom:6px;">Total tagihan</div>
      <div style="font-size:22px;font-weight:800;margin-bottom:14px;">${rupiah(total)}</div>
      <label for="dlgf_cash_paid">Uang diterima</label>
      <input id="dlgf_cash_paid" type="number" min="0" step="1000" value="${total}" inputmode="numeric" style="font-size:20px;font-weight:700;">
      <div style="margin-top:12px;padding:12px;border-radius:10px;background:#f6f8fb;">
        <div class="muted" style="font-size:12px;">Perkiraan kembalian</div>
        <div id="dlgf_cash_change" style="font-size:22px;font-weight:800;">${rupiah(0)}</div>
      </div>`;

    showDialogBox({
      title: 'Pembayaran Cash',
      fieldsHtml,
      okLabel: 'Bayar',
      onOk: () => {
        const input = document.getElementById('dlgf_cash_paid');
        const paid = Number(input?.value);
        if (!Number.isFinite(paid) || paid < total) {
          const err = document.getElementById('dlgError');
          err.textContent = `Nominal cash tidak boleh kurang dari total tagihan (${rupiah(total)}).`;
          err.style.display = 'block';
          input?.focus();
          return;
        }
        resolveDialog(paid);
      },
    });

    const input = document.getElementById('dlgf_cash_paid');
    const change = document.getElementById('dlgf_cash_change');
    const update = () => {
      const paid = Number(input?.value);
      const valid = Number.isFinite(paid);
      const diff = valid ? paid - total : 0;
      if (change) change.textContent = rupiah(Math.max(0, diff));
      const err = document.getElementById('dlgError');
      if (valid && paid >= total) {
        if (err) err.style.display = 'none';
      } else if (valid && paid < total) {
        if (err) {
          err.textContent = `Kurang ${rupiah(total - paid)} dari total tagihan.`;
          err.style.display = 'block';
        }
      }
    };
    input?.addEventListener('input', update);
    input?.focus();
    input?.select();
    update();
  });
}

/**
 * File-upload popup for CSV bulk import. Shows a file picker + optional template hint text.
 * Resolves with the raw text content of the chosen file, or null if cancelled.
 */
function uploadCsvDialog(title, hintText) {
  return new Promise((resolve) => {
    _dlgResolve = resolve;
    ensureDialogRoot();
    const fieldsHtml = `
      ${hintText ? `<p class="muted" style="font-size:12px;">${hintText}</p>` : ''}
      <input type="file" id="dlgf_file" accept=".csv,text/csv">`;
    showDialogBox({
      title, fieldsHtml, okLabel: 'Upload',
      onOk: () => {
        const input = document.getElementById('dlgf_file');
        const file = input.files && input.files[0];
        if (!file) {
          const err = document.getElementById('dlgError');
          err.textContent = 'Pilih file CSV terlebih dahulu.';
          err.style.display = 'block';
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolveDialog(reader.result);
        reader.readAsText(file);
      },
    });
  });
}


/**
 * Excel bulk upload popup with a direct template-download button.
 * Resolves to base64 content (without the data URL prefix), or null when cancelled.
 */
function uploadExcelDialog(title, hintText, templateUrl) {
  return new Promise((resolve) => {
    _dlgResolve = resolve;
    ensureDialogRoot();
    const fieldsHtml = `
      ${hintText ? `<p class="muted" style="font-size:12px;">${hintText}</p>` : ''}
      ${templateUrl ? `<p><a class="btn secondary" style="display:inline-block;text-decoration:none;margin:4px 0 10px;" href="${templateUrl}" target="_blank" rel="noopener">⬇ Download Template Excel</a></p>` : ''}
      <label>File Excel (.xlsx)</label>
      <input type="file" id="dlgf_file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">`;
    showDialogBox({
      title, fieldsHtml, okLabel: 'Upload',
      onOk: () => {
        const input = document.getElementById('dlgf_file');
        const file = input.files && input.files[0];
        if (!file) {
          const err = document.getElementById('dlgError');
          err.textContent = 'Pilih file Excel (.xlsx) terlebih dahulu.';
          err.style.display = 'block';
          return;
        }
        if (!/\.xlsx$/i.test(file.name)) {
          const err = document.getElementById('dlgError');
          err.textContent = 'Format file harus .xlsx.';
          err.style.display = 'block';
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          resolveDialog(dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl);
        };
        reader.onerror = () => {
          const err = document.getElementById('dlgError');
          err.textContent = 'File tidak dapat dibaca.';
          err.style.display = 'block';
        };
        reader.readAsDataURL(file);
      },
    });
  });
}

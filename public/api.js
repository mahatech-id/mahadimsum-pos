async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
  return data;
}
function rupiah(n) { return 'Rp' + Math.round(n || 0).toLocaleString('id-ID'); }

/**
 * Full QRIS dynamic-QR payment flow, shared by staff.html (Kasir) and admin.html (POS).
 * Both pages already define identical #modalOverlay/#modalBody elements and a
 * closeModal() function, which this re-uses directly.
 *
 * Call this AFTER the transaction has been created via /pos/checkout with
 * payment.method === 'QRIS' (so it already exists as PENDING). Resolves with the
 * final transaction once it's PAID, or null if the cashier cancels / it expires.
 */
function payWithQris(transactionId, trxNo, grandTotal) {
  return new Promise(async (resolve) => {
    window.qrisPaymentModalActive = true;
    const overlay = document.getElementById('modalOverlay');
    const closeButton = document.getElementById('modalCloseBtn');
    if (closeButton) closeButton.style.display = 'none';
    if (overlay) overlay.onclick = (event) => { if (event.target === overlay) event.stopPropagation(); }; 
    let pollTimer = null;
    let countdownTimer = null;
    let secondsLeft = 0;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearInterval(countdownTimer);
      resolve(result);
    }

    function unlockModal() {
      window.qrisPaymentModalActive = false;
      if (closeButton) closeButton.style.display = '';
      if (overlay) overlay.onclick = (event) => { if (event.target === overlay) closeModal(event); }; // restore normal modal close behavior
    }

    window.cancelQrisPayment = async (id) => {
      try { await api('POST', `/pos/${id}/qris/cancel`, {}); } catch (e) { /* best effort */ }
      unlockModal();
      closeModal();
      finish(null);
    };

    function renderState(innerHtml) {
      document.getElementById('modalBody').innerHTML = `
        <h3>Pembayaran QRIS</h3>
        <p class="muted" style="margin:0 0 10px;">${trxNo} — ${rupiah(grandTotal)}</p>
        ${innerHtml}`;
      document.getElementById('modalOverlay').style.display = 'block';
    }

    renderState(`<p class="muted">Membuat QR pembayaran...</p>`);

    let qr;
    try {
      qr = await api('POST', `/pos/${transactionId}/qris/generate`, {});
    } catch (e) {
      renderState(`
        <p class="error">${e.message}</p>
        ${e.message && e.message.includes('belum dikonfigurasi') ? '<p class="muted" style="font-size:12px;">Admin perlu mengisi email login aplikasi mobile QRIS Interactive di menu Settings terlebih dahulu.</p>' : ''}
        <button class="secondary" style="width:100%;" onclick="cancelQrisPayment(${transactionId})">Batalkan</button>`);
      return;
    }

    // POS payment modal is limited to 3 minutes; never outlive provider expiry.
    secondsLeft = Math.min(Number(qr.expiresInSeconds) || 180, 180);

    function renderQr() {
      const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
      const ss = String(secondsLeft % 60).padStart(2, '0');
      const qrImageHtml = qr.qrUrl
        ? `<img src="${qr.qrUrl}" alt="QRIS pembayaran" style="width:100%;max-width:260px;display:block;margin:0 auto;border-radius:10px;">`
        : qr.qrContent
          ? `<div id="qrisRawContainer" style="width:260px;height:260px;margin:0 auto;"></div>`
          : `<p class="error">QR tidak tersedia dari provider.</p>`;
      renderState(`
        <div style="display:grid;gap:12px;">
          <div style="background:var(--surface-2, #f5f7fa);border-radius:10px;padding:12px 14px;">
            <div style="font-size:12px;color:var(--muted, #6b7280);margin-bottom:4px;">Nomor Transaksi</div>
            <div style="font-weight:700;overflow-wrap:anywhere;">${trxNo}</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:12px;color:var(--muted, #6b7280);margin-bottom:4px;">Nama Merchant</div>
            <div style="font-weight:600;">${qr.merchantName || 'MAHADIMSUM'}</div>
          </div>
          <div style="padding:8px 0;">${qrImageHtml}</div>
          <div style="text-align:center;padding:12px;border:1px solid var(--border, #e5e7eb);border-radius:10px;">
            <div style="font-size:12px;color:var(--muted, #6b7280);margin-bottom:4px;">Nominal Pembayaran</div>
            <div style="font-size:26px;font-weight:800;">${rupiah(grandTotal)}</div>
          </div>
          <p id="qrisStatusLine" class="muted" style="text-align:center;margin:0;font-weight:600;">Menunggu pembayaran... (${mm}:${ss})</p>
          <button class="secondary" style="width:100%;margin-top:0;" onclick="cancelQrisPayment(${transactionId})">Batalkan</button>
        </div>`);
      if (qr.qrContent && !qr.qrUrl && window.QRCode && document.getElementById('qrisRawContainer')) {
        new QRCode(document.getElementById('qrisRawContainer'), { text: qr.qrContent, width: 260, height: 260 });
      }
    }
    renderQr();

    // If the provider returns raw EMVCo content, render it with QRCode.js.
    if (qr.qrContent && !qr.qrUrl && !window.QRCode) {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      script.onload = renderQr;
      document.head.appendChild(script);
    }

    countdownTimer = setInterval(() => {
      secondsLeft -= 1;
      const statusLine = document.getElementById('qrisStatusLine');
      if (statusLine) {
        const mm = String(Math.floor(Math.max(0, secondsLeft) / 60)).padStart(2, '0');
        const ss = String(Math.max(0, secondsLeft) % 60).padStart(2, '0');
        statusLine.textContent = `Menunggu pembayaran... (${mm}:${ss})`;
      }
      if (secondsLeft <= 0) {
        clearInterval(countdownTimer);
        api('POST', `/pos/${transactionId}/qris/cancel`, {}).catch(() => {});
        renderState(`<p class="error">QR sudah kadaluarsa dan transaksi dibatalkan.</p><button class="secondary" style="width:100%;" onclick="cancelQrisPayment(${transactionId})">Batalkan</button>`);
      }
    }, 1000);

    pollTimer = setInterval(async () => {
      try {
        const result = await api('GET', `/pos/${transactionId}/qris/status`);
        if (result.transaction.payment_status === 'PAID') {
          renderState(`<p style="text-align:center;font-size:40px;margin:10px 0;">✅</p>
            <p style="text-align:center;font-weight:700;color:var(--success);">Pembayaran Berhasil!</p>`);
          setTimeout(() => { unlockModal(); closeModal(); finish(result.transaction); }, 1500);
        } else if (['VOID', 'CANCELLED', 'FAILED'].includes(result.transaction.payment_status)) {
          renderState(`<p class="error">Pembayaran ${result.transaction.payment_status}.</p><button class="secondary" style="width:100%;" onclick="cancelQrisPayment(${transactionId})">Selesai</button>`);
        }
      } catch (e) { /* transient network hiccup — keep polling silently */ }
    }, 4000);
  });
}

async function requireSession(allowedRoles) {
  try {
    const me = await api('GET', '/auth/me');
    if (allowedRoles && !allowedRoles.includes(me.role)) {
      window.location.href = me.role === 'ADMIN' ? '/admin.html' : '/staff.html';
      return null;
    }
    return me;
  } catch (e) {
    window.location.href = '/index.html';
    return null;
  }
}

/** QRIS Interactive unofficial mobile-app invoice adapter.
 * Uses the merchant's own QRIS Interactive mobile-app login and creates a real
 * invoice with provider invoiceId/refNo; never synthesizes a payable QR locally.
 * Private, undocumented upstream API may change without notice.
 */
const { getSetting } = require('../db');
const interactive = require('./qris-interactive');
function crc16CcittFalse(input) { let crc=0xFFFF; for (let i=0;i<input.length;i++){ crc ^= input.charCodeAt(i)<<8; for(let b=0;b<8;b++) crc=(crc&0x8000)?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF; } return crc.toString(16).toUpperCase().padStart(4,'0'); }
function parseTlv(payload) { const out=[]; let i=0; while(i<payload.length){ if(i+4>payload.length) throw new Error('QRIS TLV header tidak lengkap.'); const tag=payload.slice(i,i+2), lenStr=payload.slice(i+2,i+4); if(!/^\d{2}$/.test(lenStr)) throw new Error('Panjang TLV tidak valid.'); const len=Number(lenStr), end=i+4+len; if(end>payload.length) throw new Error('Panjang TLV melebihi payload.'); out.push({tag,value:payload.slice(i+4,end)}); i=end; } return out; }
function encodeTlv(tag,value) { value=String(value); if(value.length>99) throw new Error('Tag terlalu panjang.'); return tag+String(value.length).padStart(2,'0')+value; }
function verifyCrc(payload) { return payload.endsWith('6304'+payload.slice(-4)) && crc16CcittFalse(payload.slice(0,-4))===payload.slice(-4).toUpperCase(); }
function normalizeStaticPayload(input) {
  let p = String(input || '').replace(/\s+/g, '');
  p = p.replace(/^0002010102112676(?=0024ID\.CO\.SPEEDCASH\.MERCHANT)/, '0002010102112674');
  if (!p || p.length < 12) throw new Error('QRIS_STATIC_PAYLOAD kosong/tidak valid.');
  const crcPos = p.lastIndexOf('6304'); if (crcPos < 0 || crcPos + 8 !== p.length) throw new Error('QRIS static harus memiliki tag CRC 63 di akhir.');
  p = p.slice(0, crcPos) + '6304' + crc16CcittFalse(p.slice(0, crcPos) + '6304'); parseTlv(p); return p;
}
function getStaticPayload() { return normalizeStaticPayload(getSetting('QRIS_STATIC_PAYLOAD')); }
// Diagnostic-only offline conversion retained for unit tests/tools. POS must call generateQr below.
function generateDynamicQr({ amount, partnerReferenceNo }) {
  const n=Number(amount); if(!Number.isFinite(n)||n<=0) throw new Error('Nominal QRIS tidak valid.');
  const fields=parseTlv(getStaticPayload().slice(0,-8)); const poi=fields.find(x=>x.tag==='01'); if(!poi||poi.value!=='11') throw new Error('QRIS master harus static.'); poi.value='12';
  const ai=fields.findIndex(x=>x.tag==='54'); if(ai>=0) fields.splice(ai,1); const currency=fields.find(x=>x.tag==='53'); if(!currency||currency.value!=='360') throw new Error('Tag mata uang IDR tidak ditemukan.');
  const ci=fields.findIndex(x=>x.tag==='58'); if(ci<0) throw new Error('Tag country tidak ditemukan.'); fields.splice(ci,0,{tag:'54',value:n.toFixed(2)}); const body=fields.map(x=>encodeTlv(x.tag,x.value)).join('')+'6304'; const content=body+crc16CcittFalse(body); return {qrContent:content,qrUrl:null,providerReference:partnerReferenceNo||null,contractId:partnerReferenceNo||null,merchantName:getSetting('QRIS_MERCHANT_NAME')||'MAHADIMSUM',amount:n,isStatic:false};
}
async function generateQr({ amount, partnerReferenceNo }) { const invoice = await interactive.generateAppInvoice(amount, partnerReferenceNo || 'MAHADIMSUM POS'); const merchantName = invoice.merchantName || getSetting('QRIS_MERCHANT_NAME') || 'MAHADIMSUM'; return { qrContent:invoice.content, qrUrl:null, providerReference:invoice.refNo, contractId:invoice.invoiceId, invoiceId:invoice.invoiceId, refNo:invoice.refNo, merchantId:invoice.mID, merchantName, amount:Math.round(Number(amount)), expiresAtIso:invoice.expiresAt, expiresInSeconds:invoice.expiresInSeconds, isProviderInvoice:true }; }
module.exports = { generateQr, generateDynamicQr, parseTlv, encodeTlv, crc16CcittFalse, verifyCrc, getStaticPayload, normalizeStaticPayload };

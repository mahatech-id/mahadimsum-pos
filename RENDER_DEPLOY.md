# Render Deployment

## Automatic first-start data

The application now bootstraps itself when the Supabase PostgreSQL database has no users.
Render only needs to run the normal Node start command:

- Build Command: `npm install`
- Start Command: `npm start`

On the first startup, `src/server.js` automatically runs `seed/seed.js`.
No Render Shell command is required.

## Login immediately after deploy

- Admin: `admin` / `admin123`
- Karyawan: `Iki` / `Iki123`

The seed includes:

- Iki employee profile with base salary Rp50,000/day, meal Rp10,000/day, transport Rp10,000/day.
- Schedule 14:00–22:00 every day.
- September 2026 attendance.
- 13 September absent.
- 15 September check-in at 14:30 (30 minutes late).
- 12 September sale of 160 dimsum pcs, qualifying for the 150 pcs/day bonus.
- September payroll calculation including the achievement bonus.

The application uses Supabase PostgreSQL and does not depend on a Render persistent disk. The application intentionally retains attendance history across months.

## QRIS Interactive mobile-app invoice mode (unofficial)

This build creates provider-issued dynamic invoices through the QRIS Interactive mobile-app API described by `dianrp-space/interactive-qris-api`; it does not create a locally modified static QR for POS payments. The upstream endpoints are private/undocumented and may change or be restricted. Use only a merchant account you own and confirm that this integration is permitted by the provider.

In Admin → Settings, configure:

- `QRIS_INTERACTIVE_APP_EMAIL`: email used to sign in to the QRIS Interactive mobile app (not necessarily the merchant web dashboard).
- `QRIS_INTERACTIVE_APP_PIN`: optional app PIN, only if the mobile app login requires it. Secret is masked in the UI.
- `QRIS_INTERACTIVE_APP_MID`: optional merchant/location mID returned by the mobile app API. Leave blank to use the first location returned for that account.

The previous `QRIS_INTERACTIVE_USERNAME` / `QRIS_INTERACTIVE_PASSWORD` settings are legacy dashboard mutation settings and are not used to create the new dynamic invoice. A merchant account that can only sign in to the web dashboard, but has no eligible mobile-app account/location, may not be able to create invoices through this integration.

The POS stores the upstream `invoiceId` and `refNo`, then verifies that exact invoice. It marks a transaction `PAID` only when the provider response includes both `dateSuccess` and `rrn`; if provider verification is unavailable or the invoice remains unpaid, the transaction remains `PENDING`. This unofficial integration has not been validated with live merchant credentials in this build.

## Recipe sauce settings consistency

Admin → Settings now has a dedicated **Takaran Bahan Resep** section. Chili Oil values are configured in ml; thick sauces (Saus Pedas, Saus Mentai, Saus Garlic) are configured in grams. Saving a value updates the matching active recipe/BOM rows, so the POS stock deduction uses the saved value. Sauce inventory is still stored in kg for the thick sauces; grams are converted to kg automatically when updating recipe quantities. Current defaults: Chili Oil 20 ml for 4-pcs menus and 25 ml for 6-pcs; Saus Pedas 40 g / 50 g for 4-pcs / 6-pcs; Mentai 30 g per portion; Garlic 30 g per portion. The old unused `SAUCE_ML_PER_PORTION_MENTAI` and `SAUCE_ML_PER_PORTION_PEDAS` keys are removed.

## Database Supabase PostgreSQL

Aplikasi ini sekarang menggunakan PostgreSQL Supabase melalui `DATABASE_URL`; SQLite (`data.sqlite`) tidak lagi dipakai. Tidak ada migrasi data lama. Pada Supabase, buka **Connect** dan pilih **Session pooler**. Render umumnya tidak mendukung koneksi IPv6 keluar, sedangkan direct host `db.<project-ref>.supabase.co:5432` menggunakan IPv6 secara default. Session pooler memakai IPv4 dan port 5432; salin seluruh connection string dari dashboard, jangan menebak hostname/username. Ganti `[YOUR-PASSWORD]` hanya di Render Environment Variables, bukan di source code/chat. Password dengan karakter khusus harus di-URL-encode.

Di Render → Environment, tambahkan:

- `DATABASE_URL` = connection string **Session pooler** dari Supabase Connect, dengan password database asli
- `SESSION_SECRET` = random secret yang panjang

Saat startup, schema PostgreSQL dan default settings dibuat otomatis. Database baru akan diisi seed operasional awal bila tabel users masih kosong. Jangan menjalankan seed berulang di database yang sudah berisi data, karena seed ini memang untuk inisialisasi instalasi baru.

**Catatan teknis:** kompatibilitas kode lama saat ini menggunakan `pg-native` synchronous query agar tidak perlu mengubah seluruh route sekaligus. Query synchronous memblokir event loop selama query berjalan; cocok hanya sebagai tahap transisi untuk trafik rendah. Untuk pemakaian jangka panjang atau beberapa kasir bersamaan, rencanakan refactor ke `pg` asynchronous + connection pool.

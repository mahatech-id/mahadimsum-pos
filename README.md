# MAHADIMSUM POS & Operations

Aplikasi Kasir & Operasional untuk UMKM dimsum MAHADIMSUM — POS, Inventory, Recipe
Management, Restock, Attendance (GPS+Camera), Payroll, RBAC, Reporting, dan Audit Log
dalam satu sistem. Dibangun sesuai `PRD_MAHADIMSUM.md`.

## 1. Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL di Supabase, dihubungkan melalui `DATABASE_URL`. Schema dan default settings dibuat otomatis saat aplikasi mulai; data SQLite lama tidak dipindahkan.
- **Auth:** session cookie (`express-session`) + `bcryptjs` password hashing
- **Frontend:** Vanilla HTML/CSS/JS (mobile-first, PWA-ready), tanpa build step —
  langsung dilayani oleh Express sebagai static files di `/public`
- **Testing:** custom lightweight assertion runner (`tests/run-tests.js`), tanpa
  dependency tambahan

## 2. Cara Menjalankan (Development)

```bash
npm install
npm run seed     # mengisi database PostgreSQL baru dengan data awal (butuh DATABASE_URL)
npm start         # jalan di http://localhost:3000
```

Login demo (dibuat oleh seed):

| Role  | Username  | Password  |
|-------|-----------|-----------|
| Admin | admin     | admin123  |
| Staff | karyawanA | staff123  |
| Staff | karyawanB | staff123  |

Buka `http://localhost:3000` di browser (mobile untuk staff, desktop untuk admin).
Kamera & GPS attendance memerlukan HTTPS di production (browser modern hanya mengizinkan
`getUserMedia`/`geolocation` di `localhost` atau origin HTTPS).

## 3. Menjalankan Test

```bash
npm test
```

Menjalankan 20+ assertion yang mencakup 24 skenario di Section 57 PRD: sale/void stock,
recipe calculation (termasuk Mozza fractional slice), bonus threshold + Ekado/Lumpia
exclusion, late/overtime calculation, QRIS vs Cash, RBAC, insufficient stock, idempotency,
GPS validation, payroll calculation, recipe versioning, manual transaction, dan audit log.

## 4. System Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   Browser (Mobile/PWA)   │        │  Browser (Desktop Admin)  │
│  staff.html (SPA vanilla)│        │  admin.html (SPA vanilla) │
└────────────┬─────────────┘        └────────────┬──────────────┘
             │  fetch() JSON over HTTPS            │
             └───────────────┬─────────────────────┘
                              ▼
                  ┌───────────────────────┐
                  │   Express.js Server    │
                  │  (session, RBAC MW)    │
                  ├───────────────────────┤
                  │ Routes (/api/*)        │
                  │  auth · menu · pos     │
                  │  inventory · attendance│
                  │  admin (payroll, users,│
                  │  reports, settings...) │
                  ├───────────────────────┤
                  │ Services (business     │
                  │ logic, DB-transaction, │
                  │ atomic):               │
                  │  pos.js · inventory.js │
                  │  attendance.js         │
                  │  payroll.js · audit.js │
                  ├───────────────────────┤
                  │ PostgreSQL / Supabase │
                  │  DATABASE_URL          │
                  └───────────────────────┘
```

Business logic dipisah total dari UI (Section 60 Maintainability): semua kalkulasi
(bonus, overtime, late deduction, stock deduction) berada di `src/services/*` dan
membaca parameter dari tabel `settings`, bukan hardcoded.

## 5. Database ERD (ringkas)

```
roles ──< role_permissions >── permissions
  │
  └─< users >── employees ──< schedules
                    │
                    ├─< attendance
                    └─< payroll

menu ──< recipes ──< recipe_items >── inventory_items ──< stock_movements
  │
  └─< transaction_items >── transactions (cashier_id → users)

settings (key-value, semua business rule configurable)
audit_log (actor_id → users, generic record_id/module)
```

Skema lengkap: lihat `src/db/schema.sql`.

## 6. API Structure (ringkas)

| Group | Base path | Contoh endpoint |
|---|---|---|
| Auth | `/api/auth` | POST `/login`, POST `/logout`, GET `/me` |
| Menu & Recipe | `/api/menu` | GET/POST `/`, POST `/:id/recipes` (versioning) |
| Inventory | `/api/inventory` | GET `/`, POST `/:id/adjust`, GET `/restock/suggested` |
| POS | `/api/pos` | POST `/checkout`, POST `/:id/void`, GET `/transactions` |
| Attendance | `/api/attendance` | POST `/check-in`, POST `/check-out`, GET/POST `/schedule` |
| Admin | `/api/admin` | `/dashboard`, `/payroll/*`, `/users`, `/roles`, `/settings`, `/audit-log`, `/reports/*` |

Semua route (kecuali `/auth/login`) memerlukan session aktif (`requireAuth`) dan
permission granular (`requirePermission('code')`) — lihat `src/middleware/rbac.js`.

## 7. Permission Matrix (RBAC)

Permission disimpan granular di tabel `permissions`, dipetakan ke role lewat
`role_permissions`, dan dapat diedit lewat halaman **Roles & Permissions** di Admin UI.

| Permission | Admin (default) | Staff (default) |
|---|---|---|
| dashboard.view | ✅ | ✅ |
| pos.use | ✅ | ✅ |
| transactions.view | ✅ | ✅ |
| transactions.manual / .void | ✅ | ❌ |
| menu.manage / recipe.manage | ✅ | ❌ |
| inventory.adjust / .allow_negative_stock | ✅ | ❌ |
| restock.manage | ✅ | ❌ |
| employees.manage | ✅ | ❌ |
| schedule.view | ✅ | ✅ |
| schedule.manage | ✅ | ❌ |
| attendance.self | ✅ | ✅ |
| attendance.correct | ✅ | ❌ |
| payroll.view / .manage / .approve | ✅ | ❌ |
| users.manage / roles.manage | ✅ | ❌ |
| settings.manage | ✅ | ❌ |
| audit.view | ✅ | ❌ |
| export.data | ✅ | ❌ |

(Daftar lengkap 28 permission ada di `src/middleware/rbac.js`.)

## 8. Business Rules yang Configurable (bukan hardcode)

Semua nilai berikut disimpan di tabel `settings` dan dapat diubah lewat Admin →
Settings tanpa deploy ulang kode:

`OPENING_TIME`, `CLOSING_TIME`, `BONUS_THRESHOLD_PCS`, `BONUS_AMOUNT`,
`OVERTIME_RATE_PER_HOUR`, `MINIMUM_OVERTIME_MINUTES`, `LATE_DEDUCTION_METHOD`,
`LATE_DEDUCTION_RATE`, `ATTENDANCE_RADIUS_METERS`, `ATTENDANCE_LAT/LNG`, dan
saus/portion ratios. Harga menu & recipe quantity disimpan di database (`menu`,
`recipe_items`), bukan di source code.

## 9. Fitur Utama yang Sudah Diimplementasikan

- ✅ POS: pilih menu → qty → catatan → cart → cash/QRIS → receipt (trx_no `TRX-YYYYMMDD-0001`)
- ✅ Automatic stock deduction saat `PAID`, restore saat `VOID`, atomic (DB transaction)
  + idempotency key (`idempotencyKey`) mencegah double-submit
- ✅ Negative stock protection default ON; admin bisa `allow_negative_stock` (diaudit)
- ✅ Recipe versioning — transaksi lama tetap memakai recipe version lama
- ✅ Mozza fractional slice (1 slice = 6 portion, 4pcs = 4/6 slice) via unit `portion`
- ✅ Friday Restock Day: suggested purchase = target − current, editable sebelum confirm
- ✅ Attendance: kamera (getUserMedia) + GPS (radius check) + late/overtime calculation
  dari `settings`, bukan hardcode
- ✅ Payroll: gapok + meal + transport + bonus (≥150 pcs/hari, Ekado & Lumpia excluded)
  + overtime − late deduction, dengan approval flow (`PENDING_APPROVAL → APPROVED → PAID`,
  terkunci setelah PAID)
- ✅ RBAC granular + halaman Roles & Permissions
- ✅ Audit log untuk semua create/update/delete/void/approve/login/logout penting
- ✅ Dashboard KPI (Section 5), Reports (sales & product), Search (dasar via query),
  Export data (kerangka endpoint tersedia di reports, bisa diperluas ke CSV/Excel/PDF)

## 10. Yang Perlu Dikembangkan Lebih Lanjut (Roadmap)

PRD ini sangat luas (61 section). Yang sudah solid: seluruh **engine inti** (POS,
inventory, recipe, attendance, payroll, RBAC, audit) sudah bekerja dan teruji otomatis.
Bagian berikut disiapkan strukturnya namun perlu penambahan sebelum go-live production:

- Export ke file fisik (Excel/CSV/PDF) — saat ini data reports tersedia via JSON API,
  tinggal tambah library seperti `exceljs`/`pdfkit`
- Notifikasi push/WhatsApp (Section 45) — arsitektur sudah mendukung (semua event
  tercatat di audit_log & stock_movements), tinggal tambah integration layer
- QRIS payment gateway sungguhan — saat ini status QRIS dikelola manual via
  `/api/pos/qris-callback`, siap diganti dengan webhook gateway asli
- Offline/PWA service worker (Section 44) — struktur idempotency key sudah mendukung
  sync queue, service worker belum ditambahkan
- Foto upload untuk menu (saat ini field `photo` tersedia, upload handler belum dibuat)

## 11. Deployment

1. Install dependency dengan `npm install`.
2. Set `DATABASE_URL` ke connection string PostgreSQL Supabase dan `SESSION_SECRET` ke nilai random yang kuat.
3. Jalankan di belakang HTTPS (wajib untuk kamera/GPS di perangkat mobile selain localhost).
4. Saat database baru kosong, aplikasi otomatis menjalankan seed awal. Jangan menjalankan seed berulang pada database operasional.
5. Jalankan `npm start`.
6. Backup database Supabase secara berkala. Data SQLite lama tidak dipindahkan pada migrasi ini.

## 12. Struktur Folder

```
mahadimsum/
├── src/
│   ├── db/            # schema.sql + koneksi & settings helper
│   ├── middleware/     # RBAC
│   ├── routes/         # Express routes per modul
│   ├── services/       # business logic (pos, inventory, attendance, payroll, audit)
│   └── server.js
├── public/             # frontend (staff.html, admin.html, index.html/login)
├── seed/                # seed.js — data awal
├── tests/               # automated tests (Section 57)
└── package.json
```

## 13. Changelog — Update Batch 2

- **Menu / User / Stock**: edit penuh + hapus (hard delete bila belum pernah
  digunakan di transaksi/recipe/pergerakan stock; otomatis fallback ke nonaktifkan
  bila sudah pernah dipakai, demi menjaga integritas riwayat)
- **Transaksi manual** kini mendukung tanggal & jam bebas (`transactionDate`,
  `transactionTime`) — bisa untuk tanggal lalu maupun tanggal mendatang
- **Bonus karyawan** sekarang dihitung dari **kategori menu "Dimsum"** (bukan lagi
  flag per-item) — item apa pun berkategori "Dimsum" otomatis ikut dihitung,
  kategori lain (Ekado/Lumpia/dll) otomatis tidak dihitung
- **Validasi pembayaran cash**: backend menolak transaksi jika nominal diterima
  lebih kecil dari total tagihan (`INSUFFICIENT_PAYMENT`), divalidasi juga di UI
- **Riwayat transaksi staff**: staff hanya melihat transaksi miliknya sendiri;
  admin tetap melihat semua
- **Catatan opsional** di check-in dan check-out absensi (`check_in_note`,
  `check_out_note`)
- **Detail transaksi bisa diklik** dari daftar riwayat (staff & admin) — modal
  menampilkan menu yang dibeli, status, metode pembayaran, dan kembalian
- **Reports grid baru** (`/admin/reports/transactions`) — satu baris per transaksi
  dengan ringkasan menu yang dibeli, status pembayaran, dan jenis pembayaran,
  di-filter berdasarkan rentang tanggal
- **Modul Utilities baru** — pencatatan pengeluaran/pemasukan harian (sewa listrik,
  gas, sewa lapak, admin bank, kasbon lunas, dll) secara debit/kredit, otomatis
  ikut mengurangi/menambah Pendapatan Bersih di dashboard
- **Dashboard dengan filter rentang tanggal** menampilkan 6 kartu KPI:
  Pendapatan Bersih `(cash+qris) − total utilities`, Total Utilities
  (debit−kredit utilities + gaji karyawan yang sudah PAID), Pendapatan Cash,
  Pendapatan QRIS, Jumlah Pcs Dimsum Terjual, dan jumlah transaksi — plus 4 tabel:
  produk terlaris, produk paling sedikit terjual, stock kritis, item perlu restock

Semua perubahan di atas tercakup dalam automated test (`tests/run-tests.js`,
27 skenario, semua PASS).

## 14. Changelog — Update Batch 3

- **Bulk upload via CSV** untuk tiga modul, masing-masing dengan popup upload file
  dan ringkasan hasil (jumlah berhasil + daftar baris gagal):
  - Utilities: `date,description,category,type,amount`
  - Transaksi manual: `date,time,menu_name,quantity,payment_method,paid_amount,notes`
    (satu baris = satu transaksi; time/payment_method/paid_amount/notes opsional)
  - Stock: `name,category,unit,current_stock,minimum_stock,target_stock,restock_frequency`
    (nama yang sudah ada akan diupdate — selisih stock tercatat sebagai pergerakan
    stock beraudit; nama baru akan membuat item baru)
- **Download Excel (.xlsx)**:
  - Transaksi (`/api/pos/transactions/export`) — tersedia di halaman Transactions
    (admin) dan Riwayat (staff, hanya transaksi miliknya)
  - Reports (`/api/admin/reports/export`) — file multi-sheet (Sales per Hari,
    Per Produk, Detail Transaksi) sesuai rentang tanggal yang dipilih
- **Dashboard**: tabel "Status Absensi Karyawan Hari Ini" dihapus; Produk/Menu
  Terlaris dan Paling Sedikit Terjual kini ditampilkan sebagai bar chart ringan
  (CSS, tanpa dependency eksternal) alih-alih tabel
- **Semua input berupa prompt/confirm/alert browser bawaan** (seperti pada
  screenshot "localhost:3000 says") **diganti popup kustom dalam aplikasi**
  (`public/dialog.js`: `promptDialog`, `promptSingle`, `confirmDialog`,
  `alertDialog`, `uploadCsvDialog`) — diterapkan di seluruh halaman admin & staff

Backend untuk batch ini diverifikasi lewat smoke test langsung ke server berjalan
(login, bulk upload x3, dashboard dengan rentang tanggal, download Excel transaksi
& reports, serta validasi bahwa staff hanya melihat transaksinya sendiri) — semua
berhasil. Satu bug ditemukan & diperbaiki selama proses ini: route
`/pos/transactions/export` sempat tertimpa oleh `/pos/transactions/:id` karena
urutan deklarasi route Express; sudah diperbaiki.

## 15. Changelog — Update Batch 4

- **Kolom Kasir**: halaman Transactions (admin), Reports (admin), dan Riwayat
  Transaksi (staff) kini menampilkan nama kasir/user yang melayani setiap transaksi
- **Filter tambahan** pada Transactions, Reports, dan Riwayat staff: metode
  pembayaran (Cash/QRIS), status pembayaran (PAID/PENDING/VOID/dll), dan nama
  kasir (khusus admin — staff hanya melihat transaksinya sendiri sehingga filter
  kasir tidak relevan). Endpoint `/api/pos/cashiers` menyediakan daftar kasir
  untuk dropdown filter
- **Baris Total Pendapatan**: setiap tabel transaksi (Transactions, Reports,
  Riwayat staff) dan file Excel yang diunduh kini menampilkan baris total di
  akhir, menjumlahkan `grand_total` dari transaksi berstatus PAID sesuai filter
  yang aktif
- **Riwayat Transaksi staff** diperbaiki: sebelumnya masih memperlakukan respons
  API sebagai array biasa padahal backend sudah mengirim bentuk
  `{ rows, summary }` (berpotensi error) — sekarang dirender dengan benar,
  dilengkapi filter rentang tanggal, metode, dan status pembayaran
- **Dashboard — format Total Utilities**: jika pengeluaran (debit) lebih
  dominan, nominal ditampilkan minus (mis. `-Rp99.999`) karena mengurangi
  pendapatan bersih; jika pemasukan (kredit) lebih dominan, ditampilkan sebagai
  angka positif biasa tanpa tanda minus (mis. `Rp400.001`) karena menambah
  pendapatan — logika dan nilai `pendapatanBersih` itu sendiri tidak berubah,
  hanya cara tampilannya di kartu dashboard

Semua perubahan diverifikasi lewat smoke test langsung ke server berjalan:
kolom `cashier_name` pada hasil `/pos/transactions` dan
`/admin/reports/transactions`, filter `paymentMethod`/`paymentStatus`/`cashierId`,
endpoint `/pos/cashiers`, serta dua skenario tanda Total Utilities
(dominan debit → positif/expense, dominan kredit → negatif/income) — semua
sesuai ekspektasi.

## 16. Changelog — Update Batch 5

- **Dashboard card Total Utilities**: kini selalu ditampilkan polos tanpa tanda
  minus (mis. `Rp25.000`, bukan `-Rp25.000`) — nilai mentah (`totalUtilities`)
  yang dipakai untuk kalkulasi Pendapatan Bersih tidak berubah, hanya cara
  tampilannya di kartu dashboard (`Math.abs`)
- **Dashboard**: grid table "Stock Kritis" dihapus; "Item Perlu Restock" kini
  tampil sebagai satu card memanjang penuh (bukan lagi berdampingan 2 kolom)
- **Menu Utilities**: baris "TOTAL UTILITIES" ditambahkan di akhir tabel,
  menjumlahkan net debit−kredit dari seluruh entry yang tampil, ditampilkan
  polos tanpa minus (konsisten dengan kartu dashboard)
- **Tampilan admin full-screen**: container `.app.wide` dan `.layout`/`.content`
  kini mengikuti dimensi penuh browser/device (height: 100vh, width: 100%,
  sidebar tetap + area konten scroll independen) alih-alih dibatasi max-width

Diverifikasi lewat smoke test: kombinasi debit+kredit pada tanggal yang sama
menghasilkan `totalUtilities` mentah bertanda (mis. `-25000` saat kredit lebih
besar), namun kartu dashboard dan baris Total Utilities di halaman Utilities
keduanya menampilkannya sebagai `Rp25.000` tanpa tanda minus.

## 17. Changelog — Update Batch 6

- **Dashboard card Total Utilities**: dikembalikan ke tampilan bertanda asli —
  positif tampil polos (`Rp...`), negatif tampil dengan minus di depan `Rp`
  (`-Rp...`) — menggantikan versi "selalu polos" dari batch sebelumnya
- **Filter rentang tanggal** ditambahkan ke halaman Transactions (admin),
  melengkapi filter metode/status/kasir yang sudah ada
- **Menu Restock (Friday Restock Day) dihapus** dari sidebar admin. Ditemukan
  dan diperbaiki bug kritis selama proses ini: referensi ke fungsi yang sudah
  dihapus masih tertinggal di router halaman, yang akan membuat seluruh
  aplikasi admin gagal total (blank screen) — sudah diperbaiki
- **Formula potongan keterlambatan diganti**: rate per menit kini diturunkan
  dari gaji pokok (gapok) masing-masing karyawan sendiri, dibagi total menit
  kerja minimum per hari — `rate/menit = gapok ÷ (jam_kerja_minimum × 60)`.
  Jam kerja minimum diatur lewat setting baru `MINIMUM_WORK_HOURS_PER_DAY`
  (default 8 jam). Contoh: gapok Rp50.000/hari ÷ 480 menit = Rp104,17/menit
- **Data demo**: `npm run seed` kini otomatis menginjeksikan absensi Karyawan A
  hadir penuh sepanjang September 2026 (30 hari) dengan keterlambatan 30 menit
  pada tanggal 13, lalu menghitung & menyimpan payroll periode tersebut secara
  otomatis sehingga langsung terlihat di menu Payroll:
  - Gapok: Rp1.500.000, Uang Makan: Rp300.000, Uang Transport: Rp300.000
  - Potongan Keterlambatan: Rp3.125 (30 menit × Rp104,17)
  - **Gaji Bersih (Net Pay): Rp2.096.875**
- **Payslip PDF** per payroll — tombol "⬇ Payslip PDF" di setiap baris menu
  Payroll (`GET /api/admin/payroll/:id/payslip`, dibangun dengan `pdfkit`),
  berisi: ringkasan kehadiran (hari kerja, menit terlambat, rate potongan),
  rincian pendapatan (gapok, uang makan, uang transport, bonus, lembur),
  rincian potongan (keterlambatan + ilustrasi potongan utilities — dihitung
  dari total pengeluaran/DEBIT utilities pada periode tersebut dibagi rata
  jumlah karyawan aktif, karena utilities saat ini belum terhubung langsung
  ke karyawan tertentu), dan gaji bersih final

Diverifikasi lewat smoke test: PDF payslip valid (header `%PDF`), formula
potongan keterlambatan gapok-based menghasilkan angka yang sama persis dengan
perhitungan manual, filter rentang tanggal pada Transactions bekerja benar,
dan seluruh 23 automated test tetap PASS tanpa regresi.

## 18. Changelog — Update Batch 7

- **Dashboard card Total Utilities — logika tanda diperbaiki** agar sesuai
  sudut pandang "dampak ke kas masuk" (kredit − debit − gaji), bukan sudut
  pandang pengeluaran internal:
  - Pengeluaran (debit) 50rb saja → `-Rp50.000`
  - Pemasukan (kredit) 10rb saja → `+Rp10.000`
  - Kredit 10rb + Debit 50rb → `-Rp40.000`
  - Kredit 50rb + Debit 10rb → `+Rp40.000`
  Nilai `totalUtilities` mentah yang dipakai untuk formula Pendapatan Bersih
  tidak berubah — hanya cara menampilkannya di kartu dashboard (tanda dibalik
  + selalu eksplisit `+`/`-`)
- **Field karyawan (opsional) di menu Utilities**: setiap entry debit/kredit
  kini bisa dikaitkan ke satu karyawan tertentu (dropdown "Tidak terkait
  karyawan" / pilih nama). Entry **DEBIT** yang terkait karyawan (mis. kasbon)
  otomatis mengurangi **net pay** karyawan tsb saat payroll periode yang
  mencakup tanggal entry tersebut dihitung — muncul sebagai baris "Potongan
  Utilities" tersendiri di hasil perhitungan, Payroll, dan Payslip. Didukung
  juga lewat upload bulk CSV (kolom `employee_name` opsional)
- **Payslip PDF disederhanakan**: baris Status dihapus; Ringkasan Kehadiran
  kini menampilkan Total Menit Kerja (baru, dihitung dari check-in/check-out
  aktual) selain Total Hari Kerja dan Total Menit Terlambat; baris rate/formula
  potongan keterlambatan (`gapok ÷ jam kerja × 60`) dihapus — potongan
  keterlambatan kini hanya ditampilkan sebagai nominal akhir. Ukuran dokumen
  tetap A4.

Diverifikasi dengan ekstraksi teks PDF sesungguhnya (via pypdf, bukan sekadar
pencarian byte mentah yang keliru karena stream PDF terkompresi): seluruh teks
yang diharapkan ada/tidak ada sudah sesuai, dan ukuran halaman PDF dikonfirmasi
595.28 × 841.89 pt (A4 persis). Empat skenario tanda dashboard dan skenario
kasbon karyawan (potongan Rp100.000 mengurangi net pay dari Rp2.096.875 menjadi
Rp1.996.875) juga diverifikasi lewat smoke test langsung ke server berjalan —
semua sesuai ekspektasi. Seluruh 23 automated test tetap PASS tanpa regresi.

## 19. Changelog — Update Batch 8

- **Bug diperbaiki: nominal payslip PDF terpotong/tidak terlihat.** Penyebabnya
  adalah penggunaan pola `doc.text(label, {continued: true})` lalu
  `doc.text(value, x, y, {align:'right'})` di pdfkit — kombinasi ini tidak
  menempatkan teks kedua pada koordinat x yang diminta, melainkan mendorongnya
  ke luar batas halaman kanan sehingga nominal (Rp...) nyaris tidak terlihat.
  Diganti dengan helper `row()` yang menggambar label dan nilai sebagai dua
  pemanggilan `doc.text()` independen pada y yang sama (tanpa `continued`),
  dengan kolom tetap: label 50–400pt, nominal 400–545pt (pas di dalam margin
  A4). Kini seluruh baris (Gaji Pokok, Uang Makan, Uang Transport, Bonus,
  Lembur, Potongan Keterlambatan, Potongan Utilities, Gaji Bersih) tampil
  penuh tanpa terpotong.

Diverifikasi dengan merender PDF hasil generate ke gambar PNG (via
`pdftoppm`) dan diperiksa langsung secara visual — semua nominal terlihat utuh
di dalam batas halaman.

## 20. Changelog — Update Batch 9

- **Hapus hitungan payroll**: tombol "Hapus" ditambahkan di menu Payroll —
  bisa menghapus hitungan payroll apa pun, termasuk yang statusnya sudah
  APPROVED atau PAID (`DELETE /api/admin/payroll/:id`)
- **Section Payslip di Profile karyawan**: staff kini melihat daftar payslip
  miliknya sendiri (hanya yang sudah di-approve/dibayar admin —
  `GET /api/admin/payroll/mine`, permission baru `payroll.view_own`) lengkap
  dengan tombol download PDF. Payslip bulan lalu tetap bisa diunduh selama
  masih dalam tahun yang sama; begitu tahun berganti, seluruh payslip tahun
  sebelumnya otomatis terhapus dari sistem (`purgeOldYearPayroll()`, dipanggil
  saat server start dan setiap kali daftar payroll diambil, sehingga tetap
  akurat meski server berjalan terus tanpa restart melewati pergantian tahun).
  Akses payslip per-PDF juga diperketat: karyawan hanya bisa membuka payslip
  miliknya sendiri yang berstatus APPROVED/PAID — mencoba membuka payslip
  karyawan lain akan ditolak (403), diverifikasi lewat smoke test
- **Riwayat absensi di Profile karyawan** kini hanya menampilkan bulan
  berjalan (filter tampilan, bukan hapus data) — otomatis "kosong" lagi begitu
  bulan berganti, lalu terisi ulang dengan absensi bulan baru
- **Menu Attendance (admin) — fitur baru**:
  - Tombol "+ Tambah Absen Manual" untuk input absensi karyawan yang lupa
    absen — foto dan lokasi GPS keduanya **opsional** (berbeda dari
    check-in/out mandiri karyawan yang mewajibkan keduanya). Late/overtime
    tetap dihitung otomatis dari jadwal jika jam diisi
  - Filter daftar absensi berdasarkan nama karyawan
  - Admin bisa membuka foto yang ditangkap karyawan (tombol "In"/"Out" per
    baris, menampilkan foto dalam modal)
  - Riwayat attendance mentah hanya disimpan untuk bulan berjalan — begitu
    bulan berganti, baris bulan sebelumnya **dihapus permanen** dari database
    (`purgeOldMonthAttendance()`, dipanggil saat startup dan setiap kali
    daftar attendance admin diambil). Payroll yang sudah dihitung & disimpan
    sebelumnya tidak terpengaruh karena disimpan terpisah di tabel `payroll`

Seluruh fitur baru diverifikasi lewat smoke test langsung ke server berjalan:
hapus payroll APPROVED berhasil, kontrol akses payslip staff (pending
tersembunyi, approved terlihat, lintas-karyawan ditolak) sesuai ekspektasi,
input absen manual dengan/tanpa foto & lokasi berfungsi dengan late-minutes
terhitung benar sesuai jadwal, filter karyawan pada daftar attendance akurat,
dan kedua mekanisme purge (bulan untuk attendance, tahun untuk payroll)
berhasil menghapus data lama sambil membiarkan data terkini utuh. Seluruh 23
automated test tetap PASS tanpa regresi.

## 21. QRIS Dinamis — Static → Dynamic + QRIS Interactive Mutation

Build ini **tidak menggunakan Winpay sama sekali**.

### Alur pembayaran

1. POS membuat transaksi QRIS lokal dengan status `PENDING`.
2. POS mengambil QRIS static merchant dari `QRIS_STATIC_PAYLOAD`.
3. Converter lokal mengubah Point of Initiation Method `01=11` menjadi `01=12`.
4. Converter menambahkan tag `54` dengan nominal transaksi, misalnya `540825000.00` untuk Rp25.000,00.
5. CRC-16/CCITT-FALSE pada tag `63` dihitung ulang.
6. QR dinamis ditampilkan pada layar kasir. Customer tidak perlu mengetik nominal.
7. Server melakukan reconciliation terhadap mutasi Merchant Dashboard QRIS Interactive.
8. Jika ditemukan transaksi `Success` dengan nominal yang sama di window transaksi, POS menjalankan `PENDING -> PAID` dan memotong stok tepat satu kali.

### QRIS static merchant yang digunakan

Payload default adalah payload yang diberikan pemilik aplikasi:

```text
00020101021126760024ID.CO.SPEEDCASH.MERCHANT01189360081530004565900215ID102600456590303UKE51440014ID.CO.QRIS.WWW0215ID10265372041290303UKE5204581253033605802ID5910MAHADIMSUM6008KARAWANG61054137162410509S442602920117202609181941504260703A0163043310
```

Konfigurasi merchant:

- NMID: `ID1026537204129`
- mID / Merchant ID: `127424927`
- Merchant: `MAHADIMSUM`
- Kota: `KARAWANG`
- Terminal: `A01`

### Interactive mutation adapter

Repo [`restugbk/qris-interactive`](https://github.com/restugbk/qris-interactive) adalah library PHP unofficial yang mendokumentasikan workflow:

```text
login(username, password)
       ↓
getMerchant()
       ↓
merchant_id
       ↓
getTransactionsByRange()
       / atau
getTransactionsByCustom(..., 'nominal', ...)
       ↓
transactions[]
       ↓
status = Success
```

Build Node.js ini mempertahankan workflow tersebut melalui `src/services/qris-interactive.js` dan menyimpan cookie session secara lokal. Interface hasil mutasi dinormalisasi menjadi `transaction_id`, `invoice_id`, `date`, `amount`, `status`, `payment_method`, `customer`, dan `rrn` jika tersedia.

> **Catatan penting:** library upstream adalah unofficial dan memakai endpoint internal Merchant Dashboard. Endpoint internal tersebut dapat berubah tanpa pemberitahuan. Karena itu path dashboard dibuat configurable di Settings, bukan dikunci permanen ke kode.

### Settings

Isi di Admin → Settings:

| Setting | Nilai / fungsi |
|---|---|
| `QRIS_STATIC_PAYLOAD` | QRIS static merchant di atas |
| `QRIS_MERCHANT_ID` | `ID1026537204129` (NMID) |
| `QRIS_MERCHANT_NAME` | `MAHADIMSUM` |
| `QRIS_INTERACTIVE_BASE_URL` | `https://merchant.qris.interactive.co.id` |
| `QRIS_INTERACTIVE_USERNAME` | Email/username dashboard merchant Interactive |
| `QRIS_INTERACTIVE_PASSWORD` | Password dashboard merchant Interactive |
| `QRIS_INTERACTIVE_MERCHANT_ID` | `127424927` |
| `QRIS_INTERACTIVE_LOGIN_PATH` | `/v2/m/login.php` |
| `QRIS_INTERACTIVE_MERCHANT_PATH` | Endpoint merchant dari dashboard/package |
| `QRIS_INTERACTIVE_TRANSACTION_PATH` | Endpoint mutasi dari dashboard/package |
| `QRIS_RECONCILE_SECONDS` | Interval server reconciliation, default 20 detik |
| `QRIS_EXPIRY_SECONDS` | Masa tampil QR POS, default 300 detik |

Password tidak dikirim kembali ke browser oleh endpoint Settings.

### Matching pembayaran

POS tidak menganggap transaksi lunas hanya karena ada nominal yang sama. Reconciliation memeriksa:

- nominal mutasi = `grand_total` transaksi;
- status mutasi = `Success`/`Paid`/`Berhasil`;
- timestamp mutasi berada pada window transaksi;
- reference/Invoice/RRN disimpan ke `qris_reference` ketika tersedia.

Jika nominal berbeda, transaksi tetap `PENDING` dan dicatat ke audit log.

### Tidak ada lagi Winpay

Kode berikut dari build lama sudah tidak menjadi jalur pembayaran:

- Winpay SNAP generate/query/cancel;
- RSA request signing;
- Winpay client/partner ID;
- Winpay webhook/payment notify;
- private/public key Winpay;
- access-token/HMAC Winpay.

`src/routes/qris-webhook.js` hanya dipertahankan sebagai compatibility stub dan tidak lagi dipasang oleh `server.js`.

### Pengujian lokal

Jalankan:

```bash
npm run test:qris
```

Test memeriksa converter Static → Dynamic, `01=12`, tag nominal `54`, CRC baru, guard nominal yang salah, dan settlement `PAID`.

### Sumber

- Repo mutation: https://github.com/restugbk/qris-interactive
- Merchant Dashboard: https://merchant.qris.interactive.co.id/


## Supabase PostgreSQL

Set `DATABASE_URL` di environment (Render) ke connection string PostgreSQL dari Supabase. Ganti `[YOUR-PASSWORD]` hanya di environment variable; jangan commit password ke repository. Schema PostgreSQL dibuat otomatis saat aplikasi mulai. Migrasi ini memulai database baru dan **tidak** memindahkan data SQLite lama.


## Update 2026-10-11 — Excel import, reporting, and inventory cost

- Bulk uploads for stock, utilities, and manual transactions now accept `.xlsx`.
- Each upload popup has a **Download Template Excel** link. Keep the template's first-row column names unchanged.
- Inventory has `unit_price`, the current cost per formula unit (e.g. per gram, piece, or slice). Existing records migrate automatically with a default of `0`.
- Reports include daily sales, product sales, and gross profit/HPP per menu based on the latest active recipe multiplied by current inventory unit prices.
- Profit is an estimate using current costs, not historical cost snapshots. Populate `unit_price` and maintain each menu's recipe for meaningful HPP.
- PostgreSQL migration is also available at `src/db/migrations/20261011_inventory_unit_price.sql`.

-- Aturan hitung disamakan dengan laporan hermes-ads milik owner:
--  * PPN iklan 3% dari spend (bukan 11%).
--  * PPN lynk 3% dari OMZET KOTOR (totalPrice + totalAddon + totalShipping), dihitung manual karena lynk tidak mengirim PPN.
-- Omzet kotor disimpan per penjualan supaya dasar PPN lynk tepat (grandTotal sudah bersih dari diskon/biaya layanan).
ALTER TABLE sales ADD COLUMN gross bigint;
ALTER TABLE account_settings ALTER COLUMN ad_tax_pct SET DEFAULT 3;
UPDATE account_settings SET ad_tax_pct = 3 WHERE ad_tax_pct = 11;
UPDATE line_settings SET fee_pct = 3 WHERE line = 'digital' AND fee_pct = 0;
CREATE INDEX sales_gross_idx ON sales (line, date) INCLUDE (gross) WHERE deleted_at IS NULL AND channel = 'lynk';

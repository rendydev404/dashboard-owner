# Menyambungkan webhook lynk.id yang sudah ada ke dashboard

lynk.id hanya mengirim ke **satu** URL webhook per akun. Saat ini URL itu menuju penerima lama di VPS
(`hermes-ads/report/lynk/webhook.py`, path `/hooks/lynk/<token>`) yang laporan Telegram / per jam-nya masih bergantung padanya.
**Jangan ganti URL di dashboard lynk.id**, nanti laporan lama berhenti. Cukup minta penerima lama **meneruskan** setiap kiriman ke dashboard.

## 1. Riwayat (sekali saja)

Di VPS, setelah dashboard hidup dan `LYNK_MERCHANT_KEY` sama dengan merchant key lynk:

```bash
DASHBOARD_URL=https://<domain-dashboard> python3 deploy/replay-lynk-events.py --dry-run
```
```bash
DASHBOARD_URL=https://<domain-dashboard> python3 deploy/replay-lynk-events.py
```

Skrip membaca SQLite lama secara read-only dan mengirim ulang tiap event dengan tanda tangan aslinya. Dashboard memverifikasi ulang tanda tangan dan tidak pernah menghitung satu transaksi dua kali (idempoten per `message_id` dan `refId`).

## 2. Transaksi baru (otomatis)

Tambahkan penerusan di `hermes-ads/report/lynk/webhook.py`. Ini perubahan kecil, gagal-aman: kalau dashboard mati, penerima lama tetap menyimpan seperti biasa.

Di bagian atas file, bersama konstanta lain:

```python
import urllib.request
FORWARD_URL = os.environ.get("LYNK_FORWARD_URL", "")  # contoh: https://<domain-dashboard>/webhooks/lynk


def forward(body: str, headers: dict) -> None:
    """Teruskan kiriman mentah ke dashboard iklan (best effort, tidak boleh mengganggu respons ke Lynk)."""
    sig = next((v for k, v in headers.items() if k.lower() == "x-lynk-signature"), "")
    req = urllib.request.Request(FORWARD_URL, data=body.encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Lynk-Signature": sig})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:  # noqa: BLE001
        pass
```

Di `do_POST`, tepat sebelum `self._reply(200, {"ok": True})`:

```python
        if FORWARD_URL:
            threading.Thread(target=forward, args=(body, headers), daemon=True).start()
```

Lalu tambahkan `LYNK_FORWARD_URL=https://<domain-dashboard>/webhooks/lynk` di `/etc/lynk-webhook.env` dan `systemctl restart lynk-webhook`.

Kalau dashboard sempat mati dan ada transaksi terlewat, jalankan lagi langkah 1 (aman diulang).

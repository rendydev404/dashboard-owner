#!/usr/bin/env python3
"""Putar ulang riwayat webhook lynk.id yang sudah tersimpan di VPS ke dashboard iklan.

Sumber: tabel `events` di SQLite penerima webhook lama (hermes-ads/report/lynk), dibuka READ-ONLY.
Tujuan: POST /webhooks/lynk dashboard dengan header X-Lynk-Signature & body asli, jadi tanda tangan diverifikasi
ulang oleh dashboard memakai LYNK_MERCHANT_KEY. Aman dijalankan berulang: dashboard idempoten per message_id.

Pemakaian (di VPS):
  DASHBOARD_URL=https://iklan.example.com python3 replay-lynk-events.py [--dry-run] [--rate 100]
Env: LYNK_DB (default /var/lib/private/lynk-webhook/lynk.db)
"""
import argparse, json, os, sqlite3, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--dry-run", action="store_true", help="hitung saja, jangan kirim")
ap.add_argument("--rate", type=int, default=100, help="maks. request per menit (dashboard membatasi 120/mnt)")
args = ap.parse_args()

DB = os.environ.get("LYNK_DB", "/var/lib/private/lynk-webhook/lynk.db")
URL = os.environ.get("DASHBOARD_URL", "").rstrip("/") + "/webhooks/lynk"
if not args.dry_run and not os.environ.get("DASHBOARD_URL"):
    sys.exit("isi DASHBOARD_URL, contoh: DASHBOARD_URL=https://iklan.example.com")

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
rows = con.execute("SELECT id, received_at, headers, body FROM events ORDER BY id").fetchall()
sent = ok = dup = rejected = skipped = failed = 0
delay = 60.0 / max(1, args.rate)

for _id, received, headers, body in rows:
    try:
        payload = json.loads(body)
    except ValueError:
        skipped += 1
        continue
    if payload.get("event") != "payment.received":
        skipped += 1
        continue
    h = {k.lower(): v for k, v in json.loads(headers).items()}
    sig = h.get("x-lynk-signature", "")
    if args.dry_run:
        sent += 1
        continue
    req = urllib.request.Request(URL, data=body.encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Lynk-Signature": sig})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            res = json.loads(r.read() or b"{}")
            dup += bool(res.get("duplicate"))
            ok += not res.get("duplicate")
    except urllib.error.HTTPError as e:
        rejected += e.code == 401
        failed += e.code != 401
        print(f"event {_id} ({received}): HTTP {e.code}", file=sys.stderr)
    except OSError as e:
        failed += 1
        print(f"event {_id}: {e}", file=sys.stderr)
    sent += 1
    time.sleep(delay)

print(f"total event {len(rows)} · dikirim {sent} · baru {ok} · sudah ada {dup} · tanda tangan ditolak {rejected} · "
      f"dilewati (bukan payment.received) {skipped} · gagal {failed}" + (" · DRY RUN" if args.dry_run else ""))

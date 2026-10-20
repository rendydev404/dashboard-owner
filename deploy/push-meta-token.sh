#!/bin/sh
# Kirim token Meta (hasil export-meta-token.py) ke VPS dashboard, HANYA kalau isinya berubah.
# Di VPS tujuan kunci ini dibatasi forced command /usr/local/bin/receive-meta-token (lihat deploy/receive-meta-token).
set -eu
SRC=${SRC:-/opt/ads-dashboard/meta-token.json}
DEST=${DEST:-root@31.97.67.66}
KEY=${KEY:-/root/.ssh/meta_token_push}
STATE=/opt/ads-dashboard/.pushed.sha256
sum=$(sha256sum "$SRC" | cut -d' ' -f1)
[ -f "$STATE" ] && [ "$(cat "$STATE")" = "$sum" ] && exit 0
ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 \
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/opt/ads-dashboard/.known_hosts \
    "$DEST" < "$SRC"
echo "$sum" > "$STATE"
echo "token terkirim ke $DEST"

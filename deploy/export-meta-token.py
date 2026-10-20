#!/usr/bin/env python3
"""Salin HANYA token Meta Ads dari login Claude Code (user claude-ads) ke file terpisah untuk dashboard.

Kenapa: /var/lib/claude-ads/.claude/.credentials.json juga berisi login akun Claude. Container dashboard tidak
perlu (dan tidak boleh) memegangnya. File hasil ekspor hanya berisi entri `meta_ads` dengan struktur yang sama,
jadi dashboard cukup mengarahkan META_MCP_CRED ke file ini.

Jalankan sebagai root di VPS (timer: lihat meta-token-export.timer). Aman dijalankan berulang.
"""
import json, os, sys, tempfile

SRC = os.environ.get("SRC", "/var/lib/claude-ads/.claude/.credentials.json")
DST = os.environ.get("DST", "/opt/ads-dashboard/meta-token.json")
UID = int(os.environ.get("DASHBOARD_UID", "1000"))  # uid user `node` di container dashboard

d = json.load(open(SRC))
ent = {k: v for k, v in d.get("mcpOAuth", {}).items() if v.get("serverName") == "meta_ads" and v.get("accessToken")}
if not ent:
    sys.exit("entri meta_ads tidak ada: login Meta Ads dulu di Claude Code (user claude-ads)")
out = {"mcpOAuth": {k: {"serverName": v["serverName"], "accessToken": v["accessToken"], "expiresAt": v.get("expiresAt")} for k, v in ent.items()}}

os.makedirs(os.path.dirname(DST), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(DST), prefix=".tok-")
with os.fdopen(fd, "w") as f:
    json.dump(out, f)
os.chmod(tmp, 0o400)
os.chown(tmp, UID, UID)
os.replace(tmp, DST)  # atomik
exp = next(iter(out["mcpOAuth"].values())).get("expiresAt")
print("ok, berlaku sampai", exp)

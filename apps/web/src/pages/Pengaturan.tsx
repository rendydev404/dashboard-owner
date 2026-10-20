import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Pencil } from "lucide-react";
import { rpk, parseRp, LINES, type Account, type Line, type Product, type User } from "@iklan/shared";
import { api, useBootstrap, refreshData } from "../lib/api";
import { Card, CardHead, Modal, toast, confirmDialog, cx } from "../components/ui";

const RESULT_TYPES = [
  ["omni_purchase", "Pembelian (pixel / omni)"],
  ["onsite_conversion.messaging_conversation_started_7d", "Percakapan WhatsApp/Messenger dimulai"],
  ["lead", "Lead form"],
  ["onsite_conversion.lead_grouped", "Lead (semua sumber)"],
] as const;

function useSave(path: string, method: "POST" | "PATCH" | "DELETE", msg: string, after?: () => void) {
  return useMutation({
    mutationFn: (json?: unknown) => api(path, { method, json }),
    onSuccess: () => { toast(msg); refreshData(); after?.(); },
    onError: (e) => toast(e.message, { tone: "err" }),
  });
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line px-4 py-3">
      {ok ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-green" /> : <XCircle size={18} className="mt-0.5 shrink-0 text-red" />}
      <div className="min-w-0 text-[13px]"><p className="font-semibold">{label}</p><p className="text-muted">{detail}</p></div>
    </div>
  );
}
const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "belum pernah");

function AccountForm({ acc, onDone }: { acc?: Account; onDone: () => void }) {
  const [f, setF] = useState({ id: acc?.id ?? "", name: acc?.name ?? "", line: acc?.line ?? ("digital" as Line), resultActionType: acc?.resultActionType ?? "omni_purchase", active: acc?.active ?? true });
  const m = useSave(acc ? `/accounts/${acc.id}` : "/accounts", acc ? "PATCH" : "POST", acc ? "Akun diperbarui" : "Akun ditambahkan, data mulai ditarik", onDone);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(acc ? { name: f.name, line: f.line, resultActionType: f.resultActionType, active: f.active } : f); }}>
      {!acc && <label className="block"><span className="label">ID akun iklan (angka, tanpa act_)</span><input className="input mt-1" inputMode="numeric" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.replace(/\D/g, "") })} required placeholder="1392053332395676" /></label>}
      <label className="block"><span className="label">Nama tampilan</span><input className="input mt-1" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} /></label>
      <label className="block"><span className="label">Jenis lini</span>
        <select className="input mt-1" value={f.line} onChange={(e) => { const line = e.target.value as Line; setF({ ...f, line, resultActionType: line === "jasa" ? RESULT_TYPES[1][0] : RESULT_TYPES[0][0] }); }}>
          <option value="digital">Produk Digital AI (omzet dari lynk.id)</option><option value="jasa">Jasa AI (leads & closing manual)</option>
        </select>
      </label>
      <label className="block"><span className="label">Hasil yang dihitung</span>
        <select className="input mt-1" value={f.resultActionType} onChange={(e) => setF({ ...f, resultActionType: e.target.value })}>
          {RESULT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {acc && <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} className="size-4 accent-[var(--accent)]" /> Akun aktif (ikut sinkron & tampil)</label>}
      <button className="btn btn-primary w-full" disabled={m.isPending}>{m.isPending ? "Menyimpan…" : "Simpan"}</button>
    </form>
  );
}

function ProductForm({ p, onDone }: { p?: Product; onDone: () => void }) {
  const [f, setF] = useState({ line: p?.line ?? ("jasa" as Line), name: p?.name ?? "", price: p?.price ? String(p.price) : "", cogs: p ? String(p.cogs) : "", url: p?.url ?? "" });
  const m = useSave(p ? `/products/${p.id}` : "/products", p ? "PATCH" : "POST", "Produk disimpan", onDone);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate({ ...(p ? {} : { line: f.line }), name: f.name, price: f.price ? parseRp(f.price) : null, cogs: parseRp(f.cogs), url: f.url || null }); }}>
      {!p && <label className="block"><span className="label">Lini</span><select className="input mt-1" value={f.line} onChange={(e) => setF({ ...f, line: e.target.value as Line })}><option value="jasa">Jasa AI</option><option value="digital">Produk Digital AI</option></select></label>}
      <label className="block"><span className="label">Nama</span><input className="input mt-1" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="label">Harga standar</span><input className="input mt-1" inputMode="decimal" placeholder="7,5jt" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        <label className="block"><span className="label">HPP standar</span><input className="input mt-1" inputMode="decimal" placeholder="2,5jt" value={f.cogs} onChange={(e) => setF({ ...f, cogs: e.target.value })} /></label>
      </div>
      <label className="block"><span className="label">Link (opsional)</span><input className="input mt-1" type="url" placeholder="https://lynk.id/…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
      <button className="btn btn-primary w-full" disabled={m.isPending}>Simpan</button>
    </form>
  );
}

function Users() {
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/users") });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: "", name: "", role: "admin", password: "" });
  const m = useSave("/users", "POST", "Pengguna ditambahkan", () => { setOpen(false); q.refetch(); });
  return (
    <Card>
      <CardHead title="Pengguna" hint="Admin bisa input penjualan & biaya, tapi tidak bisa aksi iklan atau ubah aturan." right={<button className="btn h-9 min-h-0" onClick={() => setOpen(true)}><Plus size={15} /> Tambah</button>} />
      <ul className="divide-y divide-line text-[13px]">
        {q.data?.map((u) => <li key={u.id} className="flex items-center justify-between py-2.5"><span><b className="font-semibold">{u.name}</b> <span className="text-muted">· {u.email}</span></span><span className="pill bg-bg capitalize text-muted">{u.role}</span></li>)}
      </ul>
      <Modal open={open} onClose={() => setOpen(false)} title="Tambah pengguna">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(f); }}>
          <label className="block"><span className="label">Nama</span><input className="input mt-1" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="block"><span className="label">Email</span><input className="input mt-1" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
          <label className="block"><span className="label">Peran</span><select className="input mt-1" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="admin">Admin / CS</option><option value="owner">Owner</option></select></label>
          <label className="block"><span className="label">Password (min. 10 karakter)</span><input className="input mt-1" type="password" minLength={10} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></label>
          <button className="btn btn-primary w-full" disabled={m.isPending}>Tambah</button>
        </form>
      </Modal>
    </Card>
  );
}

export default function Pengaturan() {
  const boot = useBootstrap().data!;
  const owner = boot.user.role === "owner";
  const i = boot.integration;
  const [accModal, setAccModal] = useState<Account | "new" | null>(null);
  const [prodModal, setProdModal] = useState<Product | "new" | null>(null);
  const [fc, setFc] = useState({ line: "digital", name: "", monthly: "" });
  const sync = useSave("/sync", "POST", "Sinkronisasi dimulai, data akan diperbarui otomatis");
  const addFc = useSave("/fixed-costs", "POST", "Biaya tetap ditambahkan", () => setFc({ ...fc, name: "", monthly: "" }));
  const fee = (line: Line) => boot.lineSettings.find((s) => s.line === line)?.feePct ?? 0;

  if (!owner) return <Card><CardHead title="Pengaturan" hint="Hanya owner yang bisa mengubah pengaturan." /></Card>;

  return (
    <div className="grid gap-3 md:gap-4 xl:grid-cols-2">
      <Card className="xl:col-span-2">
        <CardHead title="Status integrasi" right={<button className="btn h-9 min-h-0" disabled={!i.metaConfigured || sync.isPending} onClick={() => sync.mutate(undefined)}><RefreshCw size={15} /> Sinkron sekarang</button>} />
        <div className="grid gap-2 md:grid-cols-3">
          <Status ok={i.metaConfigured && !i.metaError} label={`Meta Ads${i.metaMode === "mcp" ? " · MCP (login Claude Code VPS)" : i.metaMode === "graph" ? " · Graph API" : ""}`}
            detail={!i.metaConfigured ? "Belum terhubung: login Claude Code di VPS (user claude-ads) atau isi META_SYSTEM_USER_TOKEN" : i.metaError ?? `Sinkron terakhir ${ago(i.lastSyncAt)}${i.metaTokenExpiresAt ? ` · login berlaku sampai ${ago(i.metaTokenExpiresAt)}` : ""}`} />
          <Status ok={i.lynkConfigured && !!i.lastLynkAt} label="Webhook lynk.id"
            detail={!i.lynkConfigured ? "LYNK_MERCHANT_KEY belum diisi di server" : `URL: ${location.origin}/webhooks/lynk · ${i.lastLynkAt ? `transaksi terakhir ${ago(i.lastLynkAt)}` : "belum ada transaksi masuk (impor riwayat: deploy/lynk-forward.md)"}`} />
          <Status ok={i.aiConfigured} label="Bot AI (Claude)" detail={i.aiConfigured ? "Terhubung" : "ANTHROPIC_API_KEY belum diisi · bot memakai mode aturan"} />
        </div>
      </Card>

      <Card>
        <CardHead title="Akun iklan" hint="Jenis lini menentukan KPI & aturan bot." right={<button className="btn h-9 min-h-0" onClick={() => setAccModal("new")}><Plus size={15} /> Tambah</button>} />
        <ul className="space-y-2">
          {boot.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 text-[13px]">
              <div className="min-w-0"><p className="truncate font-semibold">{a.name}</p><p className="truncate text-[12px] text-muted">{a.id} · {LINES[a.line].label} · sinkron {ago(a.lastSyncedAt)}</p></div>
              <div className="flex shrink-0 items-center gap-1">
                {!a.active && <span className="pill bg-bg text-muted">Nonaktif</span>}
                <button className="btn btn-ghost size-9 p-0" onClick={() => setAccModal(a)} aria-label={`Ubah ${a.name}`}><Pencil size={15} /></button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHead title="Produk & jasa" hint="Harga & HPP standar dipakai saat input penjualan jasa. Produk lynk.id dibuat otomatis." right={<button className="btn h-9 min-h-0" onClick={() => setProdModal("new")}><Plus size={15} /> Tambah</button>} />
        <ul className="max-h-[340px] space-y-1 overflow-y-auto">
          {boot.products.filter((p) => p.active).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-[13px] hover:bg-hover">
              <div className="min-w-0"><p className="truncate font-medium">{p.name}</p><p className="text-[12px] text-muted">{LINES[p.line].label} · harga {p.price ? rpk(p.price) : "—"} · HPP {rpk(p.cogs)}</p></div>
              <button className="btn btn-ghost size-9 shrink-0 p-0" onClick={() => setProdModal(p)} aria-label={`Ubah ${p.name}`}><Pencil size={15} /></button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHead title="Biaya operasional tetap" hint="Dihitung prorata: bulanan × jumlah hari periode / 30." />
        <ul className="mb-3 divide-y divide-line text-[13px]">
          {boot.fixedCosts.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <span>{c.name} <span className="text-muted">· {LINES[c.line].label}</span></span>
              <span className="flex items-center gap-1"><span className="num font-semibold">{rpk(c.monthly)}/bln</span>
                <button className="btn btn-ghost size-8 min-h-0 p-0 text-muted hover:text-red" aria-label="Hapus" onClick={async () => {
                  if (await confirmDialog({ title: "Hentikan biaya ini?", body: `${c.name} tidak dihitung lagi mulai hari ini.`, confirm: "Hentikan", danger: true }))
                    api(`/fixed-costs/${c.id}`, { method: "DELETE" }).then(() => { toast("Biaya dihentikan"); refreshData(); });
                }}><Trash2 size={15} /></button>
              </span>
            </li>
          ))}
        </ul>
        <form className="grid gap-2 sm:grid-cols-[1fr_1.4fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); if (parseRp(fc.monthly)) addFc.mutate({ ...fc, monthly: parseRp(fc.monthly) }); }}>
          <select className="input" value={fc.line} onChange={(e) => setFc({ ...fc, line: e.target.value })} aria-label="Lini"><option value="digital">Digital</option><option value="jasa">Jasa</option></select>
          <input className="input" placeholder="Langganan AI" value={fc.name} onChange={(e) => setFc({ ...fc, name: e.target.value })} required aria-label="Nama biaya" />
          <input className="input" placeholder="450rb / bulan" inputMode="decimal" value={fc.monthly} onChange={(e) => setFc({ ...fc, monthly: e.target.value })} required aria-label="Biaya per bulan" />
          <button className="btn btn-primary" disabled={addFc.isPending}><Plus size={15} /> Tambah</button>
        </form>
      </Card>

      <Card>
        <CardHead title="Fee platform per lini" hint="Potongan % dari omzet (misal fee lynk.id kalau grandTotal belum bersih)." />
        <div className="space-y-2">
          {(["digital", "jasa"] as const).map((l) => <FeeRow key={l} line={l} value={fee(l)} />)}
        </div>
      </Card>

      <div className="xl:col-span-2"><Users /></div>

      <Modal open={!!accModal} onClose={() => setAccModal(null)} title={accModal === "new" ? "Tambah akun iklan" : "Ubah akun iklan"}>
        {accModal && <AccountForm acc={accModal === "new" ? undefined : accModal} onDone={() => setAccModal(null)} />}
      </Modal>
      <Modal open={!!prodModal} onClose={() => setProdModal(null)} title={prodModal === "new" ? "Tambah produk / jasa" : "Ubah produk / jasa"}>
        {prodModal && <ProductForm p={prodModal === "new" ? undefined : prodModal} onDone={() => setProdModal(null)} />}
      </Modal>
    </div>
  );
}

function FeeRow({ line, value }: { line: Line; value: number }) {
  const [v, setV] = useState(String(value));
  const m = useSave(`/line-settings/${line}`, "PATCH", "Fee diperbarui");
  return (
    <form className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2 text-[13px]" onSubmit={(e) => { e.preventDefault(); m.mutate({ feePct: Number(v.replace(",", ".")) || 0 }); }}>
      <span className="text-muted">{LINES[line].label}</span>
      <span className="flex items-center gap-2">
        <input className="input h-8 min-h-0 w-20 px-2 text-right" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={`Fee ${LINES[line].label} (%)`} />%
        <button className={cx("btn h-8 min-h-0 px-3", String(value) !== v && "btn-primary")} disabled={m.isPending}>Simpan</button>
      </span>
    </form>
  );
}

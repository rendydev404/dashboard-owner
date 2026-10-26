import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2, Wallet } from "lucide-react";
import { rp, rpk, pct, dec, nf, parseRp, fmtDate, fmtRange, LINES, type Kpis, type PlColumn, type ManualResp } from "@iklan/shared";
import { api, useBootstrap, useManual, usePl, refreshData, queryClient } from "../lib/api";
import { getToday } from "../lib/view";
import { Card, CardHead, ErrorState, Skeleton, Delta, EmptyState, toast, confirmDialog, cx } from "../components/ui";

type Row = [label: string, key: keyof Kpis, kind?: "neg" | "group" | "total", fmt?: (v: number) => string];
const ROWS: Row[] = [
  ["Penjualan", "revenue"], ["Fee platform / PPN lynk", "fee", "neg"], ["HPP / biaya pengerjaan", "cogs", "neg"], ["Laba kotor", "gross", "group"],
  ["Spend iklan", "spend", "neg"], ["PPN iklan (3%)", "adTax", "neg"], ["Biaya operasional (prorata)", "fixed", "neg"], ["Biaya lain (input manual)", "other", "neg"],
  ["Laba bersih", "net", "total"], ["Margin bersih", "netMargin", undefined, (v) => pct(v)], ["ROAS riil", "roas", undefined, (v) => dec(v) + "x"], ["Order / closing", "orders", undefined, nf],
];

function LabaCard({ col }: { col: PlColumn }) {
  const k = col.kpis, total = col.key === "total";
  return (
    <div className={cx("card p-5", total && "border-accent/40 bg-accent-soft/40")}>
      <div className="flex items-start justify-between gap-2">
        <div><p className="text-[13px] font-medium">Laba {col.label}</p><p className="text-[12px] text-muted">{col.src}</p></div>
        <span className="grid size-8 place-items-center rounded-lg border border-line"><Wallet size={16} /></span>
      </div>
      <p className={cx("num mt-3 text-[26px] font-medium tracking-tight", k.net >= 0 ? "text-green-ink" : "text-red-ink")}>{rpk(k.net)}</p>
      <p className="text-[12px] text-muted">omzet {rpk(k.revenue)} · margin {pct(k.netMargin)}</p>
      <div className="mt-2"><Delta cur={k.net} prev={col.prevNet} goodUp /></div>
    </div>
  );
}

function MoneyInput({ name, value, onChange, placeholder, required, label }: { name: string; value: string; onChange: (v: string) => void; placeholder: string; required?: boolean; label: string }) {
  const n = parseRp(value);
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input mt-1" name={name} inputMode="decimal" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} required={required} />
      <span className="mt-1 block h-4 text-[11.5px] text-muted num">{value && (n ? `= ${rp(n)}` : <span className="text-red-ink">Format tidak dikenali</span>)}</span>
    </label>
  );
}

function SaleForm() {
  const boot = useBootstrap().data!;
  const jasaAccs = boot.accounts.filter((a) => a.line === "jasa");
  const jasaProducts = boot.products.filter((p) => p.line === "jasa" && p.active);
  const empty = { date: getToday(), accountId: jasaAccs[0]?.id ?? "", product: "", client: "", source: "iklan", revenue: "", cogs: "" };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const std = jasaProducts.find((p) => p.name.toLowerCase() === f.product.trim().toLowerCase());
  const m = useMutation({
    mutationFn: () => api("/sales", { method: "POST", json: { ...f, accountId: f.accountId || null, cogs: f.cogs || null } }),
    onSuccess: () => { toast(`Penjualan jasa ${rp(parseRp(f.revenue))} tersimpan`); setF({ ...empty, date: f.date, accountId: f.accountId }); refreshData(); },
    onError: (e) => toast(e.message, { tone: "err" }),
  });
  return (
    <form className="grid gap-x-3 gap-y-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (parseRp(f.revenue)) m.mutate(); }}>
      <label className="block"><span className="label">Tanggal</span><input type="date" className="input mt-1" value={f.date} max={getToday()} onChange={(e) => set("date")(e.target.value)} required /></label>
      <label className="block"><span className="label">Akun jasa</span>
        <select className="input mt-1" value={f.accountId} onChange={(e) => set("accountId")(e.target.value)}>
          {jasaAccs.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="">Tanpa akun iklan</option>
        </select>
      </label>
      <label className="block sm:col-span-2"><span className="label">Jasa</span>
        <input className="input mt-1" list="jasa-list" placeholder="Pilih atau ketik nama jasa" value={f.product} onChange={(e) => set("product")(e.target.value)} required maxLength={200} />
        <datalist id="jasa-list">{jasaProducts.map((p) => <option key={p.id} value={p.name}>{p.price ? rpk(p.price) : ""}</option>)}</datalist>
      </label>
      <label className="block"><span className="label">Nama klien</span><input className="input mt-1" placeholder="PT / nama klien" value={f.client} onChange={(e) => set("client")(e.target.value)} maxLength={200} /></label>
      <label className="block"><span className="label">Sumber klien</span>
        <select className="input mt-1" value={f.source} onChange={(e) => set("source")(e.target.value)}>
          <option value="iklan">Iklan</option><option value="organik">Organik</option><option value="referral">Referral</option>
        </select>
      </label>
      <MoneyInput name="revenue" label="Nilai deal" placeholder={std?.price ? rpk(std.price) : "7,5jt"} value={f.revenue} onChange={set("revenue")} required />
      <MoneyInput name="cogs" label="Biaya pengerjaan / HPP" placeholder={std ? `kosong = ${rpk(std.cogs)}` : "kosong = HPP standar"} value={f.cogs} onChange={set("cogs")} />
      <button className="btn btn-primary sm:col-span-2" disabled={m.isPending}>{m.isPending ? "Menyimpan…" : "Simpan penjualan jasa"}</button>
    </form>
  );
}

function CostForm() {
  const empty = { date: getToday(), line: "jasa", name: "", amount: "" };
  const [f, setF] = useState(empty);
  const m = useMutation({
    mutationFn: () => api("/costs", { method: "POST", json: f }),
    onSuccess: () => { toast(`Biaya ${rp(parseRp(f.amount))} tersimpan`); setF({ ...empty, date: f.date, line: f.line }); refreshData(); },
    onError: (e) => toast(e.message, { tone: "err" }),
  });
  return (
    <form className="grid gap-x-3 gap-y-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (parseRp(f.amount)) m.mutate(); }}>
      <label className="block"><span className="label">Tanggal</span><input type="date" className="input mt-1" value={f.date} max={getToday()} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
      <label className="block"><span className="label">Lini bisnis</span>
        <select className="input mt-1" value={f.line} onChange={(e) => setF({ ...f, line: e.target.value })}>
          <option value="jasa">Jasa AI</option><option value="digital">Produk Digital AI</option>
        </select>
      </label>
      <label className="block"><span className="label">Nama biaya</span><input className="input mt-1" placeholder="Fee freelancer" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} /></label>
      <MoneyInput name="amount" label="Jumlah" placeholder="500rb" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required />
      <button className="btn btn-primary sm:col-span-2" disabled={m.isPending}>{m.isPending ? "Menyimpan…" : "Simpan biaya"}</button>
    </form>
  );
}

function History() {
  const [limit, setLimit] = useState(25);
  const { data, isLoading } = useManual(limit);
  const del = async (kind: "sale" | "cost", id: number, title: string) => {
    if (!(await confirmDialog({ title: "Hapus input ini?", body: title, confirm: "Hapus", danger: true }))) return;
    const path = kind === "sale" ? "sales" : "costs";
    // Optimistic: langsung hilang dari daftar, balik lagi kalau gagal.
    const key = ["manual", limit];
    const prev = queryClient.getQueryData<ManualResp>(key);
    if (prev) queryClient.setQueryData(key, { ...prev, items: prev.items.filter((x) => !(x.kind === kind && x.id === id)) });
    try {
      await api(`/${path}/${id}`, { method: "DELETE" });
      refreshData();
      toast("Input dihapus", { action: { label: "Undo", run: () => api(`/${path}/${id}/restore`, { method: "POST" }).then(() => refreshData()) }, ms: 5000 });
    } catch (e) {
      if (prev) queryClient.setQueryData(key, prev);
      toast((e as Error).message, { tone: "err" });
    }
  };
  if (isLoading) return <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (!data?.items.length) return <EmptyState title="Belum ada input manual" />;
  return (
    <>
      <ul className="divide-y divide-line">
        {data.items.map((it) => (
          <li key={it.kind + it.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0 text-[13px]">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className={cx("pill", it.kind === "sale" ? "bg-accent-soft text-accent" : "bg-yellow-soft text-yellow-ink")}>{it.kind === "sale" ? "Jasa" : "Biaya"}</span>
                <b className="font-semibold">{it.title}</b>
                <span className={cx("num font-semibold", it.kind === "sale" ? "text-green-ink" : "text-red-ink")}>{it.kind === "sale" ? "+" : "−"}{rpk(it.amount)}</span>
              </div>
              <p className="mt-0.5 truncate text-[12px] text-muted">
                {fmtDate(it.date)} · {it.kind === "sale" ? `${it.client || "tanpa nama"} · ${it.source ?? "-"}${it.cogs ? ` · HPP ${rpk(it.cogs)}` : ""}` : LINES[it.line].label}
              </p>
            </div>
            <button className="btn btn-ghost size-9 shrink-0 p-0 text-muted hover:text-red" onClick={() => del(it.kind, it.id, `${it.title} · ${rp(it.amount)}`)} aria-label="Hapus"><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
      {data.nextCursor && <button className="btn mt-2 w-full" onClick={() => setLimit((l) => l + 25)}>Muat lagi</button>}
    </>
  );
}

export default function LabaRugi() {
  const { data: d, error, isLoading, refetch, isPlaceholderData } = usePl();
  if (error && !d) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  const T = d?.columns.find((c) => c.key === "total")?.kpis;

  return (
    <div className={cx("space-y-3 transition-opacity md:space-y-4", isPlaceholderData && "opacity-70")}>
      <div className="grid gap-3 sm:grid-cols-3 md:gap-4">
        {isLoading || !d ? Array.from({ length: 3 }, (_, i) => <div key={i} className="card h-[150px] p-5"><Skeleton className="h-full" /></div>) : d.columns.map((c) => <LabaCard key={c.key} col={c} />)}
      </div>

      <div className="grid gap-3 md:gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHead title="Laporan laba rugi per lini bisnis" hint={d && `Periode ${fmtRange(d.range.from, d.range.to)} (${d.range.days} hari) · selalu semua lini, tidak ikut filter akun`} />
          {!d ? <Skeleton className="h-[420px]" /> : (
            <div className="-mx-5 overflow-x-auto px-5">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead><tr className="text-[12px] text-muted">
                  <th className="pb-3 text-left font-medium">Pos</th>
                  {d.columns.map((c) => <th key={c.key} className={cx("px-3 pb-3 text-right font-medium", c.key === "total" && "rounded-t-xl bg-accent-soft pt-2 text-accent")}>{c.label}<span className="block text-[11px] font-normal">{c.src}</span></th>)}
                </tr></thead>
                <tbody>
                  {ROWS.map(([label, key, kind, fmt]) => (
                    <tr key={key} className={cx(kind === "group" && "bg-bg font-semibold", kind === "total" && "text-[14.5px] font-bold")}>
                      <td className={cx("py-2.5 pr-3", kind ? "text-ink" : "text-muted", kind === "total" && "border-t-2 border-ink pt-3", kind === "group" && "rounded-l-lg pl-2")}>{label}</td>
                      {d.columns.map((c) => {
                        const v = c.kpis[key] as number;
                        const text = fmt ? fmt(v) : kind === "neg" ? (v ? `(${rp(v)})` : "—") : rp(v);
                        return (
                          <td key={c.key} className={cx("num px-3 py-2.5 text-right", c.key === "total" && "bg-accent-soft/60", kind === "total" && "border-t-2 border-ink pt-3",
                            (kind === "total" || key === "net") && (v >= 0 ? "text-green-ink" : "text-red-ink"), kind === "neg" && v && "text-red-ink/90")}>{text}</td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHead title="Angka kunci gabungan" hint="Patokan untuk keputusan scale / stop" />
          {!T ? <Skeleton className="h-[300px]" /> : (
            <>
              <dl className="space-y-2">
                {[
                  ["ROAS impas (break-even)", dec(T.beRoas) + "x"], ["ROAS riil sekarang", dec(T.roas) + "x"], ["Margin kotor", pct(T.margin)],
                  ["CPA maksimal impas", rpk(T.maxCpaBE)], ["CPA sekarang (incl. PPN)", rpk(T.cpa)], ["Laba per order", rpk(T.profitPerOrder)],
                  ...(T.leads ? [["Closing rate leads jasa", pct(T.closeRate)], ["CPL sekarang", rpk(T.cpl)]] : []),
                ].map(([a, b]) => (
                  <div key={a} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 text-[13px]"><dt className="text-muted">{a}</dt><dd className="num font-semibold">{b}</dd></div>
                ))}
              </dl>
              {!!d?.otherItems.length && (
                <div className="mt-3 rounded-xl border border-dashed border-line-strong p-3 text-[12px] text-muted">
                  <b className="text-ink">Biaya lain periode ini</b>
                  {d.otherItems.map((o) => <p key={o.id}>{fmtDate(o.date, false)} · {o.name} ({LINES[o.line].label}) <span className="num">{rpk(o.amount)}</span></p>)}
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <div className="no-print grid gap-3 md:gap-4 xl:grid-cols-2">
        <Card>
          <CardHead title="Input penjualan jasa AI" hint="Masuk ke laba rugi lini Jasa AI. Nominal boleh ditulis 7.500.000, 7,5jt atau 750rb." />
          <SaleForm />
        </Card>
        <Card>
          <CardHead title="Input biaya lain" hint="Biaya di luar iklan & operasional rutin, misal freelancer, fee sales, refund." />
          <CostForm />
          <h3 className="mb-1 mt-6 text-[15px] font-semibold">Riwayat input manual</h3>
          <History />
        </Card>
      </div>
    </div>
  );
}

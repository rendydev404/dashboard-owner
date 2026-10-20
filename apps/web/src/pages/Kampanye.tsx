import { useMemo, useState } from "react";
import { Pause, Play, TrendingUp, Search, ArrowUpDown, ArrowDown, ArrowUp, Megaphone } from "lucide-react";
import { rpk, dec, pct, nf, type CampaignRow, type Tone } from "@iklan/shared";
import { useBootstrap, useCampaigns } from "../lib/api";
import { startCampaignAction } from "../lib/campaign-action";
import { Card, CardHead, EmptyState, ErrorState, Skeleton, cx } from "../components/ui";

const ROW: Record<Tone, string> = { green: "row-green", yellow: "row-yellow", red: "row-red", gray: "", neutral: "" };
const BADGE: Record<Tone, string> = {
  green: "bg-green text-white", yellow: "bg-yellow text-[#3b2a00]", red: "bg-red text-white", gray: "bg-bg text-muted", neutral: "bg-accent-soft text-accent",
};
type SortKey = "name" | "spend" | "clicks" | "ctr" | "leads" | "cpl" | "purchases" | "cpa" | "roas";

function Actions({ c, owner }: { c: CampaignRow; owner: boolean }) {
  const [busy, setBusy] = useState(false);
  if (!owner) return null;
  const run = async (a: "pause" | "activate" | "scale") => { setBusy(true); await startCampaignAction(c.id, a); setBusy(false); };
  return (
    <div className="flex justify-end gap-1">
      {c.status === "ACTIVE"
        ? <button className="btn btn-ghost h-8 min-h-0 px-2 text-[12.5px]" disabled={busy} onClick={() => run("pause")} title="Pause"><Pause size={14} /> Pause</button>
        : <button className="btn btn-ghost h-8 min-h-0 px-2 text-[12.5px]" disabled={busy} onClick={() => run("activate")} title="Aktifkan"><Play size={14} /> Aktifkan</button>}
      {c.status === "ACTIVE" && <button className="btn btn-ghost h-8 min-h-0 px-2 text-[12.5px]" disabled={busy} onClick={() => run("scale")} title="Naikkan budget"><TrendingUp size={14} /> Scale</button>}
    </div>
  );
}

export default function Kampanye() {
  const { data, error, isLoading, refetch, isPlaceholderData } = useCampaigns();
  const boot = useBootstrap().data!;
  const owner = boot.user.role === "owner";
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "spend", dir: -1 });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "ACTIVE" | "PAUSED">("all");

  const rows = useMemo(() => {
    if (!data) return [];
    const val = (r: CampaignRow) => { const v = r[sort.k]; return v == null ? Infinity : v; };
    return data.rows
      .filter((r) => (status === "all" || (status === "ACTIVE" ? r.status === "ACTIVE" : r.status !== "ACTIVE")) && r.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => sort.k === "name" ? a.name.localeCompare(b.name) * sort.dir : ((val(a) as number) - (val(b) as number)) * sort.dir || b.spend - a.spend);
  }, [data, sort, q, status]);

  if (error && !data) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  const leads = data?.hasLeads, multi = data?.multiAccount;
  const T = rows.reduce((t, r) => ({ spend: t.spend + r.spend, clicks: t.clicks + r.clicks, impr: t.impr + r.impressions, leads: t.leads + r.leads, purch: t.purch + r.purchases, rev: t.rev + r.revenue }), { spend: 0, clicks: 0, impr: 0, leads: 0, purch: 0, rev: 0 });

  const Th = ({ k, children, right }: { k?: SortKey; children: React.ReactNode; right?: boolean }) => (
    <th scope="col" className={cx("whitespace-nowrap px-3 pb-3 text-[12px] font-medium text-muted", right ? "text-right" : "text-left")}>
      {k ? (
        <button className={cx("inline-flex items-center gap-1 hover:text-ink", sort.k === k && "text-ink")} onClick={() => setSort((s) => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : -1 }))}>
          {children}{sort.k === k ? (sort.dir > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-40" />}
        </button>
      ) : children}
    </th>
  );

  return (
    <Card className={cx("transition-opacity", isPlaceholderData && "opacity-70")}>
      <CardHead title="Performa kampanye" hint={<>Klik judul kolom untuk mengurutkan. ROAS kampanye digital memakai pixel Meta, jasa memakai estimasi dari leads.{data?.singleDay && " Periode 1 hari = sinyal awal."}</>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input min-h-[38px] pl-9" placeholder="Cari kampanye" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari kampanye" />
        </label>
        <div className="flex rounded-full border border-line p-0.5 text-[12.5px]">
          {(["all", "ACTIVE", "PAUSED"] as const).map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={cx("rounded-full px-3 py-1.5", status === s ? "bg-accent text-accent-ink font-semibold" : "text-muted")}>
              {s === "all" ? "Semua" : s === "ACTIVE" ? "Aktif" : "Jeda"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        : !rows.length ? <EmptyState icon={<Megaphone size={20} />} title="Tidak ada kampanye" text="Belum ada kampanye berjalan di periode & akun ini." />
        : (
          <>
            {/* Desktop: tabel */}
            <div className="-mx-5 hidden overflow-x-auto px-5 md:block">
              <table className="w-full border-separate border-spacing-y-1.5 text-[13px]">
                <thead><tr>
                  <Th k="name">Kampanye</Th><Th>Status</Th><Th k="spend" right>Spend</Th><Th k="clicks" right>Klik</Th><Th k="ctr" right>CTR</Th>
                  {leads && <><Th k="leads" right>Leads</Th><Th k="cpl" right>CPL</Th></>}
                  <Th k="purchases" right>{leads ? "Beli/closing" : "Beli"}</Th><Th k="cpa" right>CPA</Th><Th k="roas" right>ROAS</Th><Th>Rekomendasi</Th>{owner && <Th right>Aksi</Th>}
                </tr></thead>
                <tbody>
                  {rows.map((c) => {
                    const st = boot.accounts.find((a) => a.id === c.accountId)?.settings;
                    const td = "px-3 py-3 first:rounded-l-xl last:rounded-r-xl";
                    const nw = "whitespace-nowrap";
                    return (
                      <tr key={c.id} className={ROW[c.rec.tone]}>
                        <td className={cx(td, "w-[300px] min-w-[220px] max-w-[300px] font-medium")}><span className="block break-words">{c.name}</span><span className="block text-[11.5px] font-normal text-muted">{multi ? c.accountName : c.line === "jasa" ? "Leads / jasa" : "Konversi / digital"}{c.dailyBudget ? ` · ${rpk(c.dailyBudget)}/hari` : ""}</span></td>
                        <td className={cx(td, nw)}><span className={cx("pill", c.status === "ACTIVE" ? "bg-green-soft text-green-ink" : "bg-bg text-muted")}>{c.status === "ACTIVE" ? "Aktif" : "Jeda"}</span></td>
                        <td className={cx(td, nw, "num text-right")}>{rpk(c.spend)}</td>
                        <td className={cx(td, nw, "num text-right")}>{nf(c.clicks)}</td>
                        <td className={cx(td, nw, "num text-right")}>{pct(c.ctr)}</td>
                        {leads && <><td className={cx(td, nw, "num text-right")}>{c.line === "jasa" ? nf(c.leads) : "—"}</td>
                          <td className={cx(td, nw, "num text-right", c.line === "jasa" && st?.maxCpl && c.cpl && c.cpl > st.maxCpl && "text-red-ink font-semibold")}>{c.line === "jasa" && c.cpl ? rpk(c.cpl) : "—"}</td></>}
                        <td className={cx(td, nw, "num text-right")}>{nf(c.purchases)}{c.revenueEstimated && <span className="text-muted">*</span>}</td>
                        <td className={cx(td, nw, "num text-right", c.line === "digital" && st?.maxCpa && c.cpa && c.cpa > st.maxCpa && "text-red-ink font-semibold")}>{c.cpa ? rpk(c.cpa) : "—"}</td>
                        <td className={cx(td, nw, "num text-right font-semibold", st && (c.roas >= st.targetRoas ? "text-green-ink" : c.spend ? "text-red-ink" : ""))}>{dec(c.roas)}x</td>
                        <td className={cx(td, nw)}><span className={cx("pill", BADGE[c.rec.tone])}>{c.rec.label}</span></td>
                        {owner && <td className={cx(td, nw, "text-right")}><Actions c={c} owner={owner} /></td>}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr className="whitespace-nowrap font-semibold">
                  <td className="px-3 pt-3">Total</td><td />
                  <td className="num px-3 pt-3 text-right">{rpk(T.spend)}</td><td className="num px-3 pt-3 text-right">{nf(T.clicks)}</td>
                  <td className="num px-3 pt-3 text-right">{pct(T.impr ? T.clicks / T.impr : 0)}</td>
                  {leads && <><td className="num px-3 pt-3 text-right">{nf(T.leads)}</td><td className="num px-3 pt-3 text-right">{T.leads ? rpk(T.spend / T.leads) : "—"}</td></>}
                  <td className="num px-3 pt-3 text-right">{nf(T.purch)}</td><td className="num px-3 pt-3 text-right">{T.purch ? rpk(T.spend / T.purch) : "—"}</td>
                  <td className="num px-3 pt-3 text-right">{dec(T.spend ? T.rev / T.spend : 0)}x</td><td />{owner && <td />}
                </tr></tfoot>
              </table>
              {leads && <p className="mt-2 text-[11.5px] text-muted">* closing & ROAS kampanye jasa = estimasi dari porsi leads.</p>}
            </div>

            {/* HP: daftar kartu */}
            <ul className="space-y-2 md:hidden">
              {rows.map((c) => (
                <li key={c.id} className={cx("rounded-xl border border-line p-3.5", ROW[c.rec.tone] || "bg-card")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold leading-snug">{c.name}</p>
                      <p className="mt-0.5 text-[12px] text-muted">{multi ? c.accountName + " · " : ""}{c.status === "ACTIVE" ? "Aktif" : "Jeda"}{c.dailyBudget ? ` · ${rpk(c.dailyBudget)}/hari` : ""}</p>
                    </div>
                    <span className={cx("pill shrink-0", BADGE[c.rec.tone])}>{c.rec.label}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                    <div><dt className="text-muted">Spend</dt><dd className="num font-semibold">{rpk(c.spend)}</dd></div>
                    <div><dt className="text-muted">{c.line === "jasa" ? "CPL" : "CPA"}</dt><dd className="num font-semibold">{c.line === "jasa" ? (c.cpl ? rpk(c.cpl) : "—") : c.cpa ? rpk(c.cpa) : "—"}</dd></div>
                    <div><dt className="text-muted">ROAS</dt><dd className="num font-semibold">{dec(c.roas)}x</dd></div>
                    <div><dt className="text-muted">{c.line === "jasa" ? "Leads" : "Klik"}</dt><dd className="num">{nf(c.line === "jasa" ? c.leads : c.clicks)}</dd></div>
                    <div><dt className="text-muted">{c.line === "jasa" ? "Closing*" : "Beli"}</dt><dd className="num">{nf(c.purchases)}</dd></div>
                    <div><dt className="text-muted">CTR</dt><dd className="num">{pct(c.ctr)}</dd></div>
                  </dl>
                  {owner && <div className="mt-2 border-t border-line/70 pt-2"><Actions c={c} owner={owner} /></div>}
                </li>
              ))}
            </ul>
          </>
        )}
    </Card>
  );
}

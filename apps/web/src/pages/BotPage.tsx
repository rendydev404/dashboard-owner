import { useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Pencil, Check, X, Undo2 } from "lucide-react";
import { rpk, dec, parseRp, LINES, type Account, type BotResp, type BotMode } from "@iklan/shared";
import { api, useBootstrap, refreshData, actionsApi } from "../lib/api";
import { useView } from "../lib/view";
import { actionSummary } from "../lib/campaign-action";
import { Card, CardHead, EmptyState, Skeleton, toast, cx } from "../components/ui";

type Field = "targetRoas" | "maxCpa" | "maxCpl" | "killAfterSpend" | "scaleStepPct" | "adTaxPct";

function RuleRow({ acc, field, label, value, display, editable }: { acc: Account; field: Field; label: string; value: number | null; display: string; editable: boolean }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState("");
  const m = useMutation({
    mutationFn: (val: number) => api(`/accounts/${acc.id}/settings`, { method: "PATCH", json: { [field]: val } }),
    onSuccess: () => { toast(`${label} diperbarui`); setEdit(false); refreshData(); },
    onError: (e) => toast(e.message, { tone: "err" }),
  });
  const parse = (s: string) => (["targetRoas", "scaleStepPct", "adTaxPct"].includes(field) ? Number(s.replace(",", ".")) : parseRp(s));
  return (
    <div className="flex min-h-[46px] items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2 text-[13px]">
      <span className="text-muted">{label}</span>
      {edit ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const n = parse(v); if (Number.isFinite(n) && n >= 0) m.mutate(n); }}>
          <input autoFocus className="input h-8 min-h-0 w-28 px-2 text-right text-[13px]" value={v} onChange={(e) => setV(e.target.value)} aria-label={label} />
          <button className="btn btn-ghost size-8 min-h-0 p-0 text-green" disabled={m.isPending} aria-label="Simpan"><Check size={16} /></button>
          <button type="button" className="btn btn-ghost size-8 min-h-0 p-0" onClick={() => setEdit(false)} aria-label="Batal"><X size={16} /></button>
        </form>
      ) : (
        <span className="flex items-center gap-1">
          <span className="num font-semibold">{display}</span>
          {editable && <button className="btn btn-ghost size-8 min-h-0 p-0 text-muted" onClick={() => { setV(value == null ? "" : String(value)); setEdit(true); }} aria-label={`Ubah ${label}`}><Pencil size={14} /></button>}
        </span>
      )}
    </div>
  );
}

const MODES: { id: BotMode; label: string }[] = [{ id: "off", label: "Mati" }, { id: "suggest", label: "Saran saja" }, { id: "auto", label: "Autopilot" }];

function AccountRules({ acc, owner }: { acc: Account; owner: boolean }) {
  const s = acc.settings;
  const mode = useMutation({
    mutationFn: (m: BotMode) => api(`/accounts/${acc.id}`, { method: "PATCH", json: { botMode: m } }),
    onSuccess: () => { toast("Mode bot diperbarui"); refreshData(); },
    onError: (e) => toast(e.message, { tone: "err" }),
  });
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-semibold">{acc.name}</p>
        <span className={cx("pill", acc.line === "jasa" ? "bg-yellow-soft text-yellow-ink" : "bg-accent-soft text-accent")}>{LINES[acc.line].label}</span>
      </div>
      <div className="mb-2 flex rounded-full border border-line p-0.5 text-[12.5px]" role="radiogroup" aria-label="Mode bot">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={acc.botMode === m.id} disabled={!owner || mode.isPending} onClick={() => mode.mutate(m.id)}
            className={cx("flex-1 rounded-full px-3 py-1.5", acc.botMode === m.id ? "bg-accent font-semibold text-accent-ink" : "text-muted")}>{m.label}</button>
        ))}
      </div>
      {acc.botMode === "auto" && <p className="mb-2 text-[12px] text-muted">Autopilot dieksekusi otomatis oleh mesin aturan (tahap P1). Saat ini bot tetap meminta konfirmasi.</p>}
      <div className="space-y-2">
        <RuleRow acc={acc} field="targetRoas" label="Target ROAS" value={s.targetRoas} display={dec(s.targetRoas) + "x"} editable={owner} />
        {acc.line === "jasa"
          ? <RuleRow acc={acc} field="maxCpl" label="Batas CPL" value={s.maxCpl} display={rpk(s.maxCpl ?? 0)} editable={owner} />
          : <RuleRow acc={acc} field="maxCpa" label="Batas CPA" value={s.maxCpa} display={rpk(s.maxCpa ?? 0)} editable={owner} />}
        <RuleRow acc={acc} field="killAfterSpend" label="Matikan setelah spend" value={s.killAfterSpend} display={rpk(s.killAfterSpend)} editable={owner} />
        <RuleRow acc={acc} field="scaleStepPct" label="Kenaikan budget saat scale" value={s.scaleStepPct} display={`+${s.scaleStepPct}%`} editable={owner} />
        <RuleRow acc={acc} field="adTaxPct" label="PPN iklan" value={s.adTaxPct} display={`${dec(s.adTaxPct, 0)}%`} editable={owner} />
      </div>
    </div>
  );
}

const STATUS: Record<string, [string, string]> = {
  executed: ["Dieksekusi", "bg-green-soft text-green-ink"], pending: ["Menunggu konfirmasi", "bg-yellow-soft text-yellow-ink"],
  failed: ["Gagal", "bg-red-soft text-red-ink"], cancelled: ["Dibatalkan", "bg-bg text-muted"], expired: ["Kedaluwarsa", "bg-bg text-muted"], reverted: ["Dibalikkan", "bg-bg text-muted"],
};
const ACTION_LABEL: Record<string, [string, string]> = {
  pause: ["Pause", "bg-red text-white"], activate: ["Aktifkan", "bg-green text-white"], scale: ["Scale", "bg-accent text-accent-ink"], update_rule: ["Ubah aturan", "bg-yellow text-[#3b2a00]"],
};
const SRC: Record<string, string> = { chat: "lewat chat", table: "dari tabel", rule_engine: "otomatis" };

function Log({ owner }: { owner: boolean }) {
  const v = useView();
  const q = useInfiniteQuery({
    queryKey: ["bot", v.acc, v.from, v.to],
    queryFn: ({ pageParam }) => api<BotResp>(`/bot?${new URLSearchParams({ acc: v.acc, from: v.from, to: v.to, ...(pageParam ? { cursor: pageParam } : {}) })}`),
    initialPageParam: "",
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (q.isLoading) return <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>;
  const items = q.data?.pages.flatMap((p) => p.actions) ?? [];
  if (!items.length) return <EmptyState title="Tidak ada aksi bot di periode ini" />;
  return (
    <>
      <ol className="relative space-y-1 border-l border-line pl-5">
        {items.map((a) => {
          const at = new Date(a.executedAt ?? a.createdAt);
          const [st, stc] = STATUS[a.status] ?? [a.status, ""];
          const [al, alc] = ACTION_LABEL[a.action] ?? [a.action, "bg-bg"];
          const p = a.params as any;
          return (
            <li key={a.id} className="relative py-2.5">
              <span className="absolute -left-[25px] top-4 size-2.5 rounded-full border-2 border-card bg-accent" />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <span className={cx("pill", alc)}>{al}</span>
                <b className="font-semibold">{a.campaignName ?? (a.action === "update_rule" ? `${p.field}: ${p.previous ?? "—"} → ${p.value}` : a.action === "launch" ? p.plan?.campaignName : "Semua kampanye")}</b>
                <span className={cx("pill", stc)}>{st}</span>
              </div>
              <p className="mt-0.5 text-[12px] text-muted">
                {at.toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {SRC[a.source]}{a.accountName ? ` · ${a.accountName}` : ""}
                {a.action !== "update_rule" && ` · ${actionSummary(a).detail.split("\n")[0]}`}
                {a.reason && ` · ${a.reason}`}{a.error && <span className="text-red-ink"> · {a.error}</span>}
              </p>
              {owner && a.status === "executed" && a.action !== "update_rule" && !p.demo && a.source !== "rule_engine" && (
                <button className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-accent" onClick={() => actionsApi.revert(a.id).then(() => { toast("Aksi dibalikkan"); refreshData(); }).catch((e) => toast(e.message, { tone: "err" }))}>
                  <Undo2 size={13} /> Batalkan aksi
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {q.hasNextPage && <button className="btn mt-3 w-full" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Muat lagi</button>}
    </>
  );
}

export default function BotPage() {
  const boot = useBootstrap().data!;
  const v = useView();
  const owner = boot.user.role === "owner";
  const accs = boot.accounts.filter((a) => a.active && (v.acc === "all" || v.acc === a.id || v.acc === a.line));
  return (
    <div className="grid gap-3 md:gap-4 xl:grid-cols-2">
      <Card>
        <CardHead title="Aturan bot" hint={'Bisa diubah di sini atau lewat chat, misal "target roas 3" atau "batas cpa 40rb".'} />
        {!accs.length ? <EmptyState title="Belum ada akun iklan" text="Tambahkan akun di Pengaturan." /> : <div className="space-y-6">{accs.map((a) => <AccountRules key={a.id} acc={a} owner={owner} />)}</div>}
      </Card>
      <Card>
        <CardHead title="Log aksi bot" hint="Aksi di periode terpilih: siapa, kapan, apa, dan hasilnya" />
        <Log owner={owner} />
      </Card>
    </div>
  );
}

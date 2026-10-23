// Kartu video iklan buatan bot: progres render → pratinjau + rencana kampanye → owner menyetujui → status upload & peluncuran.
// Status dipantau dengan polling ringan hanya selama prosesnya berjalan (berhenti saat menunggu review atau selesai).
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, ExternalLink, Rocket, Trash2, Mic, MicOff } from "lucide-react";
import { rp, type CreativeRun, type CreativeStatus } from "@iklan/shared";
import { api, ApiError, refreshData } from "../lib/api";
import { LAUNCH_GOAL } from "../lib/campaign-action";
import { AdBot } from "../components/AdBot";
import { toast, cx } from "../components/ui";

const RUNNING: CreativeStatus[] = ["queued", "rendering", "approved", "uploading", "launching"];
const LABEL: Partial<Record<CreativeStatus, string>> = {
  queued: "Mengantre", rendering: "Membuat video", approved: "Disetujui", uploading: "Mengirim ke Meta", launching: "Membuat kampanye",
};
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="grid grid-cols-[84px_1fr] gap-2 py-1 text-[12.5px]"><span className="text-muted">{k}</span><span className="min-w-0 break-words">{v}</span></div>
);

export function VideoCard({ runId }: { runId: number }) {
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["creative", runId],
    queryFn: () => api<CreativeRun>(`/creative/${runId}`),
    refetchInterval: (query) => (query.state.data && !RUNNING.includes(query.state.data.status) ? false : 2500),
    staleTime: 2000,
  });
  const r = q.data;
  // Kartu lebih tinggi dari placeholder-nya: begitu data pertama datang, pastikan terlihat utuh di area chat.
  const box = useRef<HTMLDivElement>(null);
  const loaded = Boolean(r);
  useEffect(() => { if (loaded) box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [loaded]);
  // Kampanye baru masuk ke data dashboard: segarkan sekali saat peluncuran selesai.
  const launched = r?.status === "launched";
  useEffect(() => { if (launched) refreshData(); }, [launched]);
  const act = async (kind: "approve" | "discard") => {
    setBusy(true);
    try {
      const next = await api<CreativeRun>(`/creative/${runId}/${kind}`, { method: "POST" });
      q.refetch();
      if (kind === "approve") toast(next.plan.startNow ? "Disetujui. Video dikirim ke Meta lalu langsung ditayangkan." : "Disetujui. Video dikirim ke Meta sebagai draft.");
    } catch (e) { toast(e instanceof ApiError ? e.message : "Gagal", { tone: "err" }); }
    setBusy(false);
  };
  if (!r) return <div className="rounded-xl border border-line bg-card p-3"><div className="skeleton h-24" /></div>;

  const running = RUNNING.includes(r.status);
  const preApproval = r.status === "queued" || r.status === "rendering";
  const adsManager = r.action?.campaignId ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${r.accountId}&selected_campaign_ids=${r.action.campaignId}` : null;

  return (
    <div ref={box} className="pop-in overflow-hidden rounded-xl border border-line bg-card text-[13px]">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Rocket size={14} className="text-accent" />
        <p className="min-w-0 flex-1 truncate font-semibold">Video iklan · {r.accountName}</p>
        <StatusPill r={r} />
      </div>

      <div className="grid gap-3 p-3 sm:grid-cols-[180px_1fr]">
        {/* Pratinjau 9:16 */}
        <div className="relative mx-auto aspect-[9/16] w-full max-w-[200px] overflow-hidden rounded-lg bg-[#15162a]">
          {r.hasVideo && !preApproval
            ? <video src={`/api/creative/${r.id}/video`} poster={`/api/creative/${r.id}/cover`} controls playsInline preload="metadata" className="size-full object-cover" />
            : (
              <div className="flex size-full flex-col items-center justify-center gap-3 p-3 text-center text-white">
                {preApproval ? <AdBot size={64} mood="think" /> : <AdBot size={56} mood={r.status === "failed" ? "sad" : "idle"} />}
                {preApproval && (
                  <>
                    <p className="text-[12px] font-medium">{r.note ?? "Menyiapkan"}…</p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                      <div className="h-full rounded-full bg-[var(--yellow)] transition-[width] duration-700" style={{ width: `${Math.max(6, r.progress)}%` }} />
                    </div>
                    <p className="num text-[11px] text-white/60">{r.progress}% · biasanya 2–3 menit</p>
                  </>
                )}
                {!preApproval && !r.hasVideo && <p className="text-[11.5px] text-white/70">{r.status === "expired" ? "File video sudah dihapus" : "Video tidak tersedia"}</p>}
              </div>
            )}
        </div>

        <div className="min-w-0 space-y-2">
          <p className="text-[15px] font-semibold leading-snug">{r.brief.hook}</p>
          <details className="group rounded-lg bg-bg px-2.5 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-semibold text-muted">
              {r.voice?.provider === "elevenlabs" ? <Mic size={13} /> : <MicOff size={13} />}
              Naskah {r.voice ? (r.voice.provider === "elevenlabs" ? "· suara ElevenLabs" : "· tanpa suara (subtitle saja)") : ""}
            </summary>
            <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed">{r.brief.script}</p>
          </details>
          <div className="divide-y divide-line rounded-lg bg-bg px-2.5 py-1">
            <Row k="Kampanye" v={<b>{r.plan.campaignName}</b>} />
            <Row k="Tujuan" v={LAUNCH_GOAL[r.plan.objective] ?? r.plan.objective} />
            <Row k="Budget" v={<><b>{rp(r.plan.dailyBudget)}</b>/hari</>} />
            <Row k="Copy" v={<span className="block whitespace-pre-line"><b>{r.plan.headline}</b>{"\n"}{r.plan.primaryText}</span>} />
            {r.plan.linkUrl && <Row k="Link" v={<a className="text-accent underline" href={r.plan.linkUrl} target="_blank" rel="noopener noreferrer">{r.plan.linkUrl}</a>} />}
            <Row k="Setelah OK" v={r.plan.startNow ? "Langsung tayang" : "Disimpan sebagai draft"} />
          </div>
          {r.qc && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
              {r.qc.checks.map((c) => (
                <li key={c.name} className={cx("inline-flex items-center gap-1", c.ok ? "text-green-ink" : "text-red-ink")} title={c.detail}>
                  {c.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{c.name}
                </li>
              ))}
              {r.result && <li className="num text-muted">{r.result.durationSec.toFixed(0)} dtk · {r.result.width}×{r.result.height} · {(r.result.bytes / 1048576).toFixed(1)} MB</li>}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t border-line px-3 py-2.5">
        {r.status === "review" && (
          <>
            <div className="flex gap-2">
              <button className="btn btn-primary h-9 min-h-0 flex-1" disabled={busy || !r.hasVideo} onClick={() => act("approve")}>
                <Rocket size={15} /> {busy ? "Memproses…" : "Setujui & iklankan"}
              </button>
              <button className="btn h-9 min-h-0" disabled={busy} onClick={() => act("discard")} aria-label="Buang video"><Trash2 size={15} /> Buang</button>
            </div>
            <p className="mt-1.5 text-[11.5px] text-muted">Tonton dulu sampai habis. Belum ada yang dikirim ke Meta sampai kamu menyetujui.</p>
          </>
        )}
        {running && !preApproval && <p className="flex items-center gap-2 text-[12.5px] text-muted"><span className="ab-bar w-16" />{r.note ?? LABEL[r.status]}…</p>}
        {preApproval && <p className="text-[11.5px] text-muted">Kamu bisa lanjut chat; kartu ini memperbarui dirinya sendiri.</p>}
        {r.status === "launched" && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] font-semibold text-green-ink">
            <span className="inline-flex items-center gap-1"><CheckCircle2 size={14} /> {r.plan.startNow ? "Kampanye dibuat & tayang" : "Kampanye dibuat sebagai draft"}</span>
            {adsManager && <a href={adsManager} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent">Buka di Ads Manager <ExternalLink size={12} /></a>}
          </p>
        )}
        {r.status === "failed" && <p className="text-[12.5px] text-red-ink"><b>Gagal:</b> {r.error ?? "tidak diketahui"}</p>}
        {r.status === "discarded" && <p className="text-[12.5px] text-muted">Video dibuang. Minta bot membuat versi baru kalau perlu.</p>}
        {r.status === "expired" && <p className="text-[12.5px] text-muted">{r.error ?? "Video kedaluwarsa (24 jam)."} Minta bot membuat ulang.</p>}
      </div>
    </div>
  );
}

function StatusPill({ r }: { r: CreativeRun }) {
  const tone = r.status === "launched" ? "bg-green-soft text-green-ink" : r.status === "failed" ? "bg-red-soft text-red-ink"
    : r.status === "review" ? "bg-yellow-soft text-yellow-ink" : "bg-accent-soft text-accent";
  const text = r.status === "review" ? "Menunggu review" : r.status === "launched" ? (r.plan.startNow ? "Tayang" : "Draft") : r.status === "failed" ? "Gagal"
    : r.status === "discarded" ? "Dibuang" : r.status === "expired" ? "Kedaluwarsa" : LABEL[r.status] ?? r.status;
  return <span className={cx("pill shrink-0", tone)}>{text}</span>;
}

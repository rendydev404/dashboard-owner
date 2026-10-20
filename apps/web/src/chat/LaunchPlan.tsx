import { CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { rp, type BotAction } from "@iklan/shared";
import { LAUNCH_GOAL } from "../lib/campaign-action";
import { cx } from "../components/ui";

const STEP: Record<string, string> = { campaign: "Kampanye", adset: "Ad set", creative: "Kreatif", ad: "Iklan", publish: "Tayang" };
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-[12.5px]"><span className="text-muted">{k}</span><span className="min-w-0 break-words">{v}</span></div>
);

/** Isi kartu konfirmasi peluncuran: rencana lengkap sebelum eksekusi, lalu status tiap langkah sesudahnya. */
export function LaunchPlan({ action }: { action: BotAction }) {
  const p = action.params as any;
  const plan = p.plan ?? {}, c = plan.creative ?? {}, t = plan.targeting ?? {};
  const result = p.result as { campaignId?: string; published?: boolean; steps?: { step: string; ok: boolean; note?: string }[] } | undefined;
  const creative = c.type === "existing" ? `Pakai kreatif lama #${c.creativeId}` : c.type === "post" ? `Boost postingan ${c.objectStoryId}` : c.videoId ? "Video baru" : "Gambar baru";
  const adsManager = result?.campaignId ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${plan.accountId}&selected_campaign_ids=${result.campaignId}` : null;
  return (
    <div className="mt-1.5 space-y-2">
      <div className="divide-y divide-line rounded-lg bg-bg px-2.5 py-1">
        <Row k="Akun" v={<b>{p.accountName ?? plan.accountId}</b>} />
        <Row k="Tujuan" v={LAUNCH_GOAL[plan.objective] ?? plan.objective} />
        <Row k="Budget" v={<><b>{rp(plan.dailyBudget ?? 0)}</b>/hari · CBO, biaya terendah</>} />
        <Row k="Audiens" v={`${(t.countries ?? ["ID"]).join(", ")} · ${t.ageMin ?? 18}–${t.ageMax ?? 65} th${t.genders && t.genders !== "all" ? ` · ${t.genders === "male" ? "pria" : "wanita"}` : ""} · Advantage+ Audience & placements`} />
        <Row k="Kreatif" v={creative} />
        {c.type === "new" && (
          <Row k="Copy" v={<span className="block whitespace-pre-line"><b>{c.headline}</b>{"\n"}{c.primaryText}{c.cta ? `\n[${c.cta.replace(/_/g, " ")}]` : ""}</span>} />
        )}
        {plan.linkUrl && <Row k="Link" v={<a className="text-accent underline" href={plan.linkUrl} target="_blank" rel="noopener noreferrer">{plan.linkUrl}</a>} />}
        <Row k="Mulai" v={plan.startNow === false ? "Simpan sebagai draft (belum tayang)" : "Langsung tayang setelah dikonfirmasi"} />
      </div>
      {action.reason && <p className="text-[12px] text-muted"><b className="text-ink">Strategi:</b> {action.reason}</p>}
      {action.status === "pending" && <p className="text-[11.5px] text-muted">Iklan belum dibuat. Semua dibuat sebagai draft dulu; kalau ada langkah gagal, tidak ada yang tayang dan tidak ada biaya.</p>}
      {result?.steps?.length ? (
        <ul className="space-y-1 text-[12px]">
          {result.steps.map((s) => (
            <li key={s.step} className={cx("flex items-start gap-1.5", s.ok ? "text-green-ink" : "text-red-ink")}>
              {s.ok ? <CheckCircle2 size={14} className="mt-px shrink-0" /> : <XCircle size={14} className="mt-px shrink-0" />}
              <span><b>{STEP[s.step] ?? s.step}</b>{s.note ? ` · ${s.note}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {adsManager && <a href={adsManager} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent">Buka di Ads Manager <ExternalLink size={12} /></a>}
    </div>
  );
}

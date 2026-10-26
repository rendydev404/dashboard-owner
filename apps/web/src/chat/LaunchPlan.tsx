import { useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, ExternalLink, Layers, ShieldCheck } from "lucide-react";
import { rp, type BotAction } from "@iklan/shared";
import { LAUNCH_GOAL } from "../lib/campaign-action";
import { cx } from "../components/ui";

const STEP: Record<string, string> = { campaign: "Kampanye", adset: "Ad set", creative: "Kreatif", ad: "Iklan", publish: "Tayang" };
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="grid grid-cols-[100px_1fr] gap-2 py-1.5 text-[12.5px]"><span className="text-muted">{k}</span><span className="min-w-0 break-words">{v}</span></div>
);

interface AdPreviewItem {
  adName: string;
  linkUrl?: string;
  creative: {
    type: "existing" | "post" | "new";
    creativeId?: string;
    objectStoryId?: string;
    imageHash?: string;
    imageUrl?: string;
    videoId?: string;
    primaryText?: string;
    headline?: string;
    description?: string;
    cta?: string;
  };
}

interface AuditItem { level: "ok" | "warn"; check: string; detail: string }

function creativeLabel(c: AdPreviewItem["creative"]) {
  if (c.type === "existing") return `Pakai kreatif lama #${c.creativeId}`;
  if (c.type === "post") return `Boost postingan ${c.objectStoryId}`;
  return c.videoId ? "Video baru" : "Gambar baru";
}

/** Isi kartu konfirmasi peluncuran kampanye baru maupun injeksi multi-iklan ke kampanye eksisting. */
export function LaunchPlan({ action }: { action: BotAction }) {
  const isAddAds = action.action === "add_ads";
  const p = action.params as any;
  const plan = p.plan ?? {};
  const t = plan.targeting ?? {};
  const ads: AdPreviewItem[] = Array.isArray(plan.ads) && plan.ads.length
    ? plan.ads
    : [{ adName: plan.adName ?? "Iklan 1", creative: plan.creative ?? { type: "new" }, linkUrl: plan.linkUrl }];
  const [activeTab, setActiveTab] = useState(0);
  const selected = ads[Math.min(activeTab, ads.length - 1)] ?? ads[0];
  const audit: AuditItem[] = Array.isArray(p.audit) ? p.audit : [];
  const result = p.result as { campaignId?: string; adsetId?: string; published?: boolean; steps?: { step: string; id?: string; ok: boolean; note?: string }[] } | undefined;
  const targetCampaignId = result?.campaignId ?? plan.campaignId;
  const adsManager = targetCampaignId
    ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${plan.accountId}&selected_campaign_ids=${targetCampaignId}`
    : null;

  return (
    <div className="mt-2 space-y-2.5">
      <div className="divide-y divide-line rounded-xl border border-line bg-bg px-3 py-1">
        <Row k="Akun" v={<b>{p.accountName ?? plan.accountId}</b>} />
        {isAddAds ? (
          <Row k="Target Ad Set" v={<><b>{p.adsetName ?? p.adsetId ?? "Ad set aktif utama"}</b></>} />
        ) : (
          <>
            <Row k="Tujuan" v={LAUNCH_GOAL[plan.objective] ?? plan.objective} />
            <Row k="Budget" v={<><b>{rp(plan.dailyBudget ?? 0)}</b>/hari · CBO, biaya terendah</>} />
            <Row k="Audiens" v={`${(t.countries ?? ["ID"]).join(", ")} · ${t.ageMin ?? 18}–${t.ageMax ?? 65} th${t.genders && t.genders !== "all" ? ` · ${t.genders === "male" ? "pria" : "wanita"}` : ""} · Advantage+ Audience & placements`} />
          </>
        )}
        <Row
          k="Variasi"
          v={
            <span className="inline-flex items-center gap-1.5">
              <Layers size={13} className="text-accent" />
              <b>{ads.length} iklan</b> {ads.length > 1 ? "dalam 1 ad set (uji kreatif/angle otomatis)" : `(${creativeLabel(selected.creative)})`}
            </span>
          }
        />
        {(selected.linkUrl ?? plan.linkUrl) && (
          <Row
            k="Link Tujuan"
            v={
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <a className="text-accent underline" href={selected.linkUrl ?? plan.linkUrl} target="_blank" rel="noopener noreferrer">
                  {selected.linkUrl ?? plan.linkUrl}
                </a>
                {plan.autoUtm && <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">+ Auto UTM</span>}
              </span>
            }
          />
        )}
        <Row k="Mulai" v={plan.startNow === false ? "Simpan sebagai draft (belum tayang)" : "Langsung tayang setelah dikonfirmasi"} />
      </div>

      {/* Pratinjau variasi kreatif & copy (1..N) */}
      <div className="rounded-xl border border-line bg-card p-3">
        {ads.length > 1 && (
          <div className="mb-2.5 flex flex-wrap gap-1.5 border-b border-line pb-2">
            {ads.map((item, idx) => (
              <button
                key={`${item.adName}-${idx}`}
                type="button"
                onClick={() => setActiveTab(idx)}
                className={cx(
                  "rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                  idx === activeTab ? "bg-accent text-accent-ink" : "bg-bg text-muted hover:bg-hover hover:text-ink",
                )}
              >
                #{idx + 1} · {item.adName}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 text-[11.5px] text-muted">
          <span className="font-semibold text-ink">{selected.adName}</span>
          <span>{creativeLabel(selected.creative)}</span>
        </div>
        {selected.creative.type === "new" && (
          <div className="mt-2 space-y-1.5 rounded-lg bg-bg p-2.5 text-[12.5px]">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-semibold text-ink">{selected.creative.headline}</p>
              {selected.creative.headline && (
                <span className={cx("shrink-0 text-[10.5px] num", selected.creative.headline.length > 40 ? "text-yellow-ink" : "text-muted")}>
                  {selected.creative.headline.length}/40 kar
                </span>
              )}
            </div>
            <p className="whitespace-pre-line leading-relaxed text-ink/90">{selected.creative.primaryText}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {selected.creative.cta && (
                <span className="rounded-md border border-line-strong bg-card px-2 py-0.5 text-[11px] font-semibold text-ink">
                  {selected.creative.cta.replace(/_/g, " ")}
                </span>
              )}
              {selected.creative.description && <span className="text-[11.5px] text-muted">{selected.creative.description}</span>}
            </div>
          </div>
        )}
      </div>

      {/* Pre-Flight Specialist Audit */}
      {audit.length > 0 && (
        <div className="rounded-xl border border-line bg-bg/70 p-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink">
            <ShieldCheck size={13} className="text-accent" /> Pre-Flight Specialist Audit
          </p>
          <ul className="space-y-1 text-[11.5px]">
            {audit.map((item, i) => (
              <li key={i} className={cx("flex items-start gap-1.5 leading-snug", item.level === "warn" ? "text-yellow-ink" : "text-green-ink")}>
                {item.level === "warn" ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={13} className="mt-0.5 shrink-0" />}
                <span><b>{item.check}:</b> <span className="text-ink/85">{item.detail}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {action.reason && <p className="text-[12px] leading-relaxed text-muted"><b className="text-ink">Strategi Media Buyer:</b> {action.reason}</p>}
      {action.status === "pending" && (
        <p className="text-[11.5px] text-muted">
          Iklan belum dibuat di Meta. Semua objek dibuat sebagai draft lebih dulu; jika ada langkah gagal, tidak ada yang tayang dan tanpa biaya.
        </p>
      )}
      {result?.steps?.length ? (
        <ul className="space-y-1 text-[12px]">
          {result.steps.map((s, idx) => (
            <li key={`${s.step}-${s.id ?? idx}`} className={cx("flex items-start gap-1.5", s.ok ? "text-green-ink" : "text-red-ink")}>
              {s.ok ? <CheckCircle2 size={14} className="mt-px shrink-0" /> : <XCircle size={14} className="mt-px shrink-0" />}
              <span><b>{STEP[s.step] ?? s.step}</b>{s.note ? ` · ${s.note}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {adsManager && (
        <a href={adsManager} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent hover:underline">
          Buka di Ads Manager <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
}

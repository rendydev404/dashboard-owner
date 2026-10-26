// Alur aksi kampanye dari tabel: buat aksi pending di server → dialog konfirmasi (nilai sebelum→sesudah) → eksekusi.
import { rp, type BotAction } from "@iklan/shared";
import { actionsApi, refreshData, ApiError } from "./api";
import { confirmDialog, toast } from "../components/ui";

export const LAUNCH_GOAL: Record<string, string> = {
  sales: "Penjualan (pixel PURCHASE)", leads_website: "Prospek website (pixel LEAD)", leads_whatsapp: "Chat WhatsApp", traffic: "Kunjungan landing page",
};

export function actionSummary(a: BotAction) {
  const p = a.params as any;
  if (a.action === "pause") return { title: "Pause kampanye?", verb: "Pause", detail: `Status: Aktif → Jeda` };
  if (a.action === "activate") return { title: "Aktifkan kampanye?", verb: "Aktifkan", detail: `Status: Jeda → Aktif` };
  if (a.action === "scale") {
    if (p.adsets?.length) return { title: `Naikkan budget ${p.pct}%?`, verb: "Naikkan", detail: p.adsets.map((s: any) => `${s.name}: ${rp(s.before)} → ${rp(s.after)}/hari`).join("\n") };
    return { title: `Naikkan budget ${p.pct}%?`, verb: "Naikkan", detail: `Budget harian: ${rp(p.before?.dailyBudget ?? 0)} → ${rp(p.after?.dailyBudget ?? 0)}` };
  }
  if (a.action === "update_rule") return { title: "Ubah aturan", verb: "Ubah", detail: `${p.field}: ${p.previous ?? "—"} → ${p.value}` };
  if (a.action === "launch") {
    const plan = p.plan ?? {};
    const count = Array.isArray(plan.ads) && plan.ads.length > 1 ? ` · ${plan.ads.length} variasi iklan` : "";
    return { title: "Luncurkan kampanye baru?", verb: "Luncurkan", detail: `${plan.campaignName} · ${rp(plan.dailyBudget ?? 0)}/hari · ${LAUNCH_GOAL[plan.objective] ?? plan.objective}${count}` };
  }
  if (a.action === "add_ads") {
    const plan = p.plan ?? {};
    const n = Array.isArray(plan.ads) ? plan.ads.length : 1;
    return {
      title: `Tambah ${n} iklan baru ke kampanye?`,
      verb: "Tambahkan",
      detail: `${a.campaignName ?? p.campaignName ?? plan.campaignId} · Ad set: ${p.adsetName ?? p.adsetId ?? "utama"} · ${n} variasi iklan`,
    };
  }
  return { title: a.action, verb: a.action, detail: "" };
}

export async function executeWithConfirm(a: BotAction) {
  const s = actionSummary(a);
  const ok = await confirmDialog({
    title: s.title,
    confirm: `Ya, ${s.verb.toLowerCase()}`,
    danger: a.action === "pause",
    body: (
      <div className="space-y-2">
        <p className="font-semibold text-ink">{a.campaignName}</p>
        <p className="text-[13px]">{a.accountName}</p>
        <p className="whitespace-pre-line rounded-lg bg-bg px-3 py-2 text-[13px] text-ink">{s.detail}</p>
        {(a.params as any).demo && <p className="text-[12px]">Mode demo: token Meta belum diisi, perubahan hanya disimpan di dashboard.</p>}
      </div>
    ),
  });
  if (!ok) { await actionsApi.cancel(a.id).catch(() => {}); return null; }
  try {
    const done = await actionsApi.confirm(a.id);
    if (done.status === "executed") {
      toast(`${s.verb}: ${a.campaignName} berhasil`, { action: { label: "Batalkan", run: () => actionsApi.revert(a.id).then(() => { toast("Aksi dibatalkan"); refreshData(); }).catch((e) => toast(e.message, { tone: "err" })) }, ms: 8000 });
    } else toast(`Gagal: ${done.error ?? "error dari Meta"}`, { tone: "err" });
    refreshData();
    return done;
  } catch (e) {
    toast(e instanceof ApiError ? e.message : "Gagal mengeksekusi", { tone: "err" });
    return null;
  }
}

export async function startCampaignAction(campaignId: string, action: "pause" | "activate" | "scale") {
  try {
    const a = await actionsApi.create(campaignId, action);
    return executeWithConfirm(a);
  } catch (e) {
    toast(e instanceof ApiError ? e.message : "Gagal menyiapkan aksi", { tone: "err" });
    return null;
  }
}

// Bot AI: Claude + tool calling (streaming), dengan jawaban cadangan berbasis aturan kalau API key belum diisi.
// Model hanya bisa MENGUSULKAN aksi kampanye; eksekusi lewat endpoint konfirmasi (lihat actions.ts).
import Anthropic from "@anthropic-ai/sdk";
import {
  type ChatEvent, type User, PRESETS, LINES, fmtRange, rp, rpk, dec, pct, nf,
} from "@iklan/shared";
import { env, aiConfigured, aiMode } from "./env";
import { sql, bumpDataVersion } from "./db";
import { loadConfig, resolveRange, resolveScope, type Config } from "./scope";
import * as Q from "./queries";
import { createCampaignAction, createLaunchAction, findCampaigns, logRuleChange, type CampaignAction } from "./actions";
import { launchContext } from "./meta/launch";
import { AD_PRESETS, adBreakdown, diagnose, placementBreakdown } from "./analysis";
import { uploadAttachment } from "./meta/upload";
import { errMsg, log } from "./log";
import { summaryWidgets, campaignsWidget, hourlyWidget, productsWidget, plWidget } from "./chat-widgets";
import { openChatSession, closeChatSession } from "./chat-sessions";

export interface ChatContext { acc: string; from: string; to: string }
type Emit = (e: ChatEvent) => void;

const RULE_FIELDS = { targetRoas: "target_roas", maxCpa: "max_cpa", maxCpl: "max_cpl", killAfterSpend: "kill_after_spend", scaleStepPct: "scale_step_pct" } as const;
type RuleField = keyof typeof RULE_FIELDS;

/** Ubah satu aturan untuk akun-akun dalam scope (dipakai chat & PATCH settings). */
export async function updateRule(accountIds: string[], field: RuleField, value: number, user: User, source: "chat" | "table") {
  const cfg = await loadConfig();
  const col = RULE_FIELDS[field];
  for (const id of accountIds) {
    const prev = (cfg.accounts.find((a) => a.id === id)?.settings as any)?.[field] ?? null;
    await sql`UPDATE account_settings SET ${sql(col)} = ${value}, updated_at = now(), updated_by = ${user.id} WHERE account_id = ${id}`;
    await logRuleChange(id, field, value, prev, user.id, source);
  }
  await bumpDataVersion();
}

/* -------------------------------------------------------------------------- tools */

const periodProps = {
  preset: { type: "string", enum: [...PRESETS], description: "Preset periode. Kosongkan untuk memakai periode yang sedang dibuka di dashboard." },
  from: { type: "string", description: "Tanggal mulai YYYY-MM-DD (custom)" },
  to: { type: "string", description: "Tanggal akhir YYYY-MM-DD (custom)" },
} as const;
const accountProp = { type: "string", description: '"all", "digital", "jasa", atau ID akun. Kosongkan untuk akun yang sedang dibuka.' } as const;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_summary",
    description: "KPI periode (laba bersih, omzet riil, spend, ROAS riil & impas, CPA, leads, CPL, closing rate, CTR) beserta periode pembanding.",
    input_schema: { type: "object", properties: { account: accountProp, ...periodProps } },
  },
  {
    name: "get_campaigns",
    description: "Daftar kampanye dengan spend, hasil, CPA/CPL, ROAS dan rekomendasi bot. Bisa diurutkan.",
    input_schema: { type: "object", properties: { account: accountProp, ...periodProps, sort: { type: "string", enum: ["spend", "roas_desc", "roas_asc", "cpa_desc"] }, limit: { type: "number" } } },
  },
  {
    name: "get_hourly",
    description: "Performa per jam: jam paling cuan (biaya per hasil terendah) dan paling boros.",
    input_schema: { type: "object", properties: { account: accountProp, ...periodProps } },
  },
  {
    name: "get_products",
    description: "Produk & jasa terlaris (omzet, qty, porsi).",
    input_schema: { type: "object", properties: { account: accountProp, ...periodProps } },
  },
  {
    name: "get_pl",
    description: "Laporan laba rugi per lini (Produk Digital AI, Jasa AI, Gabungan).",
    input_schema: { type: "object", properties: { ...periodProps } },
  },
  {
    name: "diagnose_performance",
    description:
      "Diagnosa mendalam satu kampanye atau seluruh akun: funnel CPM → CTR → CVR → biaya per hasil, dibanding periode lalu DAN baseline 90 hari akun, " +
      "dekomposisi penyebab naik/turunnya biaya per hasil (berapa % karena CPM, CTR, atau CVR), tren harian, paruh awal vs akhir periode (deteksi creative fatigue), " +
      "volume untuk learning phase, sinyal otomatis, dan unit economics (ROAS impas, CPA maks impas, target akun). Pakai untuk pertanyaan 'kenapa', evaluasi, atau sebelum memberi rekomendasi.",
    input_schema: {
      type: "object",
      properties: {
        account: accountProp, ...periodProps,
        campaign_query: { type: "string", description: "Potongan nama kampanye (kosongkan untuk seluruh akun)" },
        campaign_id: { type: "string" },
      },
    },
  },
  {
    name: "get_ad_breakdown",
    description:
      "Rincian per IKLAN/kreatif langsung dari Meta: spend & porsi spend, frekuensi, CPM, CTR tautan, landing page rate, add to cart, checkout, hasil, biaya per hasil, " +
      "ROAS pixel, retensi video (hold 25%, ThruPlay), dan ranking kualitas/engagement/konversi. Pakai untuk menilai kreatif mana yang menang/kalah, creative fatigue, " +
      "dan masalah landing page/checkout. Butuh satu akun (atau satu kampanye).",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "ID akun; boleh kosong kalau kampanye atau akun yang dibuka sudah jelas" },
        campaign_query: { type: "string" }, campaign_id: { type: "string" },
        period: { type: "string", enum: [...AD_PRESETS], description: "Default last_14d" },
        limit: { type: "number", description: "Maks. iklan (default 12, maks. 30)" },
      },
    },
  },
  {
    name: "get_placement_breakdown",
    description:
      "Performa per placement (Facebook, Instagram, WhatsApp, Threads, Audience Network) langsung dari Meta: spend & porsi, impresi, CPM, CTR, CPC, hasil, biaya per hasil, CVR. " +
      "Pakai saat CPM/CTR/impresi terlihat janggal, atau untuk menilai placement mana yang menghasilkan vs hanya menyerap impresi murah.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "ID akun; boleh kosong kalau kampanye atau akun yang dibuka sudah jelas" },
        campaign_query: { type: "string" }, campaign_id: { type: "string" },
        period: { type: "string", enum: [...AD_PRESETS], description: "Default last_14d" },
      },
    },
  },
  {
    name: "set_view",
    description: "Pindahkan tampilan dashboard user ke akun dan/atau periode lain.",
    input_schema: { type: "object", properties: { account: accountProp, ...periodProps } },
  },
  {
    name: "update_rule",
    description: "Ubah aturan bot untuk akun yang dipilih: targetRoas (x), maxCpa (Rp), maxCpl (Rp), killAfterSpend (Rp), scaleStepPct (%).",
    input_schema: {
      type: "object",
      properties: { account: accountProp, field: { type: "string", enum: Object.keys(RULE_FIELDS) }, value: { type: "number" } },
      required: ["field", "value"],
    },
  },
  {
    name: "propose_campaign_action",
    description:
      "USULKAN aksi ke kampanye Meta: pause, activate, atau scale (naikkan budget %). Tool ini TIDAK mengeksekusi; ia membuat kartu konfirmasi untuk user. " +
      "Kalau nama kampanye ambigu, tool mengembalikan daftar kandidat — tanyakan ke user yang mana.",
    input_schema: {
      type: "object",
      properties: {
        campaign_query: { type: "string", description: "Potongan nama kampanye" },
        campaign_id: { type: "string", description: "ID kampanye kalau sudah pasti" },
        action: { type: "string", enum: ["pause", "activate", "scale"] },
        pct: { type: "number", description: "Persen kenaikan budget untuk scale (default aturan akun, maks. 50)" },
        reason: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "list_ad_accounts",
    description: "Daftar akun iklan di dashboard (ID, nama, lini). WAJIB dipakai sebelum membuat iklan baru untuk MENANYAKAN ke user akun mana yang dipakai.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_launch_context",
    description:
      "Bahan merancang iklan baru di satu akun: Page & Instagram yang bisa dipakai, pixel/dataset, kreatif yang sudah ada (bisa dipakai ulang), " +
      "kampanye dengan spend terbesar 30 hari (+ROAS), produk & link, minimal/maksimal budget harian. Panggil setelah user memilih akun.",
    input_schema: { type: "object", properties: { account_id: { type: "string" } }, required: ["account_id"] },
  },
  {
    name: "upload_media_to_meta",
    description:
      "Upload foto/video yang dilampirkan user di chat (baris '[Lampiran … media_id=…]') ke perpustakaan media akun iklan Meta. " +
      "Foto → imageHash; video → videoId (diproses Meta 1–5 menit). Panggil SETELAH akun dipastikan. Memanggil lagi untuk media_id yang sama " +
      "mengembalikan status terbaru (cek apakah video sudah siap). Upload ini belum membuat iklan dan tanpa biaya. File sementara di server dihapus begitu Meta menerimanya.",
    input_schema: {
      type: "object",
      properties: { media_id: { type: "string", description: "media_id dari baris lampiran" }, account_id: { type: "string", description: "ID akun iklan yang DIPILIH USER" } },
      required: ["media_id", "account_id"],
    },
  },
  {
    name: "propose_launch",
    description:
      "USULKAN kampanye baru (kampanye CBO → ad set Advantage+ → kreatif → iklan). TIDAK membuat apa pun di Meta: tool ini hanya menampilkan " +
      "kartu rencana untuk dikonfirmasi user. Setelah user menekan 'Ya, eksekusi', sistem membuat semuanya sebagai draft lalu menayangkannya. " +
      "Hanya panggil setelah user memilih akun dan menyebut/menyetujui budget harian, produk/tujuan, dan kreatif.",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "ID akun yang DIPILIH USER" },
        campaignName: { type: "string", description: "Format: [Tujuan] - [Produk/Angle] - [Tanggal], mis. 'Penjualan - Timelapse AI - 21 Okt'" },
        objective: { type: "string", enum: ["sales", "leads_website", "leads_whatsapp", "traffic"], description: "sales = pembelian di website (pixel PURCHASE); leads_website = prospek di website (pixel LEAD); leads_whatsapp = chat WhatsApp; traffic = kunjungan landing page" },
        dailyBudget: { type: "integer", description: "Budget harian kampanye dalam Rupiah (bulat). Harus sesuai yang user sebut/setujui." },
        pageId: { type: "string" },
        instagramUserId: { type: "string", description: "Opsional, supaya tayang di Instagram atas nama akun IG brand" },
        pixelId: { type: "string", description: "Wajib untuk sales & leads_website" },
        linkUrl: { type: "string", description: "Landing page/halaman produk (https://...). Wajib kecuali leads_whatsapp atau memakai kreatif/post yang sudah ada" },
        targeting: {
          type: "object",
          properties: {
            countries: { type: "array", items: { type: "string" }, description: "Kode negara ISO, default ['ID']" },
            ageMin: { type: "integer" }, ageMax: { type: "integer" },
            genders: { type: "string", enum: ["all", "male", "female"] },
          },
        },
        creative: {
          type: "object",
          description:
            "Salah satu: {type:'existing', creativeId} memakai kreatif yang sudah terbukti; {type:'post', objectStoryId:'PAGEID_POSTID'} boost postingan Page; " +
            "{type:'new', imageUrl|imageHash|videoId, primaryText, headline, description?, cta} kreatif baru. " +
            "Untuk lampiran chat: pakai imageHash/videoId dari upload_media_to_meta (thumbnail video diambil otomatis dari Meta).",
          properties: {
            type: { type: "string", enum: ["existing", "post", "new"] },
            creativeId: { type: "string" }, objectStoryId: { type: "string" },
            imageHash: { type: "string" }, imageUrl: { type: "string" }, videoId: { type: "string" },
            primaryText: { type: "string" }, headline: { type: "string" }, description: { type: "string" },
            cta: { type: "string", enum: ["SHOP_NOW", "BUY_NOW", "LEARN_MORE", "SIGN_UP", "ORDER_NOW", "GET_OFFER", "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "WHATSAPP_MESSAGE"] },
          },
          required: ["type"],
        },
        adName: { type: "string" },
        startNow: { type: "boolean", description: "true = langsung tayang setelah dikonfirmasi (default); false = simpan sebagai draft di Ads Manager" },
        rationale: { type: "string", description: "Alasan singkat strategi (ditampilkan di kartu)" },
      },
      required: ["accountId", "campaignName", "objective", "dailyBudget", "pageId", "creative", "adName"],
    },
  },
];

function scopeAndRange(input: any, ctx: ChatContext, cfg: Config) {
  const scope = resolveScope(input.account || ctx.acc, cfg);
  const r = input.preset ? resolveRange(undefined, undefined, input.preset) : resolveRange(input.from || ctx.from, input.to || ctx.to);
  return { scope, r };
}
const label = (scope: { acc: string }, cfg: Config) =>
  scope.acc === "all" ? "Semua akun" : scope.acc === "digital" ? "Akun Produk Digital" : scope.acc === "jasa" ? "Akun Jasa" : cfg.accounts.find((a) => a.id === scope.acc)?.name;

/** Cari kampanye dari ID atau potongan nama: dulu di scope yang dibuka, lalu di semua akun. */
async function resolveCampaign(input: any, scopeIds: string[], cfg: Config): Promise<{ id: string; accountId: string } | { ambiguous: true; candidates: unknown[] } | { error: string }> {
  if (input.campaign_id) {
    const [c] = await sql`SELECT id, account_id FROM campaigns WHERE id = ${String(input.campaign_id)}`;
    return c ? { id: c.id, accountId: c.account_id } : { error: "ID kampanye tidak dikenal" };
  }
  let cands = await findCampaigns(input.campaign_query ?? "", scopeIds);
  if (!cands.length) cands = await findCampaigns(input.campaign_query ?? "", cfg.accounts.map((a) => a.id));
  if (!cands.length) return { error: "Kampanye tidak ditemukan. Minta user menyebut sebagian nama kampanye." };
  const top = cands.filter((x) => Math.floor(x.score) === Math.floor(cands[0].score));
  if (top.length > 1) return { ambiguous: true, candidates: top.slice(0, 8).map((x) => ({ id: x.id, name: x.name, account: x.account_name, status: x.status })) };
  return { id: cands[0].id, accountId: cands[0].account_id };
}

/** Akun (dan kampanye opsional) untuk analisis live Meta: dari input, kampanye yang disebut, atau akun yang sedang dibuka. */
async function adTarget(input: any, ctx: ChatContext, cfg: Config) {
  const scope = resolveScope(ctx.acc, cfg);
  let accountId: string | undefined = input.account_id, campaignId: string | null = null;
  if (input.campaign_id || input.campaign_query) {
    const c = await resolveCampaign(input, scope.accountIds, cfg);
    if (!("id" in c)) return c;
    campaignId = c.id; accountId ??= c.accountId;
  }
  accountId ??= scope.accounts.length === 1 ? scope.accounts[0].id : undefined;
  const acc = cfg.accounts.find((a) => a.id === accountId);
  return acc ? { acc, campaignId } : { error: "Sebutkan akun iklannya (lihat list_ad_accounts) atau nama kampanyenya." };
}

function slimKpis(k: any) {
  const keys = ["spend", "adTax", "revenue", "orders", "net", "netMargin", "roas", "metaRoas", "beRoas", "cpa", "maxCpaBE", "leads", "cpl", "closeRate", "ctr", "cpc", "aov", "fixed", "other"];
  return Object.fromEntries(keys.map((x) => [x, typeof k[x] === "number" ? Math.round(k[x] * 1000) / 1000 : k[x]]));
}

export async function runTool(name: string, input: any, ctx: ChatContext, user: User, emit: Emit): Promise<unknown> {
  const cfg = await loadConfig();
  switch (name) {
    case "get_summary": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const s = await Q.summaryFor(scope, r, cfg);
      summaryWidgets(label(scope, cfg) ?? "", fmtRange(r.from, r.to), fmtRange(r.prevFrom, r.prevTo), s.kpis, s.prev).forEach((widget) => emit({ type: "widget", widget }));
      return { scope: label(scope, cfg), period: fmtRange(r.from, r.to), compare: fmtRange(r.prevFrom, r.prevTo), now: slimKpis(s.kpis), previous: slimKpis(s.prev) };
    }
    case "get_campaigns": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const c = await Q.campaigns(scope, r);
      const rows = [...c.rows];
      if (input.sort === "roas_desc") rows.sort((a, b) => b.roas - a.roas);
      if (input.sort === "roas_asc") rows.sort((a, b) => (a.spend > 0 ? a.roas : 99) - (b.spend > 0 ? b.roas : 99));
      if (input.sort === "cpa_desc") rows.sort((a, b) => (b.cpa ?? 1e12) - (a.cpa ?? 1e12));
      const cw = campaignsWidget(label(scope, cfg) ?? "", fmtRange(r.from, r.to), rows);
      if (cw) emit({ type: "widget", widget: cw });
      return {
        scope: label(scope, cfg), period: fmtRange(r.from, r.to), singleDaySignal: r.days === 1,
        campaigns: rows.slice(0, Math.min(input.limit ?? 15, 30)).map((x) => ({
          id: x.id, name: x.name, account: x.accountName, line: x.line, status: x.status, dailyBudget: x.dailyBudget, spend: x.spend,
          purchases: x.purchases, leads: x.leads, cpa: x.cpa && Math.round(x.cpa), cpl: x.cpl && Math.round(x.cpl),
          roas: Math.round(x.roas * 100) / 100, roasSource: x.revenueEstimated ? "estimasi dari leads" : "pixel Meta", recommendation: x.rec.label,
        })),
      };
    }
    case "get_hourly": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const h = await Q.hourly(scope, r);
      const hw = hourlyWidget(h);
      if (hw) emit({ type: "widget", widget: hw });
      const fmt = (x: any) => ({ hour: `${String(x.hour).padStart(2, "0")}:00`, spend: x.spend, results: x.results, costPerResult: x.cost && Math.round(x.cost) });
      return { metric: h.metric, best: h.best.map(fmt), worst: h.worst.map(fmt) };
    }
    case "get_products": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const p = await Q.products(scope, r);
      const pw = productsWidget(fmtRange(r.from, r.to), p);
      if (pw) emit({ type: "widget", widget: pw });
      return { period: fmtRange(r.from, r.to), total: p.total, top: p.rows.slice(0, 10).map((x) => ({ name: x.name, line: x.line, qty: x.qty, revenue: x.revenue, share: Math.round(x.share * 1000) / 10 })) };
    }
    case "get_pl": {
      const r = input.preset ? resolveRange(undefined, undefined, input.preset) : resolveRange(input.from || ctx.from, input.to || ctx.to);
      const p = await Q.pl(r, cfg);
      emit({ type: "widget", widget: plWidget(fmtRange(r.from, r.to), p) });
      return { period: fmtRange(r.from, r.to), lines: p.columns.map((c) => ({ line: c.label, ...slimKpis(c.kpis), gross: Math.round(c.kpis.gross), prevNet: c.prevNet })) };
    }
    case "diagnose_performance": {
      let { scope, r } = scopeAndRange(input, ctx, cfg);
      let campaignId: string | null = null;
      if (input.campaign_id || input.campaign_query) {
        const c = await resolveCampaign(input, scope.accountIds, cfg);
        if (!("id" in c)) return c;
        campaignId = c.id;
        if (!scope.accountIds.includes(c.accountId)) scope = resolveScope(c.accountId, cfg);
      }
      const [d, s] = await Promise.all([diagnose(scope, r, campaignId), Q.summaryFor(scope, r, cfg)]);
      const k = s.kpis;
      return {
        scope: label(scope, cfg), ...d,
        economics: {
          breakEvenRoas: Math.round(k.beRoas * 100) / 100, maxCpaBreakEven: Math.round(k.maxCpaBE), aov: Math.round(k.aov), closeRate: k.leads ? Math.round(k.closeRate * 1000) / 10 : null,
          realRoasScope: Math.round(k.roas * 100) / 100, netProfitScope: Math.round(k.net),
          accountRules: scope.accounts.map((a) => ({ account: a.name, line: a.line, targetRoas: a.settings.targetRoas, maxCpa: a.settings.maxCpa, maxCpl: a.settings.maxCpl, killAfterSpend: a.settings.killAfterSpend })),
        },
      };
    }
    case "get_ad_breakdown":
    case "get_placement_breakdown": {
      const t = await adTarget(input, ctx, cfg);
      if (!("acc" in t)) return t;
      const period = (AD_PRESETS as readonly string[]).includes(input.period) ? input.period : "last_14d";
      const res = name === "get_ad_breakdown"
        ? await adBreakdown(t.acc, t.campaignId, period, Math.min(Number(input.limit) || 12, 30))
        : await placementBreakdown(t.acc, t.campaignId, period);
      return { account: t.acc.name, ...res };
    }
    case "set_view": {
      const acc = input.account as string | undefined;
      if (acc) resolveScope(acc, cfg); // validasi
      emit({ type: "view", acc, preset: input.preset, from: input.from, to: input.to });
      return { ok: true };
    }
    case "update_rule": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh mengubah aturan" };
      const scope = resolveScope(input.account || ctx.acc, cfg);
      await updateRule(scope.accountIds, input.field, Number(input.value), user, "chat");
      scope.accountIds.forEach((id) => emit({ type: "rule_changed", accountId: id }));
      return { ok: true, accounts: scope.accounts.map((a) => a.name), field: input.field, value: input.value };
    }
    case "propose_campaign_action": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh mengontrol iklan" };
      const scope = resolveScope(ctx.acc, cfg);
      const c = await resolveCampaign(input, scope.accountIds, cfg);
      if (!("id" in c)) return c;
      const action = await createCampaignAction({ campaignId: c.id, action: input.action as CampaignAction, pct: input.pct, source: "chat", userId: user.id, reason: input.reason });
      emit({ type: "action_card", action });
      return { ok: true, pendingActionId: action.id, note: "Kartu konfirmasi sudah tampil. User harus menekan 'Ya, eksekusi'. Jangan bilang sudah dieksekusi." };
    }
    case "list_ad_accounts":
      return { accounts: cfg.accounts.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, line: LINES[a.line].label })) };
    case "get_launch_context": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh membuat iklan" };
      return await launchContext(String(input.account_id ?? ""));
    }
    case "upload_media_to_meta": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh membuat iklan" };
      const acc = cfg.accounts.find((a) => a.id === String(input.account_id ?? "") && a.active);
      if (!acc) return { error: "Akun iklan tidak terdaftar atau tidak aktif. Tanyakan akun mana (list_ad_accounts)." };
      return { account: acc.name, ...(await uploadAttachment(String(input.media_id ?? ""), user.id, acc.id)) };
    }
    case "propose_launch": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh membuat iklan" };
      const action = await createLaunchAction(input, user.id, input.rationale);
      emit({ type: "action_card", action });
      return { ok: true, pendingActionId: action.id, note: "Kartu rencana sudah tampil. Iklan BELUM dibuat. Minta user memeriksa lalu menekan 'Ya, eksekusi'. Jangan bilang iklan sudah tayang." };
    }
  }
  return { error: "Tool tidak dikenal" };
}

/* -------------------------------------------------------------------------- Claude */

function systemPrompt(cfg: Config) {
  const rules = cfg.accounts.map((a) => {
    const s = a.settings;
    return `- ${a.name} (ID ${a.id}, ${LINES[a.line].label}): target ROAS ${s.targetRoas}x, ${a.line === "jasa" ? `batas CPL ${rp(s.maxCpl ?? 0)}` : `batas CPA ${rp(s.maxCpa ?? 0)}`}, matikan setelah spend ${rp(s.killAfterSpend)}, scale +${s.scaleStepPct}%, PPN iklan ${s.adTaxPct}%`;
  }).join("\n");
  return `Kamu "Bot Iklan": konsultan performance marketing senior & Meta Ads specialist (10+ tahun, kelola ratusan miliar spend direct response di Indonesia) untuk owner bisnis Produk Digital AI (jualan di lynk.id) dan Jasa AI (closing manual lewat chat).
Kamu dibayar untuk keputusan yang menghasilkan laba, bukan laporan angka. Berpikir seperti media buyer + growth strategist + analis keuangan sekaligus: tajam, jujur, berbasis data, tegas memberi rekomendasi, dan selalu menjelaskan "kenapa".

Gaya: Bahasa Indonesia santai (gw/lo), padat, angka dulu baru penjelasan. Format uang seperti Rp1,2 jt / Rp450 rb.
Format jawaban (markdown):
- Buka dengan 1 kalimat kesimpulan yang **ditebalkan** (jawab pertanyaannya langsung).
- Pakai judul kecil (### ) kalau jawabannya punya beberapa bagian, daftar berpoin untuk temuan, dan langkah bernomor untuk saran.
- Tabel markdown hanya untuk perbandingan kecil (maks. 5 baris) yang tidak sudah tampil sebagai widget.
- Tool get_summary, get_campaigns, get_hourly, get_products, get_pl OTOMATIS menampilkan widget kartu/grafik. Jangan ulangi semua angkanya; sebut 2–3 angka kunci lalu fokus ke insight dan saran.
- Untuk analisis/evaluasi/"kenapa", pakai struktur: **Kesimpulan** → ### Diagnosa (angka + perbandingan) → ### Akar masalah (fakta vs hipotesis) → ### Yang harus dilakukan (urut dampak terbesar, konkret: apa, berapa, kapan) → ### Pantau (metrik & ambang untuk evaluasi berikutnya). Tutup dengan "Keyakinan: tinggi/sedang/rendah" + alasan singkat (ukuran sampel, kualitas data).

Prinsip data & kejujuran:
- Selalu ambil angka lewat tools, jangan mengarang angka, benchmark, atau ID. Sebut akun & periode yang dipakai.
- Pisahkan FAKTA (dari data) dan HIPOTESIS (dugaan yang perlu diuji). Kalau data tidak cukup, bilang terus terang dan usulkan cara mengujinya.
- Bandingkan dengan data akun sendiri (periode lalu, baseline 90 hari dari diagnose_performance) sebelum memakai patokan umum. Patokan umum hanya sebagai konteks, sebut "patokan umum".
- Bedakan ROAS riil (omzet lynk.id/input manual ÷ spend) dan ROAS Meta (pixel, atribusi 7d click/1d view, bisa lebih tinggi atau lebih rendah dari riil). Keputusan laba memakai ROAS riil & laba bersih. ROAS per kampanye jasa adalah estimasi dari leads.
- Laba bersih = omzet − fee − HPP − spend − PPN iklan − biaya tetap prorata − biaya lain.
- Signifikansi: < 3 hari data, < ~10 konversi, atau spend < 1–2× target CPA = sinyal awal, jangan keputusan drastis kecuali jelas boros (spend ≥ batas spend akun tanpa hasil).

Cara menganalisis (urut, jangan loncat):
1. Validitas data: sinkron terakhir, tracking pixel/lead jalan? Selisih besar ROAS Meta vs riil = cek atribusi/pixel dulu sebelum menyalahkan iklan.
2. Unit economics: bandingkan ROAS riil dengan ROAS impas dan target; CPA dengan CPA maks impas; jasa: CPL ÷ closing rate = biaya per closing (CAC) vs margin per closing. Ini menentukan "sehat/tidak".
3. Dekomposisi funnel: biaya per hasil = CPM ÷ (1000 × CTR × CVR). Pakai diagnose_performance untuk tahu driver utama:
   - CPM naik → lelang/musim (Q4, harbolnas 11.11/12.12, Ramadan), audiens sempit/jenuh, atau kualitas kreatif rendah.
   - CPM/impresi janggal (CPM sangat rendah, impresi melonjak) → hampir selalu placement WhatsApp/Audience Network, bukan error data. Cek get_placement_breakdown dan nilai pakai CPC & biaya per hasil.
   - CTR turun → hook/kreatif lemah atau lelah (frekuensi tinggi, CTR menurun dari hari ke hari).
   - CVR turun → masalah setelah klik: landing page (lambat, landing rate < ~70%), offer/harga, checkout (add to cart banyak tapi pembelian sedikit), atau tracking.
4. Level kreatif: get_ad_breakdown untuk melihat iklan mana yang menyerap spend vs yang benar-benar menghasilkan, frekuensi, hold rate video, ranking. Pemenang = biaya per hasil rendah DENGAN volume cukup.
5. Struktur & delivery: budget terpecah, learning phase (< ~50 hasil/minggu per ad set), terlalu sering diedit, overlap.
6. Baru rekomendasi: prioritaskan perbaikan dengan dampak laba terbesar & usaha terkecil.

Playbook keputusan:
- Aturan akun: Matikan kalau spend ≥ batas spend dan CPA/CPL lewat batas; Scale kalau ROAS ≥ 1,3× target; Ganti kreatif kalau ROAS < target (digital) atau CPL lewat batas (jasa). Periode 1 hari = sinyal awal saja.
- Scale vertikal maks. 20–30% tiap 2–3 hari pada kampanye yang stabil; scale horizontal dengan menggandakan pemenang/angle baru. Jangan scale kampanye yang CPA-nya baru bagus 1–2 hari.
- Creative fatigue (CTR turun + CPM/frekuensi naik): jangan matikan pemenang mendadak; masukkan 2–3 variasi baru (hook/visual/angle berbeda) di ad set yang sama.
- Testing kreatif: uji angle/konsep yang benar-benar beda (masalah, hasil/transformasi, bukti sosial, demo, perbandingan, urgensi), bukan sekadar ganti warna. Algoritma Meta sekarang memilih audiens lewat kreatif, jadi keberagaman kreatif = jangkauan audiens.
- Copy: hook 3 detik/baris pertama spesifik ke masalah/hasil, manfaat konkret + angka, bukti (testimoni, jumlah pembeli, demo), hilangkan keraguan (harga, garansi, cara akses), CTA jelas.
- Offer sering lebih berdampak dari targeting: bundling, bonus, harga jangkar, batas waktu yang jujur. Untuk jasa: percepat respons chat (< 5 menit) karena closing rate jatuh drastis kalau lead dibiarkan.
- Konteks Indonesia: daya beli naik di tanggal gajian (25–5), CPM naik di Q4 & menjelang harbolnas, jam aktif malam; pakai get_hourly sebelum menyarankan jadwal.
- Patuh kebijakan iklan Meta: tanpa klaim berlebihan/jaminan hasil/penghasilan, tanpa menyebut atribut personal ("Kamu yang gemuk…"), tanpa before-after menyesatkan.

Aksi:
- Untuk pause/aktifkan/scale, panggil propose_campaign_action. Itu hanya membuat kartu konfirmasi; JANGAN pernah bilang aksi sudah dijalankan. Minta user menekan tombol konfirmasi.
- Kalau user minta pindah akun/periode, panggil set_view.
- Tawarkan langkah lanjut yang konkret di akhir (mis. "mau gw siapin 3 variasi hook untuk iklan X?"), maksimal satu tawaran.

Membuat iklan baru (WAJIB urut):
1. Kalau user belum menyebut akun secara eksplisit, panggil list_ad_accounts lalu TANYA akun mana. Jangan memilih akun sendiri.
2. Pastikan jelas: produk/jasa yang diiklankan, tujuan (penjualan / prospek website / chat WhatsApp / traffic), budget HARIAN dalam Rupiah, dan kreatif (pakai kreatif lama yang terbukti, boost postingan, atau gambar/video baru + copy). Kalau ada yang belum jelas, tanya singkat dalam satu pesan. Jangan mengarang budget.
3. Panggil get_launch_context untuk akun itu. Pakai Page, IG, dan pixel dari sana; jangan mengarang ID.
4. Susun rencana terbaik, jelaskan singkat (tujuan & event optimasi, budget, audiens, kreatif & copy), lalu panggil propose_launch. Sistem menampilkan kartu konfirmasi; iklan baru dibuat & tayang setelah user menekan "Ya, eksekusi".

Foto/video dari user (pesan berisi baris "[Lampiran foto|video · media_id=…]"):
- Itu kreatif yang ingin diiklankan user. Kamu tidak bisa melihat isinya; tanyakan singkat isi/pesan utamanya kalau belum jelas dari teks user, lalu tulis copy (primary text, headline ≤ 40 karakter, CTA) yang cocok.
- Setelah akun pasti, panggil upload_media_to_meta(media_id, account_id). Foto → creative {type:'new', imageHash}. Video → creative {type:'new', videoId} (thumbnail otomatis). Jangan mengarang hash/ID.
- Video yang masih diproses Meta boleh langsung dibuatkan kartu rencananya; beri tahu user bahwa tombol "Ya, eksekusi" baru berhasil setelah video siap (1–5 menit).
- Satu lampiran = satu iklan. Lebih dari satu lampiran: tanyakan mau 1 kampanye dengan iklan terpisah (buat satu per satu) atau pilih satu.

Best practice membuat iklan:
- Struktur sederhana: 1 kampanye CBO, 1 ad set, 1–3 iklan. Hindari memecah budget kecil ke banyak ad set.
- Targeting broad + Advantage+ Audience & Advantage+ placements (default). Negara ID, usia 18–65 kecuali produk jelas butuh rentang lain. Jangan mengarang ID interest.
- Event optimasi sedekat mungkin ke uang: produk digital → sales (PURCHASE); jasa → leads_website (LEAD) atau leads_whatsapp kalau closing lewat chat.
- Budget: idealnya ≥ 2–3× target CPA per hari supaya bisa keluar dari learning phase (~50 konversi/minggu). Kalau budget user terlalu kecil, sampaikan risikonya tapi tetap ikuti keputusan user.
- Kreatif: utamakan kreatif/angle yang terbukti (ROAS/CPA terbaik di get_launch_context). Copy: hook kuat di baris pertama, manfaat konkret, bukti/sosial proof, CTA jelas; headline ≤ 40 karakter. Sesuaikan bahasa santai Indonesia.
- Setelah tayang: jangan diubah 3–5 hari pertama (learning). Evaluasi pakai aturan akun (target ROAS, batas CPA/CPL); scale bertahap maks. 20–30% per 2–3 hari.

Aturan akun saat ini:
${rules || "- (belum ada akun iklan)"}`;
}

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));

async function chatWithClaude(message: string, history: Anthropic.MessageParam[], ctx: ChatContext, user: User, emit: Emit, convId: string) {
  const cfg = await loadConfig();
  const scope = resolveScope(ctx.acc, cfg);
  const intro = `[Konteks dashboard: ${label(scope, cfg)} · ${fmtRange(ctx.from, ctx.to)} (from=${ctx.from}, to=${ctx.to}) · hari ini ${resolveRange().today}]\n`;
  const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: intro + message }];
  const tools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t));
  let usage = { input: 0, output: 0, cacheRead: 0 };
  let finalText = "";

  for (let step = 0; step < 6; step++) {
    const stream = anthropic().messages.stream({
      model: env.CLAUDE_MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: systemPrompt(cfg), cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    stream.on("text", (t) => { finalText += t; emit({ type: "text", text: t }); });
    const msg = await stream.finalMessage();
    usage.input += msg.usage.input_tokens; usage.output += msg.usage.output_tokens; usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      let out: unknown;
      try { out = await runTool(block.name, block.input, ctx, user, emit); } catch (e) { out = { error: errMsg(e) }; }
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
    if (finalText) { emit({ type: "text", text: "\n\n" }); finalText += "\n\n"; }
  }
  await sql`
    INSERT INTO chat_messages (conversation_id, user_id, role, content, input_tokens, output_tokens, cache_read_tokens)
    VALUES (${convId}, ${user.id}, 'user', ${sql.json({ text: message })}, null, null, null),
           (${convId}, ${user.id}, 'assistant', ${sql.json({ text: finalText.trim() })}, ${usage.input}, ${usage.output}, ${usage.cacheRead})`;
}

/* -------------------------------------------------------------------------- Claude Code (jembatan di host) */

/**
 * Bot memakai Claude Code yang login di VPS (user claude-ads) lewat deploy/claude-bridge.mjs.
 * Jembatan menjalankan `claude -p` dengan tool dashboard sebagai server MCP (/internal/mcp, token sekali pakai),
 * lalu mengalirkan teks balik sebagai NDJSON: {t:"text",v} | {t:"break"} | {t:"done",usage} | {t:"error",v}.
 */
async function chatViaBridge(message: string, history: { role: "user" | "assistant"; content: string }[], ctx: ChatContext, user: User, emit: Emit, convId: string) {
  const cfg = await loadConfig();
  const scope = resolveScope(ctx.acc, cfg);
  const transcript = history.map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`).join("\n\n");
  const prompt = (transcript ? `Riwayat percakapan sebelumnya:\n${transcript}\n\n` : "") +
    `[Konteks dashboard: ${label(scope, cfg)} · ${fmtRange(ctx.from, ctx.to)} (from=${ctx.from}, to=${ctx.to}) · hari ini ${resolveRange().today}]\n` +
    `Pesan user: ${message}`;
  const token = openChatSession({ user, ctx, emit });
  let finalText = "", usage = { input: 0, output: 0, cacheRead: 0 }, failed: string | null = null;
  try {
    const res = await fetch(new URL("/v1/chat", env.CLAUDE_BRIDGE_URL), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLAUDE_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.CLAUDE_MODEL, system: systemPrompt(cfg), prompt, mcpUrl: env.CLAUDE_MCP_URL, mcpToken: token }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 429) throw new Error("Bot sedang melayani pertanyaan lain, coba lagi beberapa detik lagi.");
    if (!res.ok || !res.body) throw new Error(`Jembatan Claude menolak (HTTP ${res.status})`);
    const reader = res.body.getReader(), td = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { t: string; v?: string; usage?: typeof usage };
        if (m.t === "text" && m.v) { finalText += m.v; emit({ type: "text", text: m.v }); }
        else if (m.t === "break" && finalText && !finalText.endsWith("\n\n")) { finalText += "\n\n"; emit({ type: "text", text: "\n\n" }); }
        else if (m.t === "done" && m.usage) usage = m.usage;
        else if (m.t === "error") failed = m.v ?? "Claude gagal menjawab";
      }
    }
  } finally {
    closeChatSession(token);
  }
  if (failed && !finalText) throw new Error(failed);
  await sql`
    INSERT INTO chat_messages (conversation_id, user_id, role, content, input_tokens, output_tokens, cache_read_tokens)
    VALUES (${convId}, ${user.id}, 'user', ${sql.json({ text: message })}, null, null, null),
           (${convId}, ${user.id}, 'assistant', ${sql.json({ text: finalText.trim(), via: "claude-code" })}, ${usage.input}, ${usage.output}, ${usage.cacheRead})`;
}

/* -------------------------------------------------------------------------- cadangan tanpa AI */

async function fallbackAnswer(message: string, ctx: ChatContext, user: User, emit: Emit) {
  const t = message.toLowerCase();
  const cfg = await loadConfig();
  const scope = resolveScope(ctx.acc, cfg);
  const r = resolveRange(ctx.from, ctx.to);
  const out: string[] = [];
  const say = (s: string) => out.push(s);

  const act = /\b(pause|matikan|stop|jeda)\b/.test(t) ? "pause" : /\b(aktifkan|nyalakan|hidupkan|jalankan)\b/.test(t) ? "activate" : /\b(scale|naikkan|naikin)\b/.test(t) ? "scale" : null;
  if (act) {
    const res: any = await runTool("propose_campaign_action", { action: act, campaign_query: message }, ctx, user, emit).catch((e) => ({ error: errMsg(e) }));
    if (res.ambiguous) say("Ada beberapa kampanye yang cocok, sebut yang mana:\n" + res.candidates.map((c: any) => `- ${c.name} (${c.account})`).join("\n"));
    else if (res.error) say(res.error);
    else say("Cek kartu di bawah, lalu tekan **Ya, eksekusi** kalau sudah yakin.");
    return out.join("\n");
  }

  const { kpis: k } = await Q.summaryFor(scope, r, cfg);
  if (/laba|untung|rugi|profit/.test(t)) {
    say(`Laba bersih **${rp(k.net)}** dari omzet ${rp(k.revenue)}, margin ${pct(k.netMargin)}.`);
    if (scope.acc === "all") {
      const p = await Q.pl(r, cfg);
      p.columns.filter((c) => c.key !== "total").forEach((c) => say(`- ${c.label}: ${rp(c.kpis.net)}`));
    }
  }
  if (/roas/.test(t)) say(`ROAS riil **${dec(k.roas)}x**, titik impas di ${dec(k.beRoas)}x.`);
  if (/spend|biaya iklan|habis berapa/.test(t)) say(`Spend iklan **${rp(k.spend)}** + PPN ${rp(k.adTax)}.`);
  if (/omzet|penjualan|revenue|pemasukan/.test(t)) say(`Omzet riil **${rp(k.revenue)}** dari ${nf(k.orders)} order/closing.`);
  if (/lead|cpl|closing/.test(t)) say(k.leads ? `Leads **${nf(k.leads)}**, CPL ${rpk(k.cpl)}, closing rate ${pct(k.closeRate)}.` : "Belum ada leads di akun/periode ini.");
  if (/cpa/.test(t)) say(`CPA (incl. PPN) **${rpk(k.cpa)}**, maks. impas ${rpk(k.maxCpaBE)}.`);
  if (/terbaik|paling bagus|best|juara|terburuk|paling jelek|boros|worst/.test(t) && !/\bjam\b/.test(t)) {
    const c = (await Q.campaigns(scope, r)).rows.filter((x) => x.spend > 0);
    const worst = /terburuk|jelek|boros|worst/.test(t);
    const pick = [...c].sort((a, b) => (worst ? a.roas - b.roas : b.roas - a.roas))[0];
    say(pick ? `${worst ? "Paling boros" : "Kampanye terbaik"}: **${pick.name}**, ROAS ${dec(pick.roas)}x dari spend ${rpk(pick.spend)}. Rekomendasi bot: ${pick.rec.label}.` : "Belum ada kampanye jalan.");
  }
  if (/\bjam\b/.test(t)) {
    const h = await Q.hourly(scope, r);
    say(h.best.length ? `Jam paling cuan: ${h.best.slice(0, 3).map((x) => `**${String(x.hour).padStart(2, "0")}:00** (${rpk(x.cost!)}/hasil)`).join(", ")}.` : "Belum ada data per jam.");
  }
  if (/terlaris|produk|jasa apa/.test(t)) {
    const p = await Q.products(scope, r);
    say(p.rows.length ? "Terlaris:\n" + p.rows.slice(0, 3).map((x) => `- ${x.name}: ${nf(x.qty)} terjual, ${rpk(x.revenue)}`).join("\n") : "Belum ada penjualan.");
  }
  if (/rekomendasi|saran|harus ngapain|evaluasi/.test(t)) {
    const rs = (await Q.campaigns(scope, r)).rows.filter((c) => !["keep", "inactive"].includes(c.rec.code));
    const ex = rs.find((c) => c.rec.code === "kill") ?? rs.find((c) => c.rec.code === "scale");
    const verb = ex?.rec.code === "kill" ? "pause" : "scale";
    const hint = ex ? `\nMau dieksekusi? Tulis misal "${verb} ${ex.name.split(/[|-]/)[0].trim().toLowerCase()}".` : "";
    say(rs.length ? "Rekomendasi bot:\n" + rs.map((c) => `- **${c.rec.label}**: ${c.name}`).join("\n") + hint : "Semua kampanye aman, pertahankan dulu.");
  }
  if (!out.length) {
    say(`Ringkasnya: laba bersih ${rp(k.net)}, spend ${rpk(k.spend)}, ROAS riil ${dec(k.roas)}x.`);
    say("Gw bisa bantu: tanya angka (\"laba bulan lalu\"), pindah tampilan (\"akun jasa\"), ubah aturan (\"target roas 3\"), kontrol iklan (\"pause test kreatif\", \"rekomendasi\").");
  }
  return out.join("\n");
}

/* -------------------------------------------------------------------------- entry */

export async function handleChat(input: { message: string; history: { role: "user" | "assistant"; content: string }[]; context: ChatContext; conversationId: string }, user: User, emit: Emit) {
  try {
    if (aiMode() === "bridge") {
      const history = input.history.slice(-12).filter((m) => m.content?.trim());
      await chatViaBridge(input.message, history, input.context, user, emit, input.conversationId);
    } else if (aiConfigured()) {
      const history = input.history.slice(-12).filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam);
      // Pesan pertama harus dari user.
      while (history.length && history[0].role !== "user") history.shift();
      await chatWithClaude(input.message, history, input.context, user, emit, input.conversationId);
    } else {
      emit({ type: "text", text: await fallbackAnswer(input.message, input.context, user, emit) });
    }
  } catch (e) {
    log.error("chat gagal", { error: errMsg(e) });
    emit({ type: "error", message: e instanceof Anthropic.APIError ? "Bot AI sedang tidak bisa dihubungi, coba lagi sebentar." : errMsg(e) });
  }
  emit({ type: "done" });
}

export const chatMode = () => (aiConfigured() ? "ai" : "rules");

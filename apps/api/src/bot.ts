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
import { createAddAdsAction, createCampaignAction, createLaunchAction, findCampaigns, logRuleChange, type CampaignAction } from "./actions";
import { launchContext } from "./meta/launch";
import { AD_PRESETS, adBreakdown, diagnose, placementBreakdown } from "./analysis";
import { readMediaVision } from "./media";
import { uploadAttachment } from "./meta/upload";
import { createVideoAd } from "./creative";
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

const creativeSchemaProp = {
  type: "object",
  description:
    "Salah satu: {type:'existing', creativeId} memakai kreatif yang sudah terbukti; {type:'post', objectStoryId:'PAGEID_POSTID'} boost postingan Page; " +
    "{type:'new', imageUrl|imageHash|videoId, primaryText, headline, description?, cta} kreatif baru. " +
    "Untuk lampiran chat: pakai imageHash/videoId dari upload_media_to_meta (thumbnail video diambil otomatis dari cover atau Meta).",
  properties: {
    type: { type: "string", enum: ["existing", "post", "new"] },
    creativeId: { type: "string" }, objectStoryId: { type: "string" },
    imageHash: { type: "string" }, imageUrl: { type: "string" }, videoId: { type: "string" },
    primaryText: { type: "string", description: "Baris pertama (≤ 125 karakter) wajib thumb-stopping hook spesifik masalah/hasil; patah baris rapi; bebas klaim terlarang Meta." },
    headline: { type: "string", description: "WAJIB ≤ 40 karakter agar tidak terpotong di layar HP Feed/Reels." },
    description: { type: "string", description: "Sub-teks pendek pendukung di bawah headline (opsional, ≤ 30 karakter efektif)." },
    cta: { type: "string", enum: ["SHOP_NOW", "BUY_NOW", "LEARN_MORE", "SIGN_UP", "ORDER_NOW", "GET_OFFER", "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "WHATSAPP_MESSAGE"] },
  },
  required: ["type"],
} as const;

const adItemSchemaProp = {
  type: "object",
  properties: {
    adName: { type: "string", description: "Format: [Kreatif/Format] - [Angle Hook], mis. 'Poster V1 - Angle Hemat Waktu'" },
    creative: creativeSchemaProp,
    linkUrl: { type: "string", description: "Opsional override URL khusus variasi iklan ini" },
  },
  required: ["adName", "creative"],
} as const;

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
    name: "inspect_media",
    description:
      "LIHAT & audit visual foto atau cover frame video yang dilampirkan user di chat (baris '[Lampiran … media_id=…]'). " +
      "WAJIB dipanggil SEBELUM upload_media_to_meta dan SEBELUM menulis copy iklan agar kamu benar-benar melihat teks dalam poster/video, produk, kontras visual, " +
      "dan keamanan zona teks Reels/Stories (jangan pernah menebak isi gambar). Maksimal 4 media_id sekaligus.",
    input_schema: {
      type: "object",
      properties: {
        media_ids: { type: "array", items: { type: "string" }, description: "Daftar media_id dari baris lampiran chat (maks. 4)" },
      },
      required: ["media_ids"],
    },
  },
  {
    name: "get_launch_context",
    description:
      "Dossier spesialis merancang iklan di satu akun: Page & Instagram, pixel/dataset, ad set aktif (activeAdsets untuk injeksi kreatif baru), kreatif yang sudah ada, " +
      "top 5 iklan pemenang 30 hari (CPA/CPL terendah) & top 3 iklan paling boncos (untuk dihindari), kampanye teratas, jam konversi terbaik, " +
      "unit economics riil 30 hari (ROAS riil, ROAS impas, AOV, rekomendasi budget testing 2× CPA & budget keluar learning phase), serta hitungan profit & batas CPA impas per produk/jasa. " +
      "Panggil setelah user memilih akun.",
    input_schema: { type: "object", properties: { account_id: { type: "string" } }, required: ["account_id"] },
  },
  {
    name: "upload_media_to_meta",
    description:
      "Upload foto/video yang dilampirkan user di chat (baris '[Lampiran … media_id=…]') ke perpustakaan media akun iklan Meta. " +
      "Foto → imageHash; video → videoId (diproses Meta 1–5 menit). PENTING: panggil inspect_media LEBIH DULU sebelum tool ini karena file lokal sementara " +
      "langsung dihapus begitu Meta menerimanya. Panggil SETELAH akun dipastikan. Upload ini belum membuat iklan dan tanpa biaya.",
    input_schema: {
      type: "object",
      properties: { media_id: { type: "string", description: "media_id dari baris lampiran" }, account_id: { type: "string", description: "ID akun iklan yang DIPILIH USER" } },
      required: ["media_id", "account_id"],
    },
  },
  {
    name: "propose_launch",
    description:
      "USULKAN kampanye baru terstruktur (1 Kampanye CBO → 1 Ad Set Broad/Advantage+ → 1 hingga 5 Kreatif/Iklan sekaligus) lengkap dengan Pre-Flight Specialist Audit. " +
      "TIDAK membuat apa pun di Meta sampai user menekan 'Ya, eksekusi'. " +
      "Mendukung multi-variasi (isi array `ads` 2–5 item untuk menguji beberapa kreatif atau beberapa angle copy di dalam 1 ad set CBO yang sama tanpa memecah budget) " +
      "maupun 1 iklan tunggal (`ads:[...]` atau `creative` + `adName`). Panggil hanya setelah akun, budget harian, tujuan/produk, dan kreatif pasti.",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "ID akun yang DIPILIH USER" },
        campaignName: { type: "string", description: "Format: [Tujuan] - [Produk/Angle] - [Tanggal], mis. 'Penjualan - Timelapse AI - 26 Okt'" },
        objective: { type: "string", enum: ["sales", "leads_website", "leads_whatsapp", "traffic"], description: "sales = pembelian di website (pixel PURCHASE); leads_website = prospek di website (pixel LEAD); leads_whatsapp = chat WhatsApp; traffic = kunjungan landing page" },
        dailyBudget: { type: "integer", description: "Budget harian kampanye dalam Rupiah (bulat). Harus sesuai yang user sebut/setujui." },
        pageId: { type: "string" },
        instagramUserId: { type: "string", description: "Opsional, supaya tayang di Instagram atas nama akun IG brand" },
        pixelId: { type: "string", description: "Wajib untuk sales & leads_website" },
        linkUrl: { type: "string", description: "Landing page/halaman produk utama (https://...). Wajib kecuali leads_whatsapp atau memakai kreatif/post yang sudah ada" },
        autoUtm: { type: "boolean", description: "true (disarankan untuk sales/leads_website/traffic) = otomatis sisipkan parameter utm_source=meta&utm_medium=paid_social&utm_campaign=...&utm_content=... per iklan" },
        targeting: {
          type: "object",
          properties: {
            countries: { type: "array", items: { type: "string" }, description: "Kode negara ISO, default ['ID']" },
            ageMin: { type: "integer" }, ageMax: { type: "integer" },
            genders: { type: "string", enum: ["all", "male", "female"] },
          },
        },
        ads: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          description: "Daftar 1–5 variasi iklan di dalam 1 ad set CBO ini (direkomendasikan untuk multi-foto/video atau A/B testing 2–3 angle copy memakai imageHash/videoId yang sama).",
          items: adItemSchemaProp,
        },
        creative: creativeSchemaProp,
        adName: { type: "string", description: "Nama iklan (dipakai jika tidak mengirim array `ads`)" },
        startNow: { type: "boolean", description: "true = langsung tayang setelah dikonfirmasi (default); false = simpan sebagai draft di Ads Manager" },
        rationale: { type: "string", description: "Alasan strategi media buying, pemilihan angle, & hitungan unit economics (ditampilkan di kartu)" },
      },
      required: ["accountId", "campaignName", "objective", "dailyBudget", "pageId"],
    },
  },
  {
    name: "propose_add_ads",
    description:
      "USULKAN penambahan 1–5 iklan/kreatif baru langsung ke dalam kampanye & ad set yang SUDAH ADA (mis. menyegarkan kampanye pemenang yang mulai creative fatigue, " +
      "atau menguji kreatif/angle baru tanpa membuat kampanye baru yang memecah budget & mereset learning phase). TIDAK membuat apa pun di Meta sampai user mengonfirmasi.",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "ID akun yang DIPILIH USER" },
        campaignId: { type: "string", description: "ID kampanye aktif tujuan (dari get_launch_context / get_campaigns)" },
        adsetId: { type: "string", description: "ID ad set tujuan (dari activeAdsets di get_launch_context). Kosongkan agar otomatis memakai ad set aktif utama di kampanye itu." },
        objective: { type: "string", enum: ["sales", "leads_website", "leads_whatsapp", "traffic"] },
        pageId: { type: "string" },
        instagramUserId: { type: "string" },
        linkUrl: { type: "string", description: "Landing page/halaman produk (https://...), wajib bila memakai kreatif baru non-WhatsApp" },
        autoUtm: { type: "boolean", description: "true = otomatis tambahkan UTM per variasi iklan" },
        ads: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          description: "1–5 variasi iklan baru yang akan disuntikkan ke ad set tujuan",
          items: adItemSchemaProp,
        },
        startNow: { type: "boolean", description: "true = langsung aktifkan iklan baru setelah dikonfirmasi (default); false = simpan draft di ad set" },
        rationale: { type: "string", description: "Alasan injeksi ke kampanye ini & perbedaan angle dibanding iklan lama" },
      },
      required: ["accountId", "campaignId", "objective", "pageId", "ads"],
    },
  },
  {
    name: "create_video_ad",
    description:
      "BUAT video iklan 9:16 (suara narasi + subtitle + teks animasi + harga + CTA) dari foto/video lampiran user, SEKALIGUS rencana kampanyenya. " +
      "Video dirender di server (±2–3 menit) lalu tampil sebagai kartu pratinjau di chat. TIDAK ada yang dikirim ke Meta sampai user menonton " +
      "dan menekan 'Setujui & iklankan'; setelah itu sistem mengupload video dan membuat + menayangkan kampanye sesuai rencana di sini. " +
      "Panggil hanya setelah akun, produk, tujuan, dan budget harian jelas, dan setelah get_launch_context (untuk Page, pixel, link, harga produk).",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "ID akun yang DIPILIH USER" },
        hook: { type: "string", description: "Teks besar 0–3 dtk pertama, ≤ 40 karakter, spesifik ke masalah/hasil" },
        bullets: { type: "array", items: { type: "string" }, description: "0–3 manfaat singkat (≤ 30 karakter) yang tampil bergantian" },
        priceBadge: { type: "string", description: "Mis. 'Rp49rb'. HARUS sama dengan harga produk dari get_launch_context; kosongkan kalau tidak yakin" },
        cta: { type: "string", description: "Ajakan di kartu penutup, mis. 'Klik link di bawah'" },
        ctaSub: { type: "string", description: "Baris kecil di bawah CTA (opsional)" },
        script: { type: "string", description: "Naskah voice over Bahasa Indonesia santai, 15–30 dtk diucapkan (±40–75 kata): hook → manfaat → bukti → CTA. Tulis angka dengan huruf (\"empat puluh sembilan ribu\")" },
        mediaIds: { type: "array", items: { type: "string" }, description: "media_id foto/video lampiran user, urut sesuai adegan (1–6)" },
        logoMediaId: { type: "string", description: "media_id logo PNG kalau user melampirkannya" },
        brandName: { type: "string" },
        campaign: {
          type: "object",
          description: "Rencana kampanye yang dijalankan saat user menyetujui video (aturan sama dengan propose_launch).",
          properties: {
            campaignName: { type: "string" },
            objective: { type: "string", enum: ["sales", "leads_website", "leads_whatsapp", "traffic"] },
            dailyBudget: { type: "integer", description: "Rupiah/hari, sesuai yang user sebut" },
            pageId: { type: "string" }, instagramUserId: { type: "string" }, pixelId: { type: "string" }, linkUrl: { type: "string" },
            targeting: { type: "object", properties: { countries: { type: "array", items: { type: "string" } }, ageMin: { type: "integer" }, ageMax: { type: "integer" }, genders: { type: "string", enum: ["all", "male", "female"] } } },
            primaryText: { type: "string", description: "Teks utama iklan di atas video" },
            headline: { type: "string", description: "≤ 40 karakter" },
            description: { type: "string" },
            metaCta: { type: "string", enum: ["SHOP_NOW", "BUY_NOW", "LEARN_MORE", "SIGN_UP", "ORDER_NOW", "GET_OFFER", "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "WHATSAPP_MESSAGE"] },
            adName: { type: "string" },
            startNow: { type: "boolean", description: "true = langsung tayang setelah disetujui (default); false = draft" },
            rationale: { type: "string" },
          },
          required: ["campaignName", "objective", "dailyBudget", "pageId", "primaryText", "headline", "adName"],
        },
      },
      required: ["accountId", "hook", "cta", "script", "mediaIds", "campaign"],
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
  if (name === "inspect_media") {
    const rawIds = Array.isArray(input.media_ids) ? input.media_ids.map(String).slice(0, 4) : [];
    if (!rawIds.length) return { error: "Berikan minimal 1 media_id di media_ids." };
    const inspected: Record<string, unknown>[] = [];
    const __images: { mimeType: "image/jpeg" | "image/png"; data: string }[] = [];
    for (const id of rawIds) {
      const v = await readMediaVision(id, user.id);
      if (!v) {
        inspected.push({ media_id: id, found: false, note: "Lampiran tidak ditemukan atau sudah kedaluwarsa." });
        continue;
      }
      if (v.data && v.mimeType) {
        __images.push({ mimeType: v.mimeType, data: v.data });
        inspected.push({
          media_id: id, found: true, kind: v.info.kind, name: v.info.name,
          sizeMb: Math.round((v.info.size / 1048576) * 10) / 10,
          visionSource: v.source, imageIndex: __images.length,
        });
      } else {
        inspected.push({
          media_id: id, found: true, kind: v.info.kind, name: v.info.name,
          sizeMb: Math.round((v.info.size / 1048576) * 10) / 10,
          visionSource: "none", note: v.note,
        });
      }
    }
    return {
      inspected,
      checklist: [
        "Baca seluruh teks/angka/harga yang tertulis di dalam gambar atau frame pembuka video.",
        "Nilai kekuatan visual hook 3 detik pertama, kontras warna, dan kejelasan subjek produk/hasil.",
        "Cek keamanan safe zone vertikal 9:16 Reels/Stories (area atas 14% dan bawah 35% rawan tertutup UI IG/FB).",
        "Pastikan primaryText & headline melengkapi visual (jangan menyalin mentah kalimat besar yang sudah ada di poster).",
      ],
      ...(__images.length ? { __images } : {}),
    };
  }
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
      const audit = (action.params as any)?.audit ?? [];
      return {
        ok: true, pendingActionId: action.id, audit,
        note: "Kartu rencana kampanye sudah tampil beserta hasil Pre-Flight Audit. Iklan BELUM dibuat. Sampaikan ringkasan strategi, unit economics, dan peringatan audit (jika ada level 'warn'), lalu minta user menekan 'Ya, eksekusi'. Jangan bilang iklan sudah tayang.",
      };
    }
    case "propose_add_ads": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh membuat iklan" };
      const action = await createAddAdsAction(input, user.id, input.rationale);
      emit({ type: "action_card", action });
      const p = action.params as any;
      return {
        ok: true, pendingActionId: action.id, campaignName: p.campaignName, adsetId: p.adsetId, adsetName: p.adsetName, audit: p.audit ?? [],
        note: "Kartu penambahan iklan baru ke kampanye eksisting sudah tampil. Iklan BELUM dibuat di Meta sampai user menekan 'Ya, eksekusi'.",
      };
    }
    case "create_video_ad": {
      if (user.role !== "owner") return { error: "Hanya owner yang boleh membuat iklan" };
      const { runId } = await createVideoAd(input, user.id);
      emit({ type: "video_card", runId });
      return {
        ok: true, runId,
        note: "Kartu video sudah tampil dan sedang dirender (±2–3 menit). Video BELUM dikirim ke Meta. Bilang ke user: tonton dulu di kartu, " +
          "lalu tekan 'Setujui & iklankan' kalau sudah oke (kampanye dibuat & tayang sesuai rencana), atau 'Buang' lalu minta revisi. Jangan bilang iklan sudah tayang.",
      };
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
  return `Kamu "Bot Iklan": konsultan performance marketing senior, Direct-Response Creative Strategist, & Meta Ads Specialist kelas atas (10+ tahun, kelola ratusan miliar spend direct response di Indonesia) untuk owner bisnis Produk Digital AI (jualan otomatis di lynk.id) dan Jasa AI (closing manual lewat WhatsApp).
Kamu dibayar untuk keputusan yang menghasilkan laba bersih nyata, bukan sekadar metrik vanity atau laporan angka. Berpikir seperti media buyer elit + creative director + analis unit economics sekaligus: tajam, jujur, berbasis data, patuh kebijakan Meta, tegas memberi rekomendasi, dan selalu menjelaskan "kenapa".

Gaya & Aturan Format (WAJIB):
- Bahasa Indonesia santai profesional (gw/lo), padat, angka dulu baru penjelasan. Format uang ringkas seperti Rp1,2 jt / Rp450 rb.
- DILARANG menggunakan emoji di seluruh teks jawaban maupun di copy iklan kecuali diminta eksplisit oleh user. Gunakan tipografi markdown yang bersih (tebal, subjudul, poin, tabel ringkas).
- Buka setiap jawaban dengan 1 kalimat kesimpulan utama yang **ditebalkan** (jawab intinya langsung).
- Pakai subjudul (### ) bila ada beberapa bagian, poin untuk temuan, dan langkah bernomor untuk eksekusi.
- Tabel markdown hanya untuk perbandingan ringkas (maks. 5 baris) yang belum tampil di widget.
- Tool get_summary, get_campaigns, get_hourly, get_products, get_pl OTOMATIS menampilkan widget visual. Jangan menyalin ulang semua angkanya; angkat 2–3 angka penentu keputusan lalu bedah insight & tindakannya.
- Untuk evaluasi/"kenapa", pakai alur: **Kesimpulan** → ### Diagnosa (angka + perbandingan) → ### Akar Masalah (fakta vs hipotesis) → ### Eksekusi Prioritas (urut dampak laba terbesar: apa, berapa, kapan) → ### Metrik Pantau. Tutup dengan "Keyakinan: tinggi/sedang/rendah" + alasan ukuran sampel.

Prinsip Data & Kejujuran Finansial:
- Selalu ambil angka lewat tools; dilarang mengarang angka, benchmark, pixel ID, Page ID, atau hash media. Sebut akun & periode yang dipakai.
- Pisahkan FAKTA (dari data) dan HIPOTESIS (dugaan yang perlu diuji).
- Bandingkan dengan baseline akun sendiri (periode sebelumnya & baseline 90 hari dari diagnose_performance) sebelum menyebut patokan umum industri.
- Bedakan ROAS riil (omzet lynk.id/pencatatan riil ÷ spend) dan ROAS Meta (pixel atribusi 7d click/1d view). Semua keputusan scale/kill mengacu ke ROAS riil & laba bersih:
  Laba bersih = omzet − fee platform − HPP − spend − PPN iklan − biaya tetap prorata − biaya lain.
- Disiplin signifikansi data: < 3 hari tayang, < ~10 konversi, atau spend < 1–2× target CPA adalah sinyal awal; jangan ambil keputusan panik kecuali sudah tembus batas kill spend akun tanpa hasil.

Kerangka Analisis Funnel (urut, jangan loncat):
1. Validitas tracking: cek sinkron terakhir & selisih ROAS Meta vs riil (masalah pixel/CAPI vs masalah iklan).
2. Unit economics: bandingkan ROAS riil terhadap ROAS impas & target; CPA (termasuk PPN iklan) terhadap CPA maks impas; untuk Jasa: CPL ÷ closing rate = CAC riil vs margin kotor per klien.
3. Dekomposisi funnel (biaya per hasil = CPM ÷ (1000 × CTR × CVR)) lewat diagnose_performance:
   - CPM melonjak → kompetisi lelang/musim (Q4, payday, Ramadan), audiens sempit, atau relevansi kreatif turun.
   - CPM sangat murah + impresi meledak tanpa hasil → cek get_placement_breakdown (biasanya bocor di Audience Network / placement berbiaya murah berkualitas rendah).
   - CTR tautan lemah (< 1% patokan umum feed/reels) atau turun di paruh akhir periode → visual/hook 3 detik gagal menghentikan jempol atau creative fatigue (frekuensi jenuh).
   - CTR bagus tapi CVR jeblok → friksi pasca-klik: kecepatan landing page (landing rate < 70%), ketidakcocokan janji iklan vs isi halaman lynk.id, harga/penawaran kurang menggigit, atau respons admin WhatsApp lambat (> 5 menit).
4. Audit level kreatif (get_ad_breakdown): identifikasi iklan mana yang memonopoli spend di CBO vs yang benar-benar mencetak CPA termurah, cek video hold 25% & ThruPlay.

======================================================================
HARNESS SPESIALIS PEMBUATAN IKLAN META (ERA ALGORITMA ANDROMEDA)
======================================================================

Di era Meta Andromeda, **kreatif adalah targeting**: algoritma membaca teks, visual, dan pola interaksi tiap iklan untuk mencari pembeli yang tepat. Tugasmu bukan sekadar "mengisi form iklan", melainkan merancang mesin konversi yang menguntungkan sejak hari pertama.

Alur Wajib Membuat / Menambah Iklan (JANGAN LONCAT):
1. **Inspeksi Visual Lebih Dulu (WAJIB bila ada lampiran)**:
   - Setiap kali pesan user memuat "[Lampiran foto|video · media_id=…]", panggil **inspect_media** SEBELUM upload_media_to_meta (karena upload ke Meta akan menghapus file sementara di server) dan SEBELUM menulis copy.
   - Lihat isi gambar/cover video secara nyata: baca headline di poster, warna, ekspresi/objek, bukti hasil, serta cek apakah ada teks penting yang rawan tertutup UI Reels/Stories (14% atas & 35% bawah). Beri review jujur 2–3 poin ke user (apa yang sudah kuat di visualnya dan apa yang perlu diperkuat lewat copy).
2. **Pastikan Akun & Parameter Inti**:
   - Kalau user belum menunjuk akun secara eksplisit, panggil list_ad_accounts lalu TANYA akun mana. Dilarang memilih akun sendiri.
   - Pastikan jelas: produk/jasa yang dijual, tujuan optimasi, dan budget HARIAN (Rupiah). Bila ada yang belum disebut user, tanyakan sekaligus dengan ringkas beserta rekomendasi angka berbasis unit economics (jangan mengarang budget).
3. **Bedah Dossier Akun (get_launch_context)**:
   - Wajib panggil get_launch_context(account_id). Pelajari sekaligus:
     a) products: harga jual, profitBeforeAds (margin bersih per order sebelum iklan), maxBreakEvenCpa (batas CPA impas setelah PPN iklan), dan breakEvenRoas. Cocokkan harga & URL persis dari sini!
     b) winningAds30d & bleedingAds30d: pelajari pola nama/angle kreatif yang terbukti menghasilkan CPA/CPL termurah di akun ini, dan hindari mengulang pola iklan yang boncos tanpa hasil.
     c) activeAdsets & topCampaigns30d: cek apakah sudah ada kampanye aktif untuk produk/tujuan yang sama.
     d) unitEconomics30d & bestHours30d: cek recommendedTestingDailyBudget (≈ 2× target CPA) dan jam konversi terbaik.
4. **Pilih Arsitektur Kampanye yang Tepat (Konsolidasi vs Injeksi)**:
   - **Opsi A — Kampanye Baru (propose_launch)**: Gunakan 1 Kampanye CBO (LOWEST_COST_WITHOUT_CAP) + 1 Ad Set Broad/Advantage+ Audience & Placements (negara ID, usia 18–65 kecuali produk spesifik menuntut rentang usia/gender tertentu; dilarang mengarang interest sempit). Aktifkan autoUtm: true untuk semua iklan website (sales, leads_website, traffic).
   - **Opsi B — Suntik ke Kampanye Pemenang (propose_add_ads)**: Jika di akun sudah ada kampanye aktif dengan tujuan & produk yang sama yang sedang jalan (atau mulai creative fatigue) dan user ingin menambah materi kreatif baru tanpa menambah budget kampanye baru, sarankan propose_add_ads ke kampanye/ad set aktif tersebut agar budget tidak terpecah dan histori optimasi terjaga.
   - **Strategi Multi-Variasi (ads 2–5 item dalam 1 Ad Set)**:
     - Bila user melampirkan 2–5 foto/video kreatif (dan bukan meminta render 1 video gabungan): gabungkan semuanya dalam 1 ad set CBO (ads: [...]), JANGAN pecah jadi banyak kampanye/ad set.
     - Bila user hanya melampirkan 1 foto/video dan budget harian ≥ 1,5–2× target CPA: rekomendasikan (atau langsung susun dalam ads: [...] memakai imageHash/videoId yang sama) **2–3 variasi sudut pandang copy (A/B Angle Testing)** agar algoritma Meta menguji pesan mana yang menghasilkan CTR & CVR tertinggi:
       * **Angle 1 (Pain-Agitation-Solution)**: tembak masalah/kebocoran waktu atau biaya paling menyakitkan → perlihatkan konsekuensinya → hadirkan produk sebagai jalan pintas logis.
       * **Angle 2 (Outcome & Mekanisme Konkret)**: buka dengan hasil spesifik & kecepatan kerja (mis. dari 3 jam jadi 10 menit) → jelaskan isi/cara kerjanya yang praktis → bukti/angka nyata.
       * **Angle 3 (Direct Offer / Value Stack)**: langsung ke nilai paket lengkap vs harganya yang jauh lebih hemat dibanding cara manual/kompetitor → hilangkan keraguan teknis → ajakan bertindak.
5. **Standar Direct-Response Copywriting Kelas Spesialis**:
   - **Sinergi Visual + Teks**: Jangan mengulang persis kalimat besar yang sudah tertulis di poster menjadi baris pertama primaryText. Jika poster sudah berteriak tentang nama produk/diskon, buka primaryText dengan masalah tajam atau skenario nyata yang membuat orang merasa relevan.
   - **125 Karakter Pertama (Wajib Kuat Sebelum '...Lihat Selengkapnya')**: Kalimat pembuka harus langsung menghentikan scroll—sebut masalah spesifik, angka penghematan waktu/biaya, atau hasil terukur. Dilarang membuka dengan basa-basi lemah ("Halo teman-teman", "Di era digital sekarang...", "Bingung cari...").
   - **Rasio Spasi & Keterbacaan Mobile**: Paragraf pendek 1–2 kalimat, pisahkan dengan baris kosong agar nyaman dibaca cepat di layar HP.
   - **Psikologi Konversi per Lini Bisnis**:
     * **Produk Digital AI (lynk.id → tujuan sales, CTA SHOP_NOW / GET_OFFER)**: Pembeli produk digital Indonesia butuh kepastian instan & anti-ribet. Jelaskan eksplisit: apa saja yang didapat, cocok untuk pemula/tanpa coding/tanpa tool berbayar mahal (bila relevan), akses otomatis langsung terkirim begitu pembayaran selesai, dan cantumkan harga asli (untuk produk impulse buy ≤ Rp150 rb, menyebut harga di copy menyaring klik penasaran dan mendongkrak CVR checkout).
     * **Jasa AI (leads_whatsapp → tujuan leads_whatsapp, CTA WHATSAPP_MESSAGE)**: Masalah terbesar iklan WhatsApp adalah banjir chat iseng yang tidak beli (low-intent leads). Tulis copy yang **mengkualifikasi prospek**: sebutkan untuk siapa jasa ini cocok, estimasi pengerjaan, dan price anchor jujur (mis. "Paket mulai Rp..." bila datanya ada di products) supaya yang klik tombol WhatsApp sudah siap budget. Selalu ingatkan owner/CS untuk membalas < 5 menit.
   - **Headline Mobile (≤ 40 karakter)**: Wajib padat ≤ 40 karakter agar tidak terpotong "..." di HP. Isi dengan proposisi nilai terkuat + pemicu aksi (mis. "Akses Instan Paket Prompt AI — Rp49rb" atau "Jasa Video Promosi AI Siap Pakai").
6. **Audit Kepatuhan Kebijakan Meta Ads & Unit Economics Sebelum Propose**:
   - **Anti-Reject / Anti-Restrict**: DILARANG menunjuk kondisi pribadi/keuangan/fisik audiens secara langsung (Personal Attributes: contoh terlarang "Buat kamu yang lagi boncos/miskin/nganggur/gemuk"). Ubah ke fokus masalah objektif ("Banyak pengiklan pemula membakar budget di minggu pertama karena..."). DILARANG menjanjikan penghasilan/keuntungan pasti ("dijamin cuan", "auto kaya", "pasti balik modal 100%").
   - Upload media lewat upload_media_to_meta(media_id, account_id) setelah akun dikonfirmasi dan setelah inspect_media.
   - Panggil propose_launch atau propose_add_ads. Periksa field audit pada hasil tool; sampaikan ke user hitungan singkat: **Harga produk → Margin sebelum iklan → Batas CPA Impas → Target CPA/ROAS → Estimasi konversi harian dari budget yang dipilih**, lalu arahkan user memeriksa kartu konfirmasi dan menekan **"Ya, eksekusi sekarang"**. JANGAN pernah mengklaim iklan sudah tayang sebelum user mengonfirmasi kartu.

Membuat VIDEO Iklan Render Server (user meminta "bikinin video", "buatkan video iklan", dsb.):
- Butuh minimal 1 foto/video lampiran sebagai bahan visual. Bila belum ada, minta user melampirkan 1–6 foto/video.
- Panggil inspect_media dulu untuk melihat urutan adegan visual terbaik dari lampiran user, lalu jalankan pemeriksaan akun & get_launch_context.
- Susun: hook ≤ 40 karakter, 0–3 bullets ≤ 30 karakter, script voice over 15–30 detik (±40–75 kata, alur Hook → Mekanisme/Manfaat → Bukti → CTA, semua angka ditulis dengan huruf agar pelafalan TTS mulus), priceBadge (HANYA dari harga asli di get_launch_context), serta copy kampanye Meta (primaryText, headline ≤ 40 karakter, metaCta).
- Panggil create_video_ad sekali (jangan panggil upload_media_to_meta / propose_launch manual untuk alur ini). Minta user menonton pratinjau video di kartu lalu menekan **"Setujui & iklankan"**.

Kontrol Kampanye Eksisting:
- Pause / aktifkan / scale: panggil propose_campaign_action (hanya menampilkan kartu konfirmasi). Scale vertikal ideal 20–30% per 2–3 hari pada kampanye yang sudah stabil di atas target ROAS / di bawah batas CPA.
- Pindah tampilan periode/akun: panggil set_view.
- Akhiri jawaban dengan maksimal 1 tawaran langkah lanjut yang tajam dan bernilai tinggi.

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

  for (let step = 0; step < 10; step++) {
    const stream = anthropic().messages.stream({
      model: env.CLAUDE_MODEL,
      max_tokens: 4096,
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
      const imgs = Array.isArray((out as any)?.__images) ? ((out as any).__images as { mimeType: "image/jpeg" | "image/png"; data: string }[]) : [];
      const clean = imgs.length && out && typeof out === "object"
        ? Object.fromEntries(Object.entries(out as Record<string, unknown>).filter(([k]) => k !== "__images"))
        : out;
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: imgs.length
          ? [
              ...imgs.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } })),
              { type: "text" as const, text: JSON.stringify(clean) },
            ]
          : JSON.stringify(clean),
      });
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

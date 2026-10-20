// Bot AI: Claude + tool calling (streaming), dengan jawaban cadangan berbasis aturan kalau API key belum diisi.
// Model hanya bisa MENGUSULKAN aksi kampanye; eksekusi lewat endpoint konfirmasi (lihat actions.ts).
import Anthropic from "@anthropic-ai/sdk";
import {
  type ChatEvent, type User, PRESETS, LINES, fmtRange, rp, rpk, dec, pct, nf,
} from "@iklan/shared";
import { env, aiConfigured } from "./env";
import { sql, bumpDataVersion } from "./db";
import { loadConfig, resolveRange, resolveScope, type Config } from "./scope";
import * as Q from "./queries";
import { createCampaignAction, findCampaigns, logRuleChange, type CampaignAction } from "./actions";
import { errMsg, log } from "./log";

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

const TOOLS: Anthropic.Tool[] = [
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
];

function scopeAndRange(input: any, ctx: ChatContext, cfg: Config) {
  const scope = resolveScope(input.account || ctx.acc, cfg);
  const r = input.preset ? resolveRange(undefined, undefined, input.preset) : resolveRange(input.from || ctx.from, input.to || ctx.to);
  return { scope, r };
}
const label = (scope: { acc: string }, cfg: Config) =>
  scope.acc === "all" ? "Semua akun" : scope.acc === "digital" ? "Akun Produk Digital" : scope.acc === "jasa" ? "Akun Jasa" : cfg.accounts.find((a) => a.id === scope.acc)?.name;

function slimKpis(k: any) {
  const keys = ["spend", "adTax", "revenue", "orders", "net", "netMargin", "roas", "metaRoas", "beRoas", "cpa", "maxCpaBE", "leads", "cpl", "closeRate", "ctr", "cpc", "aov", "fixed", "other"];
  return Object.fromEntries(keys.map((x) => [x, typeof k[x] === "number" ? Math.round(k[x] * 1000) / 1000 : k[x]]));
}

async function runTool(name: string, input: any, ctx: ChatContext, user: User, emit: Emit): Promise<unknown> {
  const cfg = await loadConfig();
  switch (name) {
    case "get_summary": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const s = await Q.summaryFor(scope, r, cfg);
      return { scope: label(scope, cfg), period: fmtRange(r.from, r.to), compare: fmtRange(r.prevFrom, r.prevTo), now: slimKpis(s.kpis), previous: slimKpis(s.prev) };
    }
    case "get_campaigns": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const c = await Q.campaigns(scope, r);
      const rows = [...c.rows];
      if (input.sort === "roas_desc") rows.sort((a, b) => b.roas - a.roas);
      if (input.sort === "roas_asc") rows.sort((a, b) => (a.spend > 0 ? a.roas : 99) - (b.spend > 0 ? b.roas : 99));
      if (input.sort === "cpa_desc") rows.sort((a, b) => (b.cpa ?? 1e12) - (a.cpa ?? 1e12));
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
      const fmt = (x: any) => ({ hour: `${String(x.hour).padStart(2, "0")}:00`, spend: x.spend, results: x.results, costPerResult: x.cost && Math.round(x.cost) });
      return { metric: h.metric, best: h.best.map(fmt), worst: h.worst.map(fmt) };
    }
    case "get_products": {
      const { scope, r } = scopeAndRange(input, ctx, cfg);
      const p = await Q.products(scope, r);
      return { period: fmtRange(r.from, r.to), total: p.total, top: p.rows.slice(0, 10).map((x) => ({ name: x.name, line: x.line, qty: x.qty, revenue: x.revenue, share: Math.round(x.share * 1000) / 10 })) };
    }
    case "get_pl": {
      const r = input.preset ? resolveRange(undefined, undefined, input.preset) : resolveRange(input.from || ctx.from, input.to || ctx.to);
      const p = await Q.pl(r, cfg);
      return { period: fmtRange(r.from, r.to), lines: p.columns.map((c) => ({ line: c.label, ...slimKpis(c.kpis), gross: Math.round(c.kpis.gross), prevNet: c.prevNet })) };
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
      let campaignId: string | undefined = input.campaign_id;
      if (!campaignId) {
        let cands = await findCampaigns(input.campaign_query ?? "", scope.accountIds);
        if (!cands.length) cands = await findCampaigns(input.campaign_query ?? "", cfg.accounts.map((a) => a.id));
        if (!cands.length) return { error: "Kampanye tidak ditemukan. Minta user menyebut sebagian nama kampanye." };
        const top = cands.filter((x) => Math.floor(x.score) === Math.floor(cands[0].score));
        if (top.length > 1) return { ambiguous: true, candidates: top.slice(0, 8).map((x) => ({ id: x.id, name: x.name, account: x.account_name, status: x.status })) };
        campaignId = cands[0].id;
      }
      const action = await createCampaignAction({ campaignId: campaignId!, action: input.action as CampaignAction, pct: input.pct, source: "chat", userId: user.id, reason: input.reason });
      emit({ type: "action_card", action });
      return { ok: true, pendingActionId: action.id, note: "Kartu konfirmasi sudah tampil. User harus menekan 'Ya, eksekusi'. Jangan bilang sudah dieksekusi." };
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
  return `Kamu "Bot Iklan", analis iklan Meta untuk owner bisnis Produk Digital AI (jualan di lynk.id) dan Jasa AI (closing manual).
Gaya: Bahasa Indonesia santai (gw/lo), singkat, angka dulu baru penjelasan. Format uang seperti Rp1,2 jt / Rp450 rb. Pakai daftar pendek kalau perlu, tanpa tabel.

Prinsip:
- Selalu ambil angka lewat tools, jangan mengarang. Sebut akun & periode yang dipakai.
- Bedakan ROAS riil (omzet lynk.id/input manual ÷ spend) dan ROAS Meta (pixel). ROAS per kampanye jasa adalah estimasi dari leads.
- Laba bersih = omzet − fee − HPP − spend − PPN iklan − biaya tetap prorata − biaya lain.
- Rekomendasi: Matikan kalau spend ≥ batas spend dan CPA/CPL lewat batas; Scale kalau ROAS ≥ 1,3× target; Ganti kreatif kalau ROAS < target (digital) atau CPL lewat batas (jasa). Periode 1 hari = sinyal awal saja.
- Untuk pause/aktifkan/scale, panggil propose_campaign_action. Itu hanya membuat kartu konfirmasi; JANGAN pernah bilang aksi sudah dijalankan. Minta user menekan tombol konfirmasi.
- Kalau user minta pindah akun/periode, panggil set_view.

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
      max_tokens: 900,
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
    if (aiConfigured()) {
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

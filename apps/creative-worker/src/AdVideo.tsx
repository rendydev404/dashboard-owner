// Template iklan Direct-Response Interaktif 9:16 (Meta Reels / Stories / TikTok).
// Merender simulasi UI interaktif (live typing, live efficiency counter, auto-checked feature list,
// price drop badge, karaoke word captions, dan animated cursor click) + efek suara UI (SFX) terintegrasi.
import { useMemo } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { activeWord, groupWords, pageAt } from "./captions";
import { END_CARD_SEC, type AdProps } from "./schema";

const FONT = '"Inter", "Segoe UI", "Noto Sans", Arial, sans-serif';

/** Buat efek suara UI (pop, click, chime) dalam format data URI WAV mono 24kHz agar video terasa hidup & interaktif. */
function buildUiSfxDataUri(durationSec: number, bulletCount: number, hasPrice: boolean, mainSec: number): string {
  const rate = 24000;
  const totalSamples = Math.max(1, Math.round(durationSec * rate));
  const byteLen = 44 + totalSamples * 2;
  const bytes = new Uint8Array(byteLen);
  const view = new DataView(bytes.buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, totalSamples * 2, true);

  const addTone = (atSec: number, lenSec: number, fStart: number, fEnd: number, amp: number) => {
    const start = Math.max(0, Math.round(atSec * rate));
    const end = Math.min(totalSamples, Math.round((atSec + lenSec) * rate));
    const span = Math.max(1, end - start);
    for (let i = start; i < end; i++) {
      const p = (i - start) / span;
      const env = Math.sin(Math.PI * p) * Math.pow(1 - p, 1.4);
      const freq = fStart + (fEnd - fStart) * p;
      const val = Math.sin((2 * Math.PI * freq * (i - start)) / rate) * env * amp;
      const cur = view.getInt16(44 + i * 2, true) / 32767;
      const mixed = Math.max(-0.95, Math.min(0.95, cur + val));
      view.setInt16(44 + i * 2, Math.round(mixed * 32767), true);
    }
  };

  // 1. Hook pop-in (0.12s) + tombol klik AI (2.1s)
  addTone(0.12, 0.09, 320, 680, 0.22);
  addTone(2.05, 0.07, 750, 420, 0.20);
  addTone(2.13, 0.14, 520, 880, 0.22);

  // 2. Suara centang (pop) untuk tiap bullet (mulai 3.45s)
  for (let b = 0; b < bulletCount; b++) {
    const t = 3.45 + b * 0.46;
    if (t < mainSec - 0.5) {
      addTone(t, 0.08, 440, 880, 0.20);
    }
  }

  // 3. Chime saat badge harga muncul (48% mainSec)
  if (hasPrice) {
    const pt = mainSec * 0.48;
    addTone(pt, 0.12, 587, 587, 0.18);
    addTone(pt + 0.09, 0.18, 880, 880, 0.22);
  }

  // 4. Klik kursor pada End Card CTA
  addTone(mainSec + 0.55, 0.06, 800, 380, 0.24);
  addTone(mainSec + 0.62, 0.16, 660, 990, 0.22);

  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** Latar interaktif: menampilkan visual produk di dalam jendela preview dinamis dengan gerakan kamera aktif. */
function SceneCard({ kind, src, frames, index }: { kind: "image" | "video"; src: string; frames: number; index: number }) {
  const f = useCurrentFrame();
  const fade = interpolate(f, [0, 7, Math.max(8, frames - 7), Math.max(9, frames)], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const zoom = interpolate(f, [0, frames], index % 2 === 0 ? [1.0, 1.12] : [1.12, 1.0], { extrapolateRight: "clamp" });
  const panY = interpolate(f, [0, frames], index % 2 === 0 ? [12, -16] : [-16, 12], { extrapolateRight: "clamp" });
  const fill = { width: "100%", height: "100%", objectFit: "cover" as const };
  return (
    <AbsoluteFill style={{ opacity: fade, overflow: "hidden" }}>
      {kind === "image" ? (
        <Img src={src} style={{ ...fill, transform: `scale(${zoom}) translateY(${panY}px)` }} />
      ) : (
        <OffthreadVideo src={src} muted style={fill} />
      )}
    </AbsoluteFill>
  );
}

function Backdrop({ props, mainFrames }: { props: AdProps; mainFrames: number }) {
  const total = props.scenes.reduce((s, x) => s + x.weight, 0);
  let at = 0;
  return (
    <>
      {props.scenes.map((s, i) => {
        const frames = i === props.scenes.length - 1 ? mainFrames - at : Math.round((s.weight / total) * mainFrames);
        const from = at;
        at += frames;
        const dur = frames + (i ? 7 : 0);
        return (
          <Sequence key={i} from={Math.max(0, from - (i ? 7 : 0))} durationInFrames={dur}>
            <SceneCard kind={s.kind} src={s.src} frames={dur} index={i} />
          </Sequence>
        );
      })}
    </>
  );
}

/** Header atas: Progress bar retensi + Indikator Live Step. */
function TopTelemetryBar({ brandName, accent, mainFrames }: { brandName: string; accent: string; mainFrames: number }) {
  const f = useCurrentFrame();
  const pct = Math.min(100, Math.max(0, (f / Math.max(1, mainFrames)) * 100));
  const stepLabel = f < mainFrames * 0.28 ? "01 · MASALAH & HOOK" : f < mainFrames * 0.62 ? "02 · DEMO SISTEM AI" : "03 · PENAWARAN AKSES";

  return (
    <div style={{ position: "absolute", top: 48, left: 48, right: 48, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ width: "100%", height: 10, background: "rgba(255,255,255,0.18)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: accent, borderRadius: 999 }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            background: "#0b0f19",
            border: "2px solid rgba(255,255,255,0.22)",
            padding: "10px 22px",
            borderRadius: 999,
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 24,
            color: "#ffffff",
            letterSpacing: 1.2,
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: 999, background: "#22c55e", display: "inline-block" }} />
          {brandName}
        </div>
        <div
          style={{
            background: "#0b0f19",
            border: `2px solid ${accent}`,
            color: accent,
            padding: "10px 22px",
            borderRadius: 999,
            fontFamily: FONT,
            fontWeight: 900,
            fontSize: 22,
            letterSpacing: 1.5,
          }}
        >
          {stepLabel}
        </div>
      </div>
    </div>
  );
}

/** Fase 1 (0 - 3.3 dtk): Simulasi Prompt Typing Interaktif + Klik Tombol Eksekusi AI. */
function InteractiveHookPrompt({ text, accent }: { text: string; accent: string }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: f, fps, config: { damping: 12, stiffness: 150 } });
  const out = interpolate(f, [fps * 2.9, fps * 3.3], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Efek mengetik karakter demi karakter dalam 1.6 detik pertama
  const chars = Math.min(text.length, Math.max(1, Math.floor(interpolate(f, [4, fps * 1.6], [0, text.length], { extrapolateRight: "clamp" }))));
  const typed = text.slice(0, chars);
  const clicked = f >= Math.round(fps * 2.1);
  const btnScale = f >= Math.round(fps * 2.0) && f <= Math.round(fps * 2.25) ? 0.92 : 1;

  return (
    <div
      style={{
        position: "absolute",
        top: 165,
        left: 48,
        right: 48,
        opacity: out,
        transform: `scale(${0.88 + 0.12 * pop})`,
      }}
    >
      <div
        style={{
          background: "#0b0f19",
          border: `4px solid ${accent}`,
          borderRadius: 32,
          padding: "28px 34px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 16, height: 16, borderRadius: 999, background: "#ef4444" }} />
            <span style={{ width: 16, height: 16, borderRadius: 999, background: "#facc15" }} />
            <span style={{ width: 16, height: 16, borderRadius: 999, background: "#22c55e" }} />
            <span style={{ marginLeft: 12, fontFamily: FONT, fontWeight: 800, fontSize: 24, color: "#94a3b8" }}>
              AI WORKFLOW ENGINE
            </span>
          </div>
          <span
            style={{
              background: clicked ? "#22c55e" : accent,
              color: "#0b0f19",
              padding: "6px 18px",
              borderRadius: 999,
              fontFamily: FONT,
              fontWeight: 900,
              fontSize: 22,
            }}
          >
            {clicked ? "SISTEM AKTIF" : "MENGETIK..."}
          </span>
        </div>

        <div
          style={{
            background: "#131b2e",
            border: "2px solid rgba(255,255,255,0.16)",
            borderRadius: 22,
            padding: "24px 28px",
            fontFamily: FONT,
            fontWeight: 900,
            fontSize: 54,
            lineHeight: 1.15,
            color: "#ffffff",
          }}
        >
          {typed}
          {!clicked && <span style={{ display: "inline-block", width: 10, height: 48, background: accent, marginLeft: 8 }} />}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: 26, color: "#cbd5e1" }}>
            Otomatisasi Penuh Bahasa Indonesia
          </span>
          <div
            style={{
              transform: `scale(${btnScale})`,
              background: clicked ? "#22c55e" : accent,
              color: "#0b0f19",
              padding: "14px 30px",
              borderRadius: 18,
              fontFamily: FONT,
              fontWeight: 900,
              fontSize: 28,
            }}
          >
            {clicked ? "BERES 10 MENIT" : "PROSES SEKARANG"}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Fase 2 (mulai 3.1 dtk): Widget Kecepatan Live + Checklist Interaktif yang Tercentang Otomatis. */
function InteractiveDashboardAndBullets({ items, accent }: { items: string[]; accent: string }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headPop = spring({ frame: f, fps, config: { damping: 13, stiffness: 130 } });
  const speedPct = Math.round(interpolate(f, [0, fps * 2.2], [12, 96], { extrapolateRight: "clamp" }));
  const savedHours = interpolate(f, [0, fps * 2.2], [0.5, 4.8], { extrapolateRight: "clamp" }).toFixed(1);

  return (
    <div style={{ position: "absolute", top: 158, left: 48, right: 48, display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Live Efficiency Meter */}
      <div
        style={{
          opacity: headPop,
          transform: `translateY(${(1 - headPop) * -28}px)`,
          background: "#0b0f19",
          border: "2px solid rgba(255,255,255,0.2)",
          borderRadius: 26,
          padding: "22px 28px",
          boxShadow: "0 18px 44px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 22, color: "#94a3b8", letterSpacing: 1 }}>
              EFISIENSI WAKTU KERJA
            </div>
            <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 40, color: "#ffffff" }}>
              Hemat {savedHours} Jam / Hari
            </div>
          </div>
          <div
            style={{
              background: "#22c55e",
              color: "#052e16",
              padding: "10px 24px",
              borderRadius: 18,
              fontFamily: FONT,
              fontWeight: 900,
              fontSize: 38,
            }}
          >
            +{speedPct}% Cepat
          </div>
        </div>
        <div style={{ width: "100%", height: 16, background: "#1e293b", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ width: `${speedPct}%`, height: "100%", background: "#22c55e", borderRadius: 999 }} />
        </div>
      </div>

      {/* Interactive Auto-Checking Feature List */}
      {items.map((b, i) => {
        const delay = Math.round(fps * 0.35) + i * 14;
        const p = spring({ frame: f - delay, fps, config: { damping: 13, stiffness: 140 } });
        const checked = f >= delay + 8;
        const checkPop = spring({ frame: f - (delay + 8), fps, config: { damping: 10, stiffness: 180 } });

        return (
          <div
            key={i}
            style={{
              opacity: p,
              transform: `translateX(${(1 - p) * -60}px)`,
              background: "#0b0f19",
              border: checked ? `3px solid ${accent}` : "2px solid rgba(255,255,255,0.16)",
              padding: "20px 26px",
              borderRadius: 24,
              display: "flex",
              alignItems: "center",
              gap: 22,
              boxShadow: "0 14px 36px rgba(0,0,0,0.48)",
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                background: checked ? accent : "#1e293b",
                border: checked ? "none" : "3px solid #64748b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transform: `scale(${checked ? 0.85 + 0.15 * checkPop : 1})`,
              }}
            >
              {checked && (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0b0f19" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </div>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 38, color: "#ffffff", lineHeight: 1.2 }}>{b}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Subtitle Karaoke Kata-per-Kata di atas Kontainer Solid Kontras Tinggi. */
function Captions({ props }: { props: AdProps }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pages = useMemo(() => groupWords(props.words), [props.words]);
  const t = f / fps;
  const page = pageAt(pages, t);
  if (!page) return null;
  const ai = activeWord(page, t);

  return (
    <div
      style={{
        position: "absolute",
        top: "59%",
        left: 44,
        right: 44,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#0b0f19",
          border: "3px solid rgba(255,255,255,0.22)",
          borderRadius: 30,
          padding: "24px 32px",
          textAlign: "center",
          fontFamily: FONT,
          fontWeight: 900,
          fontSize: 66,
          lineHeight: 1.18,
          textTransform: "uppercase",
          boxShadow: "0 20px 50px rgba(0,0,0,0.68)",
        }}
      >
        {page.words.map((w, i) => {
          const active = i === ai;
          return (
            <span
              key={i}
              style={{
                color: active ? "#0b0f19" : "#ffffff",
                background: active ? props.brand.accent : "transparent",
                padding: active ? "4px 16px" : "4px 6px",
                borderRadius: 16,
                display: "inline-block",
                margin: "4px 8px",
                transform: active ? "scale(1.1)" : "none",
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Kartu Diskon & Harga Interaktif dengan Animasi Coret Harga Normal. */
function InteractivePriceCard({ text, accent }: { text: string; accent: string }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: f, fps, config: { damping: 11, stiffness: 140 } });
  const pulse = 1 + Math.sin(f / 6) * 0.025;

  return (
    <div
      style={{
        position: "absolute",
        top: "76%",
        left: 48,
        right: 48,
        display: "flex",
        justifyContent: "center",
        transform: `scale(${p * pulse})`,
      }}
    >
      <div
        style={{
          background: "#0b0f19",
          border: `4px solid ${accent}`,
          borderRadius: 999,
          padding: "16px 38px",
          display: "inline-flex",
          alignItems: "center",
          gap: 24,
          boxShadow: "0 20px 48px rgba(0,0,0,0.68)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 22, color: "#94a3b8", letterSpacing: 1 }}>
            PENAWARAN HARI INI
          </span>
          <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 28, color: "#ef4444", textDecoration: "line-through" }}>
            Normal Rp499rb
          </span>
        </div>
        <div
          style={{
            background: accent,
            color: "#0b0f19",
            padding: "12px 34px",
            borderRadius: 999,
            fontFamily: FONT,
            fontWeight: 900,
            fontSize: 58,
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

/** Kartu Penutup (End Card) dengan Simulasi Kursor Mengklik Tombol CTA. */
function EndCard({ props }: { props: AdProps }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: f, fps, config: { damping: 13 } });

  // Kursor bergerak menuju tombol CTA dan mengklik pada frame ke-16
  const clickFrame = Math.round(fps * 0.55);
  const cursorX = interpolate(f, [0, clickFrame], [240, 40], { extrapolateRight: "clamp" });
  const cursorY = interpolate(f, [0, clickFrame], [220, 24], { extrapolateRight: "clamp" });
  const isClicking = f >= clickFrame && f <= clickFrame + 6;
  const btnScale = isClicking ? 0.92 : f > clickFrame + 6 ? 1.04 : 1;

  return (
    <AbsoluteFill
      style={{
        background: "#0b0f19",
        alignItems: "center",
        justifyContent: "center",
        gap: 34,
        opacity: interpolate(f, [0, 6], [0, 1]),
        padding: "0 64px",
      }}
    >
      <div
        style={{
          background: "#131b2e",
          border: `4px solid ${props.brand.accent}`,
          borderRadius: 44,
          padding: "68px 56px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 32,
          boxShadow: "0 28px 80px rgba(0,0,0,0.7)",
        }}
      >
        <div
          style={{
            background: "#1e293b",
            border: "2px solid rgba(255,255,255,0.18)",
            padding: "12px 28px",
            borderRadius: 999,
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 28,
            color: "#cbd5e1",
            letterSpacing: 2.5,
            textTransform: "uppercase",
          }}
        >
          {props.brand.name}
        </div>

        {props.priceBadge && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 30, color: "#94a3b8", marginBottom: 8 }}>
              SEKALI BAYAR · TANPA BIAYA BULANAN
            </div>
            <div
              style={{
                display: "inline-block",
                background: "#22c55e",
                color: "#052e16",
                padding: "14px 48px",
                borderRadius: 999,
                fontFamily: FONT,
                fontWeight: 900,
                fontSize: 74,
              }}
            >
              {props.priceBadge}
            </div>
          </div>
        )}

        {/* Tombol CTA Interaktif + Kursor */}
        <div style={{ position: "relative", width: "100%", display: "flex", justifyContent: "center", marginTop: 10 }}>
          <div
            style={{
              transform: `scale(${btnScale * (0.9 + 0.1 * p)})`,
              background: props.brand.accent,
              color: "#0b0f19",
              padding: "28px 56px",
              borderRadius: 28,
              fontFamily: FONT,
              fontWeight: 900,
              fontSize: 62,
              textAlign: "center",
              width: "100%",
              boxShadow: "0 18px 44px rgba(0,0,0,0.5)",
            }}
          >
            {props.cta}
          </div>

          {/* Kursor SVG */}
          <div
            style={{
              position: "absolute",
              bottom: -24,
              right: 110,
              transform: `translate(${cursorX}px, ${cursorY}px) scale(${isClicking ? 0.85 : 1})`,
            }}
          >
            <svg width="76" height="76" viewBox="0 0 24 24" fill="#ffffff" stroke="#0b0f19" strokeWidth="2">
              <path d="M5 3l14 9-6 2-3 6z" />
            </svg>
          </div>
        </div>

        {props.ctaSub && (
          <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 36, color: "#cbd5e1", textAlign: "center" }}>
            {props.ctaSub}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

export function AdVideo(props: AdProps) {
  const { fps, durationInFrames } = useVideoConfig();
  const endFrames = Math.round(END_CARD_SEC * fps);
  const mainFrames = durationInFrames - endFrames;
  const mainSec = mainFrames / fps;

  const sfxUri = useMemo(
    () => buildUiSfxDataUri(props.durationSec, props.bullets.length, Boolean(props.priceBadge), mainSec),
    [props.durationSec, props.bullets.length, props.priceBadge, mainSec],
  );

  return (
    <AbsoluteFill style={{ background: "#0b0f19" }}>
      <Backdrop props={props} mainFrames={mainFrames} />
      <AbsoluteFill style={{ background: "rgba(11, 15, 25, 0.34)" }} />
      <Sequence durationInFrames={mainFrames}>
        <TopTelemetryBar brandName={props.brand.name} accent={props.brand.accent} mainFrames={mainFrames} />
        <InteractiveHookPrompt text={props.hook} accent={props.brand.accent} />
        {props.bullets.length > 0 && (
          <Sequence from={Math.round(fps * 3.1)}>
            <InteractiveDashboardAndBullets items={props.bullets} accent={props.brand.accent} />
          </Sequence>
        )}
        <Captions props={props} />
        {props.priceBadge && (
          <Sequence from={Math.round(mainFrames * 0.48)}>
            <InteractivePriceCard text={props.priceBadge} accent={props.brand.accent} />
          </Sequence>
        )}
      </Sequence>
      <Sequence from={mainFrames}>
        <EndCard props={props} />
      </Sequence>
      {props.audioSrc && <Audio src={props.audioSrc} volume={1} />}
      <Audio src={sfxUri} volume={0.32} />
    </AbsoluteFill>
  );
}

// Template iklan 9:16. Teks, harga, logo, dan subtitle digambar dari props, bukan dibuat model video,
// jadi ejaan dan angkanya selalu persis seperti data yang dikirim.
import { useMemo } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { activeWord, groupWords, pageAt } from "./captions";
import { END_CARD_SEC, type AdProps } from "./schema";

const FONT = '"Noto Sans", "Inter", "Segoe UI", Arial, sans-serif';
// Zona aman Reels/TikTok: UI platform menutupi ±14% atas dan ±20% bawah.
const SAFE = { top: "14%", sub: "55%", price: "74%" };

const stroke = (px: number) => ({ WebkitTextStroke: `${px}px #000`, paintOrder: "stroke fill" as const });

/** Adegan latar: foto (zoom pelan) atau video (dibisukan, suara hanya dari voice over). */
function Scene({ kind, src, frames }: { kind: "image" | "video"; src: string; frames: number }) {
  const f = useCurrentFrame();
  const fade = interpolate(f, [0, 10, frames - 10, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const zoom = interpolate(f, [0, frames], [1, 1.12], { extrapolateRight: "clamp" });
  const fill = { width: "100%", height: "100%", objectFit: "cover" as const };
  return (
    <AbsoluteFill style={{ opacity: fade, overflow: "hidden" }}>
      {kind === "image"
        ? <Img src={src} style={{ ...fill, transform: `scale(${zoom})` }} />
        : <OffthreadVideo src={src} muted style={fill} />}
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
        // Tumpang tindih 10 frame supaya pindah adegan memudar, bukan putus.
        return <Sequence key={i} from={Math.max(0, from - (i ? 10 : 0))} durationInFrames={frames + (i ? 10 : 0)}><Scene kind={s.kind} src={s.src} frames={frames + (i ? 10 : 0)} /></Sequence>;
      })}
    </>
  );
}

function Hook({ text, accent }: { text: string; accent: string }) {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  const pop = spring({ frame: f, fps, config: { damping: 12, stiffness: 140 } });
  const out = interpolate(f, [fps * 2.6, fps * 3.1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", top: SAFE.top, left: 60, right: 60, textAlign: "center", opacity: out, transform: `scale(${0.8 + 0.2 * pop})` }}>
      <div style={{ display: "inline-block", background: accent, color: "#111", padding: "22px 34px", borderRadius: 28, fontFamily: FONT, fontWeight: 900, fontSize: 74, lineHeight: 1.12, boxShadow: "0 12px 40px rgba(0,0,0,.45)" }}>{text}</div>
    </div>
  );
}

function Bullets({ items, accent }: { items: string[]; accent: string }) {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: "30%", left: 70, right: 70, display: "flex", flexDirection: "column", gap: 18 }}>
      {items.map((b, i) => {
        const p = spring({ frame: f - i * 10, fps, config: { damping: 14 } });
        return (
          <div key={i} style={{ opacity: p, transform: `translateX(${(1 - p) * -60}px)`, background: "rgba(0,0,0,.6)", color: "#fff", padding: "16px 26px", borderRadius: 20, fontFamily: FONT, fontWeight: 800, fontSize: 48, borderLeft: `10px solid ${accent}`, alignSelf: "flex-start" }}>{b}</div>
        );
      })}
    </div>
  );
}

function Captions({ props }: { props: AdProps }) {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  const pages = useMemo(() => groupWords(props.words), [props.words]);
  const t = f / fps;
  const page = pageAt(pages, t);
  if (!page) return null;
  const ai = activeWord(page, t);
  return (
    <div style={{ position: "absolute", top: SAFE.sub, left: 50, right: 50, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 88, lineHeight: 1.1, textTransform: "uppercase" }}>
      {page.words.map((w, i) => (
        <span key={i} style={{ color: i === ai ? props.brand.accent : "#fff", display: "inline-block", margin: "0 16px", transform: i === ai ? "scale(1.08)" : "none", ...stroke(14) }}>{w.text}</span>
      ))}
    </div>
  );
}

function Price({ text, accent }: { text: string; accent: string }) {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  const p = spring({ frame: f, fps, config: { damping: 10, stiffness: 120 } });
  return (
    <div style={{ position: "absolute", top: SAFE.price, left: 0, right: 0, display: "flex", justifyContent: "center", transform: `scale(${p})` }}>
      <div style={{ background: accent, color: "#111", padding: "14px 44px", borderRadius: 999, fontFamily: FONT, fontWeight: 900, fontSize: 80, boxShadow: "0 10px 34px rgba(0,0,0,.5)" }}>{text}</div>
    </div>
  );
}

function EndCard({ props }: { props: AdProps }) {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  const p = spring({ frame: f, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{ background: props.brand.primary, alignItems: "center", justifyContent: "center", gap: 34, opacity: interpolate(f, [0, 6], [0, 1]) }}>
      {props.logoSrc && <Img src={props.logoSrc} style={{ width: 260, height: 260, objectFit: "contain", transform: `scale(${p})` }} />}
      <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 92, color: "#fff", textAlign: "center", padding: "0 70px", lineHeight: 1.1, transform: `scale(${0.9 + 0.1 * p})` }}>{props.cta}</div>
      {props.priceBadge && <div style={{ background: props.brand.accent, color: "#111", padding: "14px 50px", borderRadius: 999, fontFamily: FONT, fontWeight: 900, fontSize: 84 }}>{props.priceBadge}</div>}
      {props.ctaSub && <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 46, color: "#ffffffcc", textAlign: "center", padding: "0 80px" }}>{props.ctaSub}</div>}
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 38, color: "#ffffff99", letterSpacing: 4, textTransform: "uppercase" }}>{props.brand.name}</div>
    </AbsoluteFill>
  );
}

export function AdVideo(props: AdProps) {
  const { fps, durationInFrames } = useVideoConfig();
  const endFrames = Math.round(END_CARD_SEC * fps);
  const mainFrames = durationInFrames - endFrames;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Backdrop props={props} mainFrames={mainFrames} />
      {/* Gradasi gelap atas & bawah supaya teks terbaca di atas foto/video terang. */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 45%, rgba(0,0,0,.6) 100%)" }} />
      <Sequence durationInFrames={mainFrames}>
        <Hook text={props.hook} accent={props.brand.accent} />
        {props.bullets.length > 0 && <Sequence from={Math.round(fps * 3.2)}><Bullets items={props.bullets} accent={props.brand.accent} /></Sequence>}
        <Captions props={props} />
        {props.priceBadge && <Sequence from={Math.round(mainFrames * 0.45)}><Price text={props.priceBadge} accent={props.brand.accent} /></Sequence>}
        {props.logoSrc && <Img src={props.logoSrc} style={{ position: "absolute", top: "5%", left: 50, width: 120, height: 120, objectFit: "contain" }} />}
      </Sequence>
      <Sequence from={mainFrames}><EndCard props={props} /></Sequence>
      {props.audioSrc && <Audio src={props.audioSrc} />}
    </AbsoluteFill>
  );
}

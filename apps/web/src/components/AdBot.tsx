// Maskot "Bot Iklan": SVG inline + animasi CSS (transform/opacity saja, tanpa library), gaya di styles.css (.adbot).
// mood: idle (melayang & berkedip) · think (mata memindai, antena memancar sinyal) · talk (mulut equalizer) · happy · sad.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cx } from "./ui";

export type BotMood = "idle" | "think" | "talk" | "happy" | "sad";

/** Mata mengikuti kursor. Satu listener pasif, dibatasi rAF, mati di layar sentuh, reduced-motion, dan tab tersembunyi. */
function useEyeTrack(ref: React.RefObject<SVGSVGElement | null>, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || !matchMedia("(pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0, x = 0, y = 0;
    const apply = () => {
      raf = 0;
      if (document.hidden) return;
      const r = el.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height * 0.42);
      const k = 4 / Math.max(60, Math.hypot(dx, dy)); // maks. ±4 unit SVG
      el.style.setProperty("--ex", `${(dx * k).toFixed(2)}px`);
      el.style.setProperty("--ey", `${(dy * k * 0.7).toFixed(2)}px`);
    };
    const move = (e: PointerEvent) => { x = e.clientX; y = e.clientY; raf ||= requestAnimationFrame(apply); };
    window.addEventListener("pointermove", move, { passive: true });
    return () => { window.removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, [ref, on]);
}

export function AdBot({ size = 40, mood = "idle", head, track, wave, className, style }: {
  size?: number; mood?: BotMood; head?: boolean; track?: boolean; wave?: number; className?: string; style?: CSSProperties;
}) {
  const ref = useRef<SVGSVGElement>(null);
  useEyeTrack(ref, Boolean(track));
  // `wave` berubah → lambaian satu kali (key baru memulai ulang animasi).
  const [waving, setWaving] = useState(false);
  useEffect(() => {
    if (!wave) return;
    setWaving(true);
    const t = setTimeout(() => setWaving(false), 1100);
    return () => clearTimeout(t);
  }, [wave]);

  return (
    <svg ref={ref} width={size} height={size} viewBox={head ? "8 2 84 76" : "0 0 100 100"} aria-hidden data-mood={mood}
      className={cx("adbot", head && "adbot-head", waving && "ab-waving", className)} style={style}>
      <g className="ab-float">
        <circle className="ab-ring" cx="50" cy="11" r="5" />
        <circle className="ab-ring ab-ring2" cx="50" cy="11" r="5" />
        <path d="M50 25V14" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        <circle className="ab-bulb" cx="50" cy="11" r="4.6" />
        <rect x="11" y="40" width="9" height="17" rx="4.5" fill="var(--accent)" opacity=".7" />
        <rect x="80" y="40" width="9" height="17" rx="4.5" fill="var(--accent)" opacity=".7" />
        <g className="ab-face">
          <rect x="17" y="24" width="66" height="50" rx="19" fill="var(--accent)" />
          <ellipse cx="38" cy="30" rx="13" ry="3.2" fill="#fff" opacity=".22" />
          <rect x="24" y="32" width="52" height="33" rx="13" fill="#15162a" />
          <g className="ab-eyes">
            <g className="ab-open">
              <rect x="34" y="40" width="9" height="12" rx="4.5" fill="#86f3ff" />
              <rect x="57" y="40" width="9" height="12" rx="4.5" fill="#86f3ff" />
            </g>
            <g className="ab-joy" fill="none" stroke="#86f3ff" strokeWidth="3" strokeLinecap="round">
              <path d="M33.5 48q5-7 10 0" /><path d="M56.5 48q5-7 10 0" />
            </g>
          </g>
          <path className="ab-smile" d="M45 57q5 3.4 10 0" fill="none" stroke="#86f3ff" strokeWidth="2.4" strokeLinecap="round" />
          <g className="ab-eq" fill="#86f3ff">
            <rect x="43" y="55" width="3" height="4" rx="1.5" /><rect x="48.5" y="55" width="3" height="4" rx="1.5" /><rect x="54" y="55" width="3" height="4" rx="1.5" />
          </g>
          <circle cx="29" cy="59" r="2.6" fill="#ff8fc7" opacity=".55" />
          <circle cx="71" cy="59" r="2.6" fill="#ff8fc7" opacity=".55" />
        </g>
        {!head && (
          <g className="ab-body">
            <rect x="31" y="76" width="38" height="19" rx="8" fill="var(--accent)" />
            <rect x="40" y="80" width="20" height="11" rx="3.5" fill="#15162a" />
            <path d="M43 88l4-3.5 3 2 6-5" fill="none" stroke="var(--yellow)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="22" y="77" width="8" height="14" rx="4" fill="var(--accent)" opacity=".85" />
            <rect className="ab-arm" x="70" y="77" width="8" height="14" rx="4" fill="var(--accent)" opacity=".85" />
          </g>
        )}
      </g>
    </svg>
  );
}

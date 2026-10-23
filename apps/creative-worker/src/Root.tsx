import { Composition } from "remotion";
import { AdVideo } from "./AdVideo";
import { FPS, HEIGHT, WIDTH, adProps, type AdProps } from "./schema";

// Nilai bawaan hanya untuk Remotion Studio; render sungguhan selalu membawa props dari API.
const preview: AdProps = {
  hook: "Bikin video AI cuma 10 menit",
  bullets: ["Tanpa ribet editing", "Cocok buat pemula"],
  priceBadge: "Rp49rb",
  cta: "Cek link di bio",
  ctaSub: "Akses langsung setelah bayar",
  words: "Bikin video AI cuma sepuluh menit. Tanpa ribet editing, cocok buat pemula.".split(" ").map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.35 })),
  durationSec: 10,
  scenes: [{ kind: "image", src: "", weight: 1 }],
  brand: { name: "Brand", primary: "#1f3a8a", accent: "#facc15" },
};

export function Root() {
  return (
    <Composition
      id="Ad" component={AdVideo} schema={adProps} defaultProps={preview}
      width={WIDTH} height={HEIGHT} fps={FPS} durationInFrames={FPS * preview.durationSec}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round(props.durationSec * FPS) })}
    />
  );
}

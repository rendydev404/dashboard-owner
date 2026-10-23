# syntax=docker/dockerfile:1
# Worker render video iklan (Remotion + Chrome headless). Konteks build = akar repo:
#   docker build -f apps/creative-worker/Dockerfile -t creative-worker .
# Jalankan dengan batas sumber daya: --memory=2g --memory-swap=2g --cpus=1.5 --shm-size=256m
# (puncak nyata ±1,4 GB di 720p; --memory-swap sama dengan --memory supaya render tidak merayap di swap server).
FROM node:22-bookworm-slim
# RENDER_SCALE=2/3 → MP4 720×1280: 1080p butuh ±1,9 GB RAM, melebihi batas 1,5 GB (uji 0.6, 23 Okt 2026).
# VIDEO_CACHE_MB=100: puncak 1.409 MB vs 1.506 MB pada 200, dan render malah sedikit lebih cepat (101 vs 109 dtk).
ENV TZ=Asia/Jakarta RENDER_GL=swangle RENDER_CONCURRENCY=2 RENDER_SCALE=2/3 VIDEO_CACHE_MB=100 BUNDLE_DIR=/app/bundle COREPACK_HOME=/usr/local/share/corepack
# Pustaka yang dibutuhkan Chrome headless + font (Noto Sans untuk teks, Noto Color Emoji untuk emoji).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 \
      libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 fonts-noto-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate && mkdir -p /app && chown node:node /app
# Selebihnya sebagai user node (tanpa chown -R yang menggandakan lapisan image).
USER node
WORKDIR /app
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY --chown=node:node apps/creative-worker/package.json apps/creative-worker/
RUN pnpm install --frozen-lockfile --filter "@iklan/creative-worker..."
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node apps/creative-worker apps/creative-worker
WORKDIR /app/apps/creative-worker
# Chrome diunduh saat build (bukan saat render pertama) dan bundle Remotion dibuat sekali (hemat >1 GB RAM saat runtime).
RUN node -e "import('@remotion/renderer').then((m) => m.ensureBrowser())" && npx tsx src/build-bundle.ts "$BUNDLE_DIR"
# Folder kerja job (aset, suara, MP4) di disk container, bukan /tmp (tmpfs = RAM). Dibersihkan saat start & tiap 24 jam.
ENV PORT=8080 JOBS_DIR=/app/jobs
RUN mkdir -p /app/jobs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]

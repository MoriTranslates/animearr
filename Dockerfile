FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
LABEL org.opencontainers.image.title="AnimeArr" \
      org.opencontainers.image.description="Anime-first companion for Sonarr/Radarr/Prowlarr" \
      org.opencontainers.image.source="https://github.com/MoriTranslates/animearr" \
      org.opencontainers.image.licenses="GPL-3.0-only"
# ffprobe is used to verify downloaded files.
# 7zz (package 7zip) unpacks torrents that arrive as 7z/ZIP archives (Settings → extraction). Alpine builds it without
# the RAR codec, so RAR sets need attention instead (see BACKLOG).
# mkvtoolnix: "Also fix the tag inside the file" (mkvpropedit edits an MKV header in place, no remux).
# su-exec: drops root to PUID:PGID in the entrypoint; tzdata: TZ works.
RUN apk add --no-cache ffmpeg 7zip mkvtoolnix su-exec tzdata
ENV NODE_ENV=production ANIMEARR_CONFIG=/config PORT=8484 PUID=1000 PGID=1000 UMASK=002 TZ=UTC
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY catalog ./catalog
COPY docker/entrypoint.sh /usr/local/bin/animearr-entrypoint
RUN chmod 755 /usr/local/bin/animearr-entrypoint && mkdir -p /config
VOLUME /config
EXPOSE 8484
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8484}/ping" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/animearr-entrypoint"]
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server/index.js"]

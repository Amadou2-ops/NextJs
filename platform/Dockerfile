# syntax=docker/dockerfile:1.12
#
# Images de production TransfertPlus (une cible par composant) :
#
#   docker build --target api      -t transfertplus/api .      # API (et worker : commande dist/worker.js)
#   docker build --target migrate  -t transfertplus/migrate .  # migrations / données de référence (tâche ponctuelle)
#   docker build --target web      -t transfertplus/web .      # site client (BFF Next.js)
#   docker build --target admin    -t transfertplus/admin .    # back-office (BFF Next.js)
#
# Exécution : image distroless (ni shell, ni gestionnaire de paquets),
# utilisateur non privilégié 65532, système de fichiers en lecture seule
# recommandé (voir deploy/compose.production.yaml). Aucun secret n'entre dans
# une image : toute la configuration est lue à l'exécution et validée au démarrage.

# Debian 13 pour la construction comme pour l'exécution : modules natifs
# (Argon2) liés à la même glibc ; la base Debian 12 portait des failles
# OpenSSL corrigeables, refusées par l'analyse bloquante.
ARG NODE_IMAGE=node:22-trixie-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot

# -----------------------------------------------------------------------------
# Dépendances (couche partagée, manifeste figé)
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline

# -----------------------------------------------------------------------------
# Builds
# -----------------------------------------------------------------------------
FROM deps AS build-api
RUN pnpm --filter @transfertplus/api run build \
 && pnpm --filter @transfertplus/api --prod --legacy deploy /out/api

FROM deps AS build-migrate
# tsx est conservé : le migrateur exécute ses sources TypeScript telles que testées en CI.
RUN pnpm --filter @transfertplus/db --legacy deploy /out/db

FROM deps AS build-web
RUN pnpm --filter @transfertplus/web run build

FROM deps AS build-admin
RUN pnpm --filter @transfertplus/admin run build

# -----------------------------------------------------------------------------
# API (et worker)
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS api
LABEL org.opencontainers.image.title="transfertplus-api" \
      org.opencontainers.image.description="API TransfertPlus (Express) — commande dist/worker.js pour le worker" \
      org.opencontainers.image.source="https://github.com/Amadou2-ops/NextJs"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build-api --chown=65532:65532 /out/api/package.json ./package.json
COPY --from=build-api --chown=65532:65532 /out/api/node_modules ./node_modules
COPY --from=build-api --chown=65532:65532 /out/api/dist ./dist
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["dist/server.js"]

# -----------------------------------------------------------------------------
# Migrateur (tâche ponctuelle avant chaque déploiement)
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS migrate
LABEL org.opencontainers.image.title="transfertplus-migrate" \
      org.opencontainers.image.source="https://github.com/Amadou2-ops/NextJs"
WORKDIR /app
COPY --from=build-migrate --chown=65532:65532 /out/db ./
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "--import", "tsx", "src/cli.ts"]
CMD ["migrate"]

# -----------------------------------------------------------------------------
# Site client et back-office (sortie autonome Next.js)
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS web
LABEL org.opencontainers.image.title="transfertplus-web" \
      org.opencontainers.image.source="https://github.com/Amadou2-ops/NextJs"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build-web --chown=65532:65532 /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=65532:65532 /repo/apps/web/.next/static ./apps/web/.next/static
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["apps/web/server.js"]

FROM ${RUNTIME_IMAGE} AS admin
LABEL org.opencontainers.image.title="transfertplus-admin" \
      org.opencontainers.image.source="https://github.com/Amadou2-ops/NextJs"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build-admin --chown=65532:65532 /repo/apps/admin/.next/standalone ./
COPY --from=build-admin --chown=65532:65532 /repo/apps/admin/.next/static ./apps/admin/.next/static
USER 65532:65532
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3001/connexion',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["apps/admin/server.js"]

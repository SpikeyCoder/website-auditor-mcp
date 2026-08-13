# Hosted Streamable HTTP entry point (src/http.ts) — Cloud Run service
# `website-auditor-mcp`, mapped to mcp.website-auditor.io. The stdio entry
# every npx/.mcpb install runs is unaffected by this image.
#
# Deploy: gcloud run deploy website-auditor-mcp --source . --region us-central1
# (see docs/CODEX-PLUGIN.md → Phase 2). Runtime env is set on the service, not
# baked here: WA_UPSELL_STYLE=info, WA_INSTALL_ID, WA_APPS_CHALLENGE_TOKEN.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Cloud Run injects PORT=8080; src/http.ts honors it. WA_HTTP_PORT wins when set
# to something non-blank, then PORT, then 8787 — a BLANK WA_HTTP_PORT falls
# through rather than shadowing PORT, which the old `??` chain could not express.
# Anything present but not an integer 1-65535 stops the boot naming the variable,
# rather than binding a port nobody asked for.
EXPOSE 8080
USER node
CMD ["node", "dist/http.js"]

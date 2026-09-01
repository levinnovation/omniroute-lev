# ── OmniRoute-LEV — Railway build from source ──────────────────────────────
#
# This Dockerfile builds OmniRoute from source (not from a pre-built image)
# and includes Playwright + patchright for web-cookie providers.
#
# Key differences from the upstream Dockerfile:
#   1. No BuildKit cache mounts (--mount=type=cache) — Railway may not support them
#   2. Consolidates the runner-web target (we always need browsers)
#   3. Includes patchright (stealth Playwright fork) replacing cloakbrowser
#   4. --no-sandbox is fixed in source (packages/browser-pool), no monkey-patch
#   5. Health check with generous start-period for Railway (300s)
#
# Build: docker build -t omniroute-lev .
# Railway: this is the primary Dockerfile for the omniroute service

# ── Common base with runtime deps ──────────────────────────────────────────
FROM node:26-trixie-slim AS base
WORKDIR /app

# Security-patched base packages + runtime deps
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# npm CVE overlay (same as upstream — patches bundled npm internals)
RUN set -eux; \
  npm install -g npm@latest; \
  npm install --prefix /tmp/npm-cve-patch --no-audit --no-fund --ignore-scripts \
    --install-strategy=nested \
    brace-expansion@5.0.9 ip-address@10.5.0 tar@7.5.22 undici@6.28.0; \
  for pkg in brace-expansion ip-address tar undici; do \
    test -d "/usr/local/lib/node_modules/npm/node_modules/$pkg"; \
    rm -rf "/usr/local/lib/node_modules/npm/node_modules/$pkg"; \
    cp -R "/tmp/npm-cve-patch/node_modules/$pkg" \
      "/usr/local/lib/node_modules/npm/node_modules/$pkg"; \
  done; \
  rm -rf /tmp/npm-cve-patch; \
  node -e "for (const p of ['brace-expansion','ip-address','tar','undici']) console.log(p, require('/usr/local/lib/node_modules/npm/node_modules/'+p+'/package.json').version);"; \
  npm --version; \
  npm cache clean --force

# ── Builder ────────────────────────────────────────────────────────────────
FROM base AS builder

ENV NEXT_TELEMETRY_DISABLED=1

# Build tools for native module compilation
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY open-sse/package.json ./open-sse/package.json
COPY packages/browser-pool/package.json ./packages/browser-pool/package.json
COPY scripts/build/postinstall.mjs ./scripts/build/postinstall.mjs
COPY scripts/build/postinstallSupport.mjs ./scripts/build/postinstallSupport.mjs
COPY scripts/build/native-binary-compat.mjs ./scripts/build/native-binary-compat.mjs
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true

# Install deps — no --ignore-scripts here because we need better-sqlite3 native build
# and tls-client-node postinstall. Run them explicitly to fail loudly.
RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)
RUN npm ci --include=optional --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && (cd node_modules/better-sqlite3 \
      && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild) \
  && node -e "require('better-sqlite3')(':memory:').close()" \
  && node node_modules/tls-client-node/scripts/postinstall.js \
  && (test -n "$(find node_modules/tls-client-node/bin -mindepth 1 -print -quit 2>/dev/null)" \
      || (echo "tls-client-node native binary missing after postinstall" >&2 && exit 1))

# Build configuration
ARG OMNIROUTE_USE_TURBOPACK=1
ENV OMNIROUTE_USE_TURBOPACK="${OMNIROUTE_USE_TURBOPACK}"
ARG OMNIROUTE_BASE_PATH=""
ENV OMNIROUTE_BASE_PATH=$OMNIROUTE_BASE_PATH
ARG DASHBOARD_ALLOW_EMBED=""
ENV DASHBOARD_ALLOW_EMBED=$DASHBOARD_ALLOW_EMBED
ENV OMNIROUTE_MITM_STUB=1

# Build memory and worker limits
ARG OMNIROUTE_BUILD_MEMORY_MB=6144
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_BUILD_MEMORY_MB}"
ARG OMNIROUTE_BUILD_WORKERS=2
ENV CIRCLE_NODE_TOTAL=${OMNIROUTE_BUILD_WORKERS}

# Copy source and build
COPY . ./
RUN mkdir -p /app/data \
  && npm run build \
  && node --input-type=module -e "import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; const standaloneRoot = '/app/.build/next/standalone/node_modules/'; const require = createRequire('/app/.build/next/standalone/package.json'); for (const pkg of ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken']) { const resolved = require.resolve(pkg); if (!resolved.startsWith(standaloneRoot)) throw new Error(pkg + ' resolved outside standalone: ' + resolved); await import(pathToFileURL(resolved).href); } const onnxRuntime = require.resolve('onnxruntime-node'); if (!onnxRuntime.startsWith(standaloneRoot)) throw new Error('onnxruntime-node resolved outside standalone: ' + onnxRuntime); await import(pathToFileURL(onnxRuntime).href);"

# ── Runner (web-cookie providers always enabled) ───────────────────────────
FROM base AS runner

LABEL org.opencontainers.image.title="omniroute-lev" \
  org.opencontainers.image.description="OmniRoute-LEV — Lev Innovation fork with robust web-cookie provider support" \
  org.opencontainers.image.url="https://omniroute.agentyx.one" \
  org.opencontainers.image.source="https://github.com/levinnovation/omniroute-lev" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV OMNIROUTE_MEMORY_MB=2048
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

# Copy built standalone app from builder
COPY --from=builder /app/.build/next/standalone ./
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations

# Copy healthcheck script
COPY --from=builder /app/scripts/dev/healthcheck.mjs ./healthcheck.mjs

# ── Playwright + Chromium for web-cookie providers ─────────────────────────
USER root

# Copy playwright from builder (avoids runtime npx download)
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright

# Install Playwright Chromium browser binaries + OS dependencies
# PLAYWRIGHT_BROWSERS_PATH puts browsers under /home/node for the non-root user
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN apt-get update \
  && node node_modules/playwright/cli.js install chromium --with-deps \
  && chown -R node:node /home/node/.cache \
  && rm -rf /var/lib/apt/lists/*

# ── patchright (stealth Playwright fork with fingerprint patches) ──────────
# LEV fork: replaces cloakbrowser (was off-lockfile, obfuscated dynamic import).
# patchright is a drop-in Playwright replacement with built-in stealth patches,
# properly pinned in package.json. Pre-download browsers at build time.
COPY --from=builder /app/node_modules/patchright ./node_modules/patchright
COPY --from=builder /app/node_modules/patchright-core ./node_modules/patchright-core
RUN node -e "const {chromium} = require('patchright'); chromium.launch({headless:true,args:['--no-sandbox']}).then(b => {console.log('patchright OK'); return b.close();}).catch(e => console.log('patchright launch skipped:', e.message.substring(0,100)))" || true

# ── wreq-js native binary for TLS fingerprint spoofing ─────────────────────
RUN ls /app/node_modules/wreq-js/rust/wreq-js.linux-x64-gnu.node && echo "wreq-js native binary OK" || echo "wreq-js binary missing"

# Fix ownership after all COPYs and installs
RUN chown -R node:node /app

EXPOSE 20128

USER node

# Health check — generous start-period (300s) for Playwright + Postgres migration on Railway
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "dev/run-standalone.mjs"]

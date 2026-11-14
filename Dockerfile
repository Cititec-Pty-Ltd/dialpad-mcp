# Multi-stage build for efficient container size
FROM node:20-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS production

RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S dialpad && \
    adduser -S dialpad -u 1001 -G dialpad

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /app/logs && chown -R dialpad:dialpad /app

# Remove bundled npm/npx from the runtime image - not needed at runtime; CMD
# runs node directly, and this trims a class of Trivy findings against npm's
# own bundled dependencies in the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER dialpad

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# 0.0.0.0 is the in-container bind. Startup still refuses to listen without a
# real CONDUIT_S2S_SECRET. MCP_ALLOW_INSECURE_DEV=1 ignores MCP_HTTP_HOST and
# binds 127.0.0.1 only. AUTH_MODE=gateway never falls back to image env credentials.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway

CMD ["node", "dist/http.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL version="${VERSION}"
LABEL description="Dialpad MCP Server - Model Context Protocol server for the Dialpad API v2"
LABEL org.opencontainers.image.title="dialpad-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for the Dialpad API v2"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/Cititec-Pty-Ltd/dialpad-mcp"
LABEL org.opencontainers.image.vendor="Cititec Pty Ltd"
LABEL org.opencontainers.image.licenses="Apache-2.0"

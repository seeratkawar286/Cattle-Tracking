# ─────────────────────────────────────────────────────────────
# sylCloud HCS048 Server — Production Dockerfile
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine

# Non-root user for security
RUN addgroup -S sylcloud && adduser -S sylcloud -G sylcloud

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source
COPY src/ ./src/

# Create logs directory
RUN mkdir -p logs && chown -R sylcloud:sylcloud /app

USER sylcloud

# Expose REST API + WebSocket port
EXPOSE 3000
# Expose TCP ingestion port for HCS048 ear tags
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]

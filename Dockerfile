# Production Dockerfile for Google Cloud Run
FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json ./

# Install production dependencies only (uses N-API/prebuilt binaries for better-sqlite3 & sharp)
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source code
COPY server.js database.js storageService.js ./
COPY public ./public

# Ensure runtime directory for SQLite metadata exists
RUN mkdir -p /app/data

# Cloud Run runtime environment configuration
ENV NODE_ENV=production
ENV PORT=8080

# Expose Cloud Run default port
EXPOSE 8080

# Start the Express server (binds to 0.0.0.0:$PORT)
CMD ["node", "server.js"]

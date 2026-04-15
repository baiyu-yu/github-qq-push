# Step 1: Build the application
FROM node:20 AS builder

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm install

# Copy source code and configuration
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build the TypeScript application
RUN npm run build

# Step 2: Runtime image
FROM node:20-slim

WORKDIR /app

# Install minimal system dependencies for Puppeteer (Chromium) and fonts
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Copy package files for production install
COPY package*.json ./

# Install only production dependencies and skip Chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm install --omit=dev && \
    npx puppeteer browsers install chrome --path /app/.cache/puppeteer

# Copy build artifacts and static files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY src/renderer/templates ./src/renderer/templates

# Set environment variables
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/app/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome

# Expose Webhook and WebUI ports
EXPOSE 7890 3000

# Start command
CMD ["npm", "start"]

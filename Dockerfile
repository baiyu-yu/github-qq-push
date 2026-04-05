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

# Install system dependencies for Puppeteer (Chromium) and Chinese fonts
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Copy package files for production install
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy build artifacts and static files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY src/renderer/templates ./src/renderer/templates

# Set environment variables
ENV NODE_ENV=production
# Puppeteer usually downloads Chromium to ~/.cache/puppeteer by default.
# We'll share it here.

# Expose Webhook and WebUI ports
EXPOSE 7890 3000

# Start command
CMD ["npm", "start"]

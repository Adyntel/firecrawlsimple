FROM node:20-slim AS base

# Create app directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm corepack@latest
RUN corepack enable

# Copy workspace files
COPY pnpm-workspace.yaml ./

# Copy package files for workspace
COPY apps/api/package.json apps/api/pnpm-lock.yaml ./apps/api/

# Install dependencies
WORKDIR /app/apps/api
RUN pnpm install --frozen-lockfile

# Install necessary build dependencies
RUN apt-get update -qq && \
    apt-get install -y \
    ca-certificates \
    git \
    golang-go \
    && update-ca-certificates

# Copy the application code
COPY apps/api/ ./

# Build Go module
RUN cd src/lib/go-html-to-md && \
    go mod tidy && \
    go build -o html-to-markdown.so -buildmode=c-shared html-to-markdown.go && \
    chmod +x html-to-markdown.so

# Build the application
RUN pnpm run build

# Install runtime dependencies
RUN apt-get install --no-install-recommends -y \
    chromium \
    chromium-sandbox \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives

# Environment setup
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ARG PORT=8080
ENV PORT=${PORT}
EXPOSE ${PORT}

CMD ["pnpm", "run", "start:production"]

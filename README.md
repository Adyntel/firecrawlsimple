# Firecrawl - Railway Deployment

A powerful web scraping and crawling service optimized for deployment on Railway.

## Architecture

This monorepo contains multiple microservices that work together to provide web scraping capabilities:

- **firecrawl-api**: Main API service (Express.js + BullMQ) - Handles incoming scrape/crawl requests
- **firecrawl-worker**: Background job processor - Processes queued scraping jobs asynchronously
- **puppeteer-service**: Browser automation microservice - Handles JavaScript rendering with Puppeteer/Hero
- **Redis**: Job queue and caching layer (Railway plugin)

## Features

- **Single URL Scraping**: Scrape individual web pages with JavaScript rendering support
- **Website Crawling**: Recursively crawl entire websites with configurable depth and filters
- **Sitemap Support**: Automatically discover and scrape pages from sitemaps
- **Job Queue System**: Asynchronous processing with BullMQ for reliable job handling
- **Rate Limiting**: Built-in rate limiting to prevent abuse
- **Proxy Support**: Configure proxy servers for scraping
- **CAPTCHA Solving**: Integration with 2captcha for automated CAPTCHA resolution
- **Markdown Conversion**: Automatic HTML to Markdown conversion
- **Health Monitoring**: Health check endpoints for service monitoring

## Repository Structure

```
firecrawlsimple/
├── apps/
│   ├── api/                          # Main API service
│   │   ├── src/
│   │   │   ├── index.ts             # Express server entry point
│   │   │   ├── controllers/         # API request handlers
│   │   │   ├── routes/              # API route definitions
│   │   │   ├── services/            # Business logic and queue workers
│   │   │   ├── scraper/             # Web scraping logic
│   │   │   └── lib/                 # Utilities and helpers
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── puppeteer-service-ts/         # Browser automation service
│       ├── api.ts                    # Puppeteer service entry point
│       ├── helpers/
│       ├── package.json
│       └── tsconfig.json
├── railway.json                      # Railway deployment configuration
├── pnpm-workspace.yaml              # pnpm monorepo configuration
├── .gitignore
└── README.md
```

## Local Development

### Prerequisites

- Node.js 18+ or 20+
- pnpm 9.12.3+
- Redis (local or remote instance)

### Installation

```bash
# Install all dependencies across the monorepo
pnpm install
```

### Running Services Locally

#### Option 1: Run API Service (Development)

```bash
cd apps/api
pnpm start:dev
```

The API will be available at http://localhost:3002

#### Option 2: Run Puppeteer Service (Development)

```bash
cd apps/puppeteer-service-ts
pnpm dev
```

The puppeteer service will be available at http://localhost:3000

#### Option 3: Run Workers (Development)

```bash
cd apps/api
pnpm workers:dev
```

### Environment Variables

Create a `.env` file in the repository root with the following variables:

```bash
# Redis Configuration
REDIS_URL=redis://localhost:6379
REDIS_RATE_LIMIT_URL=redis://localhost:6379

# Service URLs (for local development)
PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3000

# Server Configuration
PORT=3002
HOST=0.0.0.0
NUM_WORKERS_PER_QUEUE=8
LOGGING_LEVEL=info
MAX_RAM=0.95
MAX_CPU=0.95

# Authentication (generate secure keys for production)
BULL_AUTH_KEY=your-bull-auth-key-here
TEST_API_KEY=your-test-api-key-here

# Optional: Proxy Configuration
PROXY_SERVER=
PROXY_USERNAME=
PROXY_PASSWORD=

# Optional: CAPTCHA Solving
TWOCAPTCHA_TOKEN=

# Optional: Alternative Scraping Service
SCRAPING_BEE_API_KEY=
```

## Railway Deployment

This repository is configured for deployment on Railway using Railpack (Railway's optimized builder).

### Prerequisites

- Railway account (https://railway.app)
- GitHub repository connected to Railway
- Railway CLI (optional, for command-line deployment)

### Deployment Steps

#### 1. Create Railway Project

1. Log in to Railway dashboard
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose this repository

#### 2. Add Redis Service

1. In your Railway project, click "+ New"
2. Select "Database" → "Redis"
3. Railway will automatically provision Redis and create a `REDIS_URL` variable

#### 3. Create Puppeteer Service

1. Click "+ New" → "GitHub Repo" → Select your repository
2. Configure the service:
   - **Service Name**: `puppeteer-service`
   - **Root Directory**: `/apps/puppeteer-service-ts`
   - **Watch Paths**: `apps/puppeteer-service-ts/**`
3. Add environment variables:
   ```
   PORT=3000
   MAX_CONCURRENCY=10
   BLOCK_MEDIA=false
   ```
4. **Important**: Do NOT generate a public domain (keep private for security)

#### 4. Create API Service

1. Click "+ New" → "GitHub Repo" → Select your repository
2. Configure the service:
   - **Service Name**: `firecrawl-api`
   - **Root Directory**: `/apps/api`
   - **Start Command**: `pnpm run start:production`
   - **Watch Paths**: `apps/api/**`
3. Add environment variables using Railway's variable references:
   ```bash
   PORT=3002
   HOST=0.0.0.0
   NUM_WORKERS_PER_QUEUE=8
   LOGGING_LEVEL=info
   MAX_RAM=0.95
   MAX_CPU=0.95

   # Use Railway variable references for service discovery
   REDIS_URL=${{Redis.REDIS_URL}}
   REDIS_RATE_LIMIT_URL=${{Redis.REDIS_URL}}
   PLAYWRIGHT_MICROSERVICE_URL=http://${{puppeteer-service.RAILWAY_PRIVATE_DOMAIN}}:3000

   # Add your authentication keys
   BULL_AUTH_KEY=<your-secure-key>
   TEST_API_KEY=<your-secure-key>
   ```
4. Generate a public domain to access the API

#### 5. Create Worker Service

1. Click "+ New" → "GitHub Repo" → Select your repository
2. Configure the service:
   - **Service Name**: `firecrawl-worker`
   - **Root Directory**: `/apps/api`
   - **Start Command**: `pnpm run workers`
   - **Watch Paths**: `apps/api/**`
3. Add the same environment variables as the API service
4. **Important**: Do NOT generate a public domain (workers don't need public access)

### Railway Private Networking

Railway automatically provides private networking between services using the `railway.internal` domain. Services communicate securely using:

- `http://` protocol (not `https://`) for internal communication
- `${{service-name.RAILWAY_PRIVATE_DOMAIN}}` for service discovery
- Port must be set as an environment variable for references to work

### Service Dependencies

The services have the following dependencies:

```
Redis (independent)
  ↓
puppeteer-service (depends on: none)
  ↓
firecrawl-api (depends on: Redis, puppeteer-service)
  ↓
firecrawl-worker (depends on: Redis, puppeteer-service, firecrawl-api)
```

## API Usage

### Health Check

```bash
curl https://your-api-domain.railway.app/health
```

Response:
```json
{
  "status": "healthy",
  "service": "firecrawl-api"
}
```

### Scrape a Single URL

```bash
curl -X POST https://your-api-domain.railway.app/v1/scrape \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com"
  }'
```

Response:
```json
{
  "success": true,
  "id": "job-id-here"
}
```

### Check Scrape Status

```bash
curl https://your-api-domain.railway.app/v1/scrape/job-id-here \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Crawl a Website

```bash
curl -X POST https://your-api-domain.railway.app/v1/crawl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "limit": 10,
    "includePaths": ["blog/*"],
    "excludePaths": ["admin/*"]
  }'
```

## Monitoring and Logging

### Railway Dashboard

- View real-time logs for each service
- Monitor resource usage (CPU, memory, network)
- Track deployment history and rollbacks
- Set up webhook notifications for failures

### Health Endpoints

- **API**: `GET /health`
- **Puppeteer Service**: `GET /health`
- **Detailed Queue Status**: `GET /serverHealthCheck`

## Troubleshooting

### Puppeteer Service Fails to Start

If the puppeteer service has issues with browser dependencies:

1. Check Railway logs for missing system libraries
2. Create a `nixpacks.toml` in the repository root:

```toml
[phases.setup]
nixPkgs = ["chromium", "nss", "freetype", "harfbuzz", "ca-certificates", "ttf-freefont"]
```

### Services Can't Communicate

1. Verify `RAILWAY_PRIVATE_DOMAIN` variable reference is correct
2. Ensure using `http://` (not `https://`) for private networking
3. Check that PORT is set as an environment variable on puppeteer service
4. Review Railway networking logs for DNS resolution errors

### Worker Not Processing Jobs

1. Verify `REDIS_URL` is identical for API and worker services
2. Check worker logs for connection errors
3. Ensure `NUM_WORKERS_PER_QUEUE` is set appropriately
4. Verify BullMQ queue names match between API and worker

### Build Timeouts

1. Verify `pnpm-lock.yaml` files are committed to the repository
2. Check Railway plan limits and resource allocation
3. Consider upgrading Railway plan if needed

## Performance Optimization

- **Horizontal Scaling**: Increase the number of worker replicas during peak times
- **Caching**: Enable Redis caching for frequently scraped sites
- **Resource Limits**: Adjust `MAX_RAM` and `MAX_CPU` based on your Railway plan
- **Concurrency**: Tune `NUM_WORKERS_PER_QUEUE` and `MAX_CONCURRENCY` for optimal throughput

## Security Considerations

- Store API keys in Railway environment variables (never commit to git)
- Keep Redis and puppeteer service private (no public domains)
- Implement rate limiting to prevent abuse
- Use strong authentication keys for production
- Configure CORS appropriately for your use case

## Contributing

When making changes:

1. Test locally before pushing
2. Railway auto-deploys on git push to main branch
3. Monitor deployment logs in Railway dashboard
4. Use Railway's rollback feature if issues occur

## License

ISC

## Support

For issues and questions:

- Check Railway documentation: https://docs.railway.app
- Review application logs in Railway dashboard
- Open an issue in this repository

## Acknowledgments

Built with:
- Express.js - Web framework
- BullMQ - Job queue system
- Puppeteer/Ulixee Hero - Browser automation
- Redis - Caching and queue backend
- Railway - Deployment platform

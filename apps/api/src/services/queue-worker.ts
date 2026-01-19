import "dotenv/config";
import { CustomError } from "../lib/custom-error";
import {
  getScrapeQueue,
  redisConnection,
  scrapeQueueName,
} from "./queue-service";
import { logtail } from "./logtail";
import { startWebScraperPipeline } from "../main/runWebScraper";
import { Logger } from "../lib/logger";
import { Job, Worker } from "bullmq";
import systemMonitor from "./system-monitor";
import { v4 as uuidv4 } from "uuid";
import {
  addCrawlJob,
  addCrawlJobDone,
  crawlToCrawler,
  finishCrawl,
  getCrawl,
  getCrawlJobs,
  lockURL,
} from "../lib/crawl-redis";
import { StoredCrawl } from "../lib/crawl-redis";
import { addScrapeJobRaw } from "./queue-jobs";
import {
  addJobPriority,
  deleteJobPriority,
  getJobPriority,
} from "../../src/lib/job-priority";
import { PlanType } from "../types";
import { getJobs } from "../../src/controllers/v1/crawl-status";
import { configDotenv } from "dotenv";
import { callWebhook } from "../../src/scraper/WebScraper/single_url";
configDotenv();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 15000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

// Usage counters for periodic capacity logs (reset every 60s)
let jobsCompleted60 = 0;
let jobsFailed60 = 0;
let resourceRejected60 = 0;
setInterval(() => {
  Logger.usage("worker", {
    event: "periodic",
    jobs_completed: jobsCompleted60,
    jobs_failed: jobsFailed60,
    resource_rejected: resourceRejected60,
  });
  jobsCompleted60 = 0;
  jobsFailed60 = 0;
  resourceRejected60 = 0;
}, 60000);

const processJobInternal = async (token: string, job: Job) => {
  const extendLockInterval = setInterval(async () => {
    Logger.info(`🐂 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  await addJobPriority(job.data.team_id, job.id);
  let err = null;
  try {
    const result = await processJob(job, token);
    try {
      await job.moveToCompleted(result.docs, token, false);
    } catch (e) {}
  } catch (error) {
    console.log("Job failed, error:", error);
    err = error;
    await job.moveToFailed(error, token, false);
  } finally {
    await deleteJobPriority(job.data.team_id, job.id);
    clearInterval(extendLockInterval);
  }

  return err;
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
});

const workerFun = async (
  queueName: string,
  processJobInternal: (token: string, job: Job) => Promise<any>,
) => {
  const worker = new Worker(queueName, null, {
    connection: redisConnection,
    lockDuration: 1 * 60 * 1000,
    stalledInterval: 30 * 1000,
    maxStalledCount: 10,
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;

  while (true) {
    if (isShuttingDown) {
      console.log("No longer accepting new jobs. SIGINT");
      break;
    }
    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();
    if (!canAcceptConnection) {
      resourceRejected60 += 1;
      await sleep(cantAcceptConnectionInterval);
      continue;
    }

    const job = await worker.getNextJob(token);
    if (job) {
      await processJobInternal(token, job);

      await sleep(gotJobInterval);
    } else {
      await sleep(connectionMonitorInterval);
    }
  }
};

const numWorkers = Math.max(1, parseInt(process.env.NUM_WORKERS_PER_QUEUE || "1", 10));
Logger.info(`Starting ${numWorkers} worker(s) for queue ${scrapeQueueName}`);
Logger.usage("worker", { event: "startup", num_workers: numWorkers, queue: scrapeQueueName });
for (let i = 0; i < numWorkers; i++) {
  workerFun(scrapeQueueName, processJobInternal);
}

async function processJob(job: Job, token: string) {
  const start = Date.now();
  Logger.info(`🐂 Worker taking job ${job.id}`);

  const countsStart = await getScrapeQueue().getJobCounts();
  Logger.usage("worker", {
    event: "job_start",
    job_id: String(job.id),
    queue_waiting: countsStart.waiting,
    queue_active: countsStart.active,
  });

  if (
    job.data.url &&
    (job.data.url.includes("researchhub.com") ||
      job.data.url.includes("ebay.com") ||
      job.data.url.includes("youtube.com"))
  ) {
    Logger.info(`🐂 Blocking job ${job.id} with URL ${job.data.url}`);
    const data = {
      success: false,
      docs: [],
      project_id: job.data.project_id,
      error:
        "URL is blocked. Suspecious activity detected. Please contact hello@firecrawl.com if you believe this is an error.",
    };
    const cBlock = await getScrapeQueue().getJobCounts();
    Logger.usage("worker", {
      event: "job_done",
      job_id: String(job.id),
      success: false,
      duration_ms: Date.now() - start,
      queue_waiting: cBlock.waiting,
      queue_active: cBlock.active,
      blocked: true,
    });
    await job.moveToCompleted(data.docs, token, false);
    return data;
  }

  try {
    job.updateProgress({
      current: 1,
      total: 100,
      current_step: "SCRAPING",
      current_url: "",
    });

    const { success, message, docs } = await startWebScraperPipeline({
      job,
      token,
    });

    if (!success) {
      throw new Error(message);
    }

    const rawHtml = docs[0] ? docs[0].rawHtml : "";

    const data = {
      success,
      result: {
        links: docs.map((doc) => {
          return {
            content: doc,
            source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
          };
        }),
      },
      project_id: job.data.project_id,
      error: message /* etc... */,
      docs,
    };

    if (job.data.crawl_id) {
      await addCrawlJobDone(job.data.crawl_id, job.id);

      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

      // Only auto-crawl if explicitly enabled
      if (job.data.enableAutoCrawl && !job.data.sitemapped) {
        if (!sc.cancelled) {
          const crawler = crawlToCrawler(job.data.crawl_id, sc);

          const links = crawler.extractLinksFromHTML(
            rawHtml,
            docs[0]?.metadata?.sourceURL ?? docs[0]?.url ?? "",
          );

          for (const link of links) {
            if (await lockURL(job.data.crawl_id, sc, link)) {
              const jobPriority = await getJobPriority({
                plan: sc.plan as PlanType,
                team_id: sc.team_id,
                basePriority: job.data.crawl_id ? 20 : 10,
              });
              Logger.debug(`🐂 Adding scrape job for link ${link}`);
              const newJob = await addScrapeJobRaw(
                {
                  url: link,
                  mode: "single_urls",
                  crawlerOptions: sc.crawlerOptions,
                  team_id: sc.team_id,
                  pageOptions: sc.pageOptions,
                  webhookUrls: job.data.webhookUrls,
                  webhookMetadata: job.data.webhookMetadata,
                  origin: job.data.origin,
                  crawl_id: job.data.crawl_id,
                  v1: job.data.v1,
                  enableAutoCrawl: job.data.enableAutoCrawl,
                },
                {},
                uuidv4(),
                jobPriority,
              );

              await addCrawlJob(job.data.crawl_id, newJob.id);
            }
          }
        }
      }

      await finishCrawl(job.data.crawl_id);
    }

    jobsCompleted60 += 1;
    const end = Date.now();
    const cDone = await getScrapeQueue().getJobCounts();
    Logger.usage("worker", {
      event: "job_done",
      job_id: String(job.id),
      success: true,
      duration_ms: end - start,
      queue_waiting: cDone.waiting,
      queue_active: cDone.active,
    });
    Logger.info(`🐂 Job done ${job.id}`);
    return data;
  } catch (error) {
    Logger.error(`🐂 Job errored ${job.id} - ${error}`);

    if (error instanceof CustomError) {
      Logger.error(error.message);

      logtail.error("Custom error while ingesting", {
        job_id: job.id,
        error: error.message,
        dataIngestionJob: error.dataIngestionJob,
      });
    }
    Logger.error(error);
    if (error.stack) {
      Logger.error(error.stack);
    }

    logtail.error("Overall error ingesting", {
      job_id: job.id,
      error: error.message,
    });

    jobsFailed60 += 1;
    const end = Date.now();
    const cFail = await getScrapeQueue().getJobCounts();
    Logger.usage("worker", {
      event: "job_done",
      job_id: String(job.id),
      success: false,
      duration_ms: end - start,
      queue_waiting: cFail.waiting,
      queue_active: cFail.active,
    });

    const data = {
      success: false,
      docs: [],
      project_id: job.data.project_id,
      error:
        "Something went wrong... Contact help@mendable.ai or try again." /* etc... */,
    };

    return data;
  }
}

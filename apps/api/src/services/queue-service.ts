import { Queue } from "bullmq";
import { Logger } from "../lib/logger";
import IORedis from "ioredis";

let scrapeQueue: Queue;

export const redisConnection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableOfflineQueue: true,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
  keepAlive: 30000,
  connectTimeout: 10000,
  lazyConnect: false,
});

export const scrapeQueueName = "{scrapeQueue}";

export function getScrapeQueue(): Queue<any> {
  if (!scrapeQueue) {
    scrapeQueue = new Queue(scrapeQueueName, {
      connection: redisConnection,
      defaultJobOptions: {
        removeOnComplete: {
          age: 90000, // 25 hours
        },
        removeOnFail: {
          age: 90000, // 25 hours
        },
      },
    });
    Logger.info("Web scraper queue created");
  }
  return scrapeQueue;
}

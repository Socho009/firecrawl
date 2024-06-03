import { CustomError } from "../lib/custom-error";
import { getTempWebScraperQueue, getWebScraperQueue } from "./queue-service";
import "dotenv/config";
import { logtail } from "./logtail";
import { startWebScraperPipeline } from "../main/runWebScraper";
import { callWebhook } from "./webhook";
import { logJob } from "./logging/log_job";
// import { initSDK } from '@hyperdx/node-opentelemetry';
import type { Job, DoneCallback } from "bull";

let isShuttingDown = false;

// if (process.env.ENV === 'production') {
//   initSDK({ consoleCapture: true, additionalInstrumentations: []});
// }

const workOnJob = async (job: Job, done: DoneCallback) => {
  try {
    job.progress({
      current: 1,
      total: 100,
      current_step: "SCRAPING",
      current_url: "",
    });
    const start = Date.now();

    const { success, message, docs } = await startWebScraperPipeline({ job });
    const end = Date.now();
    const timeTakenInSeconds = (end - start) / 1000;

    const data = {
      success: success,
      result: {
        links: docs.map((doc) => {
          return { content: doc, source: doc?.metadata?.sourceURL ?? doc?.url ?? "" };
        }),
      },
      project_id: job.data.project_id,
      error: message /* etc... */,
    };

    await callWebhook(job.data.team_id, data);

    await logJob({
      success: success,
      message: message,
      num_docs: docs.length,
      docs: docs,
      time_taken: timeTakenInSeconds,
      team_id: job.data.team_id,
      mode: "crawl",
      url: job.data.url,
      crawlerOptions: job.data.crawlerOptions,
      pageOptions: job.data.pageOptions,
      origin: job.data.origin,
    });
    done(null, data);
  } catch (error) {
    if (error instanceof CustomError) {
      // Here we handle the error, then save the failed job
      console.error(error.message); // or any other error handling

      logtail.error("Custom error while ingesting", {
        job_id: job.id,
        error: error.message,
        dataIngestionJob: error.dataIngestionJob,
      });
    }
    console.log(error);

    logtail.error("Overall error ingesting", {
      job_id: job.id,
      error: error.message,
    });

    const data = {
      success: false,
      project_id: job.data.project_id,
      error:
        "Something went wrong... Contact help@mendable.ai or try again." /* etc... */,
    };
    await callWebhook(job.data.team_id, data);
    await logJob({
      success: false,
      message: typeof error === 'string' ? error : (error.message ?? "Something went wrong... Contact help@mendable.ai"),
      num_docs: 0,
      docs: [],
      time_taken: 0,
      team_id: job.data.team_id,
      mode: "crawl",
      url: job.data.url,
      crawlerOptions: job.data.crawlerOptions,
      pageOptions: job.data.pageOptions,
      origin: job.data.origin,
    });
    done(null, data);
  }
}

getWebScraperQueue().process(
  Math.floor(Number(process.env.NUM_WORKERS_PER_QUEUE ?? 8)),
  workOnJob
);

async function closeGracefully() {
  console.log('Starting graceful shutdown...');
  const webScraperQueue = getWebScraperQueue();
  const tempWebScraperQueue = getTempWebScraperQueue();

  console.log('Moving active jobs to temp queue...');
  try {
    const activeJobsOnWebScraperQueue = await webScraperQueue.getActive();
    console.log('Active jobs:', activeJobsOnWebScraperQueue.map(job => job.id));

    const moveJobPromises = activeJobsOnWebScraperQueue.map(async (job) => {
      console.log('Moving job:', job.id);
      try {
        await job.moveToFailed({ message: 'Graceful shutdown' }, true);
        console.log(`Job ${job.id} moved to failed.`);
        await tempWebScraperQueue.add({ ...job.data }, { jobId: job.id });
        console.log(`Job ${job.id} added to temp queue.`);
      } catch (error) {
        console.error(`Error moving job ${job.id}:`, error);
      }
    });

    await Promise.all(moveJobPromises);
    console.log('All active jobs moved to temp queue.');
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
  }

  console.log('Graceful shutdown complete. Exiting process.');
}

const shutdown = async (signal: string) => {
  isShuttingDown = true;
  console.log(`${signal} signal received.`);
  await closeGracefully();
  console.log('Finished closeGracefully... bye...')
  process.exit(0);
};

process.on('SIGTERM', async () => await shutdown('SIGTERM'));
process.on('SIGINT', async () => await shutdown('SIGINT'));

getTempWebScraperQueue().process(1, (job, done) => {
  if (!isShuttingDown) {
    workOnJob(job, done);
  }
});

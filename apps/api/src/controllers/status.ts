import { Request, Response } from "express";
import { getTempWebScraperQueue, getWebScraperQueue } from "../../src/services/queue-service";

export async function crawlJobStatusPreviewController(req: Request, res: Response) {
  try {
    let job = await getWebScraperQueue().getJob(req.params.jobId);
    if (!job) {
      const tempJob = await getTempWebScraperQueue().getJob(req.params.jobId);
      if (!tempJob) {
        return res.status(404).json({ error: "Job not found" });
      }
      job = tempJob;
    }

    const { current, current_url, total, current_step, partialDocs } = await job.progress();
    res.json({
      status: await job.getState(),
      // progress: job.progress(),
      current: current,
      current_url: current_url,
      current_step: current_step,
      total: total,
      data: job.returnvalue,
      partial_data: partialDocs ?? [],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}

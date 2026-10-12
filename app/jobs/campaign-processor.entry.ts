import { startCampaignProcessor } from "./campaign-processor.server";

const worker = startCampaignProcessor();

console.info("[campaign-processor] Started; checking every minute.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.info(`[campaign-processor] Received ${signal}; draining active poll.`);
    void worker.stop().then(() => {
      console.info("[campaign-processor] Worker stopped.");
    });
  });
}

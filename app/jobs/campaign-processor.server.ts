import {
  processDueCampaigns,
  type CampaignProcessorOptions,
} from "../services/campaign-processor.server";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = 1_000;

export interface CampaignProcessorRunner {
  runOnce(): ReturnType<typeof processDueCampaigns>;
  stop(): Promise<void>;
}

/** Start a local worker; one poll runs at a time, even when Shopify work exceeds one minute. */
export function startCampaignProcessor(
  options: CampaignProcessorOptions & { intervalMs?: number; initialDelayMs?: number } = {},
): CampaignProcessorRunner {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("Campaign processor interval must be a positive integer.");
  }
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new RangeError("Campaign processor initial delay must be a non-negative integer.");
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activePoll: Promise<void> | undefined;
  const schedule = (delay = intervalMs) => {
    if (stopped) return;
    timer = setTimeout(() => {
      activePoll = processDueCampaigns(options)
        .then(() => undefined)
        .catch((error: unknown) => {
          (options.logger ?? console).error("[campaign-processor] Poll failed", error);
        })
        .finally(() => {
          activePoll = undefined;
          schedule();
        });
    }, delay);
  };

  const runOnce = () => processDueCampaigns(options);
  schedule(initialDelayMs);

  return {
    runOnce,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await activePoll;
    },
  };
}

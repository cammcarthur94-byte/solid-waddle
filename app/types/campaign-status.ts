export const CAMPAIGN_STATUSES = [
  "Draft",
  "Scheduled",
  "Running",
  "Completed",
  "Cancelled",
  "Failed",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

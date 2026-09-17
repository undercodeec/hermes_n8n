export const ADVERTISING_QUEUE = 'advertising-google-sync';
export const ADVERTISING_REFERENCE_PATTERN = /\bUC-[A-Z2-7]{22}\b/;

export interface AdvertisingSyncJobData {
  syncJobId?: string;
}

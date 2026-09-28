// Public configuration. Only the publishable (anon) key belongs here —
// never put the service-role key in this repository.
export const CONFIG = {
  APP_NAME: 'Daily Consultant Reports',
  // Optional logo shown in the app header and PDF header, e.g. 'img/logo.png'.
  LOGO_URL: null,

  SUPABASE_URL: 'https://klhqyozldjtnduopsouc.supabase.co',
  SUPABASE_KEY: 'sb_publishable_yWJWXT-OQ_Z5l8FP8DuE9Q_ON4uFGtB',
  PHOTO_BUCKET: 'report-photos',

  TIMEZONE: 'Asia/Riyadh',
  UTC_OFFSET: '+03:00', // Saudi Arabia has no daylight saving time.

  // Photo compression (Section 7.2)
  PHOTO_MAX_SIDE: 1600,
  PHOTO_MAX_MB: 0.3,
  MAX_PHOTOS: 20,

  // Free-tier limits (Section 12.1): storage and database are separate quotas.
  STORAGE_LIMIT_BYTES: 1024 * 1024 * 1024,
  DB_LIMIT_BYTES: 500 * 1024 * 1024,
  // The server stops accepting new photos / reports at these levels (margin below the quota),
  // so the meters and warnings are measured against them.
  STORAGE_STOP_BYTES: 950 * 1024 * 1024,
  DB_STOP_BYTES: 420 * 1024 * 1024,
  WARN_PERCENT: 75,
  DANGER_PERCENT: 90,

  // Archive: a range above this size is split into several ZIP files.
  ARCHIVE_PART_BYTES: 220 * 1024 * 1024,

  PAGE_SIZE: 25,
  HEARTBEAT_WARN_DAYS: 3,
};

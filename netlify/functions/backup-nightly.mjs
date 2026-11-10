// Every night at 3 AM Eastern (08:00 UTC): snapshot all app data into the backups store.
// Keeps the last 30 nightly snapshots. Manage, download and restore them from Profile › Site Backups.
import { runNightlyBackup } from './api.mjs';

export default async (req, context) => {
  const s = await runNightlyBackup(context);
  return new Response(`backup ${s.key} (${s.records} records)`);
};

export const config = { schedule: '0 8 * * *' };

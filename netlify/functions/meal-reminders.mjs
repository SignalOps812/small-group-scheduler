// Runs every hour: emails meal train volunteers the day before their date (from 9 AM in the train's time zone).
import { runMealReminders } from './api.mjs';

export default async (req, context) => {
  const sent = await runMealReminders(context);
  console.log(`[meal-reminders] sent ${sent}`);
  return new Response(`sent ${sent}`);
};

export const config = { schedule: '@hourly' };

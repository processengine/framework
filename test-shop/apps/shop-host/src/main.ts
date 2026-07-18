import { createCheckoutApplication } from './app.js';
import { loadConfig } from './config.js';

const application = await createCheckoutApplication(loadConfig());
await application.start();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await application.stop();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());


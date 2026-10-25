// A deployed image is controlled unless the operator explicitly selects live.
import { readRevision } from './revision.mjs';
readRevision(true);
const profile = process.env.SAINT_LOOK_DEPLOYMENT_PROFILE || 'controlled-http';
if (!['controlled-http', 'live'].includes(profile)) throw new Error('Unsupported deployment profile.');
process.env.SAINT_LOOK_DEPLOYMENT_PROFILE = profile;
if (profile === 'controlled-http') {
  await import('./start-controlled.mjs');
} else {
  if (process.env.SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED !== 'true'
    || !process.env.GEMINI_API_KEY?.trim() || !process.env.PHOTOROOM_API_KEY?.trim()) {
    throw new Error('Live provider configuration is incomplete.');
  }
  if (Object.keys(process.env).some(key => key.startsWith('SAINT_LOOK_TEST_') && process.env[key])) {
    throw new Error('Test overrides are not allowed in a live release.');
  }
  process.env.NODE_ENV = 'production';
  process.env.SAINT_LOOK_PROVIDER = 'live';
  await import('./server.mjs');
}

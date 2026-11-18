const { expo } = require('./app.json');

// The demo is the default. Never infer staging from a stray .env file.
const variant = process.env.HERMES_MOBILE_BUILD_VARIANT || 'demo';
if (!['demo', 'staging'].includes(variant)) throw new Error('Unknown mobile build variant.');

function testEndpoint(value) {
  if (!value) throw new Error('Both isolated HTTPS test endpoints are required for a staging build.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      ['localhost', '127.0.0.1'].includes(url.hostname) || url.hostname.endsWith('.invalid')) {
    throw new Error('Staging builds require explicit, reachable HTTPS test endpoints.');
  }
}

if (variant === 'staging') {
  if (process.env.HERMES_MOBILE_ISOLATED_TEST_CONFIRMED !== 'yes') {
    throw new Error('Confirm BOTH endpoints are isolated test systems, never production.');
  }
  testEndpoint(process.env.EXPO_PUBLIC_CRM_AUTH_BASE_URL);
  testEndpoint(process.env.EXPO_PUBLIC_HERMES_API_BASE_URL);
} else if (process.env.EXPO_PUBLIC_MOBILE_AUTH_MODE || process.env.EXPO_PUBLIC_MOBILE_INBOX_MODE ||
           process.env.EXPO_PUBLIC_CRM_AUTH_BASE_URL || process.env.EXPO_PUBLIC_HERMES_API_BASE_URL) {
  throw new Error('Demo build must not contain staging configuration.');
}

module.exports = {
  ...expo,
  name: variant === 'demo' ? 'Hermes CRM Demo - Test' : 'Hermes CRM Staging - Test',
  android: {
    ...expo.android,
    package: variant === 'demo' ? 'com.undercodeec.hermescrmdemo.test' : 'com.undercodeec.hermescrmstaging.test',
    allowBackup: false,
  },
};

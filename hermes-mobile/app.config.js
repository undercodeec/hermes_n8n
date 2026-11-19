// Single source of Expo app configuration; duplicate app.json would be ambiguous
// for expo-doctor when the build variant changes the package and display name.
const expo = {
  name: 'Hermes CRM Demo - Test',
  slug: 'hermes-crm-demo',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: { supportsTablet: true },
  android: {
    adaptiveIcon: {
      backgroundColor: '#F8FAFF',
      foregroundImage: './assets/android-icon-foreground.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: { favicon: './assets/favicon.png' },
  plugins: ['expo-secure-store', 'expo-font'],
};

// The demo is the default. Never infer staging from a stray .env file.
const variant = process.env.HERMES_MOBILE_BUILD_VARIANT || 'demo';
if (!['demo', 'staging', 'read-only-public'].includes(variant)) throw new Error('Unknown mobile build variant.');

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
  if (process.env.EXPO_PUBLIC_MOBILE_INBOX_MODE || process.env.HERMES_MOBILE_PUBLIC_READ_ONLY_CONFIRMED ||
      ['admincrm.undercodeec.com', 'api.undercodeec.com'].some((host) =>
        [process.env.EXPO_PUBLIC_CRM_AUTH_BASE_URL, process.env.EXPO_PUBLIC_HERMES_API_BASE_URL]
          .some((endpoint) => new URL(endpoint).hostname === host))) {
    throw new Error('The isolated auth + synthetic demo build cannot target public APIs or real Inbox.');
  }
} else if (variant === 'read-only-public') {
  if (process.env.HERMES_MOBILE_PUBLIC_READ_ONLY_CONFIRMED !== 'yes' ||
      process.env.EXPO_PUBLIC_MOBILE_AUTH_MODE !== 'staging' ||
      process.env.EXPO_PUBLIC_MOBILE_INBOX_MODE !== 'read-only' ||
      process.env.EXPO_PUBLIC_CRM_AUTH_BASE_URL !== 'https://api.undercodeec.com' ||
      process.env.EXPO_PUBLIC_HERMES_API_BASE_URL !== 'https://api.undercodeec.com') {
    throw new Error('Public API read-only test requires explicit, exact HTTPS CRM and Hermes URLs and both opt-ins.');
  }
} else if (process.env.EXPO_PUBLIC_MOBILE_AUTH_MODE || process.env.EXPO_PUBLIC_MOBILE_INBOX_MODE ||
           process.env.EXPO_PUBLIC_CRM_AUTH_BASE_URL || process.env.EXPO_PUBLIC_HERMES_API_BASE_URL) {
  throw new Error('Demo build must not contain staging configuration.');
}

module.exports = {
  ...expo,
  name: variant === 'demo' ? 'Hermes CRM Demo - Test' :
    variant === 'staging' ? 'Hermes CRM Staging - Test' : 'Hermes CRM Read-Only - Test',
  android: {
    ...expo.android,
    package: variant === 'demo' ? 'com.undercodeec.hermescrmdemo.test' :
      variant === 'staging' ? 'com.undercodeec.hermescrmstaging.test' : 'com.undercodeec.hermescrmreadonly.publicapitest',
    allowBackup: false,
    ...(variant === 'read-only-public' ? { blockedPermissions: [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.VIBRATE',
    ] } : {}),
  },
};

import type { CapacitorConfig } from '@capacitor/cli';

export const APP_NAME = 'Turnleaf';

const config: CapacitorConfig = {
  appId: 'app.turnleaf.reader',
  appName: APP_NAME,
  webDir: 'dist',
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
  },
  android: {
    // Kavita may be hosted on a local HTTP address; onboarding requires explicit confirmation.
    allowMixedContent: true,
  },
};

export default config;

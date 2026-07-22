import { APP_PROPERTIES } from '../app.properties';

/**
 * Ad configuration for Content-sprout landing.
 * Visibility is controlled by `APP_PROPERTIES.adsEnabled`.
 * Auto ad units work with client alone; fill slot IDs when you create dedicated units.
 */
export const ADS_CONFIG = {
  enabled: APP_PROPERTIES.adsEnabled,
  adsenseClient: 'ca-pub-8211818025464738' as string,
  slots: {
    mid: '' as string,
    bottom: '' as string,
  },
} as const;

export type AdPlacement = keyof typeof ADS_CONFIG.slots;

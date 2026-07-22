import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import { firebaseConfig, isFirebaseConfigured } from './firebase.config';

/** Initialize Firebase App + Analytics (browser only). No-ops until config is filled in. */
export async function initFirebase(): Promise<void> {
  if (!isFirebaseConfigured()) {
    console.info(
      '[Content-sprout] Firebase web config not set yet — Hosting deploy still works; Analytics skipped. See DEPLOY.md.',
    );
    return;
  }

  const app = initializeApp(firebaseConfig);
  if (await isSupported()) {
    getAnalytics(app);
  }
}

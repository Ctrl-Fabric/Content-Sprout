/**
 * Firebase web app config (Hosting + Analytics).
 *
 * After you create a Firebase project, replace these values with the Web app
 * config from Firebase Console → Project settings → Your apps,
 * or run: `npx firebase apps:sdkconfig web`
 *
 * Until then, Analytics init is skipped when `projectId` is still a placeholder.
 */
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'content-sprout.firebaseapp.com',
  projectId: 'content-sprout',
  storageBucket: 'content-sprout.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
  measurementId: '',
} as const;

/** True when real Firebase web credentials have been pasted in. */
export function isFirebaseConfigured(): boolean {
  return (
    !!firebaseConfig.apiKey &&
    firebaseConfig.apiKey !== 'REPLACE_ME' &&
    !!firebaseConfig.appId &&
    firebaseConfig.appId !== 'REPLACE_ME'
  );
}

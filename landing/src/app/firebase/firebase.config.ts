/**
 * Firebase web app config (Hosting + Analytics).
 * From Firebase Console → Project settings → Your apps.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyC0vyPac8Q3muIGZ8zzDSoA6IESChGDEMo',
  authDomain: 'content-sprout.firebaseapp.com',
  projectId: 'content-sprout',
  storageBucket: 'content-sprout.firebasestorage.app',
  messagingSenderId: '591388977909',
  appId: '1:591388977909:web:f29ec889c21447960433bc',
  measurementId: 'G-3F71LTP19S',
} as const;

/** True when Firebase web credentials are present. */
export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.appId && firebaseConfig.projectId);
}

export const environment = {
  production: false,
  /** JSON API — proxied to FastAPI by angular.json proxyConfig in development. */
  apiBase: '/api',
  /**
   * Media file URLs hit FastAPI directly so <video> Range/206 requests are not
   * rewritten by the Angular/Vite proxy (which surfaces as a MIME-type error).
   */
  mediaBase: 'http://127.0.0.1:17829/api',
  appName: 'Content-Sprout',
};

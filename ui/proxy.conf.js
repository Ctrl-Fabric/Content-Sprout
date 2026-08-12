/**
 * Dev proxy for JSON/API traffic. Media playback URLs use environment.mediaBase
 * (direct FastAPI) so Range requests are not buffered by the Angular proxy.
 */
const target = process.env.NG_PROXY_TARGET || 'http://127.0.0.1:17829';

module.exports = {
  '/api': {
    target,
    secure: false,
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
  },
};

// Same-origin production bundle against the local development API, including nginx's cookie path.
module.exports = {
  '/api': { target: 'http://localhost:3000', changeOrigin: true, pathRewrite: { '^/api': '' }, cookiePathRewrite: { '/auth': '/api/auth' } },
  '/socket.io': { target: 'http://localhost:3000', changeOrigin: true, ws: true },
};

// Development: ng serve on :4300 proxies /admin -> the admin API on :3002 (see proxy.conf.json), so the
// browser sees a single origin and the kanera_admin_rt cookie (path /admin/auth) is same-origin. Keep
// apiUrl empty so requests stay under /admin and match the cookie path.
export const environment = {
  production: false,
  apiUrl: "",
};

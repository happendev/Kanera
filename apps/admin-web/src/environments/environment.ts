// Production: the admin API and this SPA are served from the same origin (buildAdminServer static-serves
// dist/admin-web), so API paths like /admin/orgs are same-origin — no base URL needed.
export const environment = {
  production: true,
  apiUrl: "",
};

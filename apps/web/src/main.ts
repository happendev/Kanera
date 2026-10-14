import { initLocale } from "./app/core/i18n/locale";

// Translations must be loaded before any application module evaluates, because `$localize` and
// compiled `i18n` templates read them when they first run. So the app graph is imported only once
// the locale is ready; see core/i18n/locale.ts.
void initLocale().then(async () => {
  const [{ bootstrapApplication }, { AppComponent }, { appConfig }, { buildInfo }] = await Promise.all([
    import("@angular/platform-browser"),
    import("./app/app.component"),
    import("./app/app.config"),
    import("./build-info.generated"),
  ]);
  console.info(`[Kanera] Version: ${buildInfo.version}; build date: ${buildInfo.builtAt}`);
  console.info("Created by Happen Software Ltd. https://www.happen.software");
  await bootstrapApplication(AppComponent, appConfig);
}).catch((err) => console.error(err));

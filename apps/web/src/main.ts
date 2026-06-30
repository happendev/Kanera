import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import { buildInfo } from "./build-info.generated";

console.info(`[Kanera] Version: ${buildInfo.version}; build date: ${buildInfo.builtAt}`);
console.info("Created by Happen Software Ltd. https://www.happen.software");

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));

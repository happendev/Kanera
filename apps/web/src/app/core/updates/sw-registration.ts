import { ApplicationRef, inject } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import { Observable, filter, from, of, switchMap, take } from "rxjs";

/** Keep full offline installation, but don't compete with the first route or its icon/text fonts. */
export function registerAfterFirstScreen(): Observable<unknown> {
  const app = inject(ApplicationRef);
  const router = inject(Router);
  const navigation: Observable<unknown> = router.navigated ? of(null) : router.events.pipe(
    filter((event) => event instanceof NavigationEnd),
    take(1),
  );
  return navigation.pipe(
    switchMap(() => from(app.whenStable())),
    switchMap(() => from(document.fonts.ready)),
    switchMap(() => new Observable<void>((subscriber) => {
      const ready = () => { subscriber.next(); subscriber.complete(); };
      // A bounded idle request keeps installed/offline functionality available on busy pages.
      // Browsers without requestIdleCallback still yield past the initial render before fetching.
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(ready, { timeout: 5_000 });
        return () => window.cancelIdleCallback(id);
      }
      const id = window.setTimeout(ready, 1_000);
      return () => window.clearTimeout(id);
    })),
  );
}

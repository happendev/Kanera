import { DestroyRef, inject, signal, type Signal } from "@angular/core";

/**
 * A signal tracking a CSS media query, torn down with the injection context that created it.
 *
 * Some layout decisions cannot be expressed in CSS — how many day columns an activity strip should
 * *render*, for one — so the component has to read the same breakpoint its stylesheet uses. Keeping
 * that in one helper means callers only duplicate the query string, not the listener plumbing.
 *
 * Must be called from an injection context (a field initialiser or constructor). Resolves to `false`
 * wherever matchMedia is unavailable, so a missing API degrades to the wide layout rather than
 * throwing.
 */
export function mediaQuerySignal(query: string): Signal<boolean> {
  const matches = signal(false);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return matches.asReadonly();

  const mql = window.matchMedia(query);
  matches.set(mql.matches);
  const onChange = (event: MediaQueryListEvent) => matches.set(event.matches);
  mql.addEventListener("change", onChange);
  inject(DestroyRef).onDestroy(() => mql.removeEventListener("change", onChange));
  return matches.asReadonly();
}

import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router } from "@angular/router";
import type { VersionDetectedEvent, VersionReadyEvent } from "@angular/service-worker";
import { SwUpdate } from "@angular/service-worker";
import { fromEvent } from "rxjs";
import { filter } from "rxjs/operators";

@Injectable({ providedIn: "root" })
export class UpdatesService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly updateAvailable = signal(false);

  constructor() {
    if (!this.swUpdate.isEnabled) return;
    this.listenForVersionUpdates();
    this.listenForUnrecoverable();
    this.listenForNavigation();
    this.setupVisibilityPolling();
  }

  private listenForVersionUpdates(): void {
    this.swUpdate.versionUpdates
      .pipe(
        filter((evt): evt is VersionDetectedEvent | VersionReadyEvent => evt.type === "VERSION_DETECTED" || evt.type === "VERSION_READY"),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((evt) => {
        if (evt.type === "VERSION_DETECTED") {
          console.log("[Admin SW] New version available:", evt.version.hash);
          return;
        }

        console.log("[Admin SW] New version ready:", evt.currentVersion.hash, "->", evt.latestVersion.hash);
        this.updateAvailable.set(true);
      });
  }

  private listenForUnrecoverable(): void {
    this.swUpdate.unrecoverable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((evt) => {
      console.warn("[Admin SW] Unrecoverable state:", evt.reason, "- reloading");
      document.location.reload();
    });
  }

  private listenForNavigation(): void {
    this.router.events
      .pipe(
        filter((evt) => evt instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        if (!this.updateAvailable()) return;
        void this.applyUpdate();
      });
  }

  private setupVisibilityPolling(): void {
    void this.checkForUpdate();
    fromEvent(document, "visibilitychange")
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (document.visibilityState === "visible") {
          void this.checkForUpdate();
        }
      });
  }

  async checkForUpdate(): Promise<void> {
    if (!this.swUpdate.isEnabled) return;

    try {
      const updateFound = await this.swUpdate.checkForUpdate();
      if (updateFound) this.updateAvailable.set(true);
    } catch (err) {
      console.warn("[Admin SW] checkForUpdate failed:", err);
    }
  }

  async applyUpdate(force = false): Promise<void> {
    try {
      if (!force) await this.swUpdate.activateUpdate();
    } finally {
      document.location.reload();
    }
  }
}

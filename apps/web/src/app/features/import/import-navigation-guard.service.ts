import { computed, inject, Injectable, signal } from "@angular/core";
import type { CanActivateFn, CanDeactivateFn } from "@angular/router";
import { ConfirmService } from "../../shared/confirm.service";

@Injectable({ providedIn: "root" })
export class ImportNavigationGuardService {
  private readonly confirm = inject(ConfirmService);
  private readonly runningImport = signal(false);

  readonly isImportRunning = computed(() => this.runningImport());

  setImportRunning(running: boolean): void {
    this.runningImport.set(running);
  }

  async confirmNavigation(): Promise<boolean> {
    if (!this.runningImport()) return true;
    return this.confirm.open({
      title: "Leave this import?",
      message: "The import is still running. Leaving this page may cancel it before Trello attachments finish copying.",
      confirmLabel: "Leave import",
      danger: true,
    });
  }
}

export const importNavigationCanActivateGuard: CanActivateFn = () =>
  inject(ImportNavigationGuardService).confirmNavigation();

export const importNavigationCanDeactivateGuard: CanDeactivateFn<unknown> = () =>
  inject(ImportNavigationGuardService).confirmNavigation();

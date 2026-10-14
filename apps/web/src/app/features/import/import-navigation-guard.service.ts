import { inject, Injectable, signal } from "@angular/core";
import type { CanActivateFn, CanDeactivateFn } from "@angular/router";
import { ConfirmService } from "../../shared/confirm.service";

@Injectable({ providedIn: "root" })
export class ImportNavigationGuardService {
  private readonly confirm = inject(ConfirmService);
  private readonly runningImport = signal(false);

  setImportRunning(running: boolean): void {
    this.runningImport.set(running);
  }

  async confirmNavigation(): Promise<boolean> {
    if (!this.runningImport()) return true;
    return this.confirm.open({
      title: $localize`:Confirm dialog title:Leave this import?`,
      message: $localize`The import is still running. Leaving this page may cancel it before Trello attachments finish copying.`,
      confirmLabel: $localize`:Button — leave the page while an import runs:Leave import`,
      danger: true,
    });
  }
}

export const importNavigationCanActivateGuard: CanActivateFn = () =>
  inject(ImportNavigationGuardService).confirmNavigation();

export const importNavigationCanDeactivateGuard: CanDeactivateFn<unknown> = () =>
  inject(ImportNavigationGuardService).confirmNavigation();

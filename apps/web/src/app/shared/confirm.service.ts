import { ApplicationRef, createComponent, EnvironmentInjector, inject, Injectable } from "@angular/core";
import { ConfirmDialogComponent } from "./confirm-dialog.component";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

@Injectable({ providedIn: "root" })
export class ConfirmService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);

  open(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const ref = createComponent(ConfirmDialogComponent, { environmentInjector: this.injector });
      ref.setInput("title", options.title);
      if (options.message) ref.setInput("message", options.message);
      if (options.confirmLabel) ref.setInput("confirmLabel", options.confirmLabel);
      if (options.danger !== undefined) ref.setInput("danger", options.danger);

      ref.instance.result.subscribe((confirmed) => {
        resolve(confirmed);
        this.appRef.detachView(ref.hostView);
        ref.destroy();
      });

      this.appRef.attachView(ref.hostView);
      document.body.appendChild(ref.location.nativeElement);
    });
  }
}

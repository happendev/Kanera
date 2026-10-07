import { ApplicationRef, createComponent, EnvironmentInjector, inject, Injectable, type ComponentRef } from "@angular/core";
import { ConfirmDialogComponent } from "./confirm-dialog.component";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  confirmationText?: string;
}

@Injectable({ providedIn: "root" })
export class ConfirmService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);

  open(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const ref = this.createDialog(options);
      if (options.message) ref.setInput("message", options.message);

      ref.instance.result.subscribe((confirmed) => {
        resolve(confirmed);
        this.unmount(ref);
      });

      this.mount(ref);
    });
  }

  openAfterLoading(options: ConfirmOptions & { loadingMessage: string }, loadMessage: () => Promise<string>): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const ref = this.createDialog(options);
      let closed = false;
      ref.setInput("message", options.loadingMessage);
      ref.setInput("loading", true);

      const close = () => this.unmount(ref);
      ref.instance.result.subscribe((confirmed) => {
        closed = true;
        resolve(confirmed);
        close();
      });

      this.mount(ref);

      void loadMessage().then((message) => {
        if (closed) return;
        ref.setInput("message", message);
        ref.setInput("loading", false);
      }).catch((error: unknown) => {
        if (closed) return;
        closed = true;
        close();
        reject(error instanceof Error ? error : new Error("Could not load confirmation details"));
      });
    });
  }

  /** A dialog with the shared inputs applied; `message` is set by each opener since loading swaps it. */
  private createDialog(options: ConfirmOptions): ComponentRef<ConfirmDialogComponent> {
    const ref = createComponent(ConfirmDialogComponent, { environmentInjector: this.injector });
    ref.setInput("title", options.title);
    if (options.confirmLabel) ref.setInput("confirmLabel", options.confirmLabel);
    if (options.danger !== undefined) ref.setInput("danger", options.danger);
    if (options.confirmationText !== undefined) ref.setInput("confirmationText", options.confirmationText);
    return ref;
  }

  private mount(ref: ComponentRef<ConfirmDialogComponent>): void {
    this.appRef.attachView(ref.hostView);
    document.body.appendChild(ref.location.nativeElement);
  }

  private unmount(ref: ComponentRef<ConfirmDialogComponent>): void {
    this.appRef.detachView(ref.hostView);
    ref.destroy();
  }
}

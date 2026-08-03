import { DIALOG_DATA, DialogRef } from "@angular/cdk/dialog";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";

export type CreateOrganisationDialogData = { hosted: boolean };
export type CreateOrganisationResult = { accessToken: string; user: AuthUser };

const DIALOG_STYLES = `
  :host { display: block; width: min(440px, calc(100vw - 32px)); }
  .organisation-dialog { background: var(--surface, #fff); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 20px 50px rgb(0 0 0 / 18%); padding: 20px; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  h2 { margin: 0 0 4px; color: var(--text); font-size: 18px; }
  p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.45; }
  label { display: grid; gap: 7px; color: var(--text); font-size: 13px; font-weight: 600; }
  input { width: 100%; }
  .error { margin-top: 12px; color: var(--danger, #dc2626); }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
`;

@Component({
  selector: "k-create-organisation-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="organisation-dialog" aria-labelledby="create-organisation-title">
      <header>
        <div>
          <h2 id="create-organisation-title">Create organisation</h2>
          <p>
            @if (data.hosted) {
              This organisation will have its own plan and billing.
            } @else {
              Create another independent organisation.
            }
          </p>
        </div>
        <button type="button" class="ghost icon" (click)="close()" aria-label="Close">
          <i class="ti ti-x"></i>
        </button>
      </header>

      <form (submit)="create(); $event.preventDefault()">
        <label>
          <span>Organisation name</span>
          <input autofocus [value]="name()" (input)="name.set($any($event.target).value)" maxlength="120" placeholder="e.g. Acme Studio" />
        </label>

        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }

        <footer>
          <button type="button" class="ghost" (click)="close()">Cancel</button>
          <button type="submit" [disabled]="busy() || !name().trim()">
            @if (busy()) { Creating… } @else { Create organisation }
          </button>
        </footer>
      </form>
    </section>
  `,
  styles: [DIALOG_STYLES],
})
export class CreateOrganisationDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly dialogRef = inject<DialogRef<CreateOrganisationResult | undefined>>(DialogRef);
  readonly data = inject<CreateOrganisationDialogData>(DIALOG_DATA);
  readonly name = signal("");
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  close(): void {
    this.dialogRef.close();
  }

  async create(): Promise<void> {
    const name = this.name().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const session = await this.api.post<CreateOrganisationResult>("/clients", { name });
      this.dialogRef.close(session);
    } catch (error) {
      this.error.set(error instanceof ApiError
        ? ((error.body as { message?: string } | undefined)?.message ?? "Could not create the organisation.")
        : "Could not create the organisation.");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "k-join-organisation-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="organisation-dialog" aria-labelledby="join-organisation-title">
      <header>
        <div>
          <h2 id="join-organisation-title">Join organisation</h2>
          <p>Enter an organisation invitation link or its invite token.</p>
        </div>
        <button type="button" class="ghost icon" (click)="close()" aria-label="Close">
          <i class="ti ti-x"></i>
        </button>
      </header>

      <form (submit)="join(); $event.preventDefault()">
        <label>
          <span>Invitation link or token</span>
          <input autofocus [value]="invite()" (input)="invite.set($any($event.target).value)" autocomplete="off" placeholder="Paste invitation link or token" />
        </label>

        <footer>
          <button type="button" class="ghost" (click)="close()">Cancel</button>
          <button type="submit" [disabled]="!invite().trim()">Continue</button>
        </footer>
      </form>
    </section>
  `,
  styles: [DIALOG_STYLES],
})
export class JoinOrganisationDialogComponent {
  private readonly dialogRef = inject<DialogRef<string | undefined>>(DialogRef);
  readonly invite = signal("");

  close(): void {
    this.dialogRef.close();
  }

  join(): void {
    const invite = this.invite().trim();
    if (invite) this.dialogRef.close(invite);
  }
}

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { API_KEY_NAME_MAX_LENGTH } from "@kanera/shared/dto/name-limits";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { AuthService } from "../../../core/auth/auth.service";
import { ConfirmService } from "../../../shared/confirm.service";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { AccountSettingsPage } from "../account-settings.page";

// Personal API keys are the caller's own, board-content-only credentials; the list carries no
// workspace/scope/creator fields (see the /me/api-keys response shape on the API).
interface PersonalApiKeyRow {
  id: string;
  label: string | null;
  keyPrefix: string;
  lastUsedAt: string | Date | null;
  revokedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface OauthConnectionRow {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  lastUsedAt: string | Date | null;
  createdAt: string | Date;
}

function apiKeyUsageTime(value: string | Date | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function sortPersonalApiKeys(keys: PersonalApiKeyRow[]): PersonalApiKeyRow[] {
  return [...keys].sort((a, b) =>
    apiKeyUsageTime(b.lastUsedAt) - apiKeyUsageTime(a.lastUsedAt)
    || apiKeyUsageTime(b.createdAt) - apiKeyUsageTime(a.createdAt));
}

@Component({
  selector: "k-account-settings-api-keys",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./api-keys.page.html",
  styleUrl: "./api-keys.page.scss",
})
export class AccountSettingsApiKeysPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  protected readonly settings = inject(AccountSettingsPage);

  // Personal API keys are gated behind the same paid entitlement as workspace keys; the server still
  // enforces it. The list/secret follow the one-time-reveal pattern used for MFA recovery codes.
  protected readonly apiAllowed = this.auth.apiAllowed;
  protected readonly personalApiKeys = signal<PersonalApiKeyRow[]>([]);
  protected readonly oauthConnections = signal<OauthConnectionRow[]>([]);
  protected readonly mcpUrl = signal("");
  protected readonly newPersonalKeyLabel = signal("");
  protected readonly revealedPersonalKeySecret = signal<string | null>(null);
  protected readonly personalKeyError = signal<string | null>(null);
  protected readonly personalKeyBusy = signal(false);
  protected readonly apiKeyNameMaxLength = API_KEY_NAME_MAX_LENGTH;

  constructor() {
    this.settings.selectedTab.set("api-keys");
  }

  async ngOnInit() {
    const [keys, connections, config] = await Promise.all([
      this.api.get<PersonalApiKeyRow[]>("/me/api-keys").catch(() => [] as PersonalApiKeyRow[]),
      this.api.get<OauthConnectionRow[]>("/me/oauth-connections").catch(() => [] as OauthConnectionRow[]),
      this.api.get<{ mcpUrl: string }>("/me/agent-connection-config").catch(() => ({ mcpUrl: "" })),
    ]);
    this.personalApiKeys.set(keys);
    this.oauthConnections.set(connections);
    this.mcpUrl.set(config.mcpUrl);
  }

  protected async createPersonalKey(e: Event) {
    e.preventDefault();
    if (this.personalKeyBusy()) return;
    this.personalKeyBusy.set(true);
    this.personalKeyError.set(null);
    try {
      const label = this.newPersonalKeyLabel().trim();
      const created = await this.api.post<PersonalApiKeyRow & { secret: string }>("/me/api-keys", label ? { label } : {});
      const { secret, ...row } = created;
      this.personalApiKeys.update((keys) => sortPersonalApiKeys([...keys, row]));
      // Show the plaintext secret once; it is never retrievable again.
      this.revealedPersonalKeySecret.set(secret);
      this.newPersonalKeyLabel.set("");
    } catch (err) {
      this.personalKeyError.set(extractErrorMessage(err));
    } finally {
      this.personalKeyBusy.set(false);
    }
  }

  protected async deletePersonalKey(id: string) {
    const key = this.personalApiKeys().find((item) => item.id === id);
    if (!key) return;
    const title = key.label ? `Delete "${key.label}"?` : "Delete this personal API key?";
    if (!await this.confirm.open({ title, message: "Anything using this key will lose access immediately." })) return;
    this.personalKeyError.set(null);
    try {
      await this.api.delete(`/me/api-keys/${id}`);
      this.personalApiKeys.update((keys) => keys.filter((item) => item.id !== id));
    } catch (err) {
      this.personalKeyError.set(extractErrorMessage(err));
    }
  }

  protected async revokeOauthConnection(id: string) {
    const connection = this.oauthConnections().find((item) => item.id === id);
    if (!connection) return;
    if (!await this.confirm.open({ title: `Disconnect ${connection.clientName}?`, message: "Its access and refresh tokens will stop working immediately." })) return;
    await this.api.delete(`/me/oauth-connections/${id}`);
    this.oauthConnections.update((items) => items.filter((item) => item.id !== id));
  }

  protected async copyText(value: string | null) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard?.writeText(value);
  }

  protected formatKeyLastUsed(value: string | Date | null | undefined): string {
    if (!value) return "Never";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Never";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const message = (err.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
    return "Unable to update personal API keys. Try again.";
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

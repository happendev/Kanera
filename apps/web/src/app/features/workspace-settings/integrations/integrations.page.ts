import { LOCALES, LOCALE_NATIVE_NAMES, type Locale } from "@kanera/shared/locales";
import { appLocale } from "../../../core/i18n/locale";
import { EmptyStateComponent } from "../../../shared/empty-state.component";
import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { UnsavedWorkService } from "../../../core/browser/unsaved-work.service";
import { AutosaveStatusComponent } from "../../../shared/autosave-status.component";
import { AutosaveTracker } from "../../../shared/autosave-tracker";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { ConfirmService } from "../../../shared/confirm.service";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { ToastService } from "../../../shared/toast.service";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";
import { formatDateTime } from "../../../shared/date-format";

type ChatProvider = "slack" | "discord" | "telegram" | "zulip";
type ChatEvent = "card_created" | "status_changed" | "priority_changed" | "title_changed" | "description_changed" | "comment_created";
interface ChatDestinationRow {
  locale: Locale;
  id: string;
  workspaceId: string;
  provider: ChatProvider;
  name: string;
  eventTypes: ChatEvent[];
  priorityFieldId: string | null;
  enabled: boolean;
  connectionSummary: string;
  lastSuccessfulAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface TestDeliveryResponse {
  status: "queued" | "delivering" | "success" | "failed";
  lastError: string | null;
}

const DEFAULT_EVENTS: ChatEvent[] = ["card_created", "status_changed", "title_changed", "description_changed", "comment_created"];

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: string; issues?: { message?: string }[] } | undefined;
    return body?.issues?.map((issue) => issue.message).filter(Boolean).join("; ")
      || body?.message
      || $localize`Something went wrong. Please try again.`;
  }
  return error instanceof Error ? error.message : $localize`Something went wrong. Please try again.`;
}

@Component({
  selector: "k-workspace-settings-integrations",
  standalone: true,
  imports: [AutosaveStatusComponent, EmptyStateComponent, DocsLinkComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./integrations.page.html",
  styleUrl: "./integrations.page.scss",
})
export class WorkspaceSettingsIntegrationsPage implements OnInit {
  protected readonly settings = inject(WorkspaceSettingsPage);
  private readonly api = inject(ApiClient);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  protected readonly pauseDestinationLabel = $localize`Pause destination`;
  protected readonly enableDestinationLabel = $localize`Enable destination`;
  protected readonly pauseLabel = $localize`:Button — pause the chat destination:Pause`;
  protected readonly enableLabel = $localize`:Button — resume the chat destination:Enable`;
  readonly providers = [
    { value: "slack" as const, label: "Slack", icon: "brand-slack" },
    { value: "discord" as const, label: "Discord", icon: "brand-discord" },
    { value: "telegram" as const, label: "Telegram", icon: "brand-telegram" },
    { value: "zulip" as const, label: "Zulip", icon: "brand-zulip" },
  ];
  readonly eventOptions: { value: ChatEvent; label: string; description: string }[] = [
    { value: "card_created", label: $localize`:Chat destination event:Card created`, description: $localize`:Chat destination event help:New work is added` },
    { value: "status_changed", label: $localize`:Chat destination event:Status changed`, description: $localize`:Chat destination event help:A card moves between lists` },
    { value: "priority_changed", label: $localize`:Chat destination event:Priority changed`, description: $localize`:Chat destination event help:The mapped field changes` },
    { value: "title_changed", label: $localize`:Chat destination event:Title changed`, description: $localize`:Chat destination event help:A card is renamed` },
    { value: "description_changed", label: $localize`:Chat destination event:Description changed`, description: $localize`:Chat destination event help:Card details are updated` },
    { value: "comment_created", label: $localize`:Chat destination event:Comment created`, description: $localize`:Chat destination event help:A teammate adds a comment` },
  ];

  readonly priorityMappingMissing = (destination: ChatDestinationRow): boolean =>
    destination.eventTypes.includes("priority_changed")
      && !this.priorityFields().some((field) => field.id === destination.priorityFieldId);
  readonly destinations = signal<ChatDestinationRow[]>([]);
  readonly loading = signal(true);
  readonly busyId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly provider = signal<ChatProvider>("slack");
  readonly localeOptions = LOCALES.map((value) => ({ value, label: LOCALE_NATIVE_NAMES[value] }));
  readonly locale = signal<Locale>(appLocale());
  readonly editingLocale = signal<Locale>(appLocale());
  readonly name = signal("");
  readonly webhookUrl = signal("");
  readonly botToken = signal("");
  readonly chatId = signal("");
  readonly threadId = signal("");
  readonly selectedEvents = signal<ReadonlySet<ChatEvent>>(new Set(DEFAULT_EVENTS));
  readonly priorityFieldId = signal("");
  readonly editingId = signal<string | null>(null);
  readonly editingName = signal("");
  readonly editingEvents = signal<ReadonlySet<ChatEvent>>(new Set());
  readonly editingPriorityFieldId = signal("");
  /** The destination editor autosaves; the chip fed by this is its only confirmation. */
  readonly editAutosave = new AutosaveTracker(inject(DestroyRef));
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly unsavedEditSource = Symbol("chat-destination-edit");
  /**
   * The editor draft differs from the saved row only while a change could not be sent: an empty
   * name, no events, or "priority changed" without a mapped field. Those are the edits a route
   * change or tab close would lose, so they mark unsaved work until the draft becomes valid.
   */
  private readonly editDirty = computed(() => {
    const id = this.editingId();
    const row = id ? this.destinations().find((destination) => destination.id === id) : undefined;
    if (!row) return false;
    const events = [...this.editingEvents()].sort();
    return this.editingLocale() !== row.locale
      || this.editingName().trim() !== row.name
      || events.join() !== [...row.eventTypes].sort().join()
      || (this.editingPriorityFieldId() || null) !== row.priorityFieldId;
  });
  private readonly syncUnsavedEdit = effect((onCleanup) => {
    this.unsavedWork.setDirty(this.unsavedEditSource, this.editDirty());
    onCleanup(() => this.unsavedWork.setDirty(this.unsavedEditSource, false));
  });
  readonly reconnectingId = signal<string | null>(null);
  readonly reconnectWebhookUrl = signal("");
  readonly reconnectBotToken = signal("");
  readonly reconnectChatId = signal("");
  readonly reconnectThreadId = signal("");
  readonly priorityFields = computed(() => this.settings.fields().filter((field) =>
    !field.archivedAt && (field.type === "select" || field.type === "text")
  ));

  constructor() {
    this.settings.selectedTab.set("integrations");
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  providerLabel(provider: ChatProvider): string {
    return this.providers.find((option) => option.value === provider)?.label ?? provider;
  }

  providerIcon(provider: ChatProvider): string {
    return this.providers.find((option) => option.value === provider)?.icon ?? "message";
  }

  eventLabel(event: string): string {
    return this.eventOptions.find((option) => option.value === event)?.label ?? (event === "chat:test" ? $localize`:Chat destination event — a test message:Test` : event);
  }

  setEvent(event: ChatEvent, checked: boolean, editing = false): void {
    const target = editing ? this.editingEvents : this.selectedEvents;
    const next = new Set(target());
    if (checked) next.add(event); else next.delete(event);
    target.set(next);
    if (event === "priority_changed" && !checked) {
      (editing ? this.editingPriorityFieldId : this.priorityFieldId).set("");
    }
    if (editing) void this.saveEdit();
  }

  setEditingPriorityField(fieldId: string): void {
    this.editingPriorityFieldId.set(fieldId);
    void this.saveEdit();
  }

  async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.name().trim();
    if (!name || this.selectedEvents().size === 0) return;
    if (this.selectedEvents().has("priority_changed") && !this.priorityFieldId()) {
      this.error.set($localize`Choose a Priority custom field.`);
      return;
    }
    const provider = this.provider();
    const credentials = provider === "telegram"
      ? {
          botToken: this.botToken().trim(),
          chatId: this.chatId().trim(),
          threadId: this.threadId().trim() ? Number(this.threadId()) : null,
        }
      : { webhookUrl: this.webhookUrl().trim() };
    this.busyId.set("create");
    this.clearMessages();
    try {
      const created = await this.api.post<ChatDestinationRow>(`/workspaces/${this.settings.workspaceId()}/chat-destinations`, {
        provider,
        locale: this.locale(),
        name,
        eventTypes: [...this.selectedEvents()],
        priorityFieldId: this.priorityFieldId() || null,
        enabled: true,
        credentials,
      });
      this.destinations.update((rows) => [created, ...rows]);
      this.name.set("");
      this.webhookUrl.set("");
      this.botToken.set("");
      this.chatId.set("");
      this.threadId.set("");
      this.priorityFieldId.set("");
      this.selectedEvents.set(new Set(DEFAULT_EVENTS));
      this.toasts.success($localize`:Toast; the chat product name precedes:${this.providerLabel(provider)}:provider: destination created.`);
    } catch (error) {
      this.error.set(extractErrorMessage(error));
    } finally {
      this.busyId.set(null);
    }
  }

  startEdit(destination: ChatDestinationRow): void {
    this.editingId.set(destination.id);
    this.editingName.set(destination.name);
    this.editingLocale.set(destination.locale);
    this.editingEvents.set(new Set(destination.eventTypes));
    this.editingPriorityFieldId.set(destination.priorityFieldId ?? "");
    this.editAutosave.reset();
    this.reconnectingId.set(null);
    this.clearMessages();
  }

  /**
   * Autosave for the open destination editor: runs on name blur and on every event or field change.
   * An invalid draft is kept on screen with a hint instead of being sent; the next valid change
   * sends the whole draft, so nothing is lost as long as the editor stays open.
   */
  async saveEdit(): Promise<void> {
    const id = this.editingId();
    const row = id ? this.destinations().find((destination) => destination.id === id) : undefined;
    if (!row || !this.editDirty()) return;
    if (!this.editingName().trim()) {
      this.error.set($localize`Give the destination a name.`);
      return;
    }
    if (this.editingEvents().size === 0) {
      this.error.set($localize`Choose at least one event to post.`);
      return;
    }
    if (this.editingEvents().has("priority_changed") && !this.editingPriorityFieldId()) {
      this.error.set($localize`Choose a Priority custom field.`);
      return;
    }
    // A concurrent PATCH (a fast second click) reuses busyId; let it finish and the caller's
    // next change re-sends the complete draft.
    if (this.busyId() === row.id) return;
    this.editAutosave.markSaving();
    const saved = await this.patch(row.id, {
      name: this.editingName().trim(),
      locale: this.editingLocale(),
      eventTypes: [...this.editingEvents()],
      priorityFieldId: this.editingPriorityFieldId() || null,
    });
    if (saved) this.editAutosave.markSaved();
    else this.editAutosave.markError();
  }

  /** Closes the editor. A draft that could not be saved is dropped, but only after the user confirms. */
  finishEdit(): void {
    if (!this.unsavedWork.confirm(this.editDirty())) return;
    this.editingId.set(null);
    this.editAutosave.reset();
    this.clearMessages();
  }

  startReconnect(destination: ChatDestinationRow): void {
    this.reconnectingId.set(destination.id);
    this.editingId.set(null);
    this.reconnectWebhookUrl.set("");
    this.reconnectBotToken.set("");
    this.reconnectChatId.set("");
    this.reconnectThreadId.set("");
    this.clearMessages();
  }

  async replaceConnection(destination: ChatDestinationRow): Promise<void> {
    const credentials = destination.provider === "telegram"
      ? {
          botToken: this.reconnectBotToken().trim(),
          chatId: this.reconnectChatId().trim(),
          threadId: this.reconnectThreadId().trim() ? Number(this.reconnectThreadId()) : null,
        }
      : { webhookUrl: this.reconnectWebhookUrl().trim() };
    if (await this.patch(destination.id, { credentials })) {
      this.reconnectingId.set(null);
      this.reconnectWebhookUrl.set("");
      this.reconnectBotToken.set("");
      this.reconnectChatId.set("");
      this.reconnectThreadId.set("");
      this.toasts.success($localize`Connection replaced.`);
    }
  }

  async toggle(destination: ChatDestinationRow): Promise<void> {
    await this.patch(destination.id, { enabled: !destination.enabled });
  }

  async sendTest(destination: ChatDestinationRow): Promise<void> {
    this.busyId.set(destination.id);
    this.clearMessages();
    try {
      const delivery = await this.api.post<TestDeliveryResponse>(`/workspaces/${this.settings.workspaceId()}/chat-destinations/${destination.id}/test`, {});
      if (delivery.status === "success") this.toasts.success($localize`:Toast:Test delivered to ${destination.name}:destination:.`);
      else this.error.set(delivery.lastError ?? $localize`The test delivery failed.`);
    } catch (error) {
      this.error.set(extractErrorMessage(error));
    } finally {
      this.busyId.set(null);
    }
  }

  async remove(destination: ChatDestinationRow): Promise<void> {
    if (!await this.confirm.open({
      title: $localize`:Confirm dialog title:Delete ${destination.name}:destination:?`,
      message: $localize`This destination will stop receiving workspace updates.`,
    })) return;
    this.busyId.set(destination.id);
    this.clearMessages();
    try {
      await this.api.delete(`/workspaces/${this.settings.workspaceId()}/chat-destinations/${destination.id}`);
      this.destinations.update((rows) => rows.filter((row) => row.id !== destination.id));
    } catch (error) {
      this.error.set(extractErrorMessage(error));
    } finally {
      this.busyId.set(null);
    }
  }

  formatDate(value: string | Date | null): string {
    if (!value) return $localize`:Last success — never:Never`;
    return formatDateTime(value, "short") || $localize`:Last success — never:Never`;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.destinations.set(await this.api.get<ChatDestinationRow[]>(`/workspaces/${this.settings.workspaceId()}/chat-destinations`));
    } catch (error) {
      this.error.set(extractErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  private async patch(id: string, body: Record<string, unknown>): Promise<boolean> {
    this.busyId.set(id);
    this.clearMessages();
    try {
      const updated = await this.api.patch<ChatDestinationRow>(`/workspaces/${this.settings.workspaceId()}/chat-destinations/${id}`, body);
      this.destinations.update((rows) => rows.map((row) => row.id === id ? updated : row));
      return true;
    } catch (error) {
      this.error.set(extractErrorMessage(error));
      return false;
    } finally {
      this.busyId.set(null);
    }
  }

  private clearMessages(): void {
    this.error.set(null);
  }
}

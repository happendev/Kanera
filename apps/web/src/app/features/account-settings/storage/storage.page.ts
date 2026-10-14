import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from "@angular/core";
import { RouterLink } from "@angular/router";
import type {
  DeleteStorageFilesResponse,
  StorageCategoryKey,
  StorageFileKind,
  StorageFileRow,
  StorageFileSort,
  StorageFilesResponse,
  StorageOverviewResponse,
} from "@kanera/shared/dto";
import { STORAGE_DELETE_MAX_FILES } from "@kanera/shared/dto/storage-limits";
import { cardPath } from "@kanera/shared/card-links";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { ConfirmService } from "../../../shared/confirm.service";
import { appLocale } from "../../../core/i18n/locale";
import { icu } from "../../../core/i18n/icu";
import { formatDate } from "../../../shared/date-format";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { ToastService } from "../../../shared/toast.service";
import { AccountSettingsPage } from "../account-settings.page";

const PAGE_SIZE = 50;
const MB = 1024 * 1024;

const CATEGORY_LABELS: Record<StorageCategoryKey, { label: string; icon: string }> = {
  cards: { label: $localize`:Storage category:Card attachments`, icon: "layout-kanban" },
  notes: { label: $localize`:Storage category:Shared notes`, icon: "notes" },
  personal: { label: $localize`:Storage category:Personal notes and scratchpads`, icon: "lock" },
};

const SIZE_FILTERS = [
  { value: 0, label: $localize`:File size filter option:Any size` },
  { value: 1 * MB, label: $localize`:File size filter option:Over 1 MB` },
  { value: 5 * MB, label: $localize`:File size filter option:Over 5 MB` },
  { value: 25 * MB, label: $localize`:File size filter option:Over 25 MB` },
  { value: 100 * MB, label: $localize`:File size filter option:Over 100 MB` },
] as const;

const AGE_FILTERS = [
  { value: 0, label: $localize`:File age filter option:Any age` },
  { value: 30, label: $localize`:File age filter option:Older than 30 days` },
  { value: 90, label: $localize`:File age filter option:Older than 90 days` },
  { value: 180, label: $localize`:File age filter option:Older than 6 months` },
  { value: 365, label: $localize`:File age filter option:Older than a year` },
] as const;

function formatBytes(value: number): string {
  const oneDecimal = (n: number) => new Intl.NumberFormat(appLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
  if (value < 1024) return $localize`:File size in bytes:${new Intl.NumberFormat(appLocale()).format(value)}:size: B`;
  if (value < MB) return $localize`:File size in kilobytes:${oneDecimal(value / 1024)}:size: KB`;
  if (value < 1024 * MB) return $localize`:File size in megabytes:${oneDecimal(value / MB)}:size: MB`;
  return $localize`:File size in gigabytes:${oneDecimal(value / 1024 / MB)}:size: GB`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "movie";
  if (mimeType.startsWith("audio/")) return "music";
  if (mimeType === "application/pdf") return "file-type-pdf";
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return "file-zip";
  return "file";
}

type FileKey = `${StorageFileKind}:${string}`;
const fileKey = (file: Pick<StorageFileRow, "kind" | "id">): FileKey => `${file.kind}:${file.id}`;

/**
 * Organisation → Storage. Shows how the org-wide storage pool is spent and gives admins a cleanup
 * tool for the files the organisation pays for. Personal notes and scratchpads are private to
 * their owners, so they appear only as a total and are never listed or deletable here.
 */
@Component({
  selector: "k-account-settings-storage",
  standalone: true,
  imports: [RouterLink, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./storage.page.html",
  styleUrl: "./storage.page.scss",
})
export class AccountSettingsStoragePage implements OnInit {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly savedKeyPlaceholder = $localize`:Placeholder for a saved S3 access key:Saved, leave blank to keep`;
  protected readonly savedSecretPlaceholder = $localize`:Placeholder for a saved S3 secret:•••••••• (saved, leave blank to keep)`;
  private readonly api = inject(ApiClient);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  protected readonly sizeFilters = SIZE_FILTERS;
  protected readonly ageFilters = AGE_FILTERS;
  protected readonly formatBytes = formatBytes;
  protected readonly fileIcon = fileIcon;
  protected readonly maxFiles = STORAGE_DELETE_MAX_FILES;
  protected readonly kindOptions: readonly SegmentedOption<"all" | StorageFileKind>[] = [
    { id: "all", icon: "files", label: $localize`:File type filter option — all files:All` },
    { id: "card", icon: "layout-kanban", label: $localize`:File type filter option — files on cards:Cards` },
    { id: "note", icon: "notes", label: $localize`:File type filter option — files on notes:Notes` },
  ];
  protected readonly sortOptions: readonly SegmentedOption<StorageFileSort>[] = [
    { id: "largest", icon: "sort-descending-numbers", label: $localize`:Sort option — largest files first:Largest` },
    { id: "oldest", icon: "calendar-time", label: $localize`:Sort option — oldest files first:Oldest` },
  ];

  readonly overview = signal<StorageOverviewResponse | null>(null);
  readonly overviewError = signal<string | null>(null);

  // Filters. Primitive signals so the reload effect keys on values, not on fresh objects.
  readonly kind = signal<"all" | StorageFileKind>("all");
  readonly sort = signal<StorageFileSort>("largest");
  readonly minBytes = signal(0);
  readonly olderThanDays = signal(0);
  readonly archivedOnly = signal(false);
  readonly workspaceId = signal("");

  readonly files = signal<StorageFileRow[]>([]);
  readonly filesTotal = signal(0);
  readonly filesTotalBytes = signal(0);
  readonly filesLoading = signal(false);
  readonly filesError = signal<string | null>(null);
  readonly selected = signal(new Map<FileKey, StorageFileRow>());
  readonly deleting = signal(false);
  private filesRequest = 0;

  readonly usage = computed(() => this.overview()?.usage ?? null);
  readonly usagePercent = computed(() => {
    const usage = this.usage();
    if (!usage?.limited || !usage.quotaBytes) return null;
    return Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100));
  });
  readonly nearLimit = computed(() => {
    const percent = this.usagePercent();
    const overview = this.overview();
    return percent !== null && !!overview && percent >= overview.warningPercent;
  });
  readonly categories = computed(() => {
    const overview = this.overview();
    if (!overview) return [];
    const total = overview.categories.reduce((sum, category) => sum + category.bytes, 0);
    return overview.categories.map((category) => ({
      ...category,
      ...CATEGORY_LABELS[category.key],
      share: total > 0 ? (category.bytes / total) * 100 : 0,
    }));
  });
  readonly workspaces = computed(() => {
    const overview = this.overview();
    if (!overview) return [];
    const max = Math.max(1, ...overview.workspaces.map((workspace) => workspace.bytes));
    return overview.workspaces.map((workspace) => ({ ...workspace, share: (workspace.bytes / max) * 100 }));
  });
  readonly hasMore = computed(() => this.files().length < this.filesTotal());
  readonly selectedCount = computed(() => this.selected().size);
  readonly selectedBytes = computed(() => [...this.selected().values()].reduce((sum, file) => sum + file.byteSize, 0));
  readonly allOnPageSelected = computed(() => {
    const files = this.files();
    const selected = this.selected();
    return files.length > 0 && files.every((file) => selected.has(fileKey(file)));
  });
  readonly selectionFull = computed(() => this.selectedCount() >= STORAGE_DELETE_MAX_FILES);
  readonly filtersActive = computed(() =>
    this.kind() !== "all" || this.minBytes() > 0 || this.olderThanDays() > 0 || this.archivedOnly() || this.workspaceId() !== "");

  constructor() {
    this.settings.selectedTab.set("storage");
    effect(() => {
      // Read every filter so any change reloads from the first page and clears a stale selection.
      const query = {
        kind: this.kind(),
        sort: this.sort(),
        minBytes: this.minBytes(),
        olderThanDays: this.olderThanDays(),
        archivedOnly: this.archivedOnly(),
        workspaceId: this.workspaceId(),
      };
      untracked(() => {
        this.selected.set(new Map());
        void this.loadFiles(query, 0);
      });
    });
  }

  ngOnInit() {
    void this.loadOverview();
  }

  protected isSelected(file: StorageFileRow): boolean {
    return this.selected().has(fileKey(file));
  }

  protected toggle(file: StorageFileRow, checked: boolean) {
    const next = new Map(this.selected());
    if (checked && next.size < STORAGE_DELETE_MAX_FILES) next.set(fileKey(file), file);
    else next.delete(fileKey(file));
    this.selected.set(next);
  }

  protected toggleAll(checked: boolean) {
    const next = new Map(this.selected());
    for (const file of this.files()) {
      if (!checked) next.delete(fileKey(file));
      else if (next.size < STORAGE_DELETE_MAX_FILES) next.set(fileKey(file), file);
    }
    this.selected.set(next);
  }

  protected resetFilters() {
    this.kind.set("all");
    this.minBytes.set(0);
    this.olderThanDays.set(0);
    this.archivedOnly.set(false);
    this.workspaceId.set("");
  }

  protected showWorkspace(workspaceId: string) {
    this.workspaceId.set(workspaceId);
    document.getElementById("storage-cleanup")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  protected selectFileLabel(fileName: string): string {
    return $localize`:Checkbox label:Select ${fileName}:fileName:`;
  }

  protected locationLabel(file: StorageFileRow): string {
    // A standalone board lives in a hidden workspace; people know it by the board's name alone.
    if (file.workspaceKind === "board" || !file.boardName) return file.boardName ?? file.workspaceName;
    return `${file.workspaceName} › ${file.boardName}`;
  }

  protected itemLabel(file: StorageFileRow): string {
    if (file.kind === "card") return file.cardKey ? `${file.cardKey} ${file.cardTitle ?? ""}`.trim() : (file.cardTitle ?? $localize`:Fallback name for a card without a title:Card`);
    return file.noteTitle?.trim() || $localize`Untitled note`;
  }

  /** Router commands for the file's card or note, so the admin can check it before deleting. */
  protected itemLink(file: StorageFileRow): { commands: string[]; queryParams?: Record<string, string> } {
    if (file.kind === "card" && file.organisationKey && file.cardKey) {
      return { commands: [cardPath(file.organisationKey, file.cardKey)] };
    }
    if (file.boardId) return { commands: ["/b", file.boardId], queryParams: { view: "notes", noteId: file.noteId ?? "" } };
    return { commands: ["/w", file.workspaceId, "notes"], queryParams: { noteId: file.noteId ?? "" } };
  }

  protected uploadedLabel(file: StorageFileRow): string {
    return `${file.uploadedByName} · ${formatDate(file.createdAt, "medium")}`;
  }

  protected loadMore() {
    void this.loadFiles(this.currentQuery(), this.files().length);
  }

  protected async deleteSelected() {
    const files = [...this.selected().values()];
    if (files.length === 0) return;
    const ok = await this.confirm.open({
      title: icu($localize`:Confirm title:{count, plural, =1 {Delete this file?} other {Delete # files?}}`, { count: files.length }),
      message: files.length === 1
        ? $localize`This permanently frees ${formatBytes(this.selectedBytes())}:size:. The file is removed from its card or note, including anywhere it is shown inline, and cannot be recovered.`
        : $localize`This permanently frees ${formatBytes(this.selectedBytes())}:size:. The files are removed from their cards and notes, including anywhere they are shown inline, and cannot be recovered.`,
      confirmLabel: $localize`:Confirm button — delete files:Delete`,
      danger: true,
    });
    if (!ok) return;
    this.deleting.set(true);
    try {
      const result = await this.api.post<DeleteStorageFilesResponse>("/clients/me/storage/files/delete", {
        files: files.map((file) => ({ kind: file.kind, id: file.id })),
      });
      this.toasts.success(icu(
        $localize`:Toast after deleting files:{count, plural, =1 {Deleted 1 file, freeing {size}} other {Deleted # files, freeing {size}}}`,
        { count: result.deletedCount, size: formatBytes(result.freedBytes) },
      ));
      this.selected.set(new Map());
      await Promise.all([this.loadOverview(), this.loadFiles(this.currentQuery(), 0)]);
    } catch (err) {
      this.toasts.error(err instanceof ApiError ? err.message : $localize`Could not delete the files`);
    } finally {
      this.deleting.set(false);
    }
  }

  private currentQuery() {
    return {
      kind: this.kind(),
      sort: this.sort(),
      minBytes: this.minBytes(),
      olderThanDays: this.olderThanDays(),
      archivedOnly: this.archivedOnly(),
      workspaceId: this.workspaceId(),
    };
  }

  private async loadOverview() {
    try {
      this.overview.set(await this.api.get<StorageOverviewResponse>("/clients/me/storage"));
      this.overviewError.set(null);
    } catch (err) {
      this.overviewError.set(err instanceof ApiError ? err.message : $localize`Could not load storage usage`);
    }
  }

  private async loadFiles(query: ReturnType<AccountSettingsStoragePage["currentQuery"]>, offset: number) {
    const request = ++this.filesRequest;
    const params = new URLSearchParams({ sort: query.sort, limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.kind !== "all") params.set("kind", query.kind);
    if (query.minBytes > 0) params.set("minBytes", String(query.minBytes));
    if (query.olderThanDays > 0) params.set("olderThanDays", String(query.olderThanDays));
    if (query.archivedOnly) params.set("archivedOnly", "true");
    if (query.workspaceId) params.set("workspaceId", query.workspaceId);
    this.filesLoading.set(true);
    try {
      const page = await this.api.get<StorageFilesResponse>(`/clients/me/storage/files?${params}`);
      // A newer filter change superseded this request; its response would show the wrong files.
      if (request !== this.filesRequest) return;
      this.files.set(offset === 0 ? page.items : [...this.files(), ...page.items]);
      this.filesTotal.set(page.total);
      this.filesTotalBytes.set(page.totalBytes);
      this.filesError.set(null);
    } catch (err) {
      if (request !== this.filesRequest) return;
      this.filesError.set(err instanceof ApiError ? err.message : $localize`Could not load files`);
    } finally {
      if (request === this.filesRequest) this.filesLoading.set(false);
    }
  }
}

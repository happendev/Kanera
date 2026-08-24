import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { TrelloImportPage } from "../../import/trello-import.page";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

type ImportSource = "trello" | "kanera";

@Component({
  selector: "k-workspace-settings-import",
  standalone: true,
  imports: [DocsLinkComponent, SegmentedComponent, TrelloImportPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./import.page.html",
  styleUrl: "./import.page.scss",
})
export class WorkspaceSettingsImportPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  protected readonly source = signal<ImportSource>("trello");
  /** Labelled: the two products are told apart by name, not by a brand glyph at 15px. */
  protected readonly sourceOptions: SegmentedOption<ImportSource>[] = [
    { id: "trello", icon: "brand-trello", label: "Trello" },
    { id: "kanera", icon: "layout-kanban", label: "Kanera" },
  ];

  constructor() {
    this.settings.selectedTab.set("import");
  }

  protected setSource(source: ImportSource) {
    this.source.set(source);
  }
}

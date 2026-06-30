import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { TrelloImportPage } from "../../import/trello-import.page";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

type ImportSource = "trello" | "kanera";

@Component({
  selector: "k-workspace-settings-import",
  standalone: true,
  imports: [TrelloImportPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./import.page.html",
  styleUrl: "./import.page.scss",
})
export class WorkspaceSettingsImportPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  protected readonly source = signal<ImportSource>("trello");

  constructor() {
    this.settings.selectedTab.set("import");
  }

  protected setSource(source: ImportSource) {
    this.source.set(source);
  }
}

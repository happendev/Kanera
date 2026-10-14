import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-api",
  standalone: true,
  imports: [EmptyStateComponent, DocsLinkComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./api.page.html",
})
export class WorkspaceSettingsApiPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  protected readonly pauseWebhookLabel = $localize`Pause webhook`;
  protected readonly enableWebhookLabel = $localize`Enable webhook`;
  protected readonly deliveringLabel = $localize`:Webhook delivery state:Delivering`;
  protected readonly queuedLabel = $localize`:Webhook delivery state:Queued`;

  protected copyWorkspaceIdLabel(): string {
    return this.settings.isStandalone() ? $localize`Copy board configuration ID` : $localize`Copy workspace ID`;
  }

  protected copyBoardIdLabel(boardName: string): string {
    return $localize`:Button aria-label:Copy ${boardName}:board: board ID`;
  }

  constructor() {
    this.settings.selectedTab.set("api");
  }
}

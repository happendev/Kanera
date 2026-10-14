import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import type { ClientMcpPolicy } from "@kanera/shared/schema";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { AccountSettingsPage } from "../account-settings.page";

/** Organisation → Security: sign-in policy and what AI agents may do with the organisation's data. */
@Component({
  selector: "k-account-settings-security",
  standalone: true,
  imports: [SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./security.page.html",
})
export class AccountSettingsSecurityPage {
  protected readonly settings = inject(AccountSettingsPage);

  protected readonly mcpPolicyOptions: readonly SegmentedOption<ClientMcpPolicy>[] = [
    { id: "off", icon: "plug-connected-x", label: $localize`:AI agent access option:Off` },
    { id: "read", icon: "eye", label: $localize`:AI agent access option:Read only` },
    { id: "write", icon: "pencil", label: $localize`:AI agent access option:Read and write` },
  ];
  protected readonly mcpPolicyHelp = computed(() => {
    switch (this.settings.mcpPolicyDraft()) {
      case "off": return $localize`Agents cannot see or change anything in this organisation. Existing connections stay listed, but their requests are refused.`;
      case "read": return $localize`Agents can read boards, cards and notes but cannot change them, even for members who can.`;
      case "write": return $localize`Agents act with the same permissions as the member who connected them.`;
    }
  });

  constructor() {
    this.settings.selectedTab.set("security");
  }
}

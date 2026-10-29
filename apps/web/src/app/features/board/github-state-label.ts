/** GitHub's own state words, shown on link cards. Unknown future states fall through untranslated. */
export function githubStateLabel(state: string): string {
  switch (state) {
    case "open": return $localize`:GitHub pull request or issue state:open`;
    case "closed": return $localize`:GitHub pull request or issue state:closed`;
    case "merged": return $localize`:GitHub pull request state:merged`;
    case "draft": return $localize`:GitHub pull request or release state:draft`;
    case "released": return $localize`:GitHub release state:released`;
    case "prerelease": return $localize`:GitHub release state:prerelease`;
    default: return state;
  }
}

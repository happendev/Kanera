const SIGNUP_CONVERSION_PAGE = "https://www.kanera.app/conversion/signup";

/**
 * Tell Google Ads that an advert click became an account.
 *
 * The Google tag never runs in this app. The marketing site owns it and the advert-click cookie;
 * this embeds that site's blank conversion page in a hidden frame, so Google's script stays on
 * another origin with no access to the session or workspace. Callers pass only a consent state
 * that is true on hosted Kanera with the Marketing choice on, and the page itself reports
 * nothing unless an advert click is on record.
 */
export function reportSignupConversion(marketingAllowed: boolean): void {
  if (!marketingAllowed || navigator.doNotTrack === "1") return;
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.src = SIGNUP_CONVERSION_PAGE;
  document.body.append(frame);
  // Long enough for the page to load and send its one request on a slow connection.
  window.setTimeout(() => frame.remove(), 60_000);
}

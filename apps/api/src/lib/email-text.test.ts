import assert from "node:assert/strict";
import { test } from "node:test";
import { cardCommentAddedEmail } from "./email-templates/card-comment-added.js";
import { htmlToText } from "./email-text.js";

test("the plain-text part keeps the message and links but drops the hidden preheader and markup", () => {
  const text = htmlToText(cardCommentAddedEmail({
    locale: "en-GB",
    notificationSettingsUrl: "https://kanera.test/settings/notifications",
    displayName: "Ada Lovelace",
    actorName: "Grace & Co",
    cardTitle: "Ship release",
    boardName: "Launch",
    cardUrl: "https://kanera.test/c/PROJ-1",
    commentExcerpt: "Looks good",
  }));
  assert.match(text, /^New comment\n\nHi Ada, Grace & Co commented on "Ship release" in Launch\./);
  assert.match(text, /Looks good/);
  assert.match(text, /Open card \(https:\/\/kanera\.test\/c\/PROJ-1\)/);
  assert.match(text, /Manage email notifications \(https:\/\/kanera\.test\/settings\/notifications\)/);
  assert.match(text, /© \d{4} Kanera/);
  // The preheader repeats the intro in HTML only; it must not open the text part twice.
  assert.equal(text.match(/commented on/g)?.length, 1);
  assert.doesNotMatch(text, /<|&amp;|&zwnj;|\n{3}/);
});

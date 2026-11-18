import assert from "node:assert/strict";
import { test } from "node:test";
import { analyticsCountryProperties, visitorCountryFromHeaders } from "./visitor-country.js";

void test("visitorCountryFromHeaders accepts only a known two-letter Cloudflare country", () => {
  assert.equal(visitorCountryFromHeaders({ "cf-ipcountry": "ZA" }), "ZA");
  assert.equal(visitorCountryFromHeaders({ "cf-ipcountry": " de " }), "DE");
  assert.equal(visitorCountryFromHeaders({ "cf-ipcountry": "XX" }), null);
  assert.equal(visitorCountryFromHeaders({ "cf-ipcountry": "T1" }), null);
  assert.equal(visitorCountryFromHeaders({ "cf-ipcountry": "\"},x" }), null);
  assert.equal(visitorCountryFromHeaders({}), null);
});

void test("analyticsCountryProperties uses PostHog's standard country fields", () => {
  assert.deepEqual(analyticsCountryProperties("NL"), { $geoip_country_code: "NL", $geoip_country_name: "Netherlands" });
  assert.deepEqual(analyticsCountryProperties(null), {});
  assert.deepEqual(analyticsCountryProperties(undefined), {});
});

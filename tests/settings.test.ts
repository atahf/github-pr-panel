import { describe, expect, test } from "bun:test";

import { DEFAULT_SETTINGS } from "~/constants";
import { parseSettingsForm, sanitizeSettings } from "~/settings";
import type { SettingsForm } from "~/types";

describe("sanitizeSettings", () => {
  test("returns defaults for missing or invalid storage", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
  });

  test("keeps valid values and replaces invalid ones", () => {
    const settings = sanitizeSettings({
      queries: { review: "  user-review-requested:@me  ", mine: "" },
      refreshMinutes: 5,
      fastRefreshSeconds: 10,
      fastRefreshMaxRuns: 2.5,
    });
    expect(settings).toEqual({
      queries: { review: "user-review-requested:@me", mine: DEFAULT_SETTINGS.queries.mine },
      refreshMinutes: 5,
      fastRefreshSeconds: DEFAULT_SETTINGS.fastRefreshSeconds,
      fastRefreshMaxRuns: DEFAULT_SETTINGS.fastRefreshMaxRuns,
    });
  });
});

describe("parseSettingsForm", () => {
  const form = (overrides: Partial<SettingsForm> = {}): SettingsForm => ({
    review: "review-requested:@me",
    mine: "author:@me",
    refreshMinutes: "3",
    fastRefreshSeconds: "30",
    fastRefreshMaxRuns: "6",
    ...overrides,
  });

  test("builds settings from valid input", () => {
    expect(parseSettingsForm(form())).toEqual({
      ok: true,
      settings: {
        queries: { review: "review-requested:@me", mine: "author:@me" },
        refreshMinutes: 3,
        fastRefreshSeconds: 30,
        fastRefreshMaxRuns: 6,
      },
    });
  });

  test("rejects empty queries", () => {
    expect(parseSettingsForm(form({ mine: "  " }))).toEqual({
      ok: false,
      error: "Search queries can't be empty.",
    });
  });

  test("rejects numbers outside the limits", () => {
    expect(parseSettingsForm(form({ refreshMinutes: "0" }))).toEqual({
      ok: false,
      error: "Refresh interval must be a whole number from 1 to 60.",
    });
    expect(parseSettingsForm(form({ fastRefreshSeconds: "15" }))).toEqual({
      ok: false,
      error: "Re-auth refresh interval must be a whole number from 30 to 300.",
    });
    expect(parseSettingsForm(form({ fastRefreshMaxRuns: "abc" })).ok).toBe(false);
  });
});

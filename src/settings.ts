import { DEFAULT_SETTINGS, LIMITS } from "~/constants";
import type { FormResult, SectionKey, Settings, SettingsForm } from "~/types";

type NumberKey = keyof typeof LIMITS;

const NUMBER_FIELDS = [
  { key: "refreshMinutes", label: "Refresh interval" },
  { key: "fastRefreshSeconds", label: "Re-auth refresh interval" },
  { key: "fastRefreshMaxRuns", label: "Re-auth refresh runs" },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inRange = (key: NumberKey, value: number) =>
  Number.isInteger(value) && value >= LIMITS[key].min && value <= LIMITS[key].max;

export const sanitizeSettings = (raw: unknown): Settings => {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  const queries = isRecord(raw.queries) ? raw.queries : {};
  const query = (key: SectionKey) => {
    const value = queries[key];
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SETTINGS.queries[key];
  };
  const number = (key: NumberKey) => {
    const value = raw[key];
    return typeof value === "number" && inRange(key, value) ? value : DEFAULT_SETTINGS[key];
  };
  return {
    queries: { review: query("review"), mine: query("mine") },
    refreshMinutes: number("refreshMinutes"),
    fastRefreshSeconds: number("fastRefreshSeconds"),
    fastRefreshMaxRuns: number("fastRefreshMaxRuns"),
  };
};

export const parseSettingsForm = (form: SettingsForm): FormResult => {
  const review = form.review.trim();
  const mine = form.mine.trim();
  if (!review || !mine) return { ok: false, error: "Search queries can't be empty." };
  const numbers = {
    refreshMinutes: Number(form.refreshMinutes),
    fastRefreshSeconds: Number(form.fastRefreshSeconds),
    fastRefreshMaxRuns: Number(form.fastRefreshMaxRuns),
  };
  const invalid = NUMBER_FIELDS.find(({ key }) => !inRange(key, numbers[key]));
  if (invalid) {
    const { min, max } = LIMITS[invalid.key];
    return { ok: false, error: `${invalid.label} must be a whole number from ${min} to ${max}.` };
  }
  return { ok: true, settings: { queries: { review, mine }, ...numbers } };
};

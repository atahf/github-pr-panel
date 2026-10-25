import type { PanelState, Settings } from "~/types";

export const GITHUB_ORIGIN = "https://github.com";

export const UNKNOWN_ORG = "unknown organization";

export const DEFAULT_SETTINGS: Settings = {
  queries: {
    review: "is:open is:pr archived:false review-requested:@me sort:updated-desc",
    mine: "is:open is:pr archived:false author:@me sort:updated-desc",
  },
  refreshMinutes: 3,
  fastRefreshSeconds: 30,
  fastRefreshMaxRuns: 6,
};

export const LIMITS = {
  refreshMinutes: { min: 1, max: 60 },
  fastRefreshSeconds: { min: 30, max: 300 },
  fastRefreshMaxRuns: { min: 1, max: 20 },
} as const;

export const EMPTY_PANEL: PanelState = {
  review: null,
  mine: null,
  error: null,
  ssoOrgs: [],
  ssoUnknown: false,
  ipBlockedOrgs: [],
  ipCheckedAt: null,
  memberOrgs: null,
  fetchedAt: null,
  refreshing: false,
};

export const searchUrl = (query: string) => `${GITHUB_ORIGIN}/pulls/search?q=${encodeURIComponent(query)}`;

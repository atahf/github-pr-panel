export type CiState = "success" | "failure" | "pending" | "none";

export type ReviewState = "approved" | "changes_requested" | "review_required" | "none";

export type CheckCounts = {
  passed: number;
  total: number;
};

export type Pr = {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  ci: CiState;
  checks: CheckCounts | null;
  review: ReviewState;
};

export type SectionKey = "review" | "mine";

export type Queries = Record<SectionKey, string>;

export type Section = {
  prs: Pr[];
  totalCount: number;
};

export type PanelError =
  | { kind: "logged_out" }
  | { kind: "rate_limited"; retryAt: number }
  | { kind: "offline" }
  | { kind: "search_error"; message: string }
  | { kind: "failed"; detail: string };

export type PanelState = {
  review: Section | null;
  mine: Section | null;
  error: PanelError | null;
  ssoOrgs: string[];
  ssoUnknown: boolean;
  fetchedAt: number | null;
  refreshing: boolean;
};

export type Settings = {
  queries: Queries;
  refreshMinutes: number;
  fastRefreshSeconds: number;
  fastRefreshMaxRuns: number;
};

export type SettingsForm = {
  review: string;
  mine: string;
  refreshMinutes: string;
  fastRefreshSeconds: string;
  fastRefreshMaxRuns: string;
};

export type FormResult = { ok: true; settings: Settings } | { ok: false; error: string };

export type PanelMessage = { type: "refresh" } | { type: "reauth-started" };

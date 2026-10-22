import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { EMPTY_PANEL, UNKNOWN_ORG } from "~/constants";
import {
  classifyResponse,
  extractEmbeddedData,
  fetchPanel,
  fetchSection,
  findSsoBlockedOrgs,
  FormatError,
  GithubError,
  isSsoWall,
  MAX_PAGES,
  parseDeferred,
  parseSearchPage,
  RATE_LIMIT_FALLBACK_MS,
  toPanelError,
  withStatus,
} from "~/github";
import type { PanelState, Pr } from "~/types";

const NOW = 1_000_000;

const item = (overrides: Record<string, unknown> = {}) => ({
  itemType: "pull_request",
  id: "PR_1",
  number: 12,
  title: "Add thing",
  permalink: "/acme/web/pull/12",
  repoNameWithOwner: "acme/web",
  isDraft: false,
  updatedAt: "2026-10-18T10:00:00Z",
  author: { displayLogin: "ana" },
  ...overrides,
});

const page = (
  results: unknown[],
  appPayload: unknown = { sso_organizations: [] },
  error: unknown = null,
) => ({
  payload: {
    pullsDashboardSurfaceContentRoute: {
      results,
      pageInfo: { currentPage: 1, totalPages: 1, totalCount: results.length, openCount: results.length },
      error,
    },
  },
  appPayload,
});

const html = (data: unknown) =>
  `<html><script type="application/json" data-target="react-partial.embeddedData">{"props":{}}</script>` +
  `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(data)}</script></html>`;

const response = (
  url: string,
  status: number,
  headers: Record<string, string> = {},
  type: ResponseType = "basic",
) => ({
  url,
  status,
  headers: new Headers(headers),
  type,
});

const stubFetch = (respond: (url: string) => Response | Promise<Response>) => {
  const fake = async (input: string | URL | Request) => respond(String(input));
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }));
};

describe("extractEmbeddedData", () => {
  test("returns the react-app embedded JSON", () => {
    const data = page([item()]);
    expect(extractEmbeddedData(html(data))).toEqual(data);
  });

  test("returns null when the page has no embedded data", () => {
    expect(extractEmbeddedData("<html><body>Sign in</body></html>")).toBeNull();
  });

  test("throws FormatError on invalid JSON", () => {
    const broken = '<script type="application/json" data-target="react-app.embeddedData">{oops</script>';
    expect(() => extractEmbeddedData(broken)).toThrow(FormatError);
  });
});

describe("parseSearchPage", () => {
  test("maps results to items with absolute URLs", () => {
    const parsed = parseSearchPage(page([item()]));
    expect(parsed.items).toEqual([
      {
        id: "PR_1",
        number: 12,
        title: "Add thing",
        url: "https://github.com/acme/web/pull/12",
        repo: "acme/web",
        author: "ana",
        isDraft: false,
        updatedAt: "2026-10-18T10:00:00Z",
      },
    ]);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.routeError).toBeNull();
    expect(parsed.ssoOrgs).toEqual([]);
  });

  test("keeps absolute permalinks and falls back to ghost author", () => {
    const parsed = parseSearchPage(
      page([item({ permalink: "https://github.com/acme/web/pull/12", author: null })]),
    );
    expect(parsed.items[0]?.url).toBe("https://github.com/acme/web/pull/12");
    expect(parsed.items[0]?.author).toBe("ghost");
  });

  test("rejects permalinks outside GitHub", () => {
    for (const permalink of ["https://evil.example/acme/web/pull/12", "javascript:alert(1)"]) {
      expect(() => parseSearchPage(page([item({ permalink })]))).toThrow("results[0].permalink");
    }
  });

  test("reads SSO org names from strings and objects", () => {
    const parsed = parseSearchPage(page([], { sso_organizations: ["acme", { login: "globex" }, { id: 3 }] }));
    expect(parsed.ssoOrgs).toEqual(["acme", "globex", UNKNOWN_ORG]);
  });

  test("reports SSO as unknown when sso_organizations is missing", () => {
    expect(parseSearchPage(page([], {})).ssoOrgs).toBeNull();
    expect(parseSearchPage({ payload: page([]).payload }).ssoOrgs).toBeNull();
  });

  test("returns the route error message", () => {
    expect(parseSearchPage(page([], undefined, { message: "Search timed out" })).routeError).toBe(
      "Search timed out",
    );
  });

  test("reads the page count and defaults to one page", () => {
    const route = page([item()]).payload.pullsDashboardSurfaceContentRoute;
    const withPages = (pageInfo: object) => ({
      payload: { pullsDashboardSurfaceContentRoute: { ...route, pageInfo } },
    });
    expect(parseSearchPage(withPages({ ...route.pageInfo, totalPages: 3 })).totalPages).toBe(3);
    expect(parseSearchPage(withPages({ totalCount: 1 })).totalPages).toBe(1);
  });

  test("throws FormatError when the route or a field is missing", () => {
    expect(() => parseSearchPage({ payload: {} })).toThrow(FormatError);
    expect(() => parseSearchPage(page([item({ number: "12" })]))).toThrow("results[0].number");
  });
});

describe("parseDeferred", () => {
  const deferred = (results: unknown[]) => ({
    payload: { pullsDashboardSurfaceContentDeferredData: { results } },
  });

  test("maps CI state, check counts and review state by id", () => {
    const statuses = parseDeferred(
      deferred([
        {
          id: "PR_1",
          statusCheckRollup: { state: "SUCCESS", totalCount: 7, successCount: 7 },
          reviewDecisionState: "APPROVED",
        },
        {
          id: "PR_2",
          statusCheckRollup: { state: "ERROR", totalCount: 7, successCount: 6 },
          reviewDecisionState: "CHANGES_REQUESTED",
        },
        { id: "PR_3", statusCheckRollup: null, reviewDecisionState: null },
        { id: "PR_4", statusCheckRollup: { state: "SOMETHING_NEW" }, reviewDecisionState: "REVIEW_REQUIRED" },
        { id: "PR_5", statusCheckRollup: { state: "PENDING", totalCount: 0, successCount: 0 } },
      ]),
    );
    expect(statuses.get("PR_1")).toEqual({
      ci: "success",
      checks: { passed: 7, total: 7 },
      review: "approved",
    });
    expect(statuses.get("PR_2")).toEqual({
      ci: "failure",
      checks: { passed: 6, total: 7 },
      review: "changes_requested",
    });
    expect(statuses.get("PR_3")).toEqual({ ci: "none", checks: null, review: "none" });
    expect(statuses.get("PR_4")).toEqual({ ci: "none", checks: null, review: "review_required" });
    expect(statuses.get("PR_5")).toEqual({ ci: "pending", checks: null, review: "none" });
  });

  test("throws FormatError when results are missing", () => {
    expect(() => parseDeferred({ payload: {} })).toThrow(FormatError);
  });
});

describe("withStatus", () => {
  test("merges statuses by id and defaults missing ones", () => {
    const { items } = parseSearchPage(page([item(), item({ id: "PR_2", number: 13 })]));
    const prs = withStatus(
      items,
      new Map([["PR_2", { ci: "pending", checks: { passed: 2, total: 5 }, review: "approved" }]]),
    );
    expect(prs.map(({ id, ci, checks, review }) => ({ id, ci, checks, review }))).toEqual([
      { id: "PR_1", ci: "none", checks: null, review: "none" },
      { id: "PR_2", ci: "pending", checks: { passed: 2, total: 5 }, review: "approved" },
    ]);
  });
});

describe("classifyResponse", () => {
  test("accepts a normal response", () => {
    expect(classifyResponse(response("https://github.com/pulls/search?q=x", 200), NOW)).toBeNull();
  });

  test("detects a redirect to the login page", () => {
    const res = response("https://github.com/login?return_to=%2Fpulls%2Fsearch", 200);
    expect(classifyResponse(res, NOW)).toEqual({ kind: "logged_out" });
  });

  test("treats any redirect as logged out", () => {
    const res = response("", 0, {}, "opaqueredirect");
    expect(classifyResponse(res, NOW)).toEqual({ kind: "logged_out" });
  });

  test("uses retry-after for rate limits", () => {
    expect(
      classifyResponse(response("https://github.com/pulls/search", 429, { "retry-after": "30" }), NOW),
    ).toEqual({
      kind: "rate_limited",
      retryAt: NOW + 30_000,
    });
    expect(
      classifyResponse(response("https://github.com/pulls/search", 403, { "retry-after": "5" }), NOW),
    ).toEqual({
      kind: "rate_limited",
      retryAt: NOW + 5_000,
    });
  });

  test("falls back to a default delay without retry-after", () => {
    expect(classifyResponse(response("https://github.com/pulls/search", 429), NOW)).toEqual({
      kind: "rate_limited",
      retryAt: NOW + RATE_LIMIT_FALLBACK_MS,
    });
  });

  test("reports other failures with the HTTP status", () => {
    expect(classifyResponse(response("https://github.com/pulls/search", 403), NOW)).toEqual({
      kind: "failed",
      detail: "HTTP 403",
    });
    expect(classifyResponse(response("https://github.com/pulls/search", 503), NOW)).toEqual({
      kind: "failed",
      detail: "HTTP 503",
    });
  });
});

describe("toPanelError", () => {
  test("maps known error types", () => {
    expect(toPanelError(new GithubError({ kind: "offline" }))).toEqual({ kind: "offline" });
    expect(toPanelError(new FormatError("route.results is missing"))).toEqual({
      kind: "failed",
      detail: "Unexpected page format: route.results is missing",
    });
    expect(toPanelError(new Error("boom"))).toEqual({ kind: "failed", detail: "boom" });
  });
});

describe("fetchSection", () => {
  const TOTAL_PAGES = MAX_PAGES + 2;

  const pageNumber = (url: string) => Number(new URL(url).searchParams.get("page"));

  // Page N holds one PR, PR_N unless given another id
  const searchPage = (number: number, id = `PR_${number}`) => {
    const data = page([item({ id, number })]);
    Object.assign(data.payload.pullsDashboardSurfaceContentRoute.pageInfo, {
      currentPage: number,
      totalPages: TOTAL_PAGES,
      totalCount: TOTAL_PAGES,
    });
    return new Response(html(data));
  };

  const deferred = (url: string) => {
    const ids = new URL(url).searchParams.getAll("ids[]");
    const results = ids.map((id) => ({ id, statusCheckRollup: { state: "SUCCESS" } }));
    return Response.json({ payload: { pullsDashboardSurfaceContentDeferredData: { results } } });
  };

  afterEach(() => mock.restore());

  test("fetches later pages up to MAX_PAGES with their statuses", async () => {
    const requested: string[] = [];
    stubFetch((url) => {
      requested.push(url);
      return url.includes("/pulls/deferred") ? deferred(url) : searchPage(pageNumber(url));
    });
    const { section } = await fetchSection("query");
    const pages = Array.from({ length: MAX_PAGES }, (_, i) => i + 1);
    expect(section.prs.map(({ id, ci }) => ({ id, ci }))).toEqual(
      pages.map((number) => ({ id: `PR_${number}`, ci: "success" })),
    );
    expect(section.totalCount).toBe(TOTAL_PAGES);
    const deferredPages = requested.filter((url) => url.includes("/pulls/deferred")).map(pageNumber);
    expect(deferredPages.sort()).toEqual(pages);
  });

  test("drops a PR that moved to a later page while loading", async () => {
    stubFetch((url) => {
      if (url.includes("/pulls/deferred")) return deferred(url);
      const number = pageNumber(url);
      return searchPage(number, number === 2 ? "PR_1" : `PR_${number}`);
    });
    const { section } = await fetchSection("query");
    expect(section.prs.map((pr) => pr.id)).toEqual(["PR_1", "PR_3", "PR_4"]);
  });

  test("keeps the pages before the first failed page", async () => {
    stubFetch((url) => {
      if (url.includes("/pulls/deferred")) return deferred(url);
      const number = pageNumber(url);
      return number === 3 ? new Response(null, { status: 500 }) : searchPage(number);
    });
    const { section } = await fetchSection("query");
    expect(section.prs.map((pr) => pr.id)).toEqual(["PR_1", "PR_2"]);
    expect(section.totalCount).toBe(TOTAL_PAGES);
  });
});

// Splits the page into small chunks to exercise reading it as a stream
const streamOf = (text: string, chunkSize = 16) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });

const ssoWallPage = (org: string) =>
  `<html><head><title>Sign in to Acme Corp</title></head>` +
  `<body class="logged-in env-production session-authentication">` +
  `<form action="https://github.com/orgs/${org}/saml/initiate?return_to=x"></form></body></html>`;

const prPage =
  `<html><head><title>Add thing</title></head><body class="logged-in env-production">` +
  `<a href="/orgs/acme/saml/initiate">not the wall</a></body></html>`;

describe("isSsoWall", () => {
  test("detects GitHub's SSO sign-in page for the org", async () => {
    expect(await isSsoWall(streamOf(ssoWallPage("acme")), "acme")).toBe(true);
    expect(await isSsoWall(streamOf(ssoWallPage("acme")), "Acme")).toBe(true);
  });

  test("stops at the body tag of a normal page", async () => {
    expect(await isSsoWall(streamOf(prPage), "acme")).toBe(false);
  });

  test("ignores another org's wall and other sign-in pages", async () => {
    expect(await isSsoWall(streamOf(ssoWallPage("globex")), "acme")).toBe(false);
    const login = `<html><body class="logged-out session-authentication"><form action="/session"></form></body></html>`;
    expect(await isSsoWall(streamOf(login), "acme")).toBe(false);
  });
});

describe("findSsoBlockedOrgs", () => {
  afterEach(() => mock.restore());

  const pr = (repo: string, number: number): Pr => ({
    id: `${repo}#${number}`,
    number,
    title: "Add thing",
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    author: "ana",
    isDraft: false,
    updatedAt: "2026-10-18T10:00:00Z",
    ci: "none",
    checks: null,
    review: "none",
  });

  test("checks one PR page per org that uses SSO", async () => {
    const requested: string[] = [];
    stubFetch((url) => {
      requested.push(url);
      if (url.endsWith("/orgs/acme/sso_status.json")) return Response.json(true);
      if (url.endsWith("/orgs/globex/sso_status.json")) return Response.json(true);
      if (url.endsWith("/sso_status.json")) return Response.json({ error: "Not Found" }, { status: 404 });
      if (url.includes("/acme/")) return new Response(streamOf(ssoWallPage("acme")));
      return new Response(streamOf(prPage));
    });
    const prs = [pr("acme/web", 1), pr("acme/api", 2), pr("globex/app", 3), pr("ana/dotfiles", 4)];
    expect(await findSsoBlockedOrgs(prs)).toEqual(["acme"]);
    expect(requested.filter((url) => url.includes("/pull/")).sort()).toEqual([
      "https://github.com/acme/web/pull/1",
      "https://github.com/globex/app/pull/3",
    ]);
  });

  test("treats failed checks as not blocked", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await findSsoBlockedOrgs([pr("acme/web", 1)])).toEqual([]);
  });
});

describe("fetchPanel", () => {
  const queries = { review: "review-query", mine: "mine-query" };

  const previous: PanelState = {
    ...EMPTY_PANEL,
    review: { prs: [], totalCount: 3 },
    mine: { prs: [], totalCount: 1 },
    fetchedAt: NOW,
  };

  afterEach(() => mock.restore());

  test("builds the panel from both searches and their statuses", async () => {
    stubFetch((url) => {
      if (url.endsWith("/sso_status.json")) return Response.json({ error: "Not Found" }, { status: 404 });
      if (url.includes("/pulls/deferred")) {
        const status = {
          id: "PR_1",
          statusCheckRollup: { state: "SUCCESS" },
          reviewDecisionState: "APPROVED",
        };
        return Response.json({
          payload: { pullsDashboardSurfaceContentDeferredData: { results: [status] } },
        });
      }
      if (url.includes("review-query"))
        return new Response(html(page([item()], { sso_organizations: ["acme"] })));
      const sso = { sso_organizations: ["acme", "globex"] };
      return new Response(html(page([], sso, { message: "Search timed out" })));
    });
    const panel = await fetchPanel(queries, EMPTY_PANEL);
    expect(panel.review?.prs.map(({ id, ci, review }) => ({ id, ci, review }))).toEqual([
      { id: "PR_1", ci: "success", review: "approved" },
    ]);
    expect(panel.mine).toEqual({ prs: [], totalCount: 0 });
    expect(panel.error).toEqual({ kind: "search_error", message: "Search timed out" });
    expect(panel.ssoOrgs).toEqual(["acme", "globex"]);
    expect(panel.ssoUnknown).toBe(false);
  });

  test("reports an org whose PR pages show the SSO wall", async () => {
    stubFetch((url) => {
      if (url.endsWith("/orgs/acme/sso_status.json")) return Response.json(true);
      if (url.includes("/pulls/deferred")) {
        return Response.json({ payload: { pullsDashboardSurfaceContentDeferredData: { results: [] } } });
      }
      if (url.includes("/acme/web/pull/12")) return new Response(streamOf(ssoWallPage("acme")));
      return new Response(html(page(url.includes("review-query") ? [item()] : [])));
    });
    const panel = await fetchPanel(queries, EMPTY_PANEL);
    expect(panel.review?.prs.map((pr) => pr.id)).toEqual(["PR_1"]);
    expect(panel.ssoOrgs).toEqual(["acme"]);
    expect(panel.error).toBeNull();
  });

  test("clears the old PRs when logged out", async () => {
    stubFetch(() => Object.defineProperty(new Response(null), "type", { value: "opaqueredirect" }));
    expect(await fetchPanel(queries, previous)).toEqual({ ...EMPTY_PANEL, error: { kind: "logged_out" } });
  });

  test("keeps the old PRs on other errors", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await fetchPanel(queries, previous)).toEqual({ ...previous, error: { kind: "offline" } });
  });
});

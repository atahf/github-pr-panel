import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { EMPTY_PANEL, UNKNOWN_ORG } from "~/constants";
import {
  checkIpAllowLists,
  classifyResponse,
  extractEmbeddedData,
  fetchPanel,
  fetchSection,
  findSsoBlockedOrgs,
  FormatError,
  GithubError,
  IP_CHECK_INTERVAL_MS,
  ipBlockedOrgOf,
  isSsoWall,
  MAX_PAGES,
  MEMBER_ORGS_TTL_MS,
  parseDeferred,
  parseMemberOrgs,
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

  test("reads the logged-in user's login", () => {
    expect(parseSearchPage(page([], { current_user: { id: 1, login: "ana" } })).login).toBe("ana");
    expect(parseSearchPage(page([])).login).toBeNull();
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

describe("findSsoBlockedOrgs", () => {
  afterEach(() => mock.restore());

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

// The message GitHub returns for a search naming an org whose IP allow list blocks the user
const ipError = (org: string) =>
  `Access to the requested organization (${org}) is blocked by an IP allow list. Your session or token ` +
  "does not satisfy the organization's or enterprise's conditional access policies. Confirm the policy " +
  "requirements are met, then try again.";

// Trimmed from GitHub's dashboard context switcher: the user's own dashboard, then one entry per org
const contextList = (orgs: string[]) =>
  '<action-list><ul aria-label="dashboards" role="listbox">' +
  '<li><a href="/" role="option" aria-selected="true">ana</a></li>' +
  orgs.map((org) => `<li><a href="/orgs/${org}/dashboard" role="option">${org}</a></li>`).join("") +
  "</ul></action-list>";

const searchReply = (error: string | null) =>
  Response.json({
    meta: { title: "Pull requests" },
    payload: {
      pullsDashboardSurfaceContentRoute: {
        results: [],
        pageInfo: { currentPage: 1, totalPages: 0, totalCount: 0 },
        error,
      },
    },
  });

const searchedOrg = (url: string) => /org:(\S+)/.exec(new URL(url).searchParams.get("q") ?? "")?.[1] ?? null;

const searchedOrgs = (requested: string[]) =>
  requested.filter((url) => url.includes("/pulls/search")).map(searchedOrg);

const fakeIpGithub =
  (memberOrgs: string[], blocked: string[], requested: string[] = []) =>
  (url: string) => {
    requested.push(url);
    if (url.includes("/dashboard/ajax_context_list")) return new Response(contextList(memberOrgs));
    const org = searchedOrg(url) ?? "";
    return searchReply(blocked.includes(org) ? ipError(org) : null);
  };

describe("ipBlockedOrgOf", () => {
  test("reads the org from GitHub's IP allow list error", () => {
    expect(ipBlockedOrgOf(ipError("sanalabs"))).toBe("sanalabs");
  });

  test("returns null for other search errors", () => {
    expect(ipBlockedOrgOf("Search timed out")).toBeNull();
  });
});

describe("parseMemberOrgs", () => {
  test("reads org logins from the dashboard context switcher", () => {
    const html = contextList(["k2k-development", "sanalabs", "SU-CS308-22FA", "sanalabs"]);
    expect(parseMemberOrgs(html)).toEqual(["k2k-development", "sanalabs", "SU-CS308-22FA"]);
  });

  test("returns no orgs for a user without any", () => {
    expect(parseMemberOrgs(contextList([]))).toEqual([]);
  });
});

describe("checkIpAllowLists", () => {
  afterEach(() => mock.restore());

  const ORGS = ["k2k-development", "sanalabs", "SU-CS308-22FA"];
  const members = { login: "ana", orgs: ORGS, fetchedAt: NOW };
  const checked: PanelState = { ...EMPTY_PANEL, memberOrgs: members, ipCheckedAt: NOW };

  test("searches each org without PRs once and reports the blocked ones", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, ["sanalabs"], requested));
    const result = await checkIpAllowLists(EMPTY_PANEL, "ana", [pr("K2K-Development/web", 1)], true, NOW);
    expect(result).toEqual({ ipBlockedOrgs: ["sanalabs"], ipCheckedAt: NOW, memberOrgs: members, retryAt: null });
    expect(requested[0]).toBe("https://github.com/dashboard/ajax_context_list?current_context=ana");
    expect(searchedOrgs(requested)).toEqual(["sanalabs", "SU-CS308-22FA"]);
    expect(new URL(requested[1] ?? "").searchParams.get("q")).toBe("is:pr org:sanalabs created:<2008-01-01");
  });

  test("sends nothing before the interval is up when no org is blocked or disappeared", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, [], requested));
    const later = NOW + IP_CHECK_INTERVAL_MS - 1;
    const result = await checkIpAllowLists(checked, "ana", [pr("sanalabs/web", 1)], true, later);
    expect(requested).toEqual([]);
    expect(result).toEqual({ ipBlockedOrgs: [], ipCheckedAt: NOW, memberOrgs: members, retryAt: null });
  });

  test("clears an org whose PRs are back without searching for it", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, ["SU-CS308-22FA"], requested));
    const previous = { ...checked, ipBlockedOrgs: ["sanalabs", "SU-CS308-22FA"] };
    const result = await checkIpAllowLists(previous, "ana", [pr("sanalabs/web", 1)], true, NOW + 1);
    expect(searchedOrgs(requested)).toEqual(["SU-CS308-22FA"]);
    expect(result.ipBlockedOrgs).toEqual(["SU-CS308-22FA"]);
  });

  test("checks blocked orgs and orgs whose PRs all disappeared before the interval is up", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, ["SU-CS308-22FA", "sanalabs"], requested));
    const previous = {
      ...checked,
      ipBlockedOrgs: ["SU-CS308-22FA"],
      mine: { prs: [pr("sanalabs/web", 1)], totalCount: 1 },
    };
    const result = await checkIpAllowLists(previous, "ana", [], true, NOW + 1);
    expect(searchedOrgs(requested)).toEqual(["SU-CS308-22FA", "sanalabs"]);
    expect(result.ipBlockedOrgs).toEqual(["SU-CS308-22FA", "sanalabs"]);
    // The interval still counts from the last full check
    expect(result.ipCheckedAt).toBe(NOW);
  });

  test("clears a lifted block on the next refresh, even with incomplete results", async () => {
    stubFetch(fakeIpGithub(ORGS, []));
    const previous = { ...checked, ipBlockedOrgs: ["sanalabs"] };
    const result = await checkIpAllowLists(previous, "ana", [], false, NOW + 1);
    expect(result.ipBlockedOrgs).toEqual([]);
    expect(result.ipCheckedAt).toBe(NOW);
  });

  const blockedSanalabs = { ...checked, ipBlockedOrgs: ["sanalabs"] };

  const notAnIpBlock: [string, () => Response][] = [
    ["a redirect", () => Object.defineProperty(new Response(null), "type", { value: "opaqueredirect" })],
    ["an HTTP error", () => new Response(null, { status: 403 })],
    ["a sign-in page", () => new Response("<html><body class='session-authentication'></body></html>")],
    ["JSON without search results", () => Response.json({})],
  ];

  for (const [name, reply] of notAnIpBlock) {
    test(`clears a blocked org when its search answers with ${name}`, async () => {
      stubFetch(reply);
      const result = await checkIpAllowLists(blockedSanalabs, "ana", [], true, NOW + 1);
      expect(result.ipBlockedOrgs).toEqual([]);
    });
  }

  test("keeps a blocked org when its search gets a server error", async () => {
    stubFetch(() => new Response(null, { status: 503 }));
    const result = await checkIpAllowLists(blockedSanalabs, "ana", [], true, NOW + 1);
    expect(result.ipBlockedOrgs).toEqual(["sanalabs"]);
  });

  test("keeps a blocked org when its search fails before the interval is up", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const result = await checkIpAllowLists(blockedSanalabs, "ana", [], true, NOW + 1);
    expect(result.ipBlockedOrgs).toEqual(["sanalabs"]);
  });

  test("doesn't check early when the results are incomplete", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, ["sanalabs"], requested));
    const previous = { ...checked, mine: { prs: [pr("sanalabs/web", 1)], totalCount: 1 } };
    const result = await checkIpAllowLists(previous, "ana", [], false, NOW + 1);
    expect(requested).toEqual([]);
    expect(result.ipBlockedOrgs).toEqual([]);
  });

  test("doesn't check early when a personal repo's PRs disappear", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, [], requested));
    const previous = { ...checked, mine: { prs: [pr("ana/dotfiles", 1)], totalCount: 1 } };
    await checkIpAllowLists(previous, "ana", [], true, NOW + 1);
    expect(requested).toEqual([]);
  });

  test("checks the new account's orgs right away after switching accounts", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(["globex"], ["globex"], requested));
    const previous = { ...checked, ipBlockedOrgs: ["sanalabs"] };
    const result = await checkIpAllowLists(previous, "bob", [], true, NOW + 1);
    expect(requested[0]).toBe("https://github.com/dashboard/ajax_context_list?current_context=bob");
    expect(result).toEqual({
      ipBlockedOrgs: ["globex"],
      ipCheckedAt: NOW + 1,
      memberOrgs: { login: "bob", orgs: ["globex"], fetchedAt: NOW + 1 },
      retryAt: null,
    });
  });

  test("drops the old account's blocks when the new account's orgs can't be loaded", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }));
    const previous = { ...checked, ipBlockedOrgs: ["sanalabs"] };
    const result = await checkIpAllowLists(previous, "bob", [], true, NOW + 1);
    expect(result).toEqual({ ipBlockedOrgs: [], ipCheckedAt: NOW + 1, memberOrgs: null, retryAt: null });
  });

  test("reuses the org list until it expires", async () => {
    const due = NOW + IP_CHECK_INTERVAL_MS;
    const listFetches = async (login: string, now: number) => {
      const requested: string[] = [];
      stubFetch(fakeIpGithub(ORGS, [], requested));
      await checkIpAllowLists(checked, login, [], true, now);
      mock.restore();
      return requested.filter((url) => url.includes("ajax_context_list")).length;
    };
    expect(await listFetches("ana", due)).toBe(0);
    expect(await listFetches("ANA", due)).toBe(0);
    expect(await listFetches("ana", NOW + MEMBER_ORGS_TTL_MS)).toBe(1);
  });

  test("stops checking at the first rate limit and reports when to retry", async () => {
    const orgs = ["a", "b", "c", "d", "e", "f"];
    const requested: string[] = [];
    stubFetch((url) => {
      requested.push(url);
      if (url.includes("ajax_context_list")) return new Response(contextList(orgs));
      if (url.includes("org%3Ab+") || url.includes("org%3Ab%20")) {
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }
      return fakeIpGithub(orgs, ["c"])(url);
    });
    const previous = { ...EMPTY_PANEL, ipBlockedOrgs: ["e"] };
    const before = Date.now();
    const result = await checkIpAllowLists(previous, "ana", [], true, NOW);
    // Only the first batch of 4 went out; e and f were never searched
    expect(searchedOrgs(requested)).toEqual(["a", "b", "c", "d"]);
    expect(result.retryAt).toBeGreaterThanOrEqual(before + 60_000);
    // Unchecked orgs keep their last state
    expect(result.ipBlockedOrgs).toEqual(["c", "e"]);
    expect(result.ipCheckedAt).toBe(NOW);
  });

  test("keeps an org's last state when its search fails", async () => {
    stubFetch((url) => {
      if (url.includes("org%3Asanalabs")) return Promise.reject(new TypeError("Failed to fetch"));
      return fakeIpGithub(ORGS, [])(url);
    });
    const previous = { ...checked, ipBlockedOrgs: ["sanalabs", "k2k-development"], ipCheckedAt: null };
    const result = await checkIpAllowLists(previous, "ana", [], true, NOW);
    expect(result.ipBlockedOrgs).toEqual(["sanalabs"]);
  });

  test("waits for the next interval when the org list can't be loaded", async () => {
    const requested: string[] = [];
    stubFetch((url) => {
      requested.push(url);
      return new Response("Not Found", { status: 404 });
    });
    const result = await checkIpAllowLists(EMPTY_PANEL, "ana", [], true, NOW);
    expect(result).toEqual({ ipBlockedOrgs: [], ipCheckedAt: NOW, memberOrgs: null, retryAt: null });
    expect(requested).toHaveLength(1);
  });

  test("sends nothing without a login", async () => {
    const requested: string[] = [];
    stubFetch(fakeIpGithub(ORGS, [], requested));
    await checkIpAllowLists(EMPTY_PANEL, null, [], true, NOW);
    expect(requested).toEqual([]);
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

  test("shows a search naming an IP-blocked org as that org's banner, not a search error", async () => {
    stubFetch((url) => {
      if (url.includes("/pulls/deferred")) {
        return Response.json({ payload: { pullsDashboardSurfaceContentDeferredData: { results: [] } } });
      }
      const sso = { sso_organizations: ["sanalabs"] };
      if (url.includes("mine-query")) return new Response(html(page([], sso, ipError("sanalabs"))));
      return new Response(html(page([], sso)));
    });
    const panel = await fetchPanel(queries, EMPTY_PANEL);
    expect(panel.error).toBeNull();
    expect(panel.ipBlockedOrgs).toEqual(["sanalabs"]);
    expect(panel.ssoOrgs).toEqual([]);
  });

  // A refresh soon after a full check, with the org hidden from search and listed as needing SSO
  const panelWithIpBlock = (singleOrgReply: () => Response) => {
    const app = { sso_organizations: ["sanalabs"], current_user: { login: "ana" } };
    const searchPage = () => new Response(html(page([], app)));
    stubFetch((url) => (url.includes("org%3Asanalabs") ? singleOrgReply() : searchPage()));
    return fetchPanel(queries, {
      ...previous,
      ipBlockedOrgs: ["sanalabs"],
      ipCheckedAt: Date.now(),
      memberOrgs: { login: "ana", orgs: ["sanalabs"], fetchedAt: Date.now() },
    });
  };

  test("shows expired SSO as soon as a VPN lifts an org's IP block", async () => {
    const panel = await panelWithIpBlock(() =>
      Object.defineProperty(new Response(null), "type", { value: "opaqueredirect" }),
    );
    expect(panel.ipBlockedOrgs).toEqual([]);
    expect(panel.ssoOrgs).toEqual(["sanalabs"]);
  });

  test("keeps hiding the SSO banner while GitHub still reports the IP block", async () => {
    const panel = await panelWithIpBlock(() => searchReply(ipError("sanalabs")));
    expect(panel.ipBlockedOrgs).toEqual(["sanalabs"]);
    expect(panel.ssoOrgs).toEqual([]);
  });

  test("checks the logged-in user's orgs for IP allow lists", async () => {
    const ipGithub = fakeIpGithub(["acme", "sanalabs"], ["sanalabs"]);
    stubFetch((url) => {
      if (url.endsWith("/sso_status.json")) return Response.json({ error: "Not Found" }, { status: 404 });
      if (url.includes("/pulls/deferred")) {
        return Response.json({ payload: { pullsDashboardSurfaceContentDeferredData: { results: [] } } });
      }
      const app = { sso_organizations: [], current_user: { login: "ana" } };
      if (url.includes("review-query")) return new Response(html(page([item()], app)));
      if (url.includes("mine-query")) return new Response(html(page([], app)));
      return ipGithub(url);
    });
    const panel = await fetchPanel(queries, EMPTY_PANEL);
    expect(panel.ipBlockedOrgs).toEqual(["sanalabs"]);
    expect(panel.memberOrgs?.orgs).toEqual(["acme", "sanalabs"]);
    expect(panel.ipCheckedAt).not.toBeNull();
  });

  test("reports a rate limit hit during the IP checks, so refreshes pause", async () => {
    stubFetch((url) => {
      if (url.includes("/pulls/deferred")) {
        return Response.json({ payload: { pullsDashboardSurfaceContentDeferredData: { results: [] } } });
      }
      const app = { sso_organizations: [], current_user: { login: "ana" } };
      if (url.includes("review-query") || url.includes("mine-query")) return new Response(html(page([], app)));
      if (url.includes("ajax_context_list")) return new Response(contextList(["sanalabs"]));
      return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    });
    const panel = await fetchPanel(queries, EMPTY_PANEL);
    expect(panel.error?.kind).toBe("rate_limited");
    expect(panel.review).toEqual({ prs: [], totalCount: 0 });
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

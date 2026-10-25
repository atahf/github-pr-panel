import { EMPTY_PANEL, GITHUB_ORIGIN, searchUrl, UNKNOWN_ORG } from "~/constants";
import type {
  CheckCounts,
  CiState,
  MemberOrgs,
  PanelError,
  PanelState,
  Pr,
  Queries,
  ReviewState,
  Section,
} from "~/types";

export const RATE_LIMIT_FALLBACK_MS = 60_000;

// GitHub shows 25 PRs per page; anything past this many pages is left to the "more on GitHub" link
export const MAX_PAGES = 4;

// A request that hangs would hold up every later refresh, so give up and report GitHub as unreachable
const REQUEST_TIMEOUT_MS = 30_000;

const EMBEDDED_DATA_RE =
  /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/;

const CI_STATES = new Map<string, CiState>([
  ["SUCCESS", "success"],
  ["FAILURE", "failure"],
  ["ERROR", "failure"],
  ["PENDING", "pending"],
  ["EXPECTED", "pending"],
]);

const REVIEW_STATES = new Map<string, ReviewState>([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes_requested"],
  ["REVIEW_REQUIRED", "review_required"],
]);

const SSO_ORG_NAME_KEYS = ["login", "name", "slug", "display_login"];

export class FormatError extends Error {}

export class GithubError extends Error {
  readonly panelError: PanelError;

  constructor(panelError: PanelError) {
    super(panelError.kind);
    this.panelError = panelError;
  }
}

type SearchItem = Omit<Pr, "ci" | "checks" | "review">;

type PrStatus = Pick<Pr, "ci" | "checks" | "review">;

type Rec = Record<string, unknown>;

type ResponseInfo = Pick<Response, "url" | "status" | "headers" | "type">;

const NO_STATUS: PrStatus = { ci: "none", checks: null, review: "none" };

// Parsing the data GitHub embeds in its PR pages

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce((current, key) => (isRec(current) ? current[key] : undefined), value);

const lookup = <T>(map: Map<string, T>, key: unknown) => (isString(key) ? map.get(key) : undefined);

const field = <T>(obj: Rec, key: string, guard: (value: unknown) => value is T, path: string): T => {
  const value = obj[key];
  if (!guard(value)) throw new FormatError(`${path}.${key} is missing or has an unexpected type`);
  return value;
};

// PR URLs are fetched with the user's session and matched against open tabs, so they must stay on GitHub
const githubUrl = (permalink: string, path: string) => {
  const url = new URL(permalink, GITHUB_ORIGIN);
  if (url.origin !== GITHUB_ORIGIN) throw new FormatError(`${path}.permalink is not a GitHub URL`);
  return url.href;
};

const parseItem = (raw: unknown, index: number): SearchItem => {
  const path = `results[${index}]`;
  if (!isRec(raw)) throw new FormatError(`${path} is not an object`);
  const author = at(raw, "author", "displayLogin");
  return {
    id: field(raw, "id", isString, path),
    number: field(raw, "number", isNumber, path),
    title: field(raw, "title", isString, path),
    url: githubUrl(field(raw, "permalink", isString, path), path),
    repo: field(raw, "repoNameWithOwner", isString, path),
    author: isString(author) ? author : "ghost",
    isDraft: field(raw, "isDraft", isBoolean, path),
    updatedAt: field(raw, "updatedAt", isString, path),
  };
};

const ssoOrgName = (raw: unknown): string => {
  if (isString(raw)) return raw;
  if (!isRec(raw)) return UNKNOWN_ORG;
  return SSO_ORG_NAME_KEYS.map((key) => raw[key]).find(isString) ?? UNKNOWN_ORG;
};

const checkCounts = (rollup: unknown): CheckCounts | null => {
  const total = at(rollup, "totalCount");
  const passed = at(rollup, "successCount");
  if (!isNumber(total) || !isNumber(passed) || total === 0) return null;
  return { passed, total };
};

const routeErrorMessage = (error: unknown): string | null => {
  if (error === null || error === undefined) return null;
  if (isString(error)) return error;
  if (isRec(error) && isString(error.message)) return error.message;
  return JSON.stringify(error);
};

export const extractEmbeddedData = (html: string): unknown => {
  const json = EMBEDDED_DATA_RE.exec(html)?.[1];
  if (json === undefined) return null;
  try {
    return JSON.parse(json);
  } catch {
    throw new FormatError("embedded data is not valid JSON");
  }
};

export const parseSearchPage = (data: unknown) => {
  const route = at(data, "payload", "pullsDashboardSurfaceContentRoute");
  if (!isRec(route)) throw new FormatError("payload.pullsDashboardSurfaceContentRoute is missing");
  if (!Array.isArray(route.results)) throw new FormatError("route.results is missing");
  if (!isRec(route.pageInfo)) throw new FormatError("route.pageInfo is missing");
  const sso = at(data, "appPayload", "sso_organizations");
  const login = at(data, "appPayload", "current_user", "login");
  const totalPages = route.pageInfo.totalPages;
  return {
    items: route.results.map(parseItem),
    totalCount: field(route.pageInfo, "totalCount", isNumber, "pageInfo"),
    // Later pages are an extra, so a missing page count just means only this page is shown
    totalPages: isNumber(totalPages) ? totalPages : 1,
    routeError: routeErrorMessage(route.error),
    ssoOrgs: Array.isArray(sso) ? sso.map(ssoOrgName) : null,
    login: isString(login) ? login : null,
  };
};

export const parseDeferred = (data: unknown): Map<string, PrStatus> => {
  const results = at(data, "payload", "pullsDashboardSurfaceContentDeferredData", "results");
  if (!Array.isArray(results)) {
    throw new FormatError("payload.pullsDashboardSurfaceContentDeferredData.results is missing");
  }
  const statuses = new Map<string, PrStatus>();
  for (const raw of results) {
    if (!isRec(raw) || !isString(raw.id)) continue;
    statuses.set(raw.id, {
      ci: lookup(CI_STATES, at(raw, "statusCheckRollup", "state")) ?? "none",
      checks: checkCounts(raw.statusCheckRollup),
      review: lookup(REVIEW_STATES, raw.reviewDecisionState) ?? "none",
    });
  }
  return statuses;
};

export const withStatus = (items: SearchItem[], statuses: Map<string, PrStatus>): Pr[] =>
  items.map((item) => ({ ...item, ...(statuses.get(item.id) ?? NO_STATUS) }));

// Fetching

const isLoginUrl = (url: string) => URL.canParse(url) && new URL(url).pathname.startsWith("/login");

const retryAt = (retryAfter: string | null, now: number) => {
  const seconds = Number(retryAfter);
  if (retryAfter === null || !Number.isFinite(seconds) || seconds <= 0) return now + RATE_LIMIT_FALLBACK_MS;
  return now + seconds * 1000;
};

export const classifyResponse = (res: ResponseInfo, now = Date.now()): PanelError | null => {
  if (res.type === "opaqueredirect" || isLoginUrl(res.url)) return { kind: "logged_out" };
  const retryAfter = res.headers.get("retry-after");
  if (res.status === 429 || (res.status === 403 && retryAfter !== null)) {
    return { kind: "rate_limited", retryAt: retryAt(retryAfter, now) };
  }
  if (res.status < 200 || res.status >= 300) return { kind: "failed", detail: `HTTP ${res.status}` };
  return null;
};

export const toPanelError = (error: unknown): PanelError => {
  if (error instanceof GithubError) return error.panelError;
  if (error instanceof FormatError) {
    return { kind: "failed", detail: `Unexpected page format: ${error.message}` };
  }
  return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
};

const githubFetch = (url: string, accept: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    credentials: "include",
    redirect: "manual",
    headers: { Accept: accept, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

const request = async (url: string, accept: string, headers: Record<string, string> = {}) => {
  const res = await githubFetch(url, accept, headers).catch(() => {
    throw new GithubError({ kind: "offline" });
  });
  const error = classifyResponse(res);
  if (error) throw new GithubError(error);
  return res;
};

// CI and review status are optional extras, so a failure here just leaves them out
const fetchStatuses = async (query: string, page: number, ids: string[]): Promise<Map<string, PrStatus>> => {
  if (ids.length === 0) return new Map();
  const params = new URLSearchParams({ q: query, page: String(page) });
  for (const id of ids) params.append("ids[]", id);
  try {
    const res = await request(`${GITHUB_ORIGIN}/pulls/deferred?${params}`, "application/json");
    return parseDeferred(await res.json());
  } catch {
    return new Map();
  }
};

const fetchPage = async (query: string, page: number) => {
  const res = await request(`${searchUrl(query)}&page=${page}`, "text/html");
  const data = extractEmbeddedData(await res.text());
  if (data === null) throw new FormatError("the PR page has no embedded data");
  const parsed = parseSearchPage(data);
  const statuses = await fetchStatuses(
    query,
    page,
    parsed.items.map((item) => item.id),
  );
  return { ...parsed, prs: withStatus(parsed.items, statuses) };
};

// SSO checks

// The <body> tag decides a normal page early; GitHub's sign-in pages carry this class
const BODY_TAG_RE = /<body[^>]*>/;
const SIGN_IN_PAGE_CLASS = "session-authentication";

const ownerOf = (pr: Pr) => pr.repo.split("/")[0] ?? "";

// sso_status.json only exists for orgs that use SSO; other owners get a 404
const usesSso = async (org: string) => {
  const url = `${GITHUB_ORIGIN}/orgs/${encodeURIComponent(org)}/sso_status.json`;
  const res = await githubFetch(url, "application/json");
  return res.status === 200;
};

// Reads only as much of the page as needed: past <body> for a normal page, up to the SAML form for the wall
export const isSsoWall = async (html: ReadableStream<Uint8Array>, org: string) => {
  const marker = `/orgs/${org.toLowerCase()}/saml/initiate`;
  const reader = html.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += decoder.decode(chunk.value, { stream: true });
      const body = BODY_TAG_RE.exec(text)?.[0];
      if (body && !body.includes(SIGN_IN_PAGE_CLASS)) return false;
      if (text.toLowerCase().includes(marker)) return true;
    }
    return false;
  } finally {
    reader.cancel().catch(() => {});
  }
};

const isBlockedBySso = async (org: string, prUrl: string) => {
  try {
    if (!(await usesSso(org))) return false;
    const res = await githubFetch(prUrl, "text/html");
    return res.ok && res.body !== null && (await isSsoWall(res.body, org));
  } catch {
    return false;
  }
};

// An expired SSO session can block an org's pages while search, CI status and sso_status.json still
// report it as fine, so one PR page per org is checked for GitHub's SSO sign-in wall
export const findSsoBlockedOrgs = async (prs: Pr[]) => {
  const firstPrByOrg = new Map<string, string>();
  for (const pr of prs) if (!firstPrByOrg.has(ownerOf(pr))) firstPrByOrg.set(ownerOf(pr), pr.url);
  const orgs = [...firstPrByOrg].filter(([org]) => org !== "");
  const blocked = await Promise.all(orgs.map(([org, url]) => isBlockedBySso(org, url)));
  return orgs.filter((_, i) => blocked[i]).map(([org]) => org);
};

// IP allow list checks

// Each check sends one search per org, so it runs far less often than the PR refresh
export const IP_CHECK_INTERVAL_MS = 15 * 60_000;
export const MEMBER_ORGS_TTL_MS = 24 * 60 * 60_000;

// A few searches at a time, so members of many orgs don't send a burst
const IP_CHECK_CONCURRENCY = 4;

const IP_BLOCKED_RE = /organization \((.+?)\) is blocked by an IP allow list/;
const MEMBER_ORG_RE = /href="\/orgs\/([^/"]+)\/dashboard"/g;

type IpCheck = Pick<PanelState, "ipBlockedOrgs" | "ipCheckedAt" | "memberOrgs"> & { retryAt: number | null };

const lowerSet = (orgs: string[]) => new Set(orgs.map((org) => org.toLowerCase()));

const uniqueOrgs = (orgs: string[]) => [...new Map(orgs.map((org) => [org.toLowerCase(), org])).values()];

export const ipBlockedOrgOf = (routeError: string) => IP_BLOCKED_RE.exec(routeError)?.[1] ?? null;

// The dashboard context switcher lists the user's orgs as /orgs/<org>/dashboard links
export const parseMemberOrgs = (html: string) =>
  uniqueOrgs([...html.matchAll(MEMBER_ORG_RE)].map((match) => match[1] ?? "").filter((org) => org !== ""));

const fetchMemberOrgs = async (login: string, now: number): Promise<MemberOrgs> => {
  const url = `${GITHUB_ORIGIN}/dashboard/ajax_context_list?current_context=${encodeURIComponent(login)}`;
  const res = await request(url, "text/fragment+html", { "X-Requested-With": "XMLHttpRequest" });
  return { login, orgs: parseMemberOrgs(await res.text()), fetchedAt: now };
};

const memberOrgsFor = async (login: string, cached: MemberOrgs | null, now: number) => {
  const usable = cached !== null && cached.login.toLowerCase() === login.toLowerCase() ? cached : null;
  if (usable && now - usable.fetchedAt < MEMBER_ORGS_TTL_MS) return usable;
  return fetchMemberOrgs(login, now).catch(() => usable);
};

// Searches that span several orgs leave out an IP-blocked one without saying so, but a search
// naming only that org reports the block. The date filter matches nothing, so the reply stays tiny
const isIpBlocked = async (org: string) => {
  try {
    const res = await request(searchUrl(`is:pr org:${org} created:<2008-01-01`), "application/json");
    const route = at(await res.json(), "payload", "pullsDashboardSurfaceContentRoute");
    if (!isRec(route)) return null;
    return isString(route.error) && ipBlockedOrgOf(route.error) !== null;
  } catch (e) {
    // A rate limit has to stop the remaining checks, not just count as one failed check
    if (e instanceof GithubError && e.panelError.kind === "rate_limited") throw e;
    return null;
  }
};

// Stops at the first rate limit; orgs left unchecked get null, like a failed check
const checkOrgs = async (orgs: string[]) => {
  const results: (boolean | null)[] = orgs.map(() => null);
  for (let i = 0; i < orgs.length; i += IP_CHECK_CONCURRENCY) {
    const batch = await Promise.allSettled(orgs.slice(i, i + IP_CHECK_CONCURRENCY).map(isIpBlocked));
    batch.forEach((result, j) => {
      if (result.status === "fulfilled") results[i + j] = result.value;
    });
    const limited = batch.find((result) => result.status === "rejected");
    if (limited) {
      const error = toPanelError(limited.reason);
      return { results, retryAt: error.kind === "rate_limited" ? error.retryAt : null };
    }
  }
  return { results, retryAt: null };
};

const prsOf = ({ review, mine }: Pick<PanelState, "review" | "mine">) => [
  ...(review?.prs ?? []),
  ...(mine?.prs ?? []),
];

// Orgs with PRs in the results are reachable and never checked. Between full checks, only an org
// whose PRs all disappeared is checked, since it may have just become blocked. That needs complete
// results: PRs missing from a failed page or past the page limit didn't disappear
export const checkIpAllowLists = async (
  previous: PanelState,
  login: string | null,
  prs: Pr[],
  complete: boolean,
  now = Date.now(),
): Promise<IpCheck> => {
  const reachable = lowerSet(prs.map(ownerOf));
  const isReachable = (org: string) => reachable.has(org.toLowerCase());
  // Switching accounts without logging out leaves the other account's orgs and blocks behind
  const switched =
    login !== null &&
    previous.memberOrgs !== null &&
    previous.memberOrgs.login.toLowerCase() !== login.toLowerCase();
  const wasBlocked = switched ? [] : previous.ipBlockedOrgs;
  const kept: IpCheck = {
    ipBlockedOrgs: wasBlocked.filter((org) => !isReachable(org)),
    ipCheckedAt: previous.ipCheckedAt,
    memberOrgs: switched ? null : previous.memberOrgs,
    retryAt: null,
  };
  if (login === null) return kept;

  const due = switched || previous.ipCheckedAt === null || now - previous.ipCheckedAt >= IP_CHECK_INTERVAL_MS;
  if (!due) {
    const hadPrs = lowerSet(prsOf(previous).map(ownerOf));
    const vanished = complete
      ? (kept.memberOrgs?.orgs ?? []).filter((org) => hadPrs.has(org.toLowerCase()) && !isReachable(org))
      : [];
    if (vanished.length === 0) return kept;
    const { results, retryAt } = await checkOrgs(vanished);
    const newlyBlocked = vanished.filter((_, i) => results[i]);
    return { ...kept, ipBlockedOrgs: uniqueOrgs([...kept.ipBlockedOrgs, ...newlyBlocked]), retryAt };
  }

  const memberOrgs = await memberOrgsFor(login, kept.memberOrgs, now);
  if (memberOrgs === null) return { ...kept, ipCheckedAt: now };
  const candidates = memberOrgs.orgs.filter((org) => !isReachable(org));
  const { results, retryAt } = await checkOrgs(candidates);
  // A failed or skipped check keeps the org's last known state
  const blockedBefore = lowerSet(wasBlocked);
  return {
    ipBlockedOrgs: candidates.filter((org, i) => results[i] ?? blockedBefore.has(org.toLowerCase())),
    ipCheckedAt: now,
    memberOrgs,
    retryAt,
  };
};

// A PR updated while the pages load can move to the next page and show up twice
const uniqueById = (prs: Pr[]) => [...new Map(prs.map((pr) => [pr.id, pr])).values()];

export const fetchSection = async (query: string) => {
  const first = await fetchPage(query, 1);
  const later = Array.from({ length: Math.min(first.totalPages, MAX_PAGES) - 1 }, (_, i) => i + 2);
  const results = await Promise.allSettled(later.map((page) => fetchPage(query, page)));
  // Keep pages up to the first failure, so the list has no gaps; the rest count toward "more on GitHub"
  const failed = results.findIndex((result) => result.status === "rejected");
  const loaded = results
    .slice(0, failed === -1 ? undefined : failed)
    .flatMap((result) => (result.status === "fulfilled" ? result.value.prs : []));
  const section: Section = { prs: uniqueById([...first.prs, ...loaded]), totalCount: first.totalCount };
  return { section, routeError: first.routeError, ssoOrgs: first.ssoOrgs, login: first.login };
};

export const fetchPanel = async (queries: Queries, previous: PanelState): Promise<PanelState> => {
  try {
    const [review, mine] = await Promise.all([fetchSection(queries.review), fetchSection(queries.mine)]);
    const routeErrors = [review.routeError, mine.routeError].filter((error) => error !== null);
    // A query that names an IP-blocked org fails with a message naming it, which gets its own banner
    const searchBlocked = routeErrors.map(ipBlockedOrgOf).filter((org) => org !== null);
    const routeError = routeErrors.find((error) => ipBlockedOrgOf(error) === null);
    const prs = [...review.section.prs, ...mine.section.prs];
    const complete = !routeError && [review, mine].every(({ section }) => section.prs.length >= section.totalCount);
    const [ssoBlocked, { retryAt, ...ip }] = await Promise.all([
      findSsoBlockedOrgs(prs),
      checkIpAllowLists(previous, review.login ?? mine.login, prs, complete),
    ]);
    const ipBlockedOrgs = uniqueOrgs([...ip.ipBlockedOrgs, ...searchBlocked]);
    const ipBlocked = lowerSet(ipBlockedOrgs);
    const ssoOrgs = [...new Set([...(review.ssoOrgs ?? []), ...(mine.ssoOrgs ?? []), ...ssoBlocked])];
    // A rate limit during the IP checks pauses refreshes like any other rate limit
    const error: PanelError | null =
      retryAt !== null
        ? { kind: "rate_limited", retryAt }
        : routeError
          ? { kind: "search_error", message: routeError }
          : null;
    return {
      review: review.section,
      mine: mine.section,
      error,
      ssoOrgs: ssoOrgs.filter((org) => !ipBlocked.has(org.toLowerCase())),
      ssoUnknown: review.ssoOrgs === null || mine.ssoOrgs === null,
      ...ip,
      ipBlockedOrgs,
      fetchedAt: Date.now(),
      refreshing: false,
    };
  } catch (e) {
    const error = toPanelError(e);
    // Logged out means the old PRs are wrong; other errors keep showing them
    const kept = error.kind === "logged_out" ? EMPTY_PANEL : previous;
    return { ...kept, error, refreshing: false };
  }
};

import { DEFAULT_SETTINGS, EMPTY_PANEL, GITHUB_ORIGIN, LIMITS, searchUrl, UNKNOWN_ORG } from "~/constants";
import { parseSettingsForm, sanitizeSettings } from "~/settings";
import { readPanel, readSettings, write } from "~/storage";
import type {
  CiState,
  PanelError,
  PanelMessage,
  PanelState,
  Pr,
  Queries,
  ReviewState,
  Section,
  Settings,
} from "~/types";

type Child = Node | string | null;

// SVG files in assets/icons are copied from GitHub Octicons (16px), https://github.com/primer/octicons
type IconName =
  | "alert"
  | "check"
  | "dot-fill"
  | "gear"
  | "git-pull-request"
  | "git-pull-request-draft"
  | "key"
  | "shield-lock"
  | "sign-in"
  | "sync"
  | "x";

type Tone = "warning" | "error" | "info";

type SectionInfo = { title: string; section: Section; query: string; showAuthor: boolean };

// Update the "5m ago" style times this often
const TICK_MS = 30_000;

const LOGIN_URL = `${GITHUB_ORIGIN}/login`;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const TIME_STEPS = [
  { below: HOUR, size: MINUTE, unit: "m" },
  { below: DAY, size: HOUR, unit: "h" },
  { below: WEEK, size: DAY, unit: "d" },
  { below: MONTH, size: WEEK, unit: "w" },
  { below: YEAR, size: MONTH, unit: "mo" },
] as const;

const CI_ICONS: Record<CiState, { name: IconName; label: string } | null> = {
  success: { name: "check", label: "Checks passed" },
  failure: { name: "x", label: "Checks failed" },
  pending: { name: "dot-fill", label: "Checks pending" },
  none: null,
};

const REVIEW_LABELS: Record<ReviewState, string | null> = {
  review_required: "Review required",
  approved: "Approved",
  changes_requested: "Changes requested",
  none: null,
};

const updatedEl = document.getElementById("updated") as HTMLSpanElement;
const refreshButton = document.getElementById("refresh") as HTMLButtonElement;
const settingsButton = document.getElementById("settings") as HTMLButtonElement;
const bannersEl = document.getElementById("banners") as HTMLDivElement;
const mainEl = document.getElementById("main") as HTMLElement;

let panel = EMPTY_PANEL;
let settings = DEFAULT_SETTINGS;
let settingsOpen = false;
let drawnContent = "";

// DOM helpers

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.append(...children.filter((child) => child !== null));
  return el;
};

const button = (attrs: Record<string, string>, onClick: () => unknown, ...children: Child[]) => {
  const el = h("button", { type: "button", ...attrs }, ...children);
  el.addEventListener("click", onClick);
  return el;
};

const icon = (name: IconName) => {
  const el = h("span", { class: "octicon", "aria-hidden": "true" });
  el.style.maskImage = `url("assets/icons/${name}.svg")`;
  return el;
};

const relativeTime = (from: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  if (seconds < MINUTE) return "now";
  const step = TIME_STEPS.find((candidate) => seconds < candidate.below);
  if (!step) return `${Math.floor(seconds / YEAR)}y`;
  return `${Math.floor(seconds / step.size)}${step.unit}`;
};

const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Browser actions

const sendMessage = (message: PanelMessage) => chrome.runtime.sendMessage(message);

const openTab = async (url: string, active = true) => {
  await chrome.tabs.create({ url, active });
};

// The tab may be on a subpage like /files or #comment-1, but /pull/123 must not match /pull/12
const isSamePr = (tabUrl: string | undefined, prUrl: string) => {
  if (tabUrl === undefined || !tabUrl.startsWith(prUrl)) return false;
  const rest = tabUrl.slice(prUrl.length);
  return rest === "" || /^[/?#]/.test(rest);
};

const focusOrOpen = async (url: string) => {
  const tabs = await chrome.tabs.query({ url: `${url}*` });
  const tab = tabs.find((candidate) => isSamePr(candidate.url, url));
  if (tab?.id === undefined) return openTab(url);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
};

const reauthUrl = (org: string) => {
  if (org === UNKNOWN_ORG) return `${GITHUB_ORIGIN}/pulls`;
  return `${GITHUB_ORIGIN}/orgs/${encodeURIComponent(org)}/sso`;
};

const startReauth = async (org: string) => {
  await openTab(reauthUrl(org));
  await sendMessage({ type: "reauth-started" });
};

// Banners

const actionButton = (label: string, iconName: IconName, onClick: () => unknown) =>
  button({ class: "button" }, onClick, icon(iconName), label);

const banner = (tone: Tone, iconName: IconName, body: Child[], action: HTMLElement | null = null) =>
  h(
    "div",
    { class: `banner banner-${tone}`, role: "status" },
    icon(iconName),
    h("div", { class: "banner-body" }, ...body),
    action,
  );

const errorBanner = (error: PanelError) => {
  switch (error.kind) {
    case "logged_out":
      return banner(
        "warning",
        "sign-in",
        ["Not logged in to GitHub."],
        actionButton("Log in", "sign-in", () => openTab(LOGIN_URL)),
      );
    case "rate_limited":
      return banner("warning", "alert", [
        `Rate limited by GitHub. Retrying after ${timeOfDay(error.retryAt)}.`,
      ]);
    case "offline":
      return banner("info", "alert", ["Can't reach GitHub. Showing the last loaded PRs."]);
    case "search_error":
      return banner("error", "alert", [
        `GitHub search failed: ${error.message}`,
        h("small", { class: "banner-detail" }, "If it keeps failing, check the search queries in settings."),
      ]);
    case "failed":
      return banner("error", "alert", [
        "Couldn't load PRs from GitHub.",
        h("small", { class: "banner-detail" }, error.detail),
      ]);
  }
};

const ssoBanner = (org: string) =>
  banner(
    "warning",
    "key",
    ["SSO expired for ", h("strong", {}, org), ". Re-authenticate to see and open its PRs."],
    actionButton("Re-authenticate", "key", () => startReauth(org)),
  );

const ssoUnknownBanner = () =>
  banner("warning", "alert", ["Couldn't check SSO status. GitHub may have changed its page format."]);

// Nothing to click: only the org or a different network can lift the block
const ipBlockedBanner = (org: string) =>
  banner("info", "shield-lock", [
    h("strong", {}, org),
    " has an IP allow list that blocks your current IP, so its PRs are hidden.",
    h("small", { class: "banner-detail" }, "Connect from an allowed network, like a VPN, to see them."),
  ]);

const banners = ({ ssoOrgs, ssoUnknown, ipBlockedOrgs, error }: PanelState) =>
  [
    ...ssoOrgs.map(ssoBanner),
    ssoUnknown ? ssoUnknownBanner() : null,
    ...ipBlockedOrgs.map(ipBlockedBanner),
    error ? errorBanner(error) : null,
  ].filter((el) => el !== null);

// PR list

const checksEl = (pr: Pr) => {
  const ci = CI_ICONS[pr.ci];
  if (!ci && !pr.checks) return null;
  const label = pr.checks ? `${pr.checks.passed} of ${pr.checks.total} checks passed` : (ci?.label ?? "");
  return h(
    "span",
    { class: `checks ci-${pr.ci}`, title: label, "aria-label": label },
    ci ? icon(ci.name) : null,
    pr.checks ? `${pr.checks.passed}/${pr.checks.total}` : null,
  );
};

const reviewEl = (review: ReviewState) => {
  const label = REVIEW_LABELS[review];
  return label ? h("span", { class: `review review-${review}` }, label) : null;
};

const authorEl = (pr: Pr) => {
  const avatar = h("img", {
    class: "avatar",
    src: `${GITHUB_ORIGIN}/${encodeURIComponent(pr.author)}.png?size=32`,
    alt: "",
    width: "14",
    height: "14",
    loading: "lazy",
  });
  avatar.addEventListener("error", () => avatar.remove());
  return h("span", { class: "pr-author" }, avatar, pr.author);
};

const separator = () => h("span", { class: "separator", "aria-hidden": "true" }, "·");

const meta = (pr: Pr, showAuthor: boolean) => {
  const details = [
    showAuthor ? authorEl(pr) : null,
    h("span", { "data-time": String(Date.parse(pr.updatedAt)) }),
    reviewEl(pr.review),
  ].filter((el) => el !== null);
  return h(
    "span",
    { class: "pr-meta" },
    h("span", { class: "pr-repo" }, pr.repo),
    h("span", {}, `#${pr.number}`),
    ...details.flatMap((el) => [separator(), el]),
  );
};

// Click switches to the PR's tab if it's open; Cmd/Ctrl-click and middle-click open it in the background
const openOnClick = (link: HTMLAnchorElement, url: string) => {
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) return openTab(url, false);
    await focusOrOpen(url);
  });
  link.addEventListener("auxclick", async (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    await openTab(url, false);
  });
};

const row = (pr: Pr, showAuthor: boolean) => {
  const link = h(
    "a",
    { class: "pr", href: pr.url, title: pr.title },
    h(
      "span",
      { class: pr.isDraft ? "pr-state draft" : "pr-state open" },
      icon(pr.isDraft ? "git-pull-request-draft" : "git-pull-request"),
    ),
    h("span", { class: "pr-main" }, h("span", { class: "pr-title" }, pr.title), meta(pr, showAuthor)),
    h("span", { class: "pr-status" }, checksEl(pr)),
  );
  openOnClick(link, pr.url);
  return h("li", {}, link);
};

const moreLink = (section: Section, query: string) => {
  const hidden = section.totalCount - section.prs.length;
  if (hidden <= 0) return null;
  return h("a", { class: "more", href: searchUrl(query), target: "_blank" }, `+${hidden} more on GitHub`);
};

const prSection = ({ title, section, query, showAuthor }: SectionInfo) => {
  const list =
    section.prs.length === 0
      ? h("p", { class: "placeholder" }, "Nothing waiting 🎉")
      : h("ul", { class: "pr-list" }, ...section.prs.map((pr) => row(pr, showAuthor)));
  return h(
    "section",
    { class: "section" },
    h("h2", { class: "section-title" }, `${title} (${section.totalCount})`),
    list,
    moreLink(section, query),
  );
};

const prSections = ({ review, mine, error }: PanelState, queries: Queries) => {
  if (review && mine) {
    return [
      prSection({ title: "Review requested", section: review, query: queries.review, showAuthor: true }),
      prSection({ title: "My PRs", section: mine, query: queries.mine, showAuthor: false }),
    ];
  }
  // Nothing loaded yet: the error banner explains why, otherwise the first refresh is still running
  if (error) return [];
  return [h("p", { class: "placeholder" }, "Loading…")];
};

// Settings form

const numberInput = (key: keyof typeof LIMITS) =>
  h("input", {
    class: "input input-number",
    type: "number",
    min: String(LIMITS[key].min),
    max: String(LIMITS[key].max),
    step: "1",
    required: "",
  });

const textInput = (attrs: Record<string, string> = {}) =>
  h("input", { class: "input", type: "text", spellcheck: "false", autocomplete: "off", ...attrs });

const field = (label: string, control: HTMLElement) =>
  h("label", { class: "field" }, h("span", { class: "field-label" }, label), control);

const group = (legend: string, hint: string | null, ...children: Child[]) =>
  h(
    "fieldset",
    { class: "group" },
    h("legend", { class: "section-title" }, legend),
    ...children,
    hint ? h("small", { class: "hint" }, hint) : null,
  );

const settingsForm = (initial: Settings, onClose: () => void) => {
  const review = textInput({ required: "" });
  const mine = textInput({ required: "" });
  const refreshMinutes = numberInput("refreshMinutes");
  const fastSeconds = numberInput("fastRefreshSeconds");
  const fastRuns = numberInput("fastRefreshMaxRuns");
  const errorEl = h("p", { class: "form-error", role: "alert" });

  const fill = (values: Settings) => {
    review.value = values.queries.review;
    mine.value = values.queries.mine;
    refreshMinutes.value = String(values.refreshMinutes);
    fastSeconds.value = String(values.fastRefreshSeconds);
    fastRuns.value = String(values.fastRefreshMaxRuns);
    errorEl.textContent = "";
  };

  const save = async () => {
    const result = parseSettingsForm({
      review: review.value,
      mine: mine.value,
      refreshMinutes: refreshMinutes.value,
      fastRefreshSeconds: fastSeconds.value,
      fastRefreshMaxRuns: fastRuns.value,
    });
    if (!result.ok) {
      errorEl.textContent = result.error;
      return;
    }
    await write({ settings: result.settings });
    onClose();
  };

  const form = h(
    "form",
    { class: "settings", novalidate: "" },
    group(
      "Search queries",
      "GitHub search syntax, e.g. user-review-requested:@me or -is:draft.",
      field("Review requested", review),
      field("My PRs", mine),
    ),
    group("Refresh", null, h("label", { class: "inline-field" }, "Every", refreshMinutes, "minutes")),
    group(
      "SSO",
      null,
      h(
        "label",
        { class: "inline-field" },
        "After Re-authenticate, refresh every",
        fastSeconds,
        "seconds, up to",
        fastRuns,
        "times",
      ),
    ),
    errorEl,
    h(
      "div",
      { class: "settings-actions" },
      button({ class: "button button-link" }, () => fill(DEFAULT_SETTINGS), "Reset to defaults"),
      button({ class: "button" }, onClose, "Cancel"),
      h("button", { class: "button button-primary", type: "submit" }, "Save"),
    ),
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });

  fill(initial);
  return form;
};

// Panel

const updatedText = (fetchedAt: number | null, now: number) => {
  if (fetchedAt === null) return "";
  const ago = relativeTime(fetchedAt, now);
  return ago === "now" ? "just now" : `${ago} ago`;
};

const updateTimes = () => {
  const now = Date.now();
  updatedEl.textContent = updatedText(panel.fetchedAt, now);
  for (const el of mainEl.querySelectorAll<HTMLElement>("[data-time]")) {
    el.textContent = relativeTime(Number(el.dataset.time), now);
  }
};

// Redraw only when what's shown changed, so keyboard focus isn't lost and banners aren't re-announced
const redraw = () => {
  const { review, mine, error, ssoOrgs, ssoUnknown, ipBlockedOrgs } = panel;
  const content = JSON.stringify({
    review,
    mine,
    error,
    ssoOrgs,
    ssoUnknown,
    ipBlockedOrgs,
    queries: settings.queries,
  });
  if (settingsOpen || content === drawnContent) return;
  drawnContent = content;
  bannersEl.replaceChildren(...banners(panel));
  mainEl.replaceChildren(...prSections(panel, settings.queries));
};

const render = () => {
  refreshButton.classList.toggle("spinning", panel.refreshing);
  redraw();
  updateTimes();
};

const openSettings = () => {
  settingsOpen = true;
  drawnContent = "";
  settingsButton.hidden = true;
  bannersEl.replaceChildren();
  mainEl.replaceChildren(settingsForm(settings, closeSettings));
  mainEl.querySelector("input")?.focus();
};

const closeSettings = () => {
  settingsOpen = false;
  settingsButton.hidden = false;
  render();
  settingsButton.focus();
};

const start = async () => {
  refreshButton.append(icon("sync"));
  settingsButton.append(icon("gear"));
  refreshButton.addEventListener("click", () => sendMessage({ type: "refresh" }));
  settingsButton.addEventListener("click", openSettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) settings = sanitizeSettings(changes.settings.newValue);
    if (!changes.panel) return;
    panel = { ...EMPTY_PANEL, ...(changes.panel.newValue as PanelState | undefined) };
    render();
  });
  setInterval(updateTimes, TICK_MS);

  settings = await readSettings();
  panel = await readPanel();
  render();
  const stale = panel.fetchedAt === null || Date.now() - panel.fetchedAt > settings.refreshMinutes * 60_000;
  if (stale) await sendMessage({ type: "refresh" });
};

start();

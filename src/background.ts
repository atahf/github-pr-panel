import { fetchPanel } from "~/github";
import { read, readPanel, readSettings, write } from "~/storage";
import type { PanelMessage, PanelState } from "~/types";

const REFRESH_ALARM = "refresh";
const FAST_REFRESH_ALARM = "fast-refresh";
const NEUTRAL_COLOR = "#59636e";
const WARNING_COLOR = "#bf8700";

let inFlight: Promise<void> | null = null;

// Badge

const warningOf = (panel: PanelState) => {
  if (panel.error?.kind === "logged_out") return "Not logged in to GitHub";
  if (panel.ssoOrgs.length > 0) return `SSO expired for ${panel.ssoOrgs.join(", ")}`;
  return null;
};

const setBadge = async (text: string, color: string, title: string) => {
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title }),
  ]);
};

// IP-blocked orgs only go in the tooltip, since the user can't fix them from here
const ipNoteOf = ({ ipBlockedOrgs }: PanelState) =>
  ipBlockedOrgs.length > 0 ? ` · PRs hidden by IP allow list: ${ipBlockedOrgs.join(", ")}` : "";

const updateBadge = async (panel: PanelState) => {
  const warning = warningOf(panel);
  const ipNote = ipNoteOf(panel);
  if (warning) return setBadge("!", WARNING_COLOR, `PR Panel: ${warning}${ipNote}`);
  const count = panel.review?.totalCount ?? 0;
  if (count === 0) return setBadge("", NEUTRAL_COLOR, `PR Panel${ipNote}`);
  return setBadge(String(count), NEUTRAL_COLOR, `PR Panel: ${count} review requests${ipNote}`);
};

// Refresh

const isRateLimited = (panel: PanelState) =>
  panel.error?.kind === "rate_limited" && Date.now() < panel.error.retryAt;

const refreshPanel = async () => {
  const settings = await readSettings();
  const previous = await readPanel();
  if (isRateLimited(previous)) return;
  await write({ panel: { ...previous, refreshing: true } });
  const panel = await fetchPanel(settings.queries, previous);
  await write({ panel });
  await updateBadge(panel);
};

// Callers that arrive while a refresh is running share it instead of starting another
const refresh = () => {
  inFlight ??= refreshPanel()
    .catch((error: unknown) => console.error("Refresh failed", error))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

const scheduleRefresh = async () => {
  const { refreshMinutes } = await readSettings();
  await chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: refreshMinutes });
};

// After re-authenticating, refresh often until SSO recovers or the runs are used up
const startFastRefresh = async () => {
  const { fastRefreshSeconds, fastRefreshMaxRuns } = await readSettings();
  const minutes = fastRefreshSeconds / 60;
  await write({ fastRefreshLeft: fastRefreshMaxRuns });
  await chrome.alarms.create(FAST_REFRESH_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
};

const fastRefreshTick = async () => {
  const left = ((await read("fastRefreshLeft")) ?? 0) - 1;
  await write({ fastRefreshLeft: left });
  await refresh();
  const { ssoOrgs } = await readPanel();
  if (left > 0 && ssoOrgs.length > 0) return;
  await chrome.alarms.clear(FAST_REFRESH_ALARM);
};

// Event handlers

const setup = async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await scheduleRefresh();
  await refresh();
};

const onSettingsChanged = async () => {
  await scheduleRefresh();
  // A refresh that's already running uses the old settings, so run another after it
  await inFlight;
  await refresh();
};

const onAlarm = async (alarm: chrome.alarms.Alarm) => {
  if (alarm.name === REFRESH_ALARM) await refresh();
  if (alarm.name === FAST_REFRESH_ALARM) await fastRefreshTick();
};

const MESSAGE_HANDLERS: Record<PanelMessage["type"], () => Promise<void>> = {
  refresh,
  "reauth-started": startFastRefresh,
};

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener(onAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) onSettingsChanged();
});
chrome.runtime.onMessage.addListener((message: PanelMessage, _sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message.type];
  if (!handler) return false;
  handler().then(
    () => sendResponse(true),
    () => sendResponse(false),
  );
  return true;
});

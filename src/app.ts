import type { AuthPayload, CiState, DashboardPayload, Freshness, Project } from "./types.js";
import { dashboardRoute, validRepoSlug } from "./routing.js";

type SortKey = "repo" | "version" | "release" | "since" | "activity" | "issues" | "prs" | "ci";
type SortDirection = "asc" | "desc";

const state = {
  data: null as DashboardPayload | null,
  auth: null as AuthPayload | null,
  query: "",
  filter: "all" as Freshness | "all",
  sortKey: "activity" as SortKey,
  sortDirection: "desc" as SortDirection,
  devMode: localStorage.getItem("releasedeck:dev-mode") === "true",
  hiddenOwners: new Set<string>(
    JSON.parse(localStorage.getItem("releasedeck:hidden-owners") || "[]") as string[],
  ),
  hiddenRepos: new Set<string>(
    JSON.parse(localStorage.getItem("releasedeck:hidden-repos") || "[]") as string[],
  ),
  route: dashboardRoute(location.pathname, location.search),
};

const numberFormat = new Intl.NumberFormat("en", { notation: "compact" });
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const elements = {
  dashboardTitle: query<HTMLHeadingElement>("#dashboardTitle"),
  generated: query<HTMLSpanElement>("#generated"),
  subtitle: query<HTMLParagraphElement>("#subtitle"),
  repoCount: query<HTMLSpanElement>("#repoCount"),
  releasedCount: query<HTMLSpanElement>("#releasedCount"),
  commitCount: query<HTMLSpanElement>("#commitCount"),
  staleCount: query<HTMLSpanElement>("#staleCount"),
  search: query<HTMLInputElement>("#search"),
  devMode: query<HTMLInputElement>("#devMode"),
  accountMenu: query<HTMLDivElement>("#accountMenu"),
  accountButton: query<HTMLButtonElement>("#accountButton"),
  accountLabel: query<HTMLSpanElement>("#accountLabel"),
  accountDropdown: query<HTMLDivElement>("#accountDropdown"),
  settingsButton: query<HTMLButtonElement>("#settingsButton"),
  settingsPanel: query<HTMLDivElement>("#settingsPanel"),
  settingsSummary: query<HTMLParagraphElement>("#settingsSummary"),
  connectionStatus: query<HTMLParagraphElement>("#connectionStatus"),
  sourceForm: query<HTMLFormElement>("#sourceForm"),
  sourceInput: query<HTMLInputElement>("#sourceInput"),
  installButton: query<HTMLButtonElement>("#installButton"),
  logoutButton: query<HTMLButtonElement>("#logoutButton"),
  ownerToggles: query<HTMLDivElement>("#ownerToggles"),
  repoToggles: query<HTMLDivElement>("#repoToggles"),
  projects: query<HTMLDivElement>("#projects"),
  template: query<HTMLTemplateElement>("#projectRow"),
  sortButtons: document.querySelectorAll<HTMLButtonElement>("[data-sort]"),
};

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing ${selector}`);
  }
  return element;
}

function ownerLabel(data: DashboardPayload): string {
  if (data.owners.length > 0) {
    const [first] = data.owners;
    const extraCount = data.owners.length - 1 + state.route.repos.length;
    return `${first ? `@${first.login}` : "custom"}${extraCount > 0 ? ` +${extraCount}` : ""}`;
  }
  if (state.route.repos.length === 1) {
    return state.route.repos[0] ?? "custom deck";
  }
  return state.route.repos.length > 1 ? `custom deck +${state.route.repos.length}` : "@steipete";
}

function daysAgo(value: string | null): number | null {
  if (!value) return null;
  return Math.round((Date.parse(value) - Date.now()) / 86400000);
}

function absoluteDate(value: string | null): string {
  return value ? dateFormat.format(new Date(value)) : "no release";
}

function relativeDate(value: string | null): string {
  const days = daysAgo(value);
  if (days === null) return "never";
  if (Math.abs(days) < 7) {
    if (days === 0) return "today";
    if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`;
    return `in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (Math.abs(days) < 45) return relativeFormat.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 18) return relativeFormat.format(months, "month");
  return relativeFormat.format(Math.round(months / 12), "year");
}

function matches(project: Project): boolean {
  if (project.archived && !state.data?.options?.includeArchived) return false;
  if (state.hiddenOwners.has(project.owner.toLowerCase())) return false;
  if (state.hiddenRepos.has(project.fullName.toLowerCase())) return false;
  if (state.filter !== "all" && project.freshness !== state.filter) return false;
  if (!state.query) return true;
  const haystack = [
    project.fullName,
    project.description,
    project.language,
    project.version,
    project.freshness,
    project.ciState,
    project.ciWorkflow,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.query);
}

function persistVisibility(): void {
  localStorage.setItem("releasedeck:hidden-owners", JSON.stringify([...state.hiddenOwners]));
  localStorage.setItem("releasedeck:hidden-repos", JSON.stringify([...state.hiddenRepos]));
}

function addSource(value: string): void {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) return;

  const url = new URL(location.href);
  const key = validRepoSlug(normalized) ? "repos" : "owners";
  if (key === "owners" && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(normalized)) {
    elements.sourceInput.setCustomValidity("Use @owner or owner/repo");
    elements.sourceInput.reportValidity();
    return;
  }

  const values = [
    ...new Set((url.searchParams.get(key) ?? "").split(",").filter(Boolean).concat(normalized)),
  ].sort();
  url.searchParams.set(key, values.join(","));
  localStorage.setItem("releasedeck:custom-sources", url.search);
  location.assign(url.toString());
}

function toggleSet(set: Set<string>, key: string, visible: boolean): void {
  if (visible) {
    set.delete(key);
  } else {
    set.add(key);
  }
}

function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const item = document.createElement("label");
  item.className = "setting-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const span = document.createElement("span");
  span.textContent = label;
  item.append(input, span);
  return item;
}

function renderSettings(): void {
  const data = state.data;
  if (!data) return;

  const owners = [...new Set(data.projects.map((project) => project.owner.toLowerCase()))].sort();
  elements.ownerToggles.replaceChildren(
    ...owners.map((owner) =>
      checkbox(`@${owner}`, !state.hiddenOwners.has(owner), (checked) => {
        toggleSet(state.hiddenOwners, owner, checked);
        persistVisibility();
        render();
      }),
    ),
  );

  elements.repoToggles.replaceChildren(
    ...data.projects.map((project) => {
      const key = project.fullName.toLowerCase();
      return checkbox(project.fullName, !state.hiddenRepos.has(key), (checked) => {
        toggleSet(state.hiddenRepos, key, checked);
        persistVisibility();
        render();
      });
    }),
  );

  const hiddenCount = state.hiddenOwners.size + state.hiddenRepos.size;
  const sourceCount = state.route.extraOwners.length + state.route.repos.length;
  elements.settingsSummary.textContent = `${sourceCount === 0 ? "default sources" : `${numberFormat.format(sourceCount)} added`} · ${
    hiddenCount === 0 ? "all visible" : `${numberFormat.format(hiddenCount)} hidden`
  }`;
  renderAuth();
}

function currentReturnTo(): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function setAccountMenuOpen(open: boolean): void {
  elements.accountDropdown.hidden = !open;
  elements.accountButton.setAttribute("aria-expanded", String(open));
}

function toggleSettingsPanel(): void {
  const open = elements.settingsPanel.toggleAttribute("data-open");
  elements.settingsButton.setAttribute("aria-pressed", String(open));
}

function login(): void {
  const loginUrl = new URL(state.auth?.loginUrl ?? "/api/auth/login", location.origin);
  loginUrl.searchParams.set("returnTo", currentReturnTo());
  location.assign(loginUrl.toString());
}

function installApp(): void {
  const installUrl = new URL(state.auth?.installUrl ?? "/api/auth/install", location.origin);
  installUrl.searchParams.set("returnTo", currentReturnTo());
  location.assign(installUrl.toString());
}

function logout(): void {
  const logoutUrl = new URL(state.auth?.logoutUrl ?? "/api/auth/logout", location.origin);
  logoutUrl.searchParams.set("returnTo", currentReturnTo());
  location.assign(logoutUrl.toString());
}

function renderAuth(): void {
  const auth = state.auth;
  if (!auth?.configured) {
    elements.accountLabel.textContent = "Login Unavailable";
    elements.accountButton.disabled = true;
    elements.installButton.hidden = true;
    elements.connectionStatus.textContent = "GitHub connection is not configured.";
    setAccountMenuOpen(false);
    return;
  }

  elements.accountButton.disabled = false;
  if (auth.user) {
    elements.accountLabel.textContent = `@${auth.user.login}`;
    elements.installButton.hidden = !auth.installNeeded;
    elements.connectionStatus.textContent =
      auth.installReason ??
      (auth.quotaConfigured
        ? `${auth.installations.length === 0 ? "Signed in." : `Connected to ${numberFormat.format(auth.installations.length)} GitHub App installation${auth.installations.length === 1 ? "" : "s"}.`}`
        : "Signed in. Dedicated app quota is not configured on this deployment.");
  } else {
    elements.accountLabel.textContent = "Connect GitHub";
    elements.installButton.hidden = true;
    elements.connectionStatus.textContent = auth.quotaConfigured
      ? "Connect GitHub to use dedicated API quota for dashboards you choose."
      : "Connect GitHub to manage dashboard access.";
    setAccountMenuOpen(false);
  }
}

function tag(label: string, tone = ""): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `tag ${tone}`.trim();
  span.textContent = label;
  return span;
}

function timestamp(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function ciRank(project: Project): number {
  const rank: Record<CiState, number> = {
    failure: 7,
    cancelled: 6,
    running: 5,
    pending: 4,
    unknown: 3,
    skipped: 2,
    neutral: 1,
    success: 0,
  };
  return rank[project.ciState];
}

function sortValue(project: Project, sortKey: SortKey): string | number {
  switch (sortKey) {
    case "repo":
      return project.fullName.toLowerCase();
    case "version":
      return (project.version ?? "").toLowerCase();
    case "release":
      return timestamp(project.releaseDate);
    case "since":
      return project.commitsSinceRelease ?? -1;
    case "activity":
      return timestamp(project.latestCommitDate || project.pushedAt);
    case "issues":
      return project.openIssues;
    case "prs":
      return project.openPullRequests;
    case "ci":
      return ciRank(project);
  }
}

function sortProjects(projects: Project[]): Project[] {
  const direction = state.sortDirection === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    const aValue = sortValue(a, state.sortKey);
    const bValue = sortValue(b, state.sortKey);
    if (typeof aValue === "string" && typeof bValue === "string") {
      return aValue.localeCompare(bValue) * direction;
    }
    return ((aValue as number) - (bValue as number)) * direction;
  });
}

function updateSortButtons(): void {
  elements.sortButtons.forEach((button) => {
    const sortKey = button.dataset.sort as SortKey;
    const active = sortKey === state.sortKey;
    if (active) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
    button.dataset.direction = active ? state.sortDirection : "";
  });
}

function issueLink(url: string, count: number): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = String(count);
  return link;
}

function ciLabel(project: Project): string {
  if (project.ciState === "unknown") {
    return "no ci";
  }
  if (project.ciState === "failure") {
    return "fail";
  }
  return project.ciState;
}

function renderProject(project: Project): DocumentFragment {
  const fragment = elements.template.content.cloneNode(true);
  if (!(fragment instanceof DocumentFragment)) {
    throw new Error("Project template did not clone to a document fragment");
  }

  const row = fragment.querySelector<HTMLElement>(".project");
  if (!row) {
    throw new Error("Project template is missing .project");
  }
  row.dataset.freshness = project.freshness;

  const link = fragment.querySelector<HTMLAnchorElement>(".repo-link");
  if (!link) {
    throw new Error("Project template is missing .repo-link");
  }
  link.href = project.url;
  link.textContent = project.fullName;

  const description = fragment.querySelector<HTMLParagraphElement>(".description");
  if (!description) {
    throw new Error("Project template is missing .description");
  }
  description.textContent = project.description || "no description";

  const tags = fragment.querySelector<HTMLDivElement>(".tags");
  if (!tags) {
    throw new Error("Project template is missing .tags");
  }
  if (project.language) tags.append(tag(project.language));
  tags.append(tag(`${numberFormat.format(project.stars)} stars`));
  if (project.archived) tags.append(tag("archived", "muted"));
  tags.append(tag(project.freshness));

  const version = fragment.querySelector<HTMLDivElement>(".version-cell");
  if (!version) {
    throw new Error("Project template is missing .version-cell");
  }
  const versionLink = document.createElement("a");
  versionLink.href = project.releaseUrl;
  versionLink.target = "_blank";
  versionLink.rel = "noreferrer";
  versionLink.textContent = project.version;
  version.append(versionLink);

  const release = fragment.querySelector<HTMLDivElement>(".release-cell");
  if (!release) {
    throw new Error("Project template is missing .release-cell");
  }
  const releaseDate = document.createElement("strong");
  releaseDate.textContent = absoluteDate(project.releaseDate);
  const releaseAge = document.createElement("span");
  releaseAge.textContent = relativeDate(project.releaseDate);
  release.replaceChildren(releaseDate, releaseAge);

  const since = fragment.querySelector<HTMLDivElement>(".since-cell");
  if (!since) {
    throw new Error("Project template is missing .since-cell");
  }
  if (project.compareUrl && project.commitsSinceRelease !== null) {
    const compare = document.createElement("a");
    compare.href = project.compareUrl;
    compare.target = "_blank";
    compare.rel = "noreferrer";
    compare.textContent = String(project.commitsSinceRelease);
    since.append(compare);
  } else {
    since.textContent = "n/a";
    since.classList.add("muted");
  }

  const activity = fragment.querySelector<HTMLDivElement>(".activity-cell");
  if (!activity) {
    throw new Error("Project template is missing .activity-cell");
  }
  const activityAge = document.createElement("strong");
  activityAge.textContent = relativeDate(project.latestCommitDate || project.pushedAt);
  const activityRef = document.createElement("span");
  activityRef.textContent = project.latestCommitSha || project.defaultBranch;
  activity.replaceChildren(activityAge, activityRef);

  const issues = fragment.querySelector<HTMLDivElement>(".issues-cell");
  if (!issues) {
    throw new Error("Project template is missing .issues-cell");
  }
  issues.append(issueLink(project.issuesUrl, project.openIssues));

  const prs = fragment.querySelector<HTMLDivElement>(".prs-cell");
  if (!prs) {
    throw new Error("Project template is missing .prs-cell");
  }
  prs.append(issueLink(project.pullRequestsUrl, project.openPullRequests));

  const ci = fragment.querySelector<HTMLDivElement>(".ci-cell");
  if (!ci) {
    throw new Error("Project template is missing .ci-cell");
  }
  ci.dataset.ci = project.ciState;
  if (project.ciUrl) {
    const ciLink = document.createElement("a");
    ciLink.href = project.ciUrl;
    ciLink.target = "_blank";
    ciLink.rel = "noreferrer";
    ciLink.textContent = ciLabel(project);
    ci.append(ciLink);
  } else {
    ci.textContent = ciLabel(project);
  }
  if (project.ciWorkflow || project.ciRunDate) {
    const detail = document.createElement("span");
    detail.textContent = project.ciWorkflow || relativeDate(project.ciRunDate);
    ci.append(detail);
  }

  return fragment;
}

function render(): void {
  if (!state.data) {
    return;
  }

  const projects: Project[] = sortProjects(state.data.projects.filter(matches));
  document.body.classList.toggle("dev-mode", state.devMode);
  elements.projects.replaceChildren(...projects.map(renderProject));
  elements.repoCount.textContent = numberFormat.format(projects.length);
  elements.releasedCount.textContent = numberFormat.format(
    projects.filter((project) => project.releaseDate).length,
  );
  elements.commitCount.textContent = numberFormat.format(
    projects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0),
  );
  elements.staleCount.textContent = numberFormat.format(
    projects.filter((project) => ["hot", "busy"].includes(project.freshness)).length,
  );
  updateSortButtons();
  renderSettings();
}

function updateStatus(): void {
  if (!state.data) return;
  const label = ownerLabel(state.data);
  elements.dashboardTitle.textContent = label;
  elements.subtitle.textContent = state.data.subtitle;
  document.title = `${label} · ReleaseDeck`;
  const cacheState = state.data.cache?.state;
  const stale = state.data.cache?.stale ? " stale" : "";
  const capped = state.data.cache?.capped ? " capped" : "";
  elements.generated.textContent = `updated ${relativeDate(state.data.generatedAt)}${cacheState ? ` · ${cacheState}` : ""}${stale}${capped}`;
}

async function fetchPayload(apiPath: string): Promise<Response> {
  const joiner = apiPath.includes("?") ? "&" : "?";
  return fetch(`${apiPath}${joiner}v=${Date.now()}`, {
    cache: "no-store",
  });
}

async function loadAuth(): Promise<void> {
  try {
    const url = new URL("/api/me", location.origin);
    url.searchParams.set("returnTo", currentReturnTo());
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (response.ok) {
      state.auth = (await response.json()) as AuthPayload;
    }
  } catch {
    state.auth = null;
  }
  renderAuth();
}

async function loadDashboard(attempt = 0): Promise<void> {
  let response = await fetchPayload(state.route.apiPath);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | DashboardPayload
      | { error?: string }
      | null;
    if (body && "cache" in body) {
      state.data = body;
      updateStatus();
      render();
      elements.projects.textContent = body.cache?.message || "dashboard error";
      return;
    }
    if (state.route.fallbackApiPath) {
      response = await fetchPayload(state.route.fallbackApiPath);
      if (response.ok) {
        state.data = (await response.json()) as DashboardPayload;
        updateStatus();
        render();
        return;
      }
    }
    const message =
      body && "error" in body ? body.error : `dashboard fetch failed: ${response.status}`;
    throw new Error(message || `dashboard fetch failed: ${response.status}`);
  }
  state.data = (await response.json()) as DashboardPayload;
  updateStatus();
  render();
  if (state.data.cache?.state === "rebuilding" && attempt < 24) {
    globalThis.setTimeout(() => {
      void loadDashboard(attempt + 1);
    }, 5000);
  }
}

async function boot(): Promise<void> {
  elements.dashboardTitle.textContent = state.route.label;
  elements.devMode.checked = state.devMode;
  await Promise.all([loadAuth(), loadDashboard()]);
}

elements.search.addEventListener("input", () => {
  state.query = elements.search.value.trim().toLowerCase();
  render();
});

elements.devMode.addEventListener("change", () => {
  state.devMode = elements.devMode.checked;
  if (!state.devMode && ["issues", "prs", "ci"].includes(state.sortKey)) {
    state.sortKey = "activity";
    state.sortDirection = "desc";
  }
  localStorage.setItem("releasedeck:dev-mode", String(state.devMode));
  render();
});

elements.accountButton.addEventListener("click", () => {
  if (!state.auth?.configured) return;
  if (!state.auth.user) {
    login();
    return;
  }
  setAccountMenuOpen(elements.accountDropdown.hasAttribute("hidden"));
});

elements.settingsButton.addEventListener("click", () => {
  toggleSettingsPanel();
  setAccountMenuOpen(false);
});

elements.sourceInput.addEventListener("input", () => {
  elements.sourceInput.setCustomValidity("");
});

elements.sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addSource(elements.sourceInput.value);
});

elements.installButton.addEventListener("click", () => {
  installApp();
});

elements.logoutButton.addEventListener("click", () => {
  logout();
});

document.addEventListener("click", (event) => {
  if (elements.accountDropdown.hidden) return;
  if (event.target instanceof Node && elements.accountMenu.contains(event.target)) return;
  setAccountMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setAccountMenuOpen(false);
  }
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = (button as HTMLElement).dataset.filter as Freshness | "all";
    render();
  });
});

elements.sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const sortKey = button.dataset.sort as SortKey;
    if (state.sortKey === sortKey) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = sortKey;
      state.sortDirection = ["repo", "version"].includes(sortKey) ? "asc" : "desc";
    }
    render();
  });
});

boot().catch((error) => {
  elements.generated.textContent = "failed";
  elements.projects.textContent = error instanceof Error ? error.message : String(error);
});

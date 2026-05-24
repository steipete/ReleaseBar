import type { Freshness, Project, RepoDetailPayload } from "./types.js";

export type SortKey = "repo" | "stars" | "release" | "since" | "activity" | "issues" | "prs" | "ci";
export type SortDirection = "asc" | "desc";
export type DashboardFilter = Freshness | "all" | "attention";

export type DashboardViewState = {
  query: string;
  language: string;
  filter: DashboardFilter;
  sortKey: SortKey;
  sortDirection: SortDirection;
  devMode: boolean;
};

export const filterOptions: DashboardFilter[] = ["all", "attention", "hot", "busy", "fresh"];
export const sortOptions: SortKey[] = ["repo", "stars", "release", "since", "activity"];
export const devSortOptions: SortKey[] = ["issues", "prs", "ci"];
const staleReleaseDays = 90;
const releaseDebtCommits = 200;
const pullRequestPressure = 10;
const issuePressure = 100;

const filterValues = new Set<string>(filterOptions);
const sortValues = new Set<string>([...sortOptions, ...devSortOptions]);
const directionValues = new Set<string>(["asc", "desc"]);

export function defaultSortKey(isDefaultRoute: boolean): SortKey {
  return isDefaultRoute ? "since" : "activity";
}

export function defaultSortDirection(key: SortKey): SortDirection {
  return key === "repo" ? "asc" : "desc";
}

export function isDevSortKey(key: SortKey): boolean {
  return devSortOptions.includes(key);
}

export function filterLabel(value: DashboardFilter): string {
  return value === "attention" ? "need attention" : value;
}

export function sortLabel(value: SortKey): string {
  return value === "since" ? "commits since" : value;
}

export function needsAttention(project: Project): boolean {
  return attentionReasons(project).length > 0;
}

export function releaseDebtText(project: Project): string | null {
  return project.releaseDate &&
    project.commitsSinceRelease !== null &&
    project.commitsSinceRelease > releaseDebtCommits
    ? `${project.commitsSinceRelease} commits since release`
    : null;
}

export function attentionReasons(project: Project, now = Date.now()): string[] {
  const reasons: string[] = [];
  const releaseDebt = releaseDebtText(project);
  if (releaseDebt) {
    reasons.push(releaseDebt);
  }
  if (project.releaseDate) {
    const ageDays = Math.floor((now - Date.parse(project.releaseDate)) / 86400000);
    if (Number.isFinite(ageDays) && ageDays >= staleReleaseDays) {
      reasons.push(`last release ${ageDays} days ago`);
    }
  }
  if (project.ciState === "failure" || project.ciState === "cancelled") {
    reasons.push(`CI ${project.ciState === "failure" ? "failing" : "cancelled"}`);
  }
  if (project.openPullRequests >= pullRequestPressure) {
    reasons.push(`${project.openPullRequests} open PRs`);
  }
  if (project.openIssues >= issuePressure) {
    reasons.push(`${project.openIssues} open issues`);
  }
  return reasons;
}

export function parseViewState(
  search: string,
  isDefaultRoute: boolean,
  persistedDevMode = false,
): DashboardViewState {
  const params = new URLSearchParams(search);
  const rawFilter = params.get("filter") ?? "";
  const rawSort = params.get("sort") ?? "";
  const hasCustomSort = sortValues.has(rawSort);
  const sortKey = (hasCustomSort ? rawSort : defaultSortKey(isDefaultRoute)) as SortKey;
  const rawDirection = params.get("dir") ?? "";
  const sortDirection = (
    hasCustomSort && directionValues.has(rawDirection)
      ? rawDirection
      : defaultSortDirection(sortKey)
  ) as SortDirection;
  const devMode = params.get("dev") === "true" || persistedDevMode || isDevSortKey(sortKey);

  return {
    query: (params.get("q") ?? "").trim(),
    language: (params.get("lang") ?? "").trim(),
    filter: (filterValues.has(rawFilter) ? rawFilter : "all") as DashboardFilter,
    sortKey,
    sortDirection,
    devMode,
  };
}

export function viewStateSearch(
  currentSearch: string,
  state: DashboardViewState,
  isDefaultRoute: boolean,
): string {
  const params = new URLSearchParams(currentSearch);
  const normalizedQuery = state.query.trim();
  const normalizedLanguage = state.language.trim();
  const fallbackSortKey = defaultSortKey(isDefaultRoute);
  const fallbackDirection = defaultSortDirection(fallbackSortKey);

  setOrDelete(params, "q", normalizedQuery);
  setOrDelete(params, "lang", normalizedLanguage);
  setOrDelete(params, "filter", state.filter === "all" ? "" : state.filter);

  const customSort = state.sortKey !== fallbackSortKey || state.sortDirection !== fallbackDirection;
  setOrDelete(params, "sort", customSort ? state.sortKey : "");
  setOrDelete(params, "dir", customSort ? state.sortDirection : "");
  setOrDelete(params, "dev", state.devMode ? "true" : "");

  const next = params.toString();
  return next ? `?${next}` : "";
}

export function matchesFilter(project: Project, value: DashboardFilter): boolean {
  if (value === "all") return true;
  if (value === "attention") return needsAttention(project);
  return project.freshness === value;
}

export function matchesProjectSearch(project: Project, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    project.fullName,
    project.description,
    project.language,
    ...(project.topics ?? []),
    project.version,
    project.releaseName,
    project.freshness,
    project.ciState,
    project.ciWorkflow,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function sortValue(project: Project, key: SortKey): string | number {
  switch (key) {
    case "repo":
      return project.fullName.toLowerCase();
    case "stars":
      return project.stars;
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

export function sortProjects(
  projects: Project[],
  activeSortKey: SortKey,
  activeSortDirection: SortDirection,
): Project[] {
  const direction = activeSortDirection === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    const aValue = sortValue(a, activeSortKey);
    const bValue = sortValue(b, activeSortKey);
    if (typeof aValue === "string" && typeof bValue === "string") {
      return aValue.localeCompare(bValue) * direction;
    }
    return ((aValue as number) - (bValue as number)) * direction;
  });
}

export function showCodeChurn(payload: RepoDetailPayload | null): boolean {
  return Boolean(
    payload?.codeFrequency.length || payload?.stats?.codeFrequency.state === "warming",
  );
}

function setOrDelete(params: URLSearchParams, key: string, value: string): void {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

function timestamp(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function ciRank(project: Project): number {
  const rank: Record<Project["ciState"], number> = {
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

export type DashboardRoute = {
  owner: string | null;
  apiPath: string;
  fallbackApiPath: string | null;
  label: string;
  isDefault: boolean;
  extraOwners: string[];
  repos: string[];
  discoverPeriod: DiscoverPeriod | null;
  discoverLanguage: string;
};

export type DiscoverPeriod = "day" | "week" | "month" | "year" | "releasebar";

export type RepoRoute = {
  owner: string;
  repo: string;
  fullName: string;
  apiPath: string;
  fallbackApiPath: string | null;
};

export type RouteOptions = {
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased: boolean;
};

export const workerApiOrigin = "";
export const workersDevApiOrigin = "https://releasedeck-api.steipete.workers.dev";
const localWorkerApiPort = "8787";
const ownerListKey = "owners";
const repoListKey = "repos";
const discoverLanguageKey = "hotLang";
const reservedRepoRouteOwners = new Set(["api", "og"]);
const discoverPeriodValues = new Set<DiscoverPeriod>([
  "day",
  "week",
  "month",
  "year",
  "releasebar",
]);

type RouteLocation = {
  protocol: string;
  hostname: string;
  port: string;
};

function currentRouteLocation(): RouteLocation | null {
  return (globalThis as { location?: RouteLocation }).location ?? null;
}

export function fallbackApiOrigin(currentLocation = currentRouteLocation()): string {
  if (
    currentLocation &&
    (currentLocation.hostname === "127.0.0.1" || currentLocation.hostname === "localhost") &&
    currentLocation.port !== localWorkerApiPort
  ) {
    return `${currentLocation.protocol}//${currentLocation.hostname}:${localWorkerApiPort}`;
  }
  return workersDevApiOrigin;
}

export function ownerFromPath(pathname: string): string | null {
  const [first] = pathname.split("/").filter(Boolean);
  if (!first || first === "index.html") {
    return null;
  }
  const owner = decodeURIComponent(first).trim().replace(/^@/, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) {
    return null;
  }
  return owner;
}

export function optionsFromSearch(search: string): RouteOptions {
  const params = new URLSearchParams(search);
  return {
    includeForks: params.get("forks") === "true",
    includeArchived: params.get("archived") === "true",
    includeUnreleased: params.get("unreleased") !== "false",
  };
}

export function listParam(search: string, key: string): string[] {
  const params = new URLSearchParams(search);
  return [
    ...new Set(
      (params.get(key) ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function validRepoSlug(repo: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d._-]{1,100}$/i.test(repo);
}

export function repoFromPath(pathname: string, apiOrigin = workerApiOrigin): RepoRoute | null {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const escaped = parts[0] === "-";
  if ((!escaped && parts.length !== 2) || (escaped && parts.length !== 3)) return null;
  const ownerPart = escaped ? parts[1] : parts[0];
  const repoPart = escaped ? parts[2] : parts[1];
  const owner = ownerPart?.trim().replace(/^@/, "").toLowerCase() ?? "";
  const repo = repoPart?.trim().toLowerCase() ?? "";
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) return null;
  const apiPath = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    owner,
    repo,
    fullName,
    apiPath: `${apiOrigin}${apiPath}`,
    fallbackApiPath: apiOrigin === "" ? `${fallbackApiOrigin()}${apiPath}` : null,
  };
}

export function ownerDashboardPath(owner: string): string {
  return `/${encodeURIComponent(owner.trim().replace(/^@/, "").toLowerCase())}`;
}

export function repoDetailPath(fullName: string): string {
  const [owner, repo] = fullName.trim().replace(/^@/, "").toLowerCase().split("/");
  if (!owner || !repo) return "/";
  const prefix = reservedRepoRouteOwners.has(owner) || repo.includes(".") ? "/-" : "";
  return `${prefix}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function discoverPeriodFromSearch(search: string): DiscoverPeriod {
  const value = (new URLSearchParams(search).get("period") ?? "week").toLowerCase();
  if (value === "today") return "day";
  return discoverPeriodValues.has(value as DiscoverPeriod) ? (value as DiscoverPeriod) : "week";
}

export function discoverLanguageFromSearch(search: string): string {
  const value = (new URLSearchParams(search).get(discoverLanguageKey) ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(value) ? value : "";
}

export function dashboardRoute(
  pathname: string,
  search = "",
  apiOrigin = workerApiOrigin,
): DashboardRoute {
  const owner = ownerFromPath(pathname);
  const options = optionsFromSearch(search);
  const extraOwners = listParam(search, ownerListKey).filter(
    (extraOwner) =>
      /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(extraOwner) &&
      extraOwner !== owner?.toLowerCase(),
  );
  const repos = listParam(search, repoListKey).filter(validRepoSlug);
  const query = new URLSearchParams();
  if (options.includeForks) query.set("forks", "true");
  if (options.includeArchived) query.set("archived", "true");
  if (!options.includeUnreleased) query.set("unreleased", "false");
  if (extraOwners.length > 0) query.set(ownerListKey, extraOwners.join(","));
  if (repos.length > 0) query.set(repoListKey, repos.join(","));
  const suffix = query.size > 0 ? `?${query}` : "";

  if (!owner) {
    const custom = extraOwners.length > 0 || repos.length > 0;
    const discoverPeriod = discoverPeriodFromSearch(search);
    const discoverLanguage =
      discoverPeriod === "releasebar" ? "" : discoverLanguageFromSearch(search);
    const discoverQuery = new URLSearchParams();
    if (discoverPeriod !== "week") discoverQuery.set("period", discoverPeriod);
    if (discoverLanguage) discoverQuery.set("lang", discoverLanguage);
    const discoverSuffix = discoverQuery.size > 0 ? `?${discoverQuery}` : "";
    const apiPath = custom
      ? `/api/dashboard${suffix}`
      : discoverPeriod === "releasebar"
        ? "/api/_hot"
        : `/api/_discover${discoverSuffix}`;
    return {
      owner: null,
      apiPath: `${apiOrigin}${apiPath}`,
      fallbackApiPath: apiOrigin === "" ? `${fallbackApiOrigin()}${apiPath}` : null,
      label: custom ? "custom deck" : "GitHub Hot",
      isDefault: !custom,
      extraOwners,
      repos,
      discoverPeriod: custom ? null : discoverPeriod,
      discoverLanguage: custom ? "" : discoverLanguage,
    };
  }

  const ownerPath = `/api/${encodeURIComponent(owner)}${suffix}`;
  return {
    owner,
    apiPath: `${apiOrigin}${ownerPath}`,
    fallbackApiPath: apiOrigin === "" ? `${fallbackApiOrigin()}${ownerPath}` : null,
    label:
      extraOwners.length > 0 || repos.length > 0
        ? `@${owner} +${extraOwners.length + repos.length}`
        : `@${owner}`,
    isDefault: false,
    extraOwners,
    repos,
    discoverPeriod: null,
    discoverLanguage: "",
  };
}

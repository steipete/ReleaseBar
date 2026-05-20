<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import CommandPalette, {
    defineActions,
    paletteStore,
    type action as CommandAction,
    type storeParams as PaletteStoreParams,
  } from "svelte-command-palette";
  import { DropdownMenu } from "bits-ui";

  import {
    defaultSortDirection,
    devSortOptions,
    filterLabel,
    filterOptions,
    isDevSortKey,
    matchesFilter,
    attentionReasons,
    needsAttention,
    parseViewState,
    releaseDebtText,
    showCodeChurn,
    sortLabel,
    sortOptions,
    sortProjects,
    viewStateSearch,
    type DashboardFilter,
    type SortDirection,
    type SortKey,
  } from "./dashboard-view.js";
  import {
    dashboardRoute,
    ownerDashboardPath,
    repoDetailPath,
    repoFromPath,
    validRepoSlug,
    fallbackApiOrigin,
    type DiscoverPeriod,
  } from "./routing.js";
  import type {
    ApiQuota,
    ActivityRange,
    AudienceRange,
    AuthPayload,
    DashboardPayload,
    Owner,
    OwnerActivityPayload,
    Project,
    RepoAudienceBackfillPayload,
    RepoAudiencePayload,
    RepoActivityRange,
    RepoDetailActivityPayload,
    RepoDetailPayload,
    RepoDetailReleaseSummary,
    TrustProfilePayload,
  } from "./types.js";

  const repoRoute = repoFromPath(location.pathname);
  const initialRoute = dashboardRoute(location.pathname, location.search);
  type InitialPageData =
    | { route: "dashboard"; payload: DashboardPayload }
    | { route: "repo"; payload: RepoDetailPayload };

  function initialPageData(): InitialPageData | null {
    const element = document.getElementById("releasebar-initial-data");
    if (!element?.textContent) return null;
    try {
      const parsed = JSON.parse(element.textContent) as InitialPageData;
      return parsed.route === "dashboard" || parsed.route === "repo" ? parsed : null;
    } catch {
      return null;
    }
  }

  const embedded = initialPageData();
  const initialOwnerTab =
    new URLSearchParams(location.search).get("tab") === "trust" ? "trust" : "overview";
  const storedDevMode = localStorage.getItem("releasedeck:dev-mode") === "true";
  const storedTheme = localStorage.getItem("releasedeck:theme");
  let theme: "dark" | "light" = storedTheme === "light" ? "light" : "dark";
  const initialView = parseViewState(
    location.search,
    initialRoute.discoverPeriod === "releasebar",
    storedDevMode,
  );
  const routeScope = initialRoute.owner ?? "default";
  const hiddenOwnersKey = `releasedeck:${routeScope}:hidden-owners`;
  const hiddenReposKey = `releasedeck:${routeScope}:hidden-repos`;

  let data: DashboardPayload | null =
    !repoRoute && embedded?.route === "dashboard" ? embedded.payload : null;
  let repoDetail: RepoDetailPayload | null =
    repoRoute && embedded?.route === "repo" ? embedded.payload : null;
  let auth: AuthPayload | null = null;
  let query = initialView.query;
  let language = initialView.language;
  let filter: DashboardFilter = initialView.filter;
  let sortKey: SortKey = initialView.sortKey;
  let sortDirection: SortDirection = initialView.sortDirection;
  let devMode = initialView.devMode;
  let hiddenOwners = new Set<string>(
    JSON.parse(localStorage.getItem(hiddenOwnersKey) || "[]") as string[],
  );
  let hiddenRepos = new Set<string>(
    JSON.parse(localStorage.getItem(hiddenReposKey) || "[]") as string[],
  );
  let settingsOpen = false;
  let sourceInput = "";
  let profileSaving = false;
  let profileMessage = "";
  let errorMessage = "";
  let paletteText = "";
  let generatedLabel = embedded ? "cached" : "loading";
  let generatedDetail = embedded ? "rendered from cached data" : "";
  let mounted = false;
  let dashboardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let repoDetailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let activityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let repoActivityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let dashboardEventSource: EventSource | null = null;
  let activityRange: ActivityRange = "week";
  let activity: OwnerActivityPayload | null = null;
  let activityLoading = false;
  let activityError = "";
  let repoSummaryRange: RepoActivityRange = "release";
  let repoActivity: RepoDetailActivityPayload | null = null;
  let repoActivityLoading = false;
  let repoActivityError = "";
  let trustProfile: TrustProfilePayload | null = null;
  let trustProfileLoading = false;
  let trustProfileError = "";
  let audienceRange: AudienceRange = "month";
  let audienceQuery = "";
  let audience: RepoAudiencePayload | null = null;
  let audienceLoading = false;
  let audienceError = "";
  let audienceBackfillLoading = false;
  let audienceBackfillMessage = "";
  let audienceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let ownerTab: "overview" | "trust" = initialOwnerTab;

  const numberFormat = new Intl.NumberFormat("en", { notation: "compact" });
  const dateFormat = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeFormat = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  });
  const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const discoverPeriods: Array<{ value: DiscoverPeriod; label: string }> = [
    { value: "day", label: "today" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "year", label: "year" },
    { value: "releasebar", label: "releasebar" },
  ];
  const discoverLanguages = ["TypeScript", "Python", "Rust", "Go", "Swift"];
  const activityRanges: Array<{ value: ActivityRange; label: string }> = [
    { value: "day", label: "day" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
  ];
  const audienceRanges: Array<{ value: AudienceRange; label: string }> = [
    { value: "week", label: "week" },
    { value: "month", label: "month" },
  ];

  $: repoSummaryRanges = repoDetail?.project.releaseDate
    ? [...activityRanges, { value: "release" as RepoActivityRange, label: "since release" }]
    : activityRanges;
  $: label = repoRoute ? (repoDetail?.fullName ?? repoRoute.fullName) : data ? ownerLabel(data) : initialRoute.label;
  $: heroOwner = ownerHero(data);
  $: heroExtraCount = initialRoute.extraOwners.length + initialRoute.repos.length;
  $: subtitle = repoRoute
    ? (repoDetail?.project.description ?? "Repository release and activity detail.")
    : data?.subtitle ?? "Release debt across recently requested public dashboards.";
  $: profileSourceCount =
    (data?.profile?.includeOwners.length ?? 0) + (data?.profile?.includeRepos.length ?? 0);
  $: subtitleOwner =
    !repoRoute &&
    !initialRoute.isDefault &&
    initialRoute.owner &&
    initialRoute.extraOwners.length === 0 &&
    initialRoute.repos.length === 0 &&
    (!data || (data.owners.length === 1 && profileSourceCount === 0))
      ? (data?.owners[0]?.login ?? initialRoute.owner)
      : null;
  $: includeArchived = data?.options?.includeArchived === true;
  $: visibleProjects = data
    ? data.projects.filter((project) =>
        matchesBase(project, query, language, hiddenOwners, hiddenRepos, includeArchived),
      )
    : [];
  $: filteredProjects = sortProjects(
    visibleProjects.filter((project) => matchesFilter(project, filter)),
    sortKey,
    sortDirection,
  );
  $: dashboardFetching =
    (!data && !errorMessage) ||
    (data?.cache?.state === "rebuilding" && data.projects.length === 0);
  $: dashboardUpdating = data?.cache?.state === "partial";
  $: ownerToggles = data
    ? [...new Set(data.projects.map((project) => project.owner.toLowerCase()))].sort()
    : [];
  $: visibleOwnerCount = new Set(visibleProjects.map((project) => project.owner.toLowerCase())).size;
  $: showProjectOwnerAvatars = initialRoute.isDefault || visibleOwnerCount > 1;
  $: languageOptions = data
    ? [
        ...new Set(
          data.projects
            .filter((project) =>
              matchesBase(project, "", "", hiddenOwners, hiddenRepos, includeArchived),
            )
            .map((project) => project.language)
            .filter((language): language is string => Boolean(language)),
        ),
      ].sort((a, b) => a.localeCompare(b))
    : [];
  $: publicProfile = data?.profile ?? null;
  $: publicSourceCount =
    (publicProfile?.includeOwners.length ?? 0) + (publicProfile?.includeRepos.length ?? 0);
  $: sourceCount = publicSourceCount + initialRoute.extraOwners.length + initialRoute.repos.length;
  $: hiddenCount = hiddenOwners.size + hiddenRepos.size;
  $: settingsSummary = `${sourceCount === 0 ? "default sources" : `${numberFormat.format(sourceCount)} added`} · ${
    hiddenCount === 0 ? "all visible" : `${numberFormat.format(hiddenCount)} hidden`
  }`;
  $: connectionStatus = authStatus();
  $: canEditPublicDefault =
    !repoRoute &&
    Boolean(auth?.user && initialRoute.owner) &&
    auth?.user?.login.toLowerCase() === initialRoute.owner?.toLowerCase();
  $: commandActions = defineActions(
    buildCommands(
      filteredProjects,
      ownerToggles,
      languageOptions,
      paletteText,
      hiddenOwners,
      hiddenRepos,
      auth,
      devMode,
      sortKey,
      sortDirection,
      filter,
      settingsSummary,
    ),
  );
  $: document.body.classList.toggle("dev-mode", devMode);
  $: document.title = `${label} · release.bar`;
  $: activeDiscoverPeriod = initialRoute.discoverPeriod ?? "week";
  $: activeDiscoverLanguage = initialRoute.discoverLanguage;
  $: syncViewState(query, language, filter, sortKey, sortDirection, devMode);
  $: detailMaxCommits = maxNumber(repoDetail?.commitActivity.map((week) => week.total) ?? []);
  $: detailMaxContributorCommits = maxNumber(
    repoDetail?.contributors.map((contributor) => contributor.commits) ?? [],
  );
  $: stableReleases = (repoDetail?.releases ?? [])
    .filter((release) => !release.prerelease)
    .slice(0, 3);
  $: preReleases = (repoDetail?.releases ?? [])
    .filter((release) => release.prerelease)
    .slice(0, 3);
  $: detailLanguageTotal = (repoDetail?.languages ?? []).reduce(
    (sum, language) => sum + language.bytes,
    0,
  );
  $: releaseCadence = cadenceSummary(repoDetail?.releases ?? []);
  $: workTrend = repoDetail?.workTrend ?? null;
  $: showOwnerActivity =
    !repoRoute && !initialRoute.isDefault && Boolean(initialRoute.owner) && heroExtraCount === 0;
  $: showTrustProfile = showOwnerActivity;
  $: filteredAudienceUsers = audience ? audienceUsersMatching(audience, audienceQuery) : [];

  function ownerLabel(payload: DashboardPayload): string {
    if (initialRoute.isDefault) {
      return payload.title || "ReleaseBar Hot";
    }
    if (payload.owners.length > 0) {
      const [first] = payload.owners;
      const extraCount = initialRoute.extraOwners.length + initialRoute.repos.length;
      return `${first ? `@${first.login}` : "custom"}${extraCount > 0 ? ` +${extraCount}` : ""}`;
    }
    if (initialRoute.repos.length === 1) {
      return initialRoute.repos[0] ?? "custom deck";
    }
    return initialRoute.repos.length > 1
      ? `custom deck +${initialRoute.repos.length}`
      : initialRoute.label;
  }

  function ownerHero(payload: DashboardPayload | null): Owner | null {
    if (repoRoute || initialRoute.isDefault || !initialRoute.owner) return null;
    return payload?.owners[0] ?? null;
  }

  function ownerAvatarUrl(owner: Owner): string {
    return owner.avatarUrl ?? `https://github.com/${encodeURIComponent(owner.login)}.png?size=160`;
  }

  function projectOwnerAvatarUrl(project: Project): string {
    const owner = data?.owners.find(
      (owner) => owner.login.toLowerCase() === project.owner.toLowerCase(),
    );
    return owner?.avatarUrl ?? `https://github.com/${encodeURIComponent(project.owner)}.png?size=80`;
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

  function relativeReset(value: string): string {
    const time = Date.parse(value);
    if (Number.isNaN(time)) return "";
    const diffMs = time - Date.now();
    if (Math.abs(diffMs) < 90 * 60 * 1000) {
      return relativeFormat.format(Math.round(diffMs / 60000), "minute");
    }
    if (Math.abs(diffMs) < 36 * 60 * 60 * 1000) {
      return `${relativeFormat.format(Math.round(diffMs / 3600000), "hour")} at ${timeFormat.format(new Date(time))}`;
    }
    return `${absoluteDate(value)} at ${timeFormat.format(new Date(time))}`;
  }

  function maxNumber(values: number[]): number {
    return values.reduce((max, value) => Math.max(max, value), 0);
  }

  function percent(value: number, max: number): number {
    if (value <= 0) return 0;
    return max <= 0 ? 0 : Math.max(4, Math.round((value / max) * 100));
  }

  function percentOfTotal(value: number, total: number): number {
    return total <= 0 ? 0 : Math.round((value / total) * 100);
  }

  function shortDate(value: string | null): string {
    if (!value) return "never";
    return dateFormat.format(new Date(value));
  }

  function commitTotal(): number {
    return (repoDetail?.commitActivity ?? []).reduce((sum, week) => sum + week.total, 0);
  }

  function codeTotal(kind: "additions" | "deletions"): number {
    return (repoDetail?.codeFrequency ?? []).reduce((sum, week) => sum + week[kind], 0);
  }

  function releaseSummaryMeta(summary: RepoDetailReleaseSummary): string {
    const count =
      summary.commitCount === null ? "" : `${numberFormat.format(summary.commitCount)} commits`;
    const used =
      summary.commitsUsed > 0 && summary.commitCount !== summary.commitsUsed
        ? `${numberFormat.format(summary.commitsUsed)} summarized`
        : "";
    const model = summary.model ?? "";
    return [count, used, model].filter(Boolean).join(" · ");
  }

  function repoActivityMeta(payload: RepoDetailActivityPayload): string {
    const eventText = `${numberFormat.format(payload.totals.events)} public event${payload.totals.events === 1 ? "" : "s"}`;
    const rangeText =
      payload.range === "day" ? "today" : payload.range === "week" ? "this week" : "this month";
    return `${eventText} ${rangeText} · updated ${relativeDate(payload.generatedAt)}`;
  }

  function median(values: number[]): number | null {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
      : Math.round(sorted[middle] ?? 0);
  }

  function cadenceSummary(releases: RepoDetailPayload["releases"]): {
    medianDays: number | null;
    latestGapDays: number | null;
    releaseCount: number;
  } {
    const dates = releases
      .map((release) => (release.publishedAt ? Date.parse(release.publishedAt) : Number.NaN))
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    const gaps = dates
      .slice(0, -1)
      .map((date, index) => Math.round((date - (dates[index + 1] ?? date)) / 86400000))
      .filter((days) => days >= 0);
    return {
      medianDays: median(gaps),
      latestGapDays: gaps[0] ?? null,
      releaseCount: dates.length,
    };
  }

  function formatDays(value: number | null): string {
    if (value === null) return "n/a";
    return `${numberFormat.format(value)}d`;
  }

  function detailValueStyle(value: string | number | null): string {
    const length = String(value ?? "").length;
    const size = length > 22 ? 24 : length > 16 ? 30 : length > 12 ? 34 : 42;
    return `--detail-value-size: ${size}px; --detail-fit-size: ${size}px`;
  }

  function fitDetailValue(node: HTMLElement, _value: string | number | null) {
    let frame = 0;
    const minSize = 20;

    function preferredSize(): number {
      const parsed = Number.parseFloat(getComputedStyle(node).getPropertyValue("--detail-value-size"));
      return Number.isFinite(parsed) ? parsed : 42;
    }

    function fit() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const preferred = preferredSize();
        node.style.setProperty("--detail-fit-size", `${preferred}px`);
        const rendered = Number.parseFloat(getComputedStyle(node).fontSize);
        const base = Number.isFinite(rendered) ? rendered : preferred;
        const available = node.clientWidth;
        const needed = node.scrollWidth;
        const next =
          available > 0 && needed > available
            ? Math.max(minSize, Math.floor(base * (available / needed) * 0.96))
            : preferred;
        node.style.setProperty("--detail-fit-size", `${next}px`);
      });
    }

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(node);
    fit();

    return {
      update(_next: string | number | null) {
        fit();
      },
      destroy() {
        cancelAnimationFrame(frame);
        observer?.disconnect();
      },
    };
  }

  function attentionText(project: Project): string {
    const reasons = attentionReasons(project).slice(0, 3);
    return reasons.length > 0 ? reasons.join(" · ") : "looks okay";
  }

  function matchesBase(
    project: Project,
    searchQuery: string,
    languageQuery: string,
    hiddenOwnerSet: Set<string>,
    hiddenRepoSet: Set<string>,
    includeArchived: boolean,
  ): boolean {
    if (project.archived && !includeArchived) return false;
    if (hiddenOwnerSet.has(project.owner.toLowerCase())) return false;
    if (hiddenRepoSet.has(project.fullName.toLowerCase())) return false;
    if (languageQuery && project.language?.toLowerCase() !== languageQuery.toLowerCase()) return false;
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return true;
    const haystack = [
      project.fullName,
      project.description,
      project.language,
      ...(project.topics ?? []),
      project.version,
      project.freshness,
      project.ciState,
      project.ciWorkflow,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  }

  function persistVisibility(nextOwners = hiddenOwners, nextRepos = hiddenRepos): void {
    localStorage.setItem(hiddenOwnersKey, JSON.stringify([...nextOwners]));
    localStorage.setItem(hiddenReposKey, JSON.stringify([...nextRepos]));
  }

  function addSource(value: string): void {
    const normalized = value.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) return;

    const url = new URL(location.href);
    const key = validRepoSlug(normalized) ? "repos" : "owners";
    if (key === "owners" && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(normalized)) {
      return;
    }

    const values = [
      ...new Set((url.searchParams.get(key) ?? "").split(",").filter(Boolean).concat(normalized)),
    ].sort();
    url.searchParams.set(key, values.join(","));
    localStorage.setItem("releasedeck:custom-sources", url.search);
    location.assign(url.toString());
  }

  function mergedProfileSources(): { includeOwners: string[]; includeRepos: string[] } {
    const includeOwners = [
      ...(publicProfile?.includeOwners ?? []),
      ...initialRoute.extraOwners,
    ].filter((owner) => !hiddenOwners.has(owner.toLowerCase()));
    return {
      includeOwners: [...new Set(includeOwners)].sort(),
      includeRepos: [
        ...new Set([...(publicProfile?.includeRepos ?? []), ...initialRoute.repos]),
      ]
        .filter((repo) => !hiddenRepos.has(repo.toLowerCase()))
        .sort(),
    };
  }

  function mergedHiddenOwners(): string[] {
    return [...new Set([...(publicProfile?.hiddenOwners ?? []), ...hiddenOwners])].sort();
  }

  function mergedHiddenRepos(): string[] {
    return [...new Set([...(publicProfile?.hiddenRepos ?? []), ...hiddenRepos])].sort();
  }

  async function savePublicDefault(): Promise<void> {
    if (!initialRoute.owner || !canEditPublicDefault) return;
    profileSaving = true;
    profileMessage = "";
    const { includeOwners, includeRepos } = mergedProfileSources();
    try {
      const response = await fetch(`/api/profile/${encodeURIComponent(initialRoute.owner)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeOwners,
          includeRepos,
          hiddenOwners: mergedHiddenOwners(),
          hiddenRepos: mergedHiddenRepos(),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `save failed: ${response.status}`);
      }
      location.assign(`/${encodeURIComponent(initialRoute.owner)}?rdRefresh=${Date.now()}`);
    } catch (error) {
      profileMessage = error instanceof Error ? error.message : String(error);
    } finally {
      profileSaving = false;
    }
  }

  async function resetPublicDefault(): Promise<void> {
    if (!initialRoute.owner || !canEditPublicDefault) return;
    profileSaving = true;
    profileMessage = "";
    try {
      const response = await fetch(`/api/profile/${encodeURIComponent(initialRoute.owner)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `reset failed: ${response.status}`);
      }
      location.assign(`/${encodeURIComponent(initialRoute.owner)}?rdRefresh=${Date.now()}`);
    } catch (error) {
      profileMessage = error instanceof Error ? error.message : String(error);
    } finally {
      profileSaving = false;
    }
  }

  function openOwner(owner: string): void {
    location.assign(`/${encodeURIComponent(owner.replace(/^@/, ""))}`);
  }

  function toggleSet(set: Set<string>, key: string, visible: boolean): Set<string> {
    const next = new Set(set);
    if (visible) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  }

  function toggleOwner(owner: string, visible: boolean): void {
    hiddenOwners = toggleSet(hiddenOwners, owner, visible);
    persistVisibility(hiddenOwners, hiddenRepos);
  }

  function toggleRepo(repo: string, visible: boolean): void {
    hiddenRepos = toggleSet(hiddenRepos, repo.toLowerCase(), visible);
    persistVisibility(hiddenOwners, hiddenRepos);
  }

  function resetHidden(): void {
    hiddenOwners = new Set();
    hiddenRepos = new Set();
    persistVisibility(hiddenOwners, hiddenRepos);
  }

  function currentReturnTo(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function login(): void {
    const loginUrl = new URL(auth?.loginUrl ?? "/api/auth/login", location.origin);
    loginUrl.searchParams.set("returnTo", currentReturnTo());
    location.assign(loginUrl.toString());
  }

  function installApp(): void {
    const installUrl = new URL(auth?.installUrl ?? "/api/auth/install", location.origin);
    installUrl.searchParams.set("returnTo", currentReturnTo());
    location.assign(installUrl.toString());
  }

  function logout(): void {
    const logoutUrl = new URL(auth?.logoutUrl ?? "/api/auth/logout", location.origin);
    logoutUrl.searchParams.set("returnTo", currentReturnTo());
    location.assign(logoutUrl.toString());
  }

  function authStatus(): string {
    if (!auth?.configured) return "GitHub connection is not configured.";
    if (auth.user) {
      return (
        auth.installReason ??
        (auth.quotaConfigured
          ? `${auth.installations.length === 0 ? "Signed in." : `Connected to ${numberFormat.format(auth.installations.length)} GitHub App installation${auth.installations.length === 1 ? "" : "s"}.`}`
          : "Signed in. Dedicated app quota is not configured on this deployment.")
      );
    }
    return auth.quotaConfigured
      ? "Connect GitHub to use dedicated API quota for dashboards you choose."
      : "Connect GitHub to manage dashboard access.";
  }

  function setSort(key: SortKey): void {
    if (isDevSortKey(key) && !devMode) {
      setDevMode(true);
    }
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = defaultSortDirection(key);
    }
  }

  function applyTheme(next: "dark" | "light"): void {
    theme = next;
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    localStorage.setItem("releasedeck:theme", next);
  }

  function toggleTheme(): void {
    applyTheme(theme === "dark" ? "light" : "dark");
  }

  function setDevMode(value: boolean): void {
    devMode = value;
    if (!devMode && isDevSortKey(sortKey)) {
      sortKey = "activity";
      sortDirection = defaultSortDirection(sortKey);
    }
    localStorage.setItem("releasedeck:dev-mode", String(devMode));
  }

  function discoverHref(period: DiscoverPeriod, nextLanguage = activeDiscoverLanguage): string {
    const params = new URLSearchParams();
    if (period !== "week") params.set("period", period);
    if (nextLanguage.trim() && period !== "releasebar") params.set("hotLang", nextLanguage.trim());
    const search = params.toString();
    return search ? `/?${search}` : "/";
  }

  function discoverLanguageHref(nextLanguage: string): string {
    return discoverHref(
      activeDiscoverPeriod,
      discoverLanguageActive(nextLanguage) ? "" : nextLanguage,
    );
  }

  function discoverLanguageActive(nextLanguage: string): boolean {
    return activeDiscoverLanguage.toLowerCase() === nextLanguage.toLowerCase();
  }

  function syncViewState(
    activeQuery: string,
    activeLanguage: string,
    activeFilter: DashboardFilter,
    activeSortKey: SortKey,
    activeSortDirection: SortDirection,
    devEnabled: boolean,
  ): void {
    if (!mounted) return;
    if (repoRoute) return;
    const nextSearch = viewStateSearch(
      location.search,
      {
        query: activeQuery,
        language: activeLanguage,
        filter: activeFilter,
        sortKey: activeSortKey,
        sortDirection: activeSortDirection,
        devMode: devEnabled,
      },
      initialRoute.discoverPeriod === "releasebar",
    );
    if (nextSearch === location.search) return;
    const nextUrl = `${location.pathname}${nextSearch}${location.hash}`;
    history.replaceState(history.state, "", nextUrl);
  }

  function ciLabel(project: Project): string {
    if (project.ciState === "unknown") return "no ci";
    if (project.ciState === "failure") return "fail";
    return project.ciState;
  }

  function quotaLabel(quota: ApiQuota | undefined): string {
    if (!quota) return "";
    const source =
      quota.source === "app"
        ? `app quota${quota.account ? ` @${quota.account}` : ""}`
        : quota.source === "shared"
          ? "shared quota"
          : "anonymous quota";
    const remaining =
      quota.remaining === null ? "" : `${numberFormat.format(quota.remaining)} left`;
    const resetAt = quota.resetAt ? relativeReset(quota.resetAt) : "";
    const reset = resetAt ? `reset ${resetAt}` : "";
    return [source, remaining, reset].filter(Boolean).join(" · ");
  }

  function updateStatus(): void {
    if (!data) return;
    const cacheState = data.cache?.state;
    const stale = data.cache?.stale && cacheState !== "stale" ? "stale" : "";
    const capped = data.cache?.capped
      ? `capped at ${numberFormat.format(data.cache.repoLimit ?? data.projects.length)}`
      : "";
    const quota = quotaLabel(data.cache?.quota);
    generatedLabel =
      cacheState === "partial"
        ? `updating · cached ${relativeDate(data.generatedAt)}`
        : `updated ${relativeDate(data.generatedAt)}`;
    generatedDetail = [cacheState, stale, capped, quota, data.cache?.message ?? ""]
      .filter(Boolean)
      .join(" · ");
  }

  function updateRepoDetailStatus(): void {
    if (!repoDetail) return;
    const cacheState = repoDetail.cache.state;
    const quota = quotaLabel(repoDetail.cache.quota);
    generatedLabel =
      cacheState === "warming"
        ? `warming stats · cached ${relativeDate(repoDetail.generatedAt)}`
        : `updated ${relativeDate(repoDetail.generatedAt)}`;
    generatedDetail = [cacheState, quota, repoDetail.cache.message ?? ""].filter(Boolean).join(" · ");
  }

  async function fetchPayload(apiPath: string, bypassCache = false): Promise<Response> {
    if (!bypassCache) {
      return fetch(apiPath);
    }
    const joiner = apiPath.includes("?") ? "&" : "?";
    return fetch(`${apiPath}${joiner}v=${Date.now()}`, { cache: "no-store" });
  }

  function clearDashboardRefreshParam(): void {
    const params = new URLSearchParams(location.search);
    if (!params.has("rdRefresh")) return;
    params.delete("rdRefresh");
    const nextSearch = params.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash}`,
    );
  }

  async function readDashboardResponse(
    response: Response,
  ): Promise<DashboardPayload | { error?: string } | null> {
    return (await response.json().catch(() => null)) as DashboardPayload | { error?: string } | null;
  }

  function shouldAutoRefresh(payload: DashboardPayload): boolean {
    return (
      payload.cache?.state === "rebuilding" ||
      payload.cache?.state === "partial" ||
      payload.cache?.state === "stale"
    );
  }

  function scheduleDashboardRefresh(attempt: number): void {
    if (dashboardRefreshTimer !== null) {
      globalThis.clearTimeout(dashboardRefreshTimer);
    }
    if (attempt >= 60) return;
    const delay = attempt < 24 ? 5000 : 15000;
    dashboardRefreshTimer = globalThis.setTimeout(() => {
      dashboardRefreshTimer = null;
      if (document.hidden) {
        scheduleDashboardRefresh(attempt);
        return;
      }
      void loadDashboard(attempt + 1).catch(() => undefined);
    }, delay);
  }

  function scheduleRepoDetailRefresh(attempt: number): void {
    if (!repoRoute) return;
    if (repoDetailRefreshTimer !== null) {
      globalThis.clearTimeout(repoDetailRefreshTimer);
    }
    if (attempt >= 36) return;
    const delay = attempt < 8 ? 5000 : 15000;
    repoDetailRefreshTimer = globalThis.setTimeout(() => {
      repoDetailRefreshTimer = null;
      if (document.hidden) {
        scheduleRepoDetailRefresh(attempt);
        return;
      }
      void loadRepoDetail(attempt + 1).catch(() => undefined);
    }, delay);
  }

  function scheduleActivityRefresh(attempt: number): void {
    if (!showOwnerActivity) return;
    if (activityRefreshTimer !== null) {
      globalThis.clearTimeout(activityRefreshTimer);
    }
    if (attempt >= 8) return;
    const delay = attempt < 3 ? 5000 : 15000;
    activityRefreshTimer = globalThis.setTimeout(() => {
      activityRefreshTimer = null;
      if (document.hidden) {
        scheduleActivityRefresh(attempt);
        return;
      }
      void loadOwnerActivity(attempt + 1).catch(() => undefined);
    }, delay);
  }

  function scheduleAudienceRefresh(attempt: number): void {
    if (!repoRoute) return;
    if (audienceRefreshTimer !== null) {
      globalThis.clearTimeout(audienceRefreshTimer);
    }
    if (attempt >= 8) return;
    const delay = attempt < 3 ? 5000 : 15000;
    audienceRefreshTimer = globalThis.setTimeout(() => {
      audienceRefreshTimer = null;
      if (document.hidden) {
        scheduleAudienceRefresh(attempt);
        return;
      }
      void loadRepoAudience(attempt + 1).catch(() => undefined);
    }, delay);
  }

  function scheduleRepoActivityRefresh(attempt: number): void {
    if (!repoRoute || repoSummaryRange === "release") return;
    if (repoActivityRefreshTimer !== null) {
      globalThis.clearTimeout(repoActivityRefreshTimer);
    }
    if (attempt >= 8) return;
    const delay = attempt < 3 ? 5000 : 15000;
    repoActivityRefreshTimer = globalThis.setTimeout(() => {
      repoActivityRefreshTimer = null;
      if (document.hidden) {
        scheduleRepoActivityRefresh(attempt);
        return;
      }
      void loadRepoActivity(attempt + 1).catch(() => undefined);
    }, delay);
  }

  function activityApiPaths(): string[] {
    if (!initialRoute.owner) return [];
    const path = `/api/${encodeURIComponent(initialRoute.owner)}/activity`;
    const url = new URL(path, location.origin);
    url.searchParams.set("range", activityRange);
    const urls = [url.toString()];
    if (initialRoute.fallbackApiPath) {
      const fallback = new URL(path, fallbackApiOrigin());
      fallback.searchParams.set("range", activityRange);
      urls.push(fallback.toString());
    }
    return urls;
  }

  function trustProfileApiPaths(): string[] {
    if (!initialRoute.owner) return [];
    const path = `/api/users/${encodeURIComponent(initialRoute.owner)}/trust`;
    const urls = [new URL(path, location.origin).toString()];
    if (initialRoute.fallbackApiPath) {
      urls.push(new URL(path, fallbackApiOrigin()).toString());
    }
    return urls;
  }

  function audienceApiPath(apiPath: string): string {
    const url = new URL(apiPath, location.origin);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/audience`;
    url.searchParams.set("range", audienceRange);
    return url.toString();
  }

  function audienceApiPaths(): string[] {
    if (!repoRoute) return [];
    const urls = [audienceApiPath(repoRoute.apiPath)];
    if (repoRoute.fallbackApiPath) {
      urls.push(audienceApiPath(repoRoute.fallbackApiPath));
    }
    return urls;
  }

  function isRepoAudiencePayload(body: unknown): body is RepoAudiencePayload {
    if (!body || typeof body !== "object") return false;
    const payload = body as {
      cache?: { state?: unknown };
      fullName?: unknown;
      users?: unknown;
    };
    return (
      typeof payload.fullName === "string" &&
      Array.isArray(payload.users) &&
      typeof payload.cache?.state === "string"
    );
  }

  function audienceBackfillApiPath(apiPath: string): string {
    const url = new URL(apiPath, location.origin);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/audience/backfill`;
    return url.toString();
  }

  function audienceBackfillApiPaths(): string[] {
    if (!repoRoute) return [];
    const urls = [audienceBackfillApiPath(repoRoute.apiPath)];
    if (repoRoute.fallbackApiPath) {
      urls.push(audienceBackfillApiPath(repoRoute.fallbackApiPath));
    }
    return urls;
  }

  function repoActivityApiPaths(): string[] {
    if (!repoRoute || repoSummaryRange === "release") return [];
    const appendActivity = (apiPath: string): string => {
      const url = new URL(`${apiPath.replace(/\/$/, "")}/activity`, location.origin);
      url.searchParams.set("range", repoSummaryRange);
      return url.toString();
    };
    const urls = [appendActivity(repoRoute.apiPath)];
    if (repoRoute.fallbackApiPath) {
      const fallback = new URL(`${repoRoute.fallbackApiPath.replace(/\/$/, "")}/activity`, fallbackApiOrigin());
      fallback.searchParams.set("range", repoSummaryRange);
      urls.push(fallback.toString());
    }
    return urls;
  }

  async function loadOwnerActivity(attempt = 0): Promise<void> {
    if (!showOwnerActivity) return;
    const paths = activityApiPaths();
    if (paths.length === 0) return;
    const requestedRange = activityRange;
    activityLoading = attempt === 0 && !activity;
    activityError = "";
    try {
      for (const path of paths) {
        const response = await fetch(path, {
          cache: attempt > 0 ? "no-store" : "default",
        });
        const body = (await response.json().catch(() => null)) as
          | OwnerActivityPayload
          | { error?: string }
          | null;
        if (body && "events" in body) {
          if (requestedRange !== activityRange) return;
          activity = body;
          if (body.summary?.state === "warming" || body.cache.state === "stale") {
            scheduleActivityRefresh(attempt);
          }
          return;
        }
        activityError =
          body && "error" in body ? (body.error ?? "") : `activity fetch failed: ${response.status}`;
      }
    } catch (error) {
      activityError = error instanceof Error ? error.message : String(error);
    } finally {
      activityLoading = false;
    }
  }

  async function loadTrustProfile(): Promise<void> {
    if (!showTrustProfile) return;
    const paths = trustProfileApiPaths();
    if (paths.length === 0) return;
    trustProfileLoading = !trustProfile;
    trustProfileError = "";
    try {
      for (const path of paths) {
        const response = await fetch(path);
        const body = (await response.json().catch(() => null)) as
          | TrustProfilePayload
          | { error?: string; cache?: { message?: string } }
          | null;
        if (body && "score" in body) {
          trustProfile = body;
          trustProfileError = "";
          return;
        }
        trustProfileError =
          body && "error" in body
            ? (body.error ?? "")
            : body?.cache?.message || `trust profile failed: ${response.status}`;
      }
    } catch (error) {
      trustProfileError = error instanceof Error ? error.message : String(error);
    } finally {
      trustProfileLoading = false;
    }
  }

  async function loadRepoAudience(attempt = 0, bypassCache = false): Promise<void> {
    if (!repoRoute) return;
    const paths = audienceApiPaths();
    if (paths.length === 0) return;
    const requestedRange = audienceRange;
    audienceLoading = attempt === 0 && !audience;
    audienceError = "";
    try {
      for (const path of paths) {
        const response = await fetchPayload(path, bypassCache || attempt > 0);
        const body = (await response.json().catch(() => null)) as
          | RepoAudiencePayload
          | { error?: string; cache?: { message?: string } }
          | null;
        if (isRepoAudiencePayload(body)) {
          if (requestedRange !== audienceRange) return;
          audience = body;
          audienceError = "";
          if (body.cache.state === "stale" || body.cache.state === "warming") {
            scheduleAudienceRefresh(attempt);
          }
          return;
        }
        audienceError =
          body && "error" in body
            ? (body.error ?? "")
            : body?.cache?.message || `audience fetch failed: ${response.status}`;
      }
    } catch (error) {
      audienceError = error instanceof Error ? error.message : String(error);
    } finally {
      audienceLoading = false;
    }
  }

  async function backfillRepoAudience(): Promise<void> {
    if (!repoRoute || audienceBackfillLoading) return;
    const paths = audienceBackfillApiPaths();
    if (paths.length === 0) return;
    audienceBackfillLoading = true;
    audienceBackfillMessage = "";
    try {
      for (const path of paths) {
        const response = await fetch(path, { method: "POST", cache: "no-store" });
        const body = (await response.json().catch(() => null)) as
          | RepoAudienceBackfillPayload
          | { error?: string; message?: string }
          | null;
        if (body && "ranges" in body) {
          audienceBackfillMessage = body.ranges
            .map((range) => `${range.range} ${range.state}`)
            .join(" · ");
          audience = null;
          await loadRepoAudience(0, true);
          return;
        }
        audienceBackfillMessage =
          body && "error" in body
            ? (body.error ?? "")
            : body?.message || `backfill failed: ${response.status}`;
      }
    } catch (error) {
      audienceBackfillMessage = error instanceof Error ? error.message : String(error);
    } finally {
      audienceBackfillLoading = false;
    }
  }

  function setActivityRange(range: ActivityRange): void {
    if (activityRange === range) return;
    activityRange = range;
    activity = null;
    activityError = "";
    if (activityRefreshTimer !== null) {
      globalThis.clearTimeout(activityRefreshTimer);
      activityRefreshTimer = null;
    }
    void loadOwnerActivity();
  }

  function setAudienceRange(range: AudienceRange): void {
    if (audienceRange === range) return;
    audienceRange = range;
    audience = null;
    audienceError = "";
    if (audienceRefreshTimer !== null) {
      globalThis.clearTimeout(audienceRefreshTimer);
      audienceRefreshTimer = null;
    }
    void loadRepoAudience();
  }

  async function loadRepoActivity(attempt = 0): Promise<void> {
    if (!repoRoute || repoSummaryRange === "release") return;
    const paths = repoActivityApiPaths();
    if (paths.length === 0) return;
    const requestedRange = repoSummaryRange;
    repoActivityLoading = attempt === 0 && !repoActivity;
    repoActivityError = "";
    try {
      for (const path of paths) {
        const response = await fetch(path, {
          cache: attempt > 0 ? "no-store" : "default",
        });
        const body = (await response.json().catch(() => null)) as
          | RepoDetailActivityPayload
          | { error?: string }
          | null;
        if (body && "events" in body) {
          if (requestedRange !== repoSummaryRange) return;
          repoActivity = body;
          if (body.summary?.state === "warming" || body.cache.state === "stale") {
            scheduleRepoActivityRefresh(attempt);
          }
          return;
        }
        repoActivityError =
          body && "error" in body
            ? (body.error ?? "")
            : `repository activity fetch failed: ${response.status}`;
      }
    } catch (error) {
      repoActivityError = error instanceof Error ? error.message : String(error);
    } finally {
      repoActivityLoading = false;
    }
  }

  function setRepoSummaryRange(range: RepoActivityRange): void {
    if (repoSummaryRange === range) return;
    repoSummaryRange = range;
    repoActivity = null;
    repoActivityError = "";
    if (repoActivityRefreshTimer !== null) {
      globalThis.clearTimeout(repoActivityRefreshTimer);
      repoActivityRefreshTimer = null;
    }
    if (range !== "release") {
      void loadRepoActivity();
    }
  }

  function activityMeta(payload: OwnerActivityPayload): string {
    const repoText = `${numberFormat.format(payload.totals.repositories)} repo${payload.totals.repositories === 1 ? "" : "s"}`;
    const eventText = `${numberFormat.format(payload.totals.events)} public event${payload.totals.events === 1 ? "" : "s"}`;
    return `${eventText} · ${repoText} · updated ${relativeDate(payload.generatedAt)}`;
  }

  function audienceMeta(payload: RepoAudiencePayload): string {
    const total = `${numberFormat.format(audienceTotalStargazers(payload))} total stargazers`;
    const scored = `${numberFormat.format(payload.totals.stargazersSampled)} scored profiles`;
    const high = `${audienceShare(payload, payload.totals.highSignal, payload.totals.highSignalPercent)} high-signal`;
    const quota = quotaLabel(payload.cache.quota);
    return [total, scored, high, payload.cache.state, quota, `updated ${relativeDate(payload.generatedAt)}`]
      .filter(Boolean)
      .join(" · ");
  }

  function audienceTotalStargazers(payload: RepoAudiencePayload): number {
    return payload.totals.stargazers ?? payload.totals.stargazersSampled;
  }

  function audienceShare(payload: RepoAudiencePayload, count: number, percent: number): string {
    const value = Number.isFinite(percent)
      ? percent
      : payload.totals.stargazersSampled > 0
        ? Math.round((count / payload.totals.stargazersSampled) * 100)
        : 0;
    return `${numberFormat.format(value)}%`;
  }

  function audienceUsersMatching(
    payload: RepoAudiencePayload,
    text: string,
  ): RepoAudiencePayload["users"] {
    const needle = text.trim().toLowerCase();
    if (!needle) return payload.users;
    return payload.users.filter((user) =>
      [
        user.login,
        user.name,
        user.company,
        user.bio,
        user.location,
        user.tier,
        ...user.reasons,
        ...(user.factors ?? []).map((factor) => `${factor.label} ${factor.detail}`),
        ...user.orgs.map((org) => org.login),
        ...user.topRepositories.map((repo) => repo.fullName),
        ...user.topRepositories.map((repo) => repo.language),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  function audienceReasonText(reasons: string[]): string {
    return reasons.length > 0 ? reasons.slice(0, 3).join(" · ") : "public profile signal";
  }

  function trustProfileAge(payload: TrustProfilePayload): string {
    if (payload.accountAgeDays === null) return "age unknown";
    const years = payload.accountAgeDays / 365;
    if (years >= 1) return `${years.toFixed(years >= 10 ? 0 : 1)} years on GitHub`;
    return `${numberFormat.format(payload.accountAgeDays)} days on GitHub`;
  }

  function trustProfileMeta(payload: TrustProfilePayload): string {
    const quota = quotaLabel(payload.cache.quota);
    return [
      trustProfileAge(payload),
      `${numberFormat.format(payload.followers)} followers`,
      `${numberFormat.format(payload.publicRepos)} repos`,
      quota,
      `updated ${relativeDate(payload.generatedAt)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function ownerSignalLabel(payload: TrustProfilePayload | null = trustProfile): string {
    if (payload) return payload.scoreLabel;
    return ownerHero(data)?.type === "org" ? "org signal" : "trust";
  }

  function ownerSignalDescription(payload: TrustProfilePayload | null = trustProfile): string {
    return payload?.type === "org" || (!payload && ownerHero(data)?.type === "org")
      ? "bounded public GitHub organization signals"
      : "bounded public GitHub trust signals";
  }

  function ownerSignalTabLabel(payload: TrustProfilePayload | null = trustProfile): string {
    return payload?.type === "org" || (!payload && ownerHero(data)?.type === "org")
      ? "org signal"
      : "trust";
  }

  function trustDimensionEntries(payload: TrustProfilePayload): Array<[string, number]> {
    if (payload.type === "org") {
      return [
        ["credibility", payload.dimensions.trust],
        ["repo footprint", payload.dimensions.builder],
        ["reach", payload.dimensions.influence],
        ["profile safety", payload.dimensions.risk],
      ];
    }
    return [
      ["trust", payload.dimensions.trust],
      ["build", payload.dimensions.builder],
      ["reach", payload.dimensions.influence],
      ["account safety", payload.dimensions.risk],
    ];
  }

  function trustFactorEntries(payload: TrustProfilePayload): TrustProfilePayload["factors"] {
    return (payload.factors ?? []).filter((factor) => factor.key !== "recency" || factor.value > 0).slice(0, 8);
  }

  function setOwnerTab(tab: "overview" | "trust"): void {
    ownerTab = tab;
    const url = new URL(location.href);
    if (tab === "trust") {
      url.searchParams.set("tab", "trust");
    } else {
      url.searchParams.delete("tab");
    }
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function factorContribution(value: number): string {
    if (value === 0) return "0.0";
    return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
  }

  function audienceInsightText(user: RepoAudiencePayload["users"][number]): string {
    const orgs = user.orgs.slice(0, 2).map((org) => `@${org.login}`).join(", ");
    const topRepo = user.topRepositories[0];
    return [
      orgs ? `orgs ${orgs}` : "",
      topRepo ? `top repo ${topRepo.fullName} · ${numberFormat.format(topRepo.stars)} stars` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function closeDashboardStream(): void {
    dashboardEventSource?.close();
    dashboardEventSource = null;
  }

  function dashboardEventsPath(apiPath: string): string | null {
    const url = new URL(apiPath, location.origin);
    if (url.pathname === "/api/_hot" || url.pathname === "/api/_discover") return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/events`;
    return url.toString();
  }

  function startDashboardStream(attempt: number): boolean {
    if (typeof EventSource === "undefined") return false;
    const eventsPath = dashboardEventsPath(initialRoute.apiPath);
    if (!eventsPath) return false;
    closeDashboardStream();
    dashboardEventSource = new EventSource(eventsPath);
    dashboardEventSource.addEventListener("dashboard", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as DashboardPayload;
      data = next;
      updateStatus();
      if (!shouldAutoRefresh(next)) {
        closeDashboardStream();
      }
    });
    dashboardEventSource.onerror = () => {
      closeDashboardStream();
      scheduleDashboardRefresh(attempt);
    };
    return true;
  }

  async function loadAuth(): Promise<void> {
    try {
      const url = new URL("/api/me", location.origin);
      url.searchParams.set("returnTo", currentReturnTo());
      const response = await fetch(url.toString(), { cache: "no-store" });
      if (response.ok) {
        auth = (await response.json()) as AuthPayload;
      }
    } catch {
      auth = null;
    }
  }

  async function loadDashboard(attempt = 0): Promise<void> {
    const forceRefresh = new URLSearchParams(location.search).has("rdRefresh");
    const bypassCache = attempt > 0 || forceRefresh;
    try {
      let response = await fetchPayload(initialRoute.apiPath, bypassCache);
      let body = await readDashboardResponse(response);
      if (response.ok && body && "projects" in body) {
        data = body;
        updateStatus();
        if (shouldAutoRefresh(data)) {
          if (!startDashboardStream(attempt)) {
            scheduleDashboardRefresh(attempt);
          }
        } else {
          closeDashboardStream();
        }
        return;
      }
      if (body && "cache" in body) {
        data = body;
        updateStatus();
        errorMessage = body.cache?.message || "dashboard error";
        return;
      }
      if (initialRoute.fallbackApiPath) {
        response = await fetchPayload(initialRoute.fallbackApiPath, bypassCache);
        body = await readDashboardResponse(response);
        if (response.ok && body && "projects" in body) {
          data = body;
          updateStatus();
          return;
        }
      }
      const message =
        body && "error" in body ? body.error : `dashboard fetch failed: ${response.status}`;
      throw new Error(message || `dashboard fetch failed: ${response.status}`);
    } finally {
      if (forceRefresh) {
        clearDashboardRefreshParam();
      }
    }
  }

  async function loadRepoDetail(attempt = 0): Promise<void> {
    if (!repoRoute) return;
    const bypassCache = attempt > 0;
    const read = async (apiPath: string) => {
      const response = await fetchPayload(apiPath, bypassCache);
      const body = (await response.json().catch(() => null)) as
        | RepoDetailPayload
        | { error?: string; cache?: { message?: string } }
        | null;
      return { response, body };
    };
    let { response, body } = await read(repoRoute.apiPath);
    if (
      repoRoute.fallbackApiPath &&
      (!response.ok || !body || !("project" in body))
    ) {
      ({ response, body } = await read(repoRoute.fallbackApiPath));
    }
    if (body && "project" in body) {
      repoDetail = body;
      if (!body.project.releaseDate && repoSummaryRange === "release") {
        repoSummaryRange = "month";
      }
      updateRepoDetailStatus();
      if (
        body.cache.state === "warming" ||
        body.cache.state === "stale" ||
        body.releaseSummary?.state === "warming"
      ) {
        scheduleRepoDetailRefresh(attempt);
      }
      if (repoSummaryRange !== "release" && !repoActivity) {
        void loadRepoActivity();
      }
      return;
    }
    const message =
      body && "error" in body
        ? body.error
        : body?.cache?.message || `repository detail failed: ${response.status}`;
    throw new Error(message || `repository detail failed: ${response.status}`);
  }

  function handleSourceSubmit(event: SubmitEvent): void {
    event.preventDefault();
    addSource(sourceInput);
  }

  function openUrl(url: string | null, newTab = true): void {
    if (!url) return;
    if (newTab) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      location.assign(url);
    }
  }

  function activeLanguage(nextLanguage: string): boolean {
    return language.trim().toLowerCase() === nextLanguage.toLowerCase();
  }

  function setLanguageFilter(nextLanguage: string): void {
    language = nextLanguage;
  }

  function toggleLanguageFilter(nextLanguage: string): void {
    language = activeLanguage(nextLanguage) ? "" : nextLanguage;
  }

  function focusSearch(): void {
    document.querySelector<HTMLInputElement>(".prompt input")?.focus();
  }

  async function copyDashboardUrl(): Promise<void> {
    await navigator.clipboard?.writeText(location.href);
  }

  function rowActivationTarget(event: Event): HTMLElement | null {
    return (event.target as HTMLElement | null)?.closest("a, button, input, label") ?? null;
  }

  function rowClick(event: MouseEvent, fullName: string): void {
    if (event.defaultPrevented || rowActivationTarget(event)) return;
    location.assign(repoDetailPath(fullName));
  }

  function rowKeydown(event: KeyboardEvent, fullName: string): void {
    if (event.defaultPrevented) return;
    if (rowActivationTarget(event)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    location.assign(repoDetailPath(fullName));
  }

  function setTopicSearch(topic: string): void {
    query = query.trim().toLowerCase() === topic.toLowerCase() ? "" : topic;
  }

  function sortCommand(key: SortKey): CommandAction {
    return {
      actionId: `sort:${key}`,
      title: `Sort by ${sortLabel(key)}`,
      subTitle: sortKey === key ? `currently ${sortDirection}` : "table order",
      group: "View",
      keywords: ["order", "table", key, sortLabel(key)],
      onRun: () => setSort(key),
    };
  }

  function filterCommand(value: DashboardFilter): CommandAction {
    return {
      actionId: `filter:${value}`,
      title: `Show ${filterLabel(value)}`,
      subTitle: filter === value ? "current filter" : "filter dashboard",
      group: "View",
      keywords: ["filter", value, filterLabel(value)],
      onRun: () => {
        filter = value;
      },
    };
  }

  function languageCommand(language: string): CommandAction {
    return {
      actionId: `language:${language.toLowerCase()}`,
      title: `Show ${language}`,
      subTitle: activeLanguage(language) ? "current language filter" : "language filter",
      group: "Languages",
      keywords: ["language", "tech", "stack", language],
      onRun: () => setLanguageFilter(language),
    };
  }

  function repoCommands(project: Project): CommandAction[] {
    const topics = project.topics ?? [];
    const commands: CommandAction[] = [
      {
        actionId: `repo:${project.fullName}`,
        title: project.fullName,
        subTitle: `${project.version} · ${project.freshness} · ${numberFormat.format(project.stars)} stars`,
        description: project.description ?? undefined,
        group: "Repos",
        keywords: [project.owner, project.name, project.language ?? "", project.version, ...topics],
        onRun: () => location.assign(repoDetailPath(project.fullName)),
      },
      {
        actionId: `github:${project.fullName}`,
        title: `Open ${project.fullName} on GitHub`,
        subTitle: "github.com",
        group: "Repos",
        keywords: ["github", "external", project.fullName],
        onRun: () => openUrl(project.url),
      },
      {
        actionId: `release:${project.fullName}`,
        title: `Open release ${project.version}`,
        subTitle: project.fullName,
        group: "Repos",
        keywords: ["tag", "version", project.fullName],
        onRun: () => openUrl(project.releaseUrl),
      },
      {
        actionId: `issues:${project.fullName}`,
        title: `Open issues`,
        subTitle: `${project.fullName} · ${project.openIssues}`,
        group: "Repos",
        keywords: ["bugs", "issues", project.fullName],
        onRun: () => openUrl(project.issuesUrl),
      },
      {
        actionId: `prs:${project.fullName}`,
        title: `Open pull requests`,
        subTitle: `${project.fullName} · ${project.openPullRequests}`,
        group: "Repos",
        keywords: ["prs", "pulls", "pull requests", project.fullName],
        onRun: () => openUrl(project.pullRequestsUrl),
      },
      {
        actionId: `hide:${project.fullName}`,
        title: `${hiddenRepos.has(project.fullName.toLowerCase()) ? "Show" : "Hide"} ${project.fullName}`,
        subTitle: "local visibility",
        group: "Visibility",
        keywords: ["hide", "show", "visible", project.fullName],
        onRun: () => toggleRepo(project.fullName, hiddenRepos.has(project.fullName.toLowerCase())),
      },
    ];
    if (project.compareUrl) {
      commands.splice(2, 0, {
        actionId: `compare:${project.fullName}`,
        title: `Open compare`,
        subTitle: `${project.fullName} · ${project.commitsSinceRelease ?? "n/a"} commits`,
        group: "Repos",
        keywords: ["compare", "commits", project.fullName],
        onRun: () => openUrl(project.compareUrl),
      });
    }
    if (project.ciUrl) {
      commands.push({
        actionId: `ci:${project.fullName}`,
        title: `Open CI`,
        subTitle: `${project.fullName} · ${ciLabel(project)}`,
        group: "Repos",
        keywords: ["ci", "checks", "actions", project.fullName],
        onRun: () => openUrl(project.ciUrl),
      });
    }
    return commands;
  }

  function isRepositorySearchProject(project: Project): boolean {
    return (
      project.version === "repo search" &&
      project.releaseDate === null &&
      project.commitsSinceRelease === null &&
      project.compareUrl === null
    );
  }

  function repositorySearchStatus(): string {
    if (data?.cache?.progress?.done === false) return "release scan queued";
    if (data?.cache?.message?.startsWith("release scan skipped")) return "release scan skipped";
    if (data?.cache?.progress?.done === true) return "outside hot scan batch";
    return "release not scanned";
  }

  function buildCommands(
    projects: Project[],
    owners: string[],
    languages: string[],
    typedText: string,
    hiddenOwnerSet: Set<string>,
    hiddenRepoSet: Set<string>,
    authPayload: AuthPayload | null,
    devEnabled: boolean,
    activeSortKey: SortKey,
    activeSortDirection: SortDirection,
    activeFilter: DashboardFilter,
    currentSettingsSummary: string,
  ): CommandAction[] {
    const rawTyped = typedText.trim();
    const typed = rawTyped.replace(/^@/, "").toLowerCase();
    const typedCommands: CommandAction[] = [];
    if (rawTyped.startsWith("@") && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(typed)) {
      typedCommands.push({
        actionId: `typed-owner:${typed}`,
        title: `Open @${typed}`,
        subTitle: "public dashboard",
        group: "Dashboards",
        keywords: ["owner", "org", typed],
        onRun: () => openOwner(typed),
      });
    }
    if (validRepoSlug(typed)) {
      typedCommands.push({
        actionId: `typed-repo:${typed}`,
        title: `Add ${typed}`,
        subTitle: "explicit public repo source",
        group: "Dashboards",
        keywords: ["repo", "source", typed],
        onRun: () => addSource(typed),
      });
    }

    const ownerCommands = owners.map((owner) => ({
      actionId: `owner:${owner}`,
      title: `Open @${owner}`,
      subTitle: hiddenOwnerSet.has(owner) ? "hidden locally" : "owner dashboard",
      group: "Dashboards",
      keywords: ["owner", "dashboard", owner],
      onRun: () => openOwner(owner),
    }));

    return [
      ...typedCommands,
      {
        actionId: "dashboard:home",
        title: "Open GitHub Hot",
        subTitle: "root dashboard",
        group: "Dashboards",
        keywords: ["home", "root", "hot", "discover", "trending"],
        onRun: () => location.assign("/"),
      },
      ...discoverPeriods.map((period) => ({
        actionId: `dashboard:discover:${period.value}`,
        title: `Open ${period.label}`,
        subTitle: period.value === "releasebar" ? "cached ReleaseBar dashboards" : "GitHub Hot",
        group: "Dashboards",
        keywords: ["hot", "discover", "trending", period.value, period.label],
        onRun: () => location.assign(discoverHref(period.value)),
      })),
      {
        actionId: "dashboard:releasebar",
        title: "Open ReleaseBar Hot",
        subTitle: "cached dashboards",
        group: "Dashboards",
        keywords: ["home", "root", "releasebar", "cache"],
        onRun: () => location.assign(discoverHref("releasebar")),
      },
      ...ownerCommands,
      ...languages.map(languageCommand),
      ...projects.flatMap(repoCommands).slice(0, 420),
      ...filterOptions.map(filterCommand),
      ...sortOptions.map(sortCommand),
      ...(devEnabled ? devSortOptions.map(sortCommand) : []),
      {
        actionId: "view:search",
        title: "Focus search",
        subTitle: "filter visible rows",
        group: "View",
        keywords: ["search", "find", "filter"],
        onRun: focusSearch,
      },
      {
        actionId: "view:copy-url",
        title: "Copy dashboard URL",
        subTitle: "share current filters",
        group: "View",
        keywords: ["copy", "share", "url", "link"],
        onRun: () => void copyDashboardUrl(),
      },
      {
        actionId: "view:dev",
        title: `${devEnabled ? "Disable" : "Enable"} dev columns`,
        subTitle: "issues, PRs, CI",
        group: "View",
        keywords: ["dev", "issues", "prs", "ci"],
        onRun: () => setDevMode(!devEnabled),
      },
      {
        actionId: "view:settings",
        title: "Open settings",
        subTitle: currentSettingsSummary,
        group: "View",
        keywords: ["settings", "sources", "visibility"],
        onRun: () => {
          settingsOpen = true;
        },
      },
      {
        actionId: "visibility:reset",
        title: "Show all hidden items",
        subTitle: currentSettingsSummary,
        group: "Visibility",
        keywords: ["reset", "hidden", "visibility"],
        onRun: resetHidden,
      },
      ...owners.map((owner) => ({
        actionId: `visibility:owner:${owner}`,
        title: `${hiddenOwnerSet.has(owner) ? "Show" : "Hide"} @${owner}`,
        subTitle: "local visibility",
        group: "Visibility",
        keywords: ["hide", "show", "owner", owner],
        onRun: () => toggleOwner(owner, hiddenOwnerSet.has(owner)),
      })),
      ...(authPayload?.configured && !authPayload.user
        ? [
            {
              actionId: "auth:login",
              title: "Connect GitHub",
              subTitle: "dedicated API quota",
              group: "Account",
              keywords: ["login", "github", "quota"],
              onRun: login,
            },
          ]
        : []),
      ...(authPayload?.user
        ? [
            ...(authPayload.installNeeded
              ? [
                  {
                    actionId: "auth:install",
                    title: "Install GitHub App",
                    subTitle: authPayload.installReason ?? "dedicated API quota",
                    group: "Account",
                    keywords: ["install", "github", "app"],
                    onRun: installApp,
                  },
                ]
              : []),
            {
              actionId: "auth:logout",
              title: "Log out",
              subTitle: `@${authPayload.user.login}`,
              group: "Account",
              keywords: ["logout", "sign out", authPayload.user.login],
              onRun: logout,
            },
          ]
        : []),
    ];
  }

  onMount(() => {
    mounted = true;
    if (isDevSortKey(sortKey) && !devMode) {
      devMode = true;
    }
    const unsubscribe = paletteStore.subscribe((value: PaletteStoreParams) => {
      paletteText = value.textInput;
    });
    const routeTask = (() => {
      if (repoRoute && repoDetail) {
        if (!repoDetail.project.releaseDate && repoSummaryRange === "release") {
          repoSummaryRange = "month";
        }
        updateRepoDetailStatus();
        if (
          repoDetail.cache.state === "warming" ||
          repoDetail.cache.state === "stale" ||
          repoDetail.releaseSummary?.state === "warming"
        ) {
          return loadRepoDetail();
        }
        if (repoSummaryRange !== "release" && !repoActivity) {
          void loadRepoActivity();
        }
        return Promise.resolve();
      }
      if (!repoRoute && data) {
        updateStatus();
        if (new URLSearchParams(location.search).has("rdRefresh")) {
          return loadDashboard();
        }
        if (shouldAutoRefresh(data)) {
          return loadDashboard();
        } else {
          closeDashboardStream();
        }
        return Promise.resolve();
      }
      return repoRoute ? loadRepoDetail() : loadDashboard();
    })();
    void Promise.all([
      loadAuth(),
      routeTask,
      showTrustProfile ? loadTrustProfile() : Promise.resolve(),
      repoRoute ? loadRepoAudience() : Promise.resolve(),
      showOwnerActivity ? loadOwnerActivity() : Promise.resolve(),
    ]).catch((error) => {
      generatedLabel = "failed";
      generatedDetail = error instanceof Error ? error.message : String(error);
      errorMessage = generatedDetail;
    });
    return () => unsubscribe();
  });

  onDestroy(() => {
    if (dashboardRefreshTimer !== null) {
      globalThis.clearTimeout(dashboardRefreshTimer);
    }
    if (repoDetailRefreshTimer !== null) {
      globalThis.clearTimeout(repoDetailRefreshTimer);
    }
    if (activityRefreshTimer !== null) {
      globalThis.clearTimeout(activityRefreshTimer);
    }
    if (audienceRefreshTimer !== null) {
      globalThis.clearTimeout(audienceRefreshTimer);
    }
    if (repoActivityRefreshTimer !== null) {
      globalThis.clearTimeout(repoActivityRefreshTimer);
    }
    closeDashboardStream();
    document.body.classList.remove("dev-mode");
  });
</script>

<main class="shell">
  <header class="topline">
    <div class="hero-copy">
      <nav class="eyebrow-nav" aria-label="Page navigation">
        <a class="eyebrow brand" href="/">release.bar</a>
        {#if repoRoute}
          <span aria-hidden="true">/</span>
          <a class="eyebrow eyebrow-back" href={ownerDashboardPath(repoRoute.owner)}>
            <span aria-hidden="true">←</span>
            @{repoRoute.owner}
          </a>
        {/if}
      </nav>
      <h1>
        {#if heroOwner}
          <span class="hero-owner-title">
            <a class="hero-owner-link" href={ownerDashboardPath(heroOwner.login)}>
              <img
                class="hero-owner-avatar"
                src={ownerAvatarUrl(heroOwner)}
                alt=""
                width="88"
                height="88"
                loading="eager"
              />
              <span>@{heroOwner.login}</span>
            </a>
            {#if heroExtraCount > 0}
              <span>+{heroExtraCount}</span>
            {/if}
          </span>
        {:else if repoRoute && repoDetail}
          <span class="repo-hero-title">
            <a
              class="repo-title-avatar-link"
              href={ownerDashboardPath(repoDetail.project.owner)}
              aria-label={`Open @${repoDetail.project.owner} dashboard`}
            >
              <img
                class="repo-title-avatar"
                src={projectOwnerAvatarUrl(repoDetail.project)}
                alt=""
                width="88"
                height="88"
                loading="eager"
              />
            </a>
            <span class="repo-title-text" title={label}>
              <span class="repo-title-name">{repoDetail.project.name}</span>
            </span>
          </span>
        {:else}
          {label}
        {/if}
      </h1>
      <p class="subtitle">
        {#if subtitleOwner}
          Release freshness for
          <a class="subtitle-link" href={ownerDashboardPath(subtitleOwner)}>
            @{subtitleOwner}</a
          >.
        {:else}
          {subtitle}
        {/if}
      </p>
      {#if repoRoute && repoDetail}
        <nav class="repo-actions" aria-label="Repository links">
          <a class="external-link" href={repoDetail.project.url} target="_blank" rel="noreferrer">GitHub</a>
          <a class="external-link" href={`${repoDetail.project.url}/releases`} target="_blank" rel="noreferrer">Releases</a>
          <a class="external-link" href={repoDetail.project.issuesUrl} target="_blank" rel="noreferrer">Issues</a>
          <a class="external-link" href={repoDetail.project.pullRequestsUrl} target="_blank" rel="noreferrer">PRs</a>
        </nav>
      {/if}
    </div>
    <div class="top-actions">
      <button
        type="button"
        class="status"
        aria-live="polite"
        aria-label={generatedDetail ? `${generatedLabel} · ${generatedDetail}` : generatedLabel}
        data-tooltip={generatedDetail || undefined}
        tabindex={generatedDetail ? 0 : undefined}
      >
        <span class="pulse"></span>
        <span>{generatedLabel}</span>
      </button>

      <button
        type="button"
        class="theme-toggle"
        onclick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {#if theme === "dark"}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        {/if}
      </button>

      {#if auth?.user}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="account-button">
            <img class="account-avatar" src={auth.user.avatarUrl} alt="" width="24" height="24" loading="lazy" />
            <span class="account-label">@{auth.user.login}</span>
            <span class="account-caret" aria-hidden="true"></span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="account-dropdown" align="end" sideOffset={8} loop>
            {#if !repoRoute}
              <DropdownMenu.Item class="menu-action" onSelect={() => (settingsOpen = !settingsOpen)}>
                Settings
              </DropdownMenu.Item>
            {/if}
            {#if auth.installNeeded}
              <DropdownMenu.Item class="menu-action" onSelect={installApp}>
                Install App
              </DropdownMenu.Item>
            {/if}
            <DropdownMenu.Item class="menu-action" onSelect={logout}>Log Out</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {:else}
        <button
          class="account-button"
          type="button"
          disabled={!auth?.configured}
          onclick={login}
          title={auth?.configured ? "Connect GitHub" : "GitHub login unavailable"}
        >
          <span class="account-label">{auth?.configured ? "Connect GitHub" : "Login Unavailable"}</span>
          {#if auth?.configured}
            <span class="account-caret" aria-hidden="true"></span>
          {/if}
        </button>
      {/if}
    </div>
  </header>

  {#if !repoRoute && initialRoute.isDefault}
    <nav class="discover-nav" aria-label="Discover GitHub repositories">
      <div class="discover-group" aria-label="Time range">
        {#each discoverPeriods as period}
          <a
            class:active={activeDiscoverPeriod === period.value}
            href={discoverHref(period.value)}
            aria-current={activeDiscoverPeriod === period.value ? "page" : undefined}
          >
            {period.label}
          </a>
        {/each}
      </div>
      {#if activeDiscoverPeriod !== "releasebar"}
        <div class="discover-group" aria-label="Language">
          <a
            class:active={!activeDiscoverLanguage}
            href={discoverHref(activeDiscoverPeriod, "")}
            aria-current={!activeDiscoverLanguage ? "page" : undefined}
          >
            all
          </a>
          {#each discoverLanguages as discoverLanguage}
            <a
              class:active={discoverLanguageActive(discoverLanguage)}
              href={discoverLanguageHref(discoverLanguage)}
              aria-current={discoverLanguageActive(discoverLanguage) ? "page" : undefined}
            >
              {discoverLanguage}
            </a>
          {/each}
        </div>
      {/if}
    </nav>
  {/if}

  {#if settingsOpen && !repoRoute}
    <div class="settings-panel" aria-label="Dashboard settings" data-open>
      <button
        class="settings-close"
        type="button"
        aria-label="Close settings"
        onclick={() => (settingsOpen = false)}
      >
        <span aria-hidden="true">×</span>
      </button>
      <div>
        <strong>dashboard</strong>
        <p>{settingsSummary}</p>
        <p class="profile-badge">
          {publicProfile
            ? `public profile config · saved by @${publicProfile.updatedBy}`
            : canEditPublicDefault
              ? "public profile config · not saved yet"
              : "local view settings"}
        </p>
        <p class="public-note">Only public GitHub repositories are listed, stored, and selectable.</p>
        <p class="connection-status">{connectionStatus}</p>
        <form class="source-form" onsubmit={handleSourceSubmit}>
          <input
            bind:value={sourceInput}
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="@owner or owner/repo"
          />
          <button type="submit">add</button>
        </form>
        {#if canEditPublicDefault}
          <div class="profile-actions">
            <button type="button" disabled={profileSaving} onclick={savePublicDefault}>
              save default
            </button>
            <button type="button" disabled={profileSaving} onclick={resetPublicDefault}>
              reset
            </button>
          </div>
          <p class="profile-status">
            {profileMessage || "Save custom sources and visibility as the public default for this route."}
          </p>
        {/if}
      </div>
      <section>
        <h2>owners</h2>
        <div class="setting-list">
          {#each ownerToggles as owner}
            <label class="setting-check">
              <input
                type="checkbox"
                checked={!hiddenOwners.has(owner)}
                onchange={(event) =>
                  toggleOwner(owner, (event.currentTarget as HTMLInputElement).checked)}
              />
              <span>@{owner}</span>
            </label>
          {/each}
        </div>
      </section>
      <section>
        <h2>repos</h2>
        <div class="setting-list repo-settings">
          {#each data?.projects ?? [] as project (project.fullName)}
            <label class="setting-check">
              <input
                type="checkbox"
                checked={!hiddenRepos.has(project.fullName.toLowerCase())}
                onchange={(event) =>
                  toggleRepo(project.fullName, (event.currentTarget as HTMLInputElement).checked)}
              />
              <span>{project.fullName}</span>
            </label>
          {/each}
        </div>
      </section>
    </div>
  {/if}

  {#if repoRoute}
    <section class="repo-detail" aria-label="Repository detail">
      {#if errorMessage}
        <div class="error-state">
          <span class="loading-kicker">repository unavailable</span>
          <strong>{errorMessage}</strong>
          <small>ReleaseBar only reads public GitHub metadata. Connected GitHub App quota can make public repo refreshes more reliable.</small>
          {#if auth?.configured && !auth.user}
            <button type="button" onclick={login}>Connect GitHub</button>
          {/if}
        </div>
      {:else if !repoDetail}
        <div class="loading-state" aria-live="polite">
          <span class="loading-kicker">fetching repository</span>
          <strong>loading stats</strong>
          <small>GitHub release and activity data is being cached.</small>
          <div class="loading-bars" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      {:else}
        {#if repoDetail.cache.state === "warming" || repoDetail.cache.state === "stale"}
          <div class="partial-state" aria-live="polite">
            <span>{repoDetail.cache.state === "warming" ? "stats warming" : "cached stats visible"}</span>
            <strong>{repoDetail.cache.message ?? "Repository statistics are refreshing."}</strong>
          </div>
        {/if}
        <div class="detail-grid">
          <section class="detail-panel detail-overview">
            <div>
              <span class="panel-kicker">release</span>
              <strong
                style={detailValueStyle(repoDetail.project.version)}
                title={repoDetail.project.version}
                use:fitDetailValue={repoDetail.project.version}
              >
                {repoDetail.project.version}
              </strong>
              <small>{shortDate(repoDetail.project.releaseDate)} · {relativeDate(repoDetail.project.releaseDate)}</small>
            </div>
            <div>
              <span class="panel-kicker">commits since</span>
              <strong
                style={detailValueStyle(repoDetail.project.commitsSinceRelease ?? "n/a")}
                use:fitDetailValue={repoDetail.project.commitsSinceRelease ?? "n/a"}
              >
                {repoDetail.project.commitsSinceRelease ?? "n/a"}
              </strong>
              <small>{repoDetail.project.freshness}</small>
            </div>
            <div>
              <span class="panel-kicker">stars</span>
              <strong
                style={detailValueStyle(numberFormat.format(repoDetail.project.stars))}
                use:fitDetailValue={numberFormat.format(repoDetail.project.stars)}
              >
                {numberFormat.format(repoDetail.project.stars)}
              </strong>
              <small>{numberFormat.format(repoDetail.project.forks)} forks</small>
            </div>
            <div>
              <span class="panel-kicker">open work</span>
              <strong
                style={detailValueStyle(numberFormat.format(repoDetail.project.openIssues + repoDetail.project.openPullRequests))}
                use:fitDetailValue={numberFormat.format(repoDetail.project.openIssues + repoDetail.project.openPullRequests)}
              >
                {numberFormat.format(repoDetail.project.openIssues + repoDetail.project.openPullRequests)}
              </strong>
              <small>{repoDetail.project.openIssues} issues · {repoDetail.project.openPullRequests} PRs</small>
            </div>
            <div>
              <span class="panel-kicker">cadence</span>
              <strong
                style={detailValueStyle(formatDays(releaseCadence.medianDays))}
                use:fitDetailValue={formatDays(releaseCadence.medianDays)}
              >
                {formatDays(releaseCadence.medianDays)}
              </strong>
              <small>median release gap · {releaseCadence.releaseCount} recent releases</small>
            </div>
          </section>

          <section class="detail-panel detail-wide">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">commit graph</span>
                <h2>last year</h2>
              </div>
              <strong>{numberFormat.format(commitTotal())} commits</strong>
            </div>
            {#if repoDetail.commitActivity.length > 0}
              <div class="spark-bars" aria-label="Weekly commits">
                {#each repoDetail.commitActivity as week}
                  <button
                    type="button"
                    aria-label={`${shortDate(week.week)} · ${numberFormat.format(week.total)} commits`}
                    data-tooltip={`${shortDate(week.week)} · ${numberFormat.format(week.total)} commits`}
                    style={`height: ${percent(week.total, detailMaxCommits)}%`}
                  ></button>
                {/each}
              </div>
            {:else}
              <p class="detail-empty">Commit activity is still warming or unavailable.</p>
            {/if}
          </section>

          <section class="detail-panel detail-wide release-summary">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">AI summary</span>
                <h2>{repoSummaryRange === "release" ? "since last release" : "recent work"}</h2>
              </div>
              <div class="range-toggle" aria-label="Repository summary range">
                {#each repoSummaryRanges as range}
                  <button
                    class:active={repoSummaryRange === range.value}
                    type="button"
                    aria-pressed={repoSummaryRange === range.value}
                    onclick={() => setRepoSummaryRange(range.value)}
                  >
                    {range.label}
                  </button>
                {/each}
              </div>
            </div>
            {#if repoSummaryRange === "release"}
              {#if repoDetail.releaseSummary?.state === "ready" && repoDetail.releaseSummary.text}
                <p>{repoDetail.releaseSummary.text}</p>
                <small>{releaseSummaryMeta(repoDetail.releaseSummary)}</small>
              {:else if repoDetail.releaseSummary?.state === "warming"}
                <p>Summarizing commit titles since the latest release.</p>
                <small>{releaseSummaryMeta(repoDetail.releaseSummary)}</small>
              {:else if repoDetail.releaseSummary?.message}
                <p class="detail-empty">{repoDetail.releaseSummary.message}</p>
              {:else}
                <p class="detail-empty">No release summary is available yet.</p>
              {/if}
            {:else if repoActivityLoading}
              <p>Loading recent work.</p>
            {:else if repoActivity?.summary?.state === "ready" && repoActivity.summary.text}
              <p>{repoActivity.summary.text}</p>
              <small>{repoActivityMeta(repoActivity)}</small>
            {:else if repoActivity?.summary?.state === "warming"}
              <p>Summarizing recent work.</p>
              <small>{repoActivityMeta(repoActivity)}</small>
            {:else if repoActivity?.summary?.message}
              <p class="detail-empty">{repoActivity.summary.message}</p>
            {:else if repoActivityError}
              <p class="detail-empty">{repoActivityError}</p>
            {:else}
              <p class="detail-empty">Recent work will appear here when GitHub returns enough signal.</p>
            {/if}
          </section>

          <section class="detail-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">contributors</span>
                <h2>top committers</h2>
              </div>
            </div>
            <div class="contributor-list">
              {#each repoDetail.contributors as contributor}
                <a
                  class="contributor-row"
                  href={contributor.url ? ownerDashboardPath(contributor.login) : repoDetailPath(repoDetail.fullName)}
                >
                  {#if contributor.avatarUrl}
                    <img src={contributor.avatarUrl} alt="" width="26" height="26" loading="lazy" />
                  {:else}
                    <span class="avatar-fallback" aria-hidden="true"></span>
                  {/if}
                  <span class="contributor-name">
                    <span>{contributor.login}</span>
                    {#if contributor.trustScore !== undefined}
                      <small
                        class={`person-score-pill tier-${contributor.trustTier ?? "low"}`}
                        title={`trust score ${numberFormat.format(contributor.trustScore)}`}
                      >
                        {numberFormat.format(contributor.trustScore)}
                      </small>
                    {/if}
                  </span>
                  <strong>{numberFormat.format(contributor.commits)}</strong>
                  <i style={`width: ${percent(contributor.commits, detailMaxContributorCommits)}%`}></i>
                </a>
              {/each}
            </div>
          </section>

          <section class="detail-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">releases</span>
                <h2>latest versions</h2>
              </div>
              <strong>{formatDays(releaseCadence.latestGapDays)}</strong>
            </div>
            <div class="release-groups">
              {#if stableReleases.length > 0}
                <div class="release-group">
                  <span class="release-group-label">stable</span>
                  <div class="release-list">
                    {#each stableReleases as release}
                      <a class="external-link" href={release.url} target="_blank" rel="noreferrer">
                        <strong>{release.tagName}</strong>
                        <span>{shortDate(release.publishedAt)} · {relativeDate(release.publishedAt)}</span>
                      </a>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if preReleases.length > 0}
                <div class="release-group">
                  <span class="release-group-label">pre</span>
                  <div class="release-list">
                    {#each preReleases as release}
                      <a class="external-link" href={release.url} target="_blank" rel="noreferrer">
                        <strong>{release.tagName}</strong>
                        <span>{shortDate(release.publishedAt)} · {relativeDate(release.publishedAt)}</span>
                      </a>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if stableReleases.length === 0 && preReleases.length === 0}
                <p class="detail-empty">Release history is unavailable.</p>
              {/if}
            </div>
          </section>

          <section class="detail-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">open work trend</span>
                <h2>last 30 days</h2>
              </div>
            </div>
            {#if workTrend}
              <div class="work-trend">
                <div>
                  <span>issues opened</span>
                  <strong>{numberFormat.format(workTrend.issuesOpened30d)}</strong>
                  <i style={`width: ${percent(workTrend.issuesOpened30d, Math.max(workTrend.issuesOpened30d, workTrend.issuesClosed30d, 1))}%`}></i>
                </div>
                <div>
                  <span>issues closed</span>
                  <strong>{numberFormat.format(workTrend.issuesClosed30d)}</strong>
                  <i style={`width: ${percent(workTrend.issuesClosed30d, Math.max(workTrend.issuesOpened30d, workTrend.issuesClosed30d, 1))}%`}></i>
                </div>
                <div>
                  <span>PRs opened</span>
                  <strong>{numberFormat.format(workTrend.pullRequestsOpened30d)}</strong>
                  <i style={`width: ${percent(workTrend.pullRequestsOpened30d, Math.max(workTrend.pullRequestsOpened30d, workTrend.pullRequestsClosed30d, 1))}%`}></i>
                </div>
                <div>
                  <span>PRs merged/closed</span>
                  <strong>{numberFormat.format(workTrend.pullRequestsClosed30d)}</strong>
                  <i style={`width: ${percent(workTrend.pullRequestsClosed30d, Math.max(workTrend.pullRequestsOpened30d, workTrend.pullRequestsClosed30d, 1))}%`}></i>
                </div>
              </div>
            {:else}
              <p class="detail-empty">Issue and PR trend data is warming or unavailable.</p>
            {/if}
          </section>

          <section class="detail-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">languages</span>
                <h2>repo mix</h2>
              </div>
            </div>
            <div class="language-bars">
              {#each repoDetail.languages.slice(0, 6) as repoLanguage}
                <div>
                  <span>{repoLanguage.name}</span>
                  <strong>{percentOfTotal(repoLanguage.bytes, detailLanguageTotal)}%</strong>
                  <i style={`width: ${percentOfTotal(repoLanguage.bytes, detailLanguageTotal)}%`}></i>
                </div>
              {/each}
            </div>
          </section>

          <section class="detail-panel detail-wide audience-panel" aria-label="Recent stargazer audience">
            <div class="panel-heading audience-heading">
              <div>
                <span class="panel-kicker">audience</span>
                <h2>new stargazers</h2>
              </div>
              <div class="range-toggle" aria-label="Audience range">
                {#each audienceRanges as range}
                  <button
                    class:active={audienceRange === range.value}
                    type="button"
                    aria-pressed={audienceRange === range.value}
                    onclick={() => setAudienceRange(range.value)}
                  >
                    {range.label}
                  </button>
                {/each}
                <button type="button" disabled={audienceBackfillLoading} onclick={backfillRepoAudience}>
                  {audienceBackfillLoading ? "backfilling" : "backfill"}
                </button>
              </div>
            </div>
            {#if audienceBackfillMessage}
              <p class="detail-empty audience-backfill-message">{audienceBackfillMessage}</p>
            {/if}
            {#if audienceLoading}
              <p class="detail-empty">Scoring recent public stargazer profiles.</p>
            {:else if audienceError}
              <p class="detail-empty">{audienceError}</p>
            {:else if audience}
              <div class="audience-summary" aria-label={audienceMeta(audience)}>
                <div>
                  <span>stargazers</span>
                  <strong>{numberFormat.format(audienceTotalStargazers(audience))}</strong>
                </div>
                <div>
                  <span>high</span>
                  <strong>{audienceShare(audience, audience.totals.highSignal, audience.totals.highSignalPercent)}</strong>
                </div>
                <div>
                  <span>medium</span>
                  <strong>{audienceShare(audience, audience.totals.mediumSignal, audience.totals.mediumSignalPercent)}</strong>
                </div>
                <div>
                  <span>bots</span>
                  <strong>{audienceShare(audience, audience.totals.bots, audience.totals.botPercent)}</strong>
                </div>
              </div>
              {#if audience.users.length > 0}
                <div class="audience-tools">
                  <input
                    bind:value={audienceQuery}
                    type="search"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="find people, orgs, companies, repos"
                    aria-label="Find stargazers"
                  />
                  <span>
                    {numberFormat.format(filteredAudienceUsers.length)} / {numberFormat.format(audience.users.length)}
                  </span>
                </div>
                <div class="audience-list">
                  {#each filteredAudienceUsers as user}
                    <a class="audience-row" href={ownerDashboardPath(user.login)}>
                      <img src={user.avatarUrl} alt="" width="34" height="34" loading="lazy" />
                      <span class="audience-user">
                        <strong>
                          <span>{user.login}</span>
                          {#if user.trustScore !== undefined}
                            <small
                              class={`person-score-pill tier-${user.trustTier ?? "low"}`}
                              title={`trust score ${numberFormat.format(user.trustScore)}`}
                            >
                              {numberFormat.format(user.trustScore)}
                            </small>
                          {/if}
                        </strong>
                        <small>{user.name || user.company || audienceReasonText(user.reasons)}</small>
                        {#if audienceInsightText(user)}
                          <small>{audienceInsightText(user)}</small>
                        {/if}
                      </span>
                      <span class="audience-score">
                        <span class={`audience-tier tier-${user.tier}`}>{user.tier}</span>
                        <strong>{numberFormat.format(user.score)}</strong>
                        <small>{numberFormat.format(user.followers)} followers · {numberFormat.format(user.publicRepos)} repos</small>
                      </span>
                    </a>
                  {/each}
                </div>
                <small class="audience-note">{audienceMeta(audience)} · public stargazer profile signals only</small>
                {#if filteredAudienceUsers.length === 0}
                  <p class="detail-empty">No stargazers match that search.</p>
                {/if}
              {:else}
                <p class="detail-empty">No recent public stargazers in this range.</p>
              {/if}
            {:else}
              <p class="detail-empty">Audience signals are warming.</p>
            {/if}
          </section>

          {#if showCodeChurn(repoDetail)}
            <section class="detail-panel detail-tail">
              <div class="panel-heading">
                <div>
                  <span class="panel-kicker">code churn</span>
                  <h2>last year</h2>
                </div>
              </div>
              {#if repoDetail.codeFrequency.length > 0}
                <div class="churn-meter">
                  <div>
                    <span>additions</span>
                    <strong>{numberFormat.format(codeTotal("additions"))}</strong>
                  </div>
                  <div>
                    <span>deletions</span>
                    <strong>{numberFormat.format(codeTotal("deletions"))}</strong>
                  </div>
                </div>
              {:else}
                <p class="detail-empty">GitHub is preparing code-frequency stats. ReleaseBar will refresh this panel.</p>
              {/if}
            </section>
          {/if}
        </div>
      {/if}
    </section>
  {:else}
  {#if showTrustProfile}
    <nav class="owner-tabs" aria-label="Owner page sections">
      <button
        class:active={ownerTab === "overview"}
        type="button"
        aria-pressed={ownerTab === "overview"}
        onclick={() => setOwnerTab("overview")}
      >
        overview
      </button>
      <button
        class:active={ownerTab === "trust"}
        type="button"
        aria-pressed={ownerTab === "trust"}
        onclick={() => setOwnerTab("trust")}
      >
        {ownerSignalTabLabel()}
      </button>
    </nav>
  {/if}

  {#if showTrustProfile && ownerTab === "overview"}
    <section class="trust-snapshot" aria-label={`${ownerSignalLabel()} summary`}>
      {#if trustProfileLoading}
        <span class="panel-kicker">{ownerSignalTabLabel()}</span>
        <strong>loading</strong>
        <small>{ownerSignalDescription()}</small>
      {:else if trustProfileError}
        <span class="panel-kicker">{ownerSignalTabLabel()}</span>
        <strong>unavailable</strong>
        <small>{trustProfileError}</small>
      {:else if trustProfile}
        <div class="trust-snapshot-score">
          <span class="panel-kicker">{ownerSignalLabel(trustProfile)}</span>
          <strong>{trustProfile.score}</strong>
          <small class={`audience-tier tier-${trustProfile.tier}`}>{trustProfile.tier}</small>
        </div>
        <div>
          <span>GitHub age</span>
          <strong>{trustProfileAge(trustProfile)}</strong>
        </div>
        <div>
          <span>reach</span>
          <strong>{numberFormat.format(trustProfile.followers)} followers</strong>
        </div>
        <div>
          <span>{trustProfile.type === "org" ? "footprint" : "builder"}</span>
          <strong>{numberFormat.format(trustProfile.stats.activeRepositories)} active repos</strong>
        </div>
        <p>{audienceReasonText(trustProfile.reasons)}</p>
        <button type="button" onclick={() => setOwnerTab("trust")}>view factors</button>
      {:else}
        <span class="panel-kicker">{ownerSignalTabLabel()}</span>
        <strong>pending</strong>
        <small>{ownerSignalDescription()} will appear here.</small>
      {/if}
    </section>
  {/if}

  {#if showTrustProfile && ownerTab === "trust"}
    <section class="trust-panel" aria-label={`GitHub ${ownerSignalLabel()} profile`}>
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">{ownerSignalTabLabel()}</span>
          <h2>{trustProfile ? `${trustProfile.score}` : "loading"}</h2>
        </div>
        {#if trustProfile}
          <span class={`audience-tier tier-${trustProfile.tier}`}>{trustProfile.tier}</span>
        {/if}
      </div>

      {#if trustProfileLoading}
        <p class="activity-text">Loading {ownerSignalDescription()}.</p>
      {:else if trustProfileError}
        <p class="activity-text muted">{trustProfileError}</p>
      {:else if trustProfile}
        <div class="trust-summary" aria-label={trustProfileMeta(trustProfile)}>
          <div>
            <span>GitHub age</span>
            <strong>{trustProfileAge(trustProfile)}</strong>
          </div>
          <div>
            <span>public reach</span>
            <strong>{numberFormat.format(trustProfile.followers)} followers</strong>
          </div>
          <div>
            <span>{trustProfile.type === "org" ? "repo footprint" : "builder proof"}</span>
            <strong>{numberFormat.format(trustProfile.stats.activeRepositories)} active repos</strong>
          </div>
          <div>
            <span>repo stars</span>
            <strong>{numberFormat.format(trustProfile.stats.totalStars)}</strong>
          </div>
        </div>

        <div class="trust-dimensions" aria-label={`${ownerSignalLabel(trustProfile)} dimensions`}>
          {#each trustDimensionEntries(trustProfile) as [label, value]}
            <span>
              <small>{label}</small>
              <strong>{value}</strong>
            </span>
          {/each}
        </div>

        {#if trustFactorEntries(trustProfile).length > 0}
          <div class="trust-factors" aria-label={`${ownerSignalLabel(trustProfile)} factors`}>
            {#each trustFactorEntries(trustProfile) as factor}
              <div class:negative={factor.sentiment === "negative"}>
                <span>
                  <strong>{factor.label}</strong>
                  <small>{factor.detail}</small>
                </span>
                <span class="factor-value">{factor.value}/{factor.maxValue}</span>
                <b style={`--factor-width: ${Math.min(100, Math.round((factor.value / Math.max(1, factor.maxValue)) * 100))}%`}></b>
                <em class="factor-impact">{factorContribution(factor.weightedValue)}</em>
              </div>
            {/each}
          </div>
        {/if}

        <p class="trust-reasons">{audienceReasonText(trustProfile.reasons)}</p>

        {#if trustProfile.topRepositories.length > 0}
          <div class="trust-table" aria-label="Repository evidence">
            {#each trustProfile.topRepositories as repo}
              <a href={repoDetailPath(repo.fullName)}>
                <span>
                  <strong>{repo.fullName}</strong>
                  <small>{repo.language || repo.topics.slice(0, 2).join(", ") || "public repo"}</small>
                </span>
                <span>{numberFormat.format(repo.stars)} stars</span>
              </a>
            {/each}
          </div>
        {/if}

        <div class="trust-tags" aria-label="Profile signals">
          {#each trustProfile.stats.languages as item}
            <span>{item.name} × {item.count}</span>
          {/each}
          {#each trustProfile.stats.topics.slice(0, 4) as item}
            <span>{item.name} × {item.count}</span>
          {/each}
          {#each trustProfile.orgs.slice(0, 4) as org}
            <span>@{org.login}</span>
          {/each}
        </div>
        <small class="activity-meta">{trustProfileMeta(trustProfile)} · public {trustProfile.type === "org" ? "organization" : "profile"} signals only</small>
      {:else}
        <p class="activity-text muted">{ownerSignalDescription()} will appear here when available.</p>
      {/if}
    </section>
  {/if}

  {#if showOwnerActivity && ownerTab === "overview"}
    <section class="activity-panel" aria-label="Recent public activity">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">working on</span>
        </div>
        <div class="range-toggle" aria-label="Activity range">
          {#each activityRanges as range}
            <button
              class:active={activityRange === range.value}
              type="button"
              aria-pressed={activityRange === range.value}
              onclick={() => setActivityRange(range.value)}
            >
              {range.label}
            </button>
          {/each}
        </div>
      </div>

      {#if activityLoading}
        <p class="activity-text">Loading recent work.</p>
      {:else if activity?.summary?.state === "ready" && activity.summary.text}
        <p class="activity-text">{activity.summary.text}</p>
      {:else if activity?.summary?.state === "warming"}
        <p class="activity-text">Summarizing recent work.</p>
      {:else if activity?.summary?.message}
        <p class="activity-text muted">{activity.summary.message}</p>
      {:else if activityError}
        <p class="activity-text muted">{activityError}</p>
      {:else}
        <p class="activity-text muted">Recent work will appear here when GitHub returns enough signal.</p>
      {/if}

      {#if activity}
        <div class="activity-stats" aria-label="Activity totals">
          <span>{numberFormat.format(activity.totals.commits)} commits</span>
          <span>{numberFormat.format(activity.totals.pullRequests)} PRs</span>
          <span>{numberFormat.format(activity.totals.issues)} issues</span>
          <span>{numberFormat.format(activity.totals.comments)} comments</span>
        </div>
        <div class="activity-repos" aria-label="Touched repositories">
          {#each activity.repositories.slice(0, 5) as repo}
            <a href={repoDetailPath(repo.fullName)}>
              {repo.fullName}
              <small>{numberFormat.format(repo.events)}</small>
            </a>
          {/each}
        </div>
        <small class="activity-meta">
          {activityMeta(activity)}
          {#if activity.cache.state === "stale"}
            · refreshing
          {/if}
        </small>
      {/if}
    </section>
  {/if}

  {#if !showTrustProfile || ownerTab === "overview"}
  <section class="console" aria-label="Project search and metrics">
    <div class="prompt">
      <span class="mark">$</span>
      <input
        bind:value={query}
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="search repos, languages, owners, versions"
      />
      <button
        class="quick-jump"
        type="button"
        aria-label="Open command palette"
        onclick={() => paletteStore.update((s: PaletteStoreParams) => ({ ...s, isVisible: true }))}
      >
        <span aria-hidden="true">⌘</span>
        <span aria-hidden="true">K</span>
      </button>
    </div>
    <div class="metrics">
      <button
        class="metric-action"
        class:active={sortKey === "repo"}
        type="button"
        aria-pressed={sortKey === "repo"}
        onclick={() => setSort("repo")}
      >
        <span>{numberFormat.format(visibleProjects.length)}</span>
        <small>repos</small>
      </button>
      <button
        class="metric-action"
        class:active={sortKey === "release"}
        type="button"
        aria-pressed={sortKey === "release"}
        onclick={() => setSort("release")}
      >
        <span>{numberFormat.format(visibleProjects.filter((project) => project.releaseDate).length)}</span>
        <small>released</small>
      </button>
      <button
        class="metric-action"
        class:active={sortKey === "since"}
        type="button"
        aria-pressed={sortKey === "since"}
        onclick={() => setSort("since")}
      >
        <span>
          {numberFormat.format(
            visibleProjects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0),
          )}
        </span>
        <small>commits since release</small>
      </button>
      <button
        class="metric-action"
        class:active={filter === "attention"}
        type="button"
        aria-pressed={filter === "attention"}
        title="Show repositories with unreleased commits, stale releases, failed CI, or open-work pressure"
        onclick={() => (filter = filter === "attention" ? "all" : "attention")}
      >
        <span>{numberFormat.format(visibleProjects.filter(needsAttention).length)}</span>
        <small>need attention</small>
      </button>
    </div>
  </section>

  <nav class="filters" aria-label="Filters">
    {#each filterOptions as option}
      <button class:active={filter === option} type="button" onclick={() => (filter = option)}>
        {filterLabel(option)}
      </button>
    {/each}
    <label class="dev-toggle">
      <input type="checkbox" checked={devMode} onchange={(event) => setDevMode((event.currentTarget as HTMLInputElement).checked)} />
      <span>dev</span>
    </label>
  </nav>

  <section class="table-wrap" aria-label="Repositories">
    <div class="table-head">
      {#each [...sortOptions, ...devSortOptions] as key}
        <button
          class:dev-only={devSortOptions.includes(key)}
          class:since-heading={key === "since"}
          type="button"
          aria-label={sortLabel(key)}
          aria-current={sortKey === key ? "true" : undefined}
          data-direction={sortKey === key ? sortDirection : ""}
          onclick={() => setSort(key)}
        >
          {#if key === "since"}
            <span class="label-full">commits since</span>
            <span class="label-compact">since</span>
          {:else}
            {sortLabel(key)}
          {/if}
        </button>
      {/each}
    </div>
    <div class="projects">
      {#if errorMessage}
        <div class="error-state">
          <span class="loading-kicker">dashboard unavailable</span>
          <strong>{errorMessage}</strong>
          <small>Unknown owners, cold caches, and GitHub rate limits can all land here. Connecting GitHub gives ReleaseBar dedicated App quota for dashboards you can access.</small>
          {#if auth?.configured && !auth.user}
            <button type="button" onclick={login}>Connect GitHub</button>
          {/if}
        </div>
      {:else if dashboardFetching}
        <div class="loading-state" aria-live="polite">
          <span class="loading-kicker">fetching dashboard</span>
          <strong>{data?.cache?.message ?? "building release data"}</strong>
          <small>GitHub data is being cached. This dashboard will refresh automatically.</small>
          <div class="loading-bars" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      {:else if filteredProjects.length === 0}
        <div class="loading-state empty-state">
          <span class="loading-kicker">no matching repos</span>
          <strong>nothing visible here</strong>
          <small>Adjust search, filters, or dashboard settings.</small>
        </div>
      {:else}
        {#if dashboardUpdating}
          <div class="partial-state" aria-live="polite">
            <span>cached rows visible · background update running</span>
            <strong>{data?.cache?.message ?? "combined dashboard updating"}</strong>
            {#if data?.cache?.progress}
              <div
                class="scan-meter"
                aria-label={`Scanned ${data.cache.progress.scanned} of ${data.cache.progress.limit ?? data.cache.repoLimit ?? data.cache.progress.scanned} repositories`}
              >
                <i
                  style={`width: ${percent(
                    data.cache.progress.scanned,
                    data.cache.progress.limit ?? data.cache.repoLimit ?? data.cache.progress.scanned,
                  )}%`}
                ></i>
              </div>
              <small>
                scanned {numberFormat.format(data.cache.progress.scanned)}
                {#if data.cache.progress.limit}
                  /{numberFormat.format(data.cache.progress.limit)}
                {/if}
                repositories; rows update automatically as GitHub responds
              </small>
            {/if}
          </div>
          {/if}
        {#each filteredProjects as project (project.fullName)}
        <div
          class="project"
          data-freshness={project.freshness}
          role="link"
          tabindex="0"
          aria-label={`${project.fullName}: ${attentionText(project)}`}
          onclick={(event) => rowClick(event, project.fullName)}
          onkeydown={(event) => rowKeydown(event, project.fullName)}
        >
          <div class="repo-cell">
            <div class="repo-title">
              {#if showProjectOwnerAvatars}
                <a
                  class="row-owner-avatar-link"
                  href={ownerDashboardPath(project.owner)}
                  title={`Open @${project.owner} dashboard`}
                  aria-label={`Open @${project.owner} dashboard`}
                >
                  <img
                    class="row-owner-avatar"
                    src={projectOwnerAvatarUrl(project)}
                    alt=""
                    width="28"
                    height="28"
                    loading="lazy"
                  />
                </a>
              {/if}
              <span class="repo-name-line">
                <a class="owner-link" href={ownerDashboardPath(project.owner)} title={`Open @${project.owner} dashboard`}>
                  {project.owner}
                </a>
                <span class="repo-separator" aria-hidden="true">/</span>
                <a class="repo-link" href={repoDetailPath(project.fullName)} title="Open repo detail">
                  {project.name}
                </a>
              </span>
            </div>
            <p class="description">{project.description || "no description"}</p>
            <div class="tags">
              {#if project.language}
                <button
                  class="tag tag-button"
                  class:active={activeLanguage(project.language)}
                  type="button"
                  aria-pressed={activeLanguage(project.language)}
                  title={`Filter by ${project.language}`}
                  onclick={() => toggleLanguageFilter(project.language ?? "")}
                >
                  {project.language}
                </button>
              {/if}
              {#each (project.topics ?? []).slice(0, 4) as topic}
                <button
                  class="tag tag-button"
                  class:active={query.trim().toLowerCase() === topic.toLowerCase()}
                  type="button"
                  aria-pressed={query.trim().toLowerCase() === topic.toLowerCase()}
                  title={`Search ${topic}`}
                  onclick={() => setTopicSearch(topic)}
                >
                  {topic}
                </button>
              {/each}
              {#if project.archived}<span class="tag muted">archived</span>{/if}
              <span class="tag">{project.freshness}</span>
            </div>
            {#if releaseDebtText(project)}
              <p class="attention-reasons">
                <span>needs attention</span>
                {releaseDebtText(project)}
              </p>
            {/if}
          </div>
          <div class="stars-cell">
            <strong>{numberFormat.format(project.stars)}</strong>
          </div>
          <div class="release-cell">
            {#if isRepositorySearchProject(project)}
              <strong>repo search</strong>
              <a class="release-version" href={repoDetailPath(project.fullName)}>
                open repo
              </a>
              <span class:scan-pending={data?.cache?.progress?.done === false}>
                {repositorySearchStatus()}
              </span>
            {:else}
              <strong>{absoluteDate(project.releaseDate)}</strong>
              {#if project.releaseDate}
                <a
                  class="release-version external-link"
                  href={project.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open release ${project.version}`}
                >
                  {project.version}
                </a>
              {:else}
                <a class="release-version" href={repoDetailPath(project.fullName)} title="Open repo detail">
                  open repo
                </a>
              {/if}
              <span>{relativeDate(project.releaseDate)}</span>
            {/if}
          </div>
          <div class="since-cell" class:muted={!project.compareUrl || project.commitsSinceRelease === null}>
            {#if project.compareUrl && project.commitsSinceRelease !== null}
              <a class="external-link" href={project.compareUrl} target="_blank" rel="noreferrer">
                {project.commitsSinceRelease}
              </a>
            {:else}
              n/a
            {/if}
          </div>
          <div class="activity-cell">
            <strong>{relativeDate(project.latestCommitDate || project.pushedAt)}</strong>
            <span>{project.latestCommitSha || project.defaultBranch}</span>
          </div>
          <div class="issues-cell dev-only">
            <a class="external-link" href={project.issuesUrl} target="_blank" rel="noreferrer">{project.openIssues}</a>
          </div>
          <div class="prs-cell dev-only">
            <a class="external-link" href={project.pullRequestsUrl} target="_blank" rel="noreferrer">
              {project.openPullRequests}
            </a>
          </div>
          <div class="ci-cell dev-only" data-ci={project.ciState}>
            {#if project.ciUrl}
              <a class="external-link" href={project.ciUrl} target="_blank" rel="noreferrer">{ciLabel(project)}</a>
            {:else}
              {ciLabel(project)}
            {/if}
            {#if project.ciWorkflow || project.ciRunDate}
              <span>{project.ciWorkflow || relativeDate(project.ciRunDate)}</span>
            {/if}
          </div>
        </div>
        {/each}
      {/if}
    </div>
  </section>
  {/if}
  {/if}
</main>

<footer class="site-footer">
  <span>A project by</span>
  <a class="external-link" href="https://steipete.me" target="_blank" rel="noreferrer">Peter Steinberger</a>
  <span class="footer-separator" aria-hidden="true">.</span>
  <a class="external-link" href="https://github.com/steipete/ReleaseBar/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT Licensed</a>
</footer>

<CommandPalette
  commands={commandActions}
  placeholder="jump to repo, dashboard, action"
  shortcut="$mod+k"
  overlayClass="command-overlay"
  paletteWrapperInnerClass="command-panel"
  inputClass="command-input"
  resultsContainerClass="command-results"
  resultContainerClass="command-result"
  optionSelectedClass="command-result-active"
  titleClass="command-title"
  subtitleClass="command-subtitle"
  descriptionClass="command-description"
  keyboardButtonClass="command-key"
  unstyled={true}
/>

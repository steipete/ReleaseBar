export type AudienceScoreTier = "high" | "medium" | "low" | "bot";

export type AudienceOrgSignal = {
  login: string;
  description: string | null;
};

export type AudienceRepoSignal = {
  fullName: string;
  description: string | null;
  url: string;
  language: string | null;
  stars: number;
  forks: number;
  updatedAt: string | null;
  pushedAt: string | null;
  topics: string[];
};

export type AudienceScoreDimensions = {
  trust: number;
  influence: number;
  builder: number;
  recency: number;
  risk: number;
};

export type AudienceScoreFactorKey =
  | "age"
  | "profile"
  | "orgs"
  | "reach"
  | "builder"
  | "recency"
  | "risk";

export type AudienceScoreFactor = {
  key: AudienceScoreFactorKey;
  label: string;
  value: number;
  maxValue: number;
  weight: number;
  weightedValue: number;
  detail: string;
  sentiment: "positive" | "neutral" | "negative";
};

export type AudienceScoreInput = {
  login: string;
  accountType?: string | null;
  followers: number;
  following?: number;
  publicRepos: number;
  publicGists?: number;
  company: string | null;
  bio: string | null;
  location: string | null;
  blog?: string | null;
  twitterUsername?: string | null;
  accountCreatedAt?: string | null;
  accountUpdatedAt?: string | null;
  starredAt: string | null;
  targetLanguage?: string | null;
  targetTopics?: string[];
  orgs?: AudienceOrgSignal[];
  repos?: AudienceRepoSignal[];
};

export type AudienceScore = {
  score: number;
  tier: AudienceScoreTier;
  reasons: string[];
  dimensions: AudienceScoreDimensions;
  factors: AudienceScoreFactor[];
};

const roleKeywords = [
  "cto",
  "chief",
  "lead",
  "senior",
  "sr",
  "director",
  "head",
  "manager",
  "architect",
  "principal",
  "founder",
  "ceo",
  "vp",
  "engineering",
  "developer",
  "software",
  "programmer",
  "devops",
  "sre",
  "infrastructure",
  "cloud",
  "machine learning",
  "ml",
  "ai",
  "data scientist",
  "analytics",
];

const knownCompanies = [
  "google",
  "microsoft",
  "amazon",
  "apple",
  "meta",
  "netflix",
  "uber",
  "airbnb",
  "github",
  "openai",
  "anthropic",
];

const notableOrgKeywords = [
  "apache",
  "cloudflare",
  "cncf",
  "docker",
  "electron",
  "github",
  "gitlab",
  "google",
  "kubernetes",
  "linux",
  "meta",
  "microsoft",
  "mozilla",
  "nodejs",
  "openai",
  "rust-lang",
  "vercel",
];

const knownBotLoginPrefixes = ["github-actions", "dependabot", "renovate"];
const botTokenPattern = /(?:^|[-_.])bot(?:$|[-_.])/;

// Account type comes from GitHub profile metadata when available. Login fallback
// stays narrow; no broad "*bot" suffix guess for ambiguous human-looking names.
function hasKnownBotLoginPrefix(normalized: string): boolean {
  return knownBotLoginPrefixes.some(
    (prefix) =>
      normalized === prefix ||
      normalized === `${prefix}bot` ||
      normalized.startsWith(`${prefix}-`) ||
      normalized.startsWith(`${prefix}.`) ||
      normalized.startsWith(`${prefix}_`) ||
      normalized.startsWith(`${prefix}[`) ||
      normalized.startsWith(`${prefix}bot-`),
  );
}

export function isLikelyBot(login: string, accountType?: string | null): boolean {
  const normalized = login.toLowerCase();
  const normalizedType = accountType?.toLowerCase();
  if (normalizedType === "bot" || normalizedType === "app") return true;
  if (normalized.endsWith("[bot]")) return true;
  return botTokenPattern.test(normalized) || hasKnownBotLoginPrefix(normalized);
}

function usefulText(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  return normalized && !["none", "n/a", "-"].includes(normalized.toLowerCase()) ? normalized : "";
}

function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86400000));
}

function addReason(reasons: string[], reason: string): void {
  if (reasons.length < 10 && !reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function textMatchesAny(value: string, keywords: string[]): string | null {
  const normalized = value.toLowerCase();
  return keywords.find((keyword) => normalized.includes(keyword)) ?? null;
}

function normalizedTopicSet(topics: string[] | undefined): Set<string> {
  return new Set((topics ?? []).map((topic) => topic.toLowerCase()));
}

function factor(
  key: AudienceScoreFactorKey,
  label: string,
  value: number,
  maxValue: number,
  weight: number,
  detail: string,
  sentiment: AudienceScoreFactor["sentiment"] = "positive",
): AudienceScoreFactor {
  const normalizedMax = Math.max(1, maxValue);
  return {
    key,
    label,
    value: clampScore(value),
    maxValue: normalizedMax,
    weight,
    weightedValue: Math.round(clampScore(value) * weight * 100) / 100,
    detail,
    sentiment,
  };
}

export function calculateAudienceScore(input: AudienceScoreInput): AudienceScore {
  if (isLikelyBot(input.login, input.accountType)) {
    return {
      score: 0,
      tier: "bot",
      reasons: ["automation account"],
      dimensions: {
        trust: 0,
        influence: 0,
        builder: 0,
        recency: 0,
        risk: 0,
      },
      factors: [
        factor(
          "risk",
          "account safety",
          0,
          100,
          0.14,
          "login pattern matches an automation account",
          "negative",
        ),
      ],
    };
  }

  const reasons: string[] = [];
  const profileFields = [
    usefulText(input.company),
    usefulText(input.bio),
    usefulText(input.location),
    usefulText(input.blog),
    usefulText(input.twitterUsername),
  ].filter(Boolean).length;
  const accountAge = daysSince(input.accountCreatedAt);
  const orgs = input.orgs ?? [];
  const repos = (input.repos ?? []).filter((repo) => !repo.fullName.includes("/."));
  const totalRepoStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
  const totalRepoForks = repos.reduce((sum, repo) => sum + repo.forks, 0);
  const latestRepoUpdatedAt = repos
    .map((repo) => Date.parse(repo.pushedAt ?? repo.updatedAt ?? ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const latestRepoAgeDays = latestRepoUpdatedAt
    ? Math.max(0, Math.floor((Date.now() - latestRepoUpdatedAt) / 86400000))
    : null;
  const targetLanguage = usefulText(input.targetLanguage).toLowerCase();
  const targetTopics = normalizedTopicSet(input.targetTopics);
  const languageMatches =
    targetLanguage && repos.some((repo) => repo.language?.toLowerCase() === targetLanguage);
  const topicMatches = repos.some((repo) =>
    (repo.topics ?? []).some((topic) => targetTopics.has(topic.toLowerCase())),
  );
  const notableOrg = orgs.find((org) =>
    textMatchesAny(`${org.login} ${org.description ?? ""}`, notableOrgKeywords),
  );
  const company = usefulText(input.company);
  const knownCompany = knownCompanies.some((known) => company.toLowerCase().includes(known));

  if (input.followers > 0) {
    if (input.followers >= 1000) {
      addReason(reasons, `${input.followers.toLocaleString("en")} followers`);
    } else if (input.followers >= 100) {
      addReason(reasons, "established GitHub audience");
    }
  }

  if (input.publicRepos > 0) {
    if (input.publicRepos >= 50) {
      addReason(reasons, "deep public repo history");
    } else if (input.publicRepos >= 10) {
      addReason(reasons, "active public builder");
    }
  }

  if (company) {
    addReason(reasons, "public company signal");
    if (knownCompany) {
      addReason(reasons, "known tech company");
    }
  }

  const bio = usefulText(input.bio).toLowerCase();
  const roleMatch = roleKeywords.find((keyword) => bio.includes(keyword));
  if (roleMatch) {
    addReason(reasons, `bio mentions ${roleMatch}`);
  } else if (bio.length > 20) {
    addReason(reasons, "filled-out public profile");
  }

  const stargazerAgeDays = daysSince(input.starredAt);
  if (stargazerAgeDays !== null) {
    if (stargazerAgeDays <= 7) {
      addReason(reasons, "starred this week");
    } else if (stargazerAgeDays <= 30) {
      addReason(reasons, "recent stargazer");
    }
  }

  if (orgs.length > 0) {
    addReason(
      reasons,
      `${orgs.length.toLocaleString("en")} public org${orgs.length === 1 ? "" : "s"}`,
    );
  }
  if (notableOrg) {
    addReason(reasons, `notable org: ${notableOrg.login}`);
  }
  if (totalRepoStars >= 100) {
    addReason(reasons, `${totalRepoStars.toLocaleString("en")} stars across recent repos`);
  } else if (repos.some((repo) => repo.stars >= 25)) {
    addReason(reasons, "starred public project");
  }
  if (languageMatches) {
    addReason(reasons, `${input.targetLanguage} repo history`);
  }
  if (topicMatches) {
    addReason(reasons, "repo topics overlap");
  }

  const ageTrust = accountAge === null ? 0 : accountAge >= 730 ? 24 : accountAge >= 180 ? 14 : 4;
  const profileTrust = Math.min(profileFields * 7, 28) + (company ? 10 : 0);
  const orgTrust = Math.min(orgs.length * 6, 18) + (notableOrg ? 16 : 0);
  const followerReach = Math.min(Math.log10(input.followers + 1) * 24, 62);
  const repoReach = Math.min(Math.log10(totalRepoStars + 1) * 12, 28);
  const followingReach = Math.min(Math.log10((input.following ?? 0) + 1) * 2, 10);
  const repoBuilder =
    Math.min(Math.log10(input.publicRepos + 1) * 18, 42) +
    Math.min(Math.log10(totalRepoStars + totalRepoForks + 1) * 14, 34);
  const gistBuilder = Math.min((input.publicGists ?? 0) * 1.5, 8);
  const activityBuilder = latestRepoAgeDays !== null && latestRepoAgeDays <= 45 ? 12 : 0;
  const languageBuilder = languageMatches ? 8 : 0;
  const influence = clampScore(followerReach + repoReach + followingReach);
  const builder = clampScore(repoBuilder + gistBuilder + activityBuilder + languageBuilder);
  const trust = clampScore(ageTrust + profileTrust + orgTrust);
  const recency = clampScore(
    stargazerAgeDays === null
      ? 0
      : stargazerAgeDays <= 7
        ? 100
        : stargazerAgeDays <= 30
          ? 65
          : stargazerAgeDays <= 90
            ? 28
            : 8,
  );
  const newAccountRisk = accountAge !== null && accountAge < 30 ? 24 : 0;
  const emptyGraphRisk = input.followers < 3 && input.publicRepos < 2 ? 22 : 0;
  const blankProfileRisk = profileFields === 0 ? 18 : 0;
  const followSpamRisk = input.followers === 0 && (input.following ?? 0) > 100 ? 18 : 0;
  const riskPenalty = clampScore(
    newAccountRisk + emptyGraphRisk + blankProfileRisk + followSpamRisk,
  );
  const safety = clampScore(100 - riskPenalty);
  const safetyDetail =
    [
      newAccountRisk ? "new account" : "",
      emptyGraphRisk ? "thin public graph" : "",
      blankProfileRisk ? "blank profile" : "",
      followSpamRisk ? "high following with no followers" : "",
    ]
      .filter(Boolean)
      .join(", ") || "no obvious public-account risk";
  const dimensions = { trust, influence, builder, recency, risk: safety };
  const recencyWeight = stargazerAgeDays === null ? 0 : 0.05;
  const scoreWeight = 0.26 + 0.27 + 0.28 + 0.14 + recencyWeight;
  const displayWeight = (weight: number) => weight / scoreWeight;
  const factors: AudienceScoreFactor[] = [
    factor(
      "age",
      "account age",
      ageTrust,
      24,
      displayWeight(0.28),
      accountAge === null
        ? "GitHub account age unavailable"
        : `${accountAge.toLocaleString("en")} days on GitHub`,
      ageTrust > 0 ? "positive" : "neutral",
    ),
    factor(
      "profile",
      "profile completeness",
      profileTrust,
      38,
      displayWeight(0.28),
      `${profileFields}/5 profile fields${company ? ", company present" : ""}`,
      profileTrust > 0 ? "positive" : "neutral",
    ),
    factor(
      "orgs",
      "org proof",
      orgTrust,
      34,
      displayWeight(0.28),
      notableOrg
        ? `${orgs.length.toLocaleString("en")} public orgs, notable ${notableOrg.login}`
        : `${orgs.length.toLocaleString("en")} public orgs`,
      orgTrust > 0 ? "positive" : "neutral",
    ),
    factor(
      "reach",
      "public reach",
      influence,
      100,
      displayWeight(0.26),
      `${input.followers.toLocaleString("en")} followers, ${totalRepoStars.toLocaleString("en")} recent repo stars`,
      influence > 0 ? "positive" : "neutral",
    ),
    factor(
      "builder",
      "builder history",
      builder,
      100,
      displayWeight(0.27),
      `${input.publicRepos.toLocaleString("en")} public repos, ${repos.length.toLocaleString("en")} recent repos scanned`,
      builder > 0 ? "positive" : "neutral",
    ),
    factor(
      "recency",
      "stargazer recency",
      recency,
      100,
      displayWeight(recencyWeight),
      stargazerAgeDays === null
        ? "not scored for profile-only trust pages"
        : `${stargazerAgeDays.toLocaleString("en")} days since starring`,
      recency > 0 ? "positive" : "neutral",
    ),
    factor(
      "risk",
      "account safety",
      safety,
      100,
      displayWeight(0.14),
      safetyDetail,
      safety >= 85 ? "positive" : safety >= 70 ? "neutral" : "negative",
    ),
  ];
  const score = clampScore(
    (influence * 0.26 + builder * 0.27 + trust * 0.28 + safety * 0.14 + recency * recencyWeight) /
      scoreWeight,
  );
  return {
    score,
    tier: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
    reasons: reasons.length > 0 ? reasons : ["public profile signal is light"],
    dimensions,
    factors,
  };
}

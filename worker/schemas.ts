import * as v from "valibot";

export const gitHubOAuthTokenSchema = v.looseObject({
  access_token: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
});

export const gitHubOAuthUserSchema = v.looseObject({
  id: v.number(),
  login: v.string(),
  name: v.nullable(v.string()),
  avatar_url: v.string(),
  html_url: v.string(),
});

const gitHubInstallationAccountSchema = v.nullable(
  v.looseObject({
    login: v.string(),
    avatar_url: v.string(),
    html_url: v.string(),
    type: v.string(),
  }),
);

export const gitHubInstallationSchema = v.looseObject({
  id: v.number(),
  account: gitHubInstallationAccountSchema,
  html_url: v.string(),
  repository_selection: v.picklist(["all", "selected"]),
  target_type: v.string(),
});

export const gitHubInstallationListSchema = v.looseObject({
  installations: v.optional(v.array(gitHubInstallationSchema)),
});

export const gitHubInstallationRepositorySchema = v.looseObject({
  full_name: v.string(),
  private: v.optional(v.boolean()),
  visibility: v.optional(v.string()),
});

export const gitHubInstallationRepositoryListSchema = v.looseObject({
  repositories: v.optional(v.array(gitHubInstallationRepositorySchema)),
});

export const gitHubInstallationTokenSchema = v.looseObject({
  token: v.optional(v.string()),
  message: v.optional(v.string()),
});

export const gitHubSearchRepositorySchema = v.looseObject({
  name: v.string(),
  full_name: v.string(),
  private: v.optional(v.boolean()),
  fork: v.optional(v.boolean()),
  archived: v.optional(v.boolean()),
  html_url: v.string(),
  description: v.nullable(v.string()),
  default_branch: v.optional(v.string()),
  language: v.nullable(v.string()),
  topics: v.optional(v.array(v.string())),
  stargazers_count: v.optional(v.number()),
  forks_count: v.optional(v.number()),
  open_issues_count: v.optional(v.number()),
  pushed_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
  owner: v.looseObject({
    login: v.string(),
  }),
});

export const gitHubSearchRepositoryListSchema = v.looseObject({
  total_count: v.optional(v.number()),
  incomplete_results: v.optional(v.boolean()),
  items: v.optional(v.array(gitHubSearchRepositorySchema)),
  message: v.optional(v.string()),
});

export const gitHubSearchCountSchema = v.looseObject({
  total_count: v.optional(v.number()),
  message: v.optional(v.string()),
});

export const gitHubRepositorySchema = v.looseObject({
  owner: v.looseObject({
    login: v.string(),
  }),
  name: v.string(),
  full_name: v.string(),
  private: v.optional(v.boolean()),
  fork: v.optional(v.boolean()),
  archived: v.optional(v.boolean()),
  html_url: v.string(),
  description: v.nullable(v.string()),
  default_branch: v.string(),
  language: v.nullable(v.string()),
  topics: v.optional(v.array(v.string())),
  stargazers_count: v.number(),
  forks_count: v.number(),
  open_issues_count: v.number(),
  pushed_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

export const gitHubStargazerSchema = v.looseObject({
  starred_at: v.nullable(v.string()),
  user: v.looseObject({
    login: v.string(),
    avatar_url: v.string(),
    html_url: v.string(),
  }),
});

export const gitHubStargazerListSchema = v.array(gitHubStargazerSchema);

export const gitHubUserProfileSchema = v.looseObject({
  login: v.string(),
  avatar_url: v.string(),
  html_url: v.string(),
  type: v.optional(v.string()),
  name: v.nullable(v.string()),
  company: v.nullable(v.string()),
  bio: v.nullable(v.string()),
  location: v.nullable(v.string()),
  blog: v.nullable(v.string()),
  twitter_username: v.nullable(v.string()),
  followers: v.number(),
  following: v.number(),
  public_repos: v.number(),
  public_gists: v.number(),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

export const gitHubUserOrganizationSchema = v.looseObject({
  login: v.string(),
  avatar_url: v.string(),
  description: v.nullable(v.string()),
});

export const gitHubUserOrganizationListSchema = v.array(gitHubUserOrganizationSchema);

export const gitHubUserRepositorySchema = v.looseObject({
  full_name: v.string(),
  html_url: v.string(),
  description: v.nullable(v.string()),
  language: v.nullable(v.string()),
  stargazers_count: v.number(),
  forks_count: v.number(),
  private: v.optional(v.boolean()),
  visibility: v.optional(v.string()),
  fork: v.boolean(),
  archived: v.boolean(),
  topics: v.optional(v.array(v.string())),
  pushed_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

export const gitHubUserRepositoryListSchema = v.array(gitHubUserRepositorySchema);

export const gitHubReleaseSchema = v.looseObject({
  tag_name: v.string(),
  name: v.nullable(v.string()),
  html_url: v.string(),
  draft: v.optional(v.boolean()),
  prerelease: v.optional(v.boolean()),
  published_at: v.nullable(v.string()),
});

export const gitHubContributorSchema = v.looseObject({
  login: v.optional(v.string()),
  avatar_url: v.optional(v.nullable(v.string())),
  html_url: v.optional(v.nullable(v.string())),
  contributions: v.number(),
});

export const gitHubCommitSchema = v.looseObject({
  sha: v.string(),
  commit: v.looseObject({
    committer: v.optional(
      v.looseObject({
        date: v.nullable(v.string()),
      }),
    ),
  }),
});

export const gitHubCompareSchema = v.looseObject({
  total_commits: v.optional(v.number()),
  html_url: v.optional(v.string()),
  commits: v.optional(
    v.array(
      v.looseObject({
        sha: v.optional(v.string()),
        commit: v.looseObject({
          message: v.string(),
        }),
      }),
    ),
  ),
});

export const gitHubCheckRunsSchema = v.looseObject({
  check_runs: v.optional(
    v.array(
      v.looseObject({
        html_url: v.optional(v.nullable(v.string())),
        status: v.optional(v.nullable(v.string())),
        conclusion: v.optional(v.nullable(v.string())),
        name: v.optional(v.nullable(v.string())),
        started_at: v.optional(v.nullable(v.string())),
        completed_at: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
});

export const gitHubCommitActivitySchema = v.array(
  v.looseObject({
    week: v.number(),
    total: v.number(),
    days: v.array(v.number()),
  }),
);

export const gitHubCodeFrequencySchema = v.array(v.tuple([v.number(), v.number(), v.number()]));

export const gitHubLanguageSchema = v.record(v.string(), v.number());

export const gitHubPublicEventSchema = v.looseObject({
  id: v.string(),
  type: v.string(),
  public: v.optional(v.boolean()),
  created_at: v.string(),
  repo: v.optional(
    v.looseObject({
      name: v.optional(v.string()),
    }),
  ),
  payload: v.optional(v.unknown()),
});

export const gitHubPublicEventListSchema = v.array(gitHubPublicEventSchema);

const authUserSchema = v.object({
  id: v.number(),
  login: v.string(),
  name: v.nullable(v.string()),
  avatarUrl: v.string(),
  url: v.string(),
});

const authInstallationSchema = v.object({
  id: v.number(),
  accountLogin: v.string(),
  accountType: v.picklist(["user", "org"]),
  accountUrl: v.string(),
  avatarUrl: v.string(),
  repositorySelection: v.picklist(["all", "selected"]),
  repositories: v.array(v.string()),
});

export const storedAuthSessionSchema = v.object({
  user: authUserSchema,
  accessToken: v.string(),
  iat: v.number(),
  exp: v.number(),
  installations: v.optional(v.array(authInstallationSchema)),
  installationsUpdatedAt: v.optional(v.string()),
});

export const hotIndexSchema = v.array(v.string());

export type GitHubOAuthToken = v.InferOutput<typeof gitHubOAuthTokenSchema>;
export type GitHubOAuthUser = v.InferOutput<typeof gitHubOAuthUserSchema>;
export type GitHubInstallation = v.InferOutput<typeof gitHubInstallationSchema>;
export type GitHubInstallationRepository = v.InferOutput<typeof gitHubInstallationRepositorySchema>;
export type GitHubInstallationToken = v.InferOutput<typeof gitHubInstallationTokenSchema>;
export type GitHubRepository = v.InferOutput<typeof gitHubRepositorySchema>;
export type GitHubRelease = v.InferOutput<typeof gitHubReleaseSchema>;
export type GitHubSearchRepository = v.InferOutput<typeof gitHubSearchRepositorySchema>;
export type GitHubStargazer = v.InferOutput<typeof gitHubStargazerSchema>;
export type GitHubPublicEvent = v.InferOutput<typeof gitHubPublicEventSchema>;
export type GitHubUserOrganization = v.InferOutput<typeof gitHubUserOrganizationSchema>;
export type GitHubUserProfile = v.InferOutput<typeof gitHubUserProfileSchema>;
export type GitHubUserRepository = v.InferOutput<typeof gitHubUserRepositorySchema>;

export function parseGitHubResponse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
  context: string,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    const issue = result.issues[0];
    const path = issue?.path?.map((segment) => String(segment.key)).join(".") ?? "";
    throw new Error(
      `GitHub response did not match expected shape for ${context}${path ? ` at ${path}` : ""}: ${issue?.message ?? "unknown"}`,
    );
  }
  return result.output;
}

export function safeJsonParse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: string,
  context: string,
): v.InferOutput<TSchema> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`releasedeck: invalid JSON in cached ${context}:`, error);
    return null;
  }
  const result = v.safeParse(schema, parsed);
  if (!result.success) {
    console.warn(
      `releasedeck: cached ${context} failed schema validation:`,
      result.issues[0]?.message ?? "unknown",
    );
    return null;
  }
  return result.output;
}

export function tryJsonParse<T>(raw: string, context: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`releasedeck: invalid JSON in cached ${context}:`, error);
    return null;
  }
}

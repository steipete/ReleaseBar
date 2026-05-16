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

const authUserSchema = v.object({
  id: v.number(),
  login: v.string(),
  name: v.nullable(v.string()),
  avatarUrl: v.string(),
  url: v.string(),
});

export const storedAuthSessionSchema = v.object({
  user: authUserSchema,
  accessToken: v.string(),
  iat: v.number(),
  exp: v.number(),
});

export const hotIndexSchema = v.array(v.string());

export type GitHubOAuthToken = v.InferOutput<typeof gitHubOAuthTokenSchema>;
export type GitHubOAuthUser = v.InferOutput<typeof gitHubOAuthUserSchema>;
export type GitHubInstallation = v.InferOutput<typeof gitHubInstallationSchema>;
export type GitHubInstallationRepository = v.InferOutput<typeof gitHubInstallationRepositorySchema>;
export type GitHubInstallationToken = v.InferOutput<typeof gitHubInstallationTokenSchema>;
export type GitHubSearchRepository = v.InferOutput<typeof gitHubSearchRepositorySchema>;

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

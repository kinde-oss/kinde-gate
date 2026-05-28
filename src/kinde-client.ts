export class KindeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KindeTimeoutError";
  }
}

export class KindeApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "KindeApiError";
  }
}

export interface KindePermission {
  id: string;
  key: string;
  name: string;
  description: string;
}

export interface FlagResult {
  flag_key: string;
  value: string | number | boolean;
  type: "string" | "integer" | "boolean";
}

export interface UserResult {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  orgs: string[];
}

export interface OrgResult {
  code: string;
  name: string;
  is_suspended: boolean;
  feature_flags: Record<string, FlagResult>;
}

export interface KindeClientConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

const TIMEOUT_MS = 3_000;
// Refresh 60 s before actual expiry to avoid races.
const EXPIRY_MARGIN_MS = 60_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new KindeTimeoutError(
        `Kinde API request timed out after ${timeoutMs}ms: ${url}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createKindeClient(cfg: KindeClientConfig) {
  const { domain, clientId, clientSecret } = cfg;
  const timeoutMs = cfg.timeoutMs ?? TIMEOUT_MS;
  const baseUrl = `https://${domain}`;

  let tokenCache: TokenCache | null = null;

  async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now + EXPIRY_MARGIN_MS) {
      return tokenCache.value;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: `${baseUrl}/api`,
    });

    const res = await fetchWithTimeout(
      `${baseUrl}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      timeoutMs,
    );

    if (!res.ok) {
      throw new KindeApiError(
        `Token request failed with status ${res.status}`,
        res.status,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    tokenCache = {
      value: data.access_token,
      expiresAt: now + data.expires_in * 1_000,
    };

    return tokenCache.value;
  }

  async function kindeGet<T>(path: string): Promise<T> {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
      timeoutMs,
    );

    if (!res.ok) {
      throw new KindeApiError(
        `Kinde API ${path} returned ${res.status}`,
        res.status,
      );
    }

    return res.json() as Promise<T>;
  }

  async function getUserPermissions(
    userId: string,
    orgCode?: string,
  ): Promise<string[]> {
    const path = orgCode
      ? `/organizations/${encodeURIComponent(orgCode)}/users/${encodeURIComponent(userId)}/permissions`
      : `/users/${encodeURIComponent(userId)}/permissions`;
    const data = await kindeGet<{ permissions: KindePermission[] }>(path);
    return data.permissions.map((p) => p.key);
  }

  async function getUserFlag(
    userId: string,
    flagKey: string,
  ): Promise<FlagResult> {
    const data = await kindeGet<{
      feature_flags: Record<
        string,
        { value: string | number | boolean; type: "s" | "i" | "b" }
      >;
    }>(`/users/${encodeURIComponent(userId)}/feature_flags`);

    const flag = data.feature_flags[flagKey];
    if (!flag) {
      throw new KindeApiError(`Feature flag '${flagKey}' not found`, 404);
    }

    const typeMap = { s: "string", i: "integer", b: "boolean" } as const;
    return {
      flag_key: flagKey,
      value: flag.value,
      type: typeMap[flag.type],
    };
  }

  async function getUser(userId: string): Promise<UserResult> {
    const data = await kindeGet<{
      id: string;
      preferred_email: string;
      first_name: string;
      last_name: string;
      organizations?: Array<{ code: string }>;
    }>(`/user?id=${encodeURIComponent(userId)}`);

    return {
      id: data.id,
      email: data.preferred_email,
      given_name: data.first_name,
      family_name: data.last_name,
      orgs: (data.organizations ?? []).map((o) => o.code),
    };
  }

  async function getOrg(orgCode: string): Promise<OrgResult> {
    const data = await kindeGet<{
      code: string;
      name: string;
      is_suspended: boolean;
      feature_flags?: Record<
        string,
        { value: string | number | boolean; type: "s" | "i" | "b" }
      >;
    }>(`/organization?code=${encodeURIComponent(orgCode)}`);

    const typeMap = { s: "string", i: "integer", b: "boolean" } as const;
    const feature_flags: Record<string, FlagResult> = {};
    for (const [key, flag] of Object.entries(data.feature_flags ?? {})) {
      feature_flags[key] = { flag_key: key, value: flag.value, type: typeMap[flag.type] };
    }

    return {
      code: data.code,
      name: data.name,
      is_suspended: data.is_suspended,
      feature_flags,
    };
  }

  // Expose cache invalidation for testing.
  function _resetTokenCache() {
    tokenCache = null;
  }

  return {
    getAccessToken,
    getUserPermissions,
    getUserFlag,
    getUser,
    getOrg,
    _resetTokenCache,
  };
}

export type KindeClient = ReturnType<typeof createKindeClient>;

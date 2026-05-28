import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createKindeClient,
  KindeTimeoutError,
  KindeApiError,
} from "../kinde-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CFG = {
  domain: "test.kinde.com",
  clientId: "client_abc",
  clientSecret: "secret_xyz",
};

type FetchArgs = [string | URL | Request, RequestInit?];

/** Build a successful JSON Response. */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Token response fixture. */
const TOKEN_RESPONSE = { access_token: "tok_test", expires_in: 3600 };

/** Permissions response fixture with two keys. */
const PERMS_RESPONSE = {
  permissions: [
    { id: "p1", key: "read:data", name: "Read Data", description: "" },
    { id: "p2", key: "write:data", name: "Write Data", description: "" },
  ],
};

// ---------------------------------------------------------------------------
// Token caching
// ---------------------------------------------------------------------------

describe("token caching", () => {
  let fetchSpy: ReturnType<typeof mock.fn>;
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  beforeEach(() => {
    fetchSpy = mock.fn(async (...args: FetchArgs) => {
      const url = args[0].toString();
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.includes("/api/v1/users/u1/permissions")) return jsonResponse(PERMS_RESPONSE);
      return jsonResponse({}, 404);
    });
    (globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;
  });

  it("fetches a token on the first call", async () => {
    const client = createKindeClient(CFG);
    const token = await client.getAccessToken();
    assert.equal(token, "tok_test");
    assert.equal(fetchSpy.mock.calls.length, 1);
    assert.ok(fetchSpy.mock.calls[0]?.arguments[0]?.toString().includes("/oauth2/token"));
  });

  it("returns the cached token on subsequent calls without hitting the network", async () => {
    const client = createKindeClient(CFG);
    await client.getAccessToken();
    await client.getAccessToken();
    await client.getAccessToken();
    // Only one network call expected.
    const tokenCalls = fetchSpy.mock.calls.filter((c) =>
      (c as unknown as { arguments: FetchArgs }).arguments[0]?.toString().includes("/oauth2/token"),
    );
    assert.equal(tokenCalls.length, 1);
  });

  it("re-fetches when the cache is manually reset", async () => {
    const client = createKindeClient(CFG);
    await client.getAccessToken();
    client._resetTokenCache();
    await client.getAccessToken();
    const tokenCalls = fetchSpy.mock.calls.filter((c) =>
      (c as unknown as { arguments: FetchArgs }).arguments[0]?.toString().includes("/oauth2/token"),
    );
    assert.equal(tokenCalls.length, 2);
  });

  it("re-fetches when the token is about to expire (within 60 s margin)", async () => {
    // Return an almost-expired token (expires_in = 59 s → within the 60 s margin).
    fetchSpy = mock.fn(async (...args: FetchArgs) => {
      const url = args[0].toString();
      if (url.includes("/oauth2/token")) {
        return jsonResponse({ access_token: "tok_fresh", expires_in: 59 });
      }
      return jsonResponse({}, 404);
    });
    (globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;

    const client = createKindeClient(CFG);
    const first = await client.getAccessToken();
    const second = await client.getAccessToken();
    assert.equal(first, "tok_fresh");
    assert.equal(second, "tok_fresh");
    // Both calls should have hit the token endpoint.
    const tokenCalls = fetchSpy.mock.calls.filter((c) =>
      (c as unknown as { arguments: FetchArgs }).arguments[0]?.toString().includes("/oauth2/token"),
    );
    assert.equal(tokenCalls.length, 2);
  });

  it("throws KindeApiError when the token endpoint returns a non-OK status", async () => {
    fetchSpy = mock.fn(async () => jsonResponse({ error: "invalid_client" }, 401));
    (globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;

    const client = createKindeClient(CFG);
    await assert.rejects(
      () => client.getAccessToken(),
      (err: Error) => {
        assert.ok(err instanceof KindeApiError);
        assert.equal((err as KindeApiError).statusCode, 401);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

describe("permission checks", () => {
  let fetchSpy: ReturnType<typeof mock.fn>;
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  beforeEach(() => {
    fetchSpy = mock.fn(async (...args: FetchArgs) => {
      const url = args[0].toString();
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.includes("/api/v1/users/u1/permissions")) return jsonResponse(PERMS_RESPONSE);
      return jsonResponse({}, 404);
    });
    (globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;
  });

  it("returns the list of permission keys for a user", async () => {
    const client = createKindeClient(CFG);
    const perms = await client.getUserPermissions("u1");
    assert.deepEqual(perms, ["read:data", "write:data"]);
  });

  it("confirms a permission the user holds", async () => {
    const client = createKindeClient(CFG);
    const perms = await client.getUserPermissions("u1");
    assert.ok(perms.includes("read:data"));
  });

  it("correctly reports a missing permission", async () => {
    const client = createKindeClient(CFG);
    const perms = await client.getUserPermissions("u1");
    assert.ok(!perms.includes("admin:all"));
  });

  it("returns an empty array when the user has no permissions", async () => {
    fetchSpy = mock.fn(async (...args: FetchArgs) => {
      const url = args[0].toString();
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.includes("/permissions")) return jsonResponse({ permissions: [] });
      return jsonResponse({}, 404);
    });
    (globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;

    const client = createKindeClient(CFG);
    const perms = await client.getUserPermissions("u_no_perms");
    assert.deepEqual(perms, []);
  });

  it("throws KindeApiError when the permissions endpoint returns 403", async () => {
    fetchSpy = mock.fn(async (...args: FetchArgs) => {
      const url = args[0].toString();
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN_RESPONSE);
      return jsonResponse({ message: "Forbidden" }, 403);
    });
    (globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;

    const client = createKindeClient(CFG);
    await assert.rejects(
      () => client.getUserPermissions("u1"),
      (err: Error) => {
        assert.ok(err instanceof KindeApiError);
        assert.equal((err as KindeApiError).statusCode, 403);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 3000ms timeout fallback
// ---------------------------------------------------------------------------

describe("3000ms timeout fallback", () => {
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  it("throws KindeTimeoutError when the token request hangs past the configured timeout", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, opts?: RequestInit) => {
      // Simulate a response that only resolves after the AbortSignal fires.
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
        );
      });
    };

    const client = createKindeClient({ ...CFG, timeoutMs: 50 });
    await assert.rejects(
      () => client.getAccessToken(),
      (err: Error) => {
        assert.ok(err instanceof KindeTimeoutError, `Expected KindeTimeoutError, got ${err.name}`);
        assert.ok(err.message.includes("50ms"));
        return true;
      },
    );
  });

  it("throws KindeTimeoutError when a permissions request hangs past the timeout", async () => {
    let callCount = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, opts?: RequestInit) => {
      const urlStr = url?.toString() ?? "";
      if (urlStr.includes("/oauth2/token")) {
        callCount++;
        return jsonResponse(TOKEN_RESPONSE);
      }
      // Hang on any non-token request.
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
        );
      });
    };

    const client = createKindeClient({ ...CFG, timeoutMs: 50 });
    await assert.rejects(
      () => client.getUserPermissions("u1"),
      KindeTimeoutError,
    );
    assert.equal(callCount, 1, "Should have fetched a token before timing out on permissions");
  });

  it("uses exactly 3000ms as the default timeout", async () => {
    // Verify the default timeout constant — we capture what AbortSignal timeout was used.
    let capturedTimeout: number | undefined;
    (globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, opts?: RequestInit) => {
      // Node's AbortSignal.timeout sets signal.reason to a TimeoutError.
      // Since we build the controller ourselves and use setTimeout, we verify
      // the signal fires at ~3000 ms by checking the error message in the thrown error.
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
        // Resolve so the test doesn't actually wait 3 s: emit abort after 1 ms.
        setTimeout(() => opts?.signal?.dispatchEvent(new Event("abort")), 1);
      });
    };

    const client = createKindeClient(CFG); // default timeoutMs = 3000
    const err = await client.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof KindeTimeoutError);
    assert.ok(
      err.message.includes("3000ms"),
      `Expected message to reference 3000ms, got: ${err.message}`,
    );
  });
});

// ---------------------------------------------------------------------------
// getUser / getOrg smoke tests
// ---------------------------------------------------------------------------

describe("getUser", () => {
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  it("maps Kinde user fields to the expected shape", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
      const u = url?.toString() ?? "";
      if (u.includes("/oauth2/token")) return jsonResponse(TOKEN_RESPONSE);
      if (u.includes("/api/v1/user")) {
        return jsonResponse({
          id: "usr_01",
          preferred_email: "alice@example.com",
          first_name: "Alice",
          last_name: "Smith",
          organizations: [{ code: "org_a" }, { code: "org_b" }],
        });
      }
      return jsonResponse({}, 404);
    };

    const client = createKindeClient(CFG);
    const user = await client.getUser("usr_01");
    assert.deepEqual(user, {
      id: "usr_01",
      email: "alice@example.com",
      given_name: "Alice",
      family_name: "Smith",
      orgs: ["org_a", "org_b"],
    });
  });
});

describe("getOrg", () => {
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  it("maps Kinde org fields and expands feature_flags type codes", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
      const u = url?.toString() ?? "";
      if (u.includes("/oauth2/token")) return jsonResponse(TOKEN_RESPONSE);
      if (u.includes("/api/v1/organization")) {
        return jsonResponse({
          code: "org_abc",
          name: "Acme Corp",
          is_suspended: false,
          feature_flags: {
            dark_mode: { value: true, type: "b" },
            max_seats: { value: 50, type: "i" },
            theme: { value: "dark", type: "s" },
          },
        });
      }
      return jsonResponse({}, 404);
    };

    const client = createKindeClient(CFG);
    const org = await client.getOrg("org_abc");
    assert.equal(org.code, "org_abc");
    assert.equal(org.name, "Acme Corp");
    assert.equal(org.is_suspended, false);
    assert.deepEqual(org.feature_flags["dark_mode"], {
      flag_key: "dark_mode",
      value: true,
      type: "boolean",
    });
    assert.deepEqual(org.feature_flags["max_seats"], {
      flag_key: "max_seats",
      value: 50,
      type: "integer",
    });
    assert.deepEqual(org.feature_flags["theme"], {
      flag_key: "theme",
      value: "dark",
      type: "string",
    });
  });
});

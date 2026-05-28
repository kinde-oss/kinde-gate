# kinde-gate

Gate OpenClaw tool calls against live Kinde roles, permissions, and feature flags.

## Why it exists

OpenClaw has no built-in way to restrict which agents or users can invoke which tools. Any session can call any registered tool unless the tool itself checks identity — which means every tool author re-implements auth logic, or nothing checks at all.

kinde-gate solves this at the platform level. It hooks into the `before_tool_call` lifecycle and calls the Kinde Management API to verify that the session's user holds a required permission before the tool runs. If they don't, the call is blocked before any tool code executes. No per-tool changes required.

It also exposes four callable agent tools that let agents query Kinde directly — checking permissions, reading feature flags, fetching user profiles, and inspecting org details — without any backend code.

## Install

```
openclaw plugins install clawhub:kinde-gate
```

## Config

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `KINDE_DOMAIN` | string | yes | — | Your Kinde domain, e.g. `yourbusiness.kinde.com` |
| `KINDE_CLIENT_ID` | string | yes | — | M2M application client ID |
| `KINDE_CLIENT_SECRET` | string | yes | — | M2M application client secret |
| `GUARD_MODE` | boolean | no | `true` | Hook into `before_tool_call` and enforce Kinde permissions on every tool call |
| `TOOLS_MODE` | boolean | no | `true` | Register `kinde_check_permission`, `kinde_get_flag`, `kinde_get_user`, and `kinde_get_org` as callable agent tools |
| `KINDE_REQUIRED_PERMISSION` | string | no | — | Permission key every user must hold to invoke any tool. Omit to allow all authenticated users through |

## Getting Kinde M2M credentials

1. In the [Kinde dashboard](https://app.kinde.com), go to **Applications → Add application** and choose **Machine to Machine**.
2. On the application's **APIs** tab, enable the **Kinde Management API** and grant it the scopes you need (at minimum `read:users` and `read:organization_user_permissions`).
3. Copy the **Client ID** and **Client Secret** from the application's **Details** tab into your OpenClaw plugin config.

## Guard mode

When `GUARD_MODE` is `true` (the default), kinde-gate registers a `before_tool_call` hook that runs before every tool invocation in the session.

The hook extracts the user identity from the tool call params (`user_id`) or from the session extension `kinde:user_id`. It then calls the Kinde Management API to fetch that user's current permissions and checks whether `KINDE_REQUIRED_PERMISSION` is present.

If the check fails for any reason — missing user, permission absent, API error, or timeout — the call is blocked and the tool never runs.

**Example blocked response:**

```json
{
  "blocked": true,
  "blockReason": "[kinde-gate] Tool 'write_file' blocked: user 'usr_01abc' does not hold the required permission 'files:write'."
}
```

**Log output on denial (structured JSON to stderr):**

```json
{
  "plugin": "kinde-gate",
  "event": "guard_denied",
  "reason": "permission_missing",
  "tool": "write_file",
  "user_id": "usr_01abc",
  "org_code": "org_xyz",
  "required_permission": "files:write",
  "user_permissions": ["files:read", "profile:read"]
}
```

Set `GUARD_MODE: false` to disable the hook entirely while keeping the Kinde tools available.

## Tools mode

When `TOOLS_MODE` is `true` (the default), kinde-gate registers four agent-callable tools.

---

### `kinde_check_permission`

Check whether a user holds a named permission.

**Input:**
```json
{ "user_id": "usr_01abc", "permission": "files:write" }
```

**Output:**
```json
{ "granted": true, "user_id": "usr_01abc", "permission": "files:write" }
```

**Org-scoped permissions**

If your permissions are org-scoped, pass `org_code` to evaluate against the correct organisation:

**Input:**
```json
{ "user_id": "usr_01abc", "permission": "access:agent", "org_code": "org_xyz" }
```

**Output:**
```json
{ "granted": true, "user_id": "usr_01abc", "permission": "access:agent", "org_code": "org_xyz" }
```

Omit `org_code` to fall back to the tenant-level permissions endpoint.

---

### `kinde_get_flag`

Retrieve the current value and type of a feature flag for a user.

**Input:**
```json
{ "user_id": "usr_01abc", "flag_key": "dark_mode" }
```

**Output:**
```json
{ "flag_key": "dark_mode", "value": true, "type": "boolean" }
```

---

### `kinde_get_user`

Fetch basic profile and organisation membership for a user.

**Input:**
```json
{ "user_id": "usr_01abc" }
```

**Output:**
```json
{
  "id": "usr_01abc",
  "email": "alice@example.com",
  "given_name": "Alice",
  "family_name": "Smith",
  "orgs": ["org_xyz", "org_abc"]
}
```

---

### `kinde_get_org`

Fetch organisation details and its active feature flags.

**Input:**
```json
{ "org_code": "org_xyz" }
```

**Output:**
```json
{
  "code": "org_xyz",
  "name": "Acme Corp",
  "is_suspended": false,
  "feature_flags": {
    "dark_mode": { "flag_key": "dark_mode", "value": true, "type": "boolean" },
    "max_seats": { "flag_key": "max_seats", "value": 50, "type": "integer" }
  }
}
```

---

Set `TOOLS_MODE: false` to disable all four tools while keeping guard mode active.

## Security

**Fails closed** — if the Kinde API is unreachable or times out (3000ms default), the tool call is blocked. The agent is never allowed through on an error.

**Secret never logged.** `KINDE_CLIENT_SECRET` is only ever sent in the HTTP POST body of the M2M token request. It does not appear in logs, error messages, stack traces, or structured audit output.

**Token cached in memory.** The M2M access token is cached per plugin instance with a 60-second expiry buffer. It is never written to disk.

## License

MIT

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type KindeClient } from "./kinde-client.js";

// ---------------------------------------------------------------------------
// Shared validation helper
// ---------------------------------------------------------------------------

function validate<T>(
  schema: Parameters<typeof Value.Check>[0],
  input: unknown,
  toolName: string,
): T {
  if (!Value.Check(schema, input)) {
    const errors = [...Value.Errors(schema, input)].map(
      (e) => `${e.path}: ${e.message}`,
    );
    throw new Error(
      `[kinde-gate] ${toolName}: invalid parameters — ${errors.join(", ")}`,
    );
  }
  return input as T;
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const CheckPermissionParams = Type.Object({
  user_id: Type.String({ minLength: 1, description: "Kinde user ID" }),
  permission: Type.String({ minLength: 1, description: "Permission key to check" }),
  org_code: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Kinde organisation code. When provided, checks org-scoped permissions at /organizations/{org_code}/users/{user_id}/permissions.",
    }),
  ),
});

const GetFlagParams = Type.Object({
  user_id: Type.String({ minLength: 1, description: "Kinde user ID" }),
  flag_key: Type.String({ minLength: 1, description: "Feature flag key" }),
});

const GetUserParams = Type.Object({
  user_id: Type.String({ minLength: 1, description: "Kinde user ID" }),
});

const GetOrgParams = Type.Object({
  org_code: Type.String({ minLength: 1, description: "Kinde organisation code" }),
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function registerTools(api: OpenClawPluginApi, client: KindeClient): void {
  // 1. kinde_check_permission
  const checkPermission: AnyAgentTool = {
    name: "kinde_check_permission",
    label: "kinde_check_permission",
    description:
      "Check whether a Kinde user currently holds a named permission. Returns granted status without exposing secrets.",
    parameters: CheckPermissionParams,
    async execute(_toolCallId, raw) {
      const params = validate<Static<typeof CheckPermissionParams>>(
        CheckPermissionParams,
        raw,
        "kinde_check_permission",
      );
      const permissions = await client.getUserPermissions(params.user_id, params.org_code);
      const result = {
        granted: permissions.includes(params.permission),
        user_id: params.user_id,
        permission: params.permission,
        org_code: params.org_code ?? null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  // 2. kinde_get_flag
  const getFlag: AnyAgentTool = {
    name: "kinde_get_flag",
    label: "kinde_get_flag",
    description:
      "Retrieve the current value and type of a Kinde feature flag for a given user.",
    parameters: GetFlagParams,
    async execute(_toolCallId, raw) {
      const params = validate<Static<typeof GetFlagParams>>(
        GetFlagParams,
        raw,
        "kinde_get_flag",
      );
      const result = await client.getUserFlag(params.user_id, params.flag_key);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  // 3. kinde_get_user
  const getUser: AnyAgentTool = {
    name: "kinde_get_user",
    label: "kinde_get_user",
    description:
      "Fetch basic profile and organisation membership for a Kinde user.",
    parameters: GetUserParams,
    async execute(_toolCallId, raw) {
      const params = validate<Static<typeof GetUserParams>>(
        GetUserParams,
        raw,
        "kinde_get_user",
      );
      const result = await client.getUser(params.user_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  // 4. kinde_get_org
  const getOrg: AnyAgentTool = {
    name: "kinde_get_org",
    label: "kinde_get_org",
    description:
      "Fetch organisation details and its active feature flags from Kinde.",
    parameters: GetOrgParams,
    async execute(_toolCallId, raw) {
      const params = validate<Static<typeof GetOrgParams>>(
        GetOrgParams,
        raw,
        "kinde_get_org",
      );
      const result = await client.getOrg(params.org_code);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  api.registerTool(checkPermission);
  api.registerTool(getFlag);
  api.registerTool(getUser);
  api.registerTool(getOrg);
}

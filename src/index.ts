import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createKindeClient, type KindeClient } from "./kinde-client.js";
import { setupGuard } from "./guard.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type PluginConfig = {
  KINDE_DOMAIN: string;
  KINDE_CLIENT_ID: string;
  KINDE_CLIENT_SECRET: string;
  GUARD_MODE?: boolean;
  TOOLS_MODE?: boolean;
  KINDE_REQUIRED_PERMISSION?: string;
};

const ConfigSchema = Type.Object(
  {
    KINDE_DOMAIN: Type.String({
      minLength: 1,
      description: "Your Kinde domain (e.g. yourbusiness.kinde.com)",
    }),
    KINDE_CLIENT_ID: Type.String({
      minLength: 1,
      description: "M2M app client ID",
    }),
    KINDE_CLIENT_SECRET: Type.String({
      minLength: 1,
      description: "M2M app client secret",
    }),
    GUARD_MODE: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "Hook into before_tool_call lifecycle and enforce Kinde permissions on every tool call.",
      }),
    ),
    TOOLS_MODE: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "Register kinde_check_permission, kinde_get_flag, kinde_get_user, and kinde_get_org as callable agent tools.",
      }),
    ),
    KINDE_REQUIRED_PERMISSION: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Permission key that all users must hold to invoke any tool (guard mode). Omit to allow all authenticated users.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const CheckPermissionParams = Type.Object({
  user_id: Type.String({ minLength: 1, description: "Kinde user ID" }),
  permission: Type.String({
    minLength: 1,
    description: "Permission key to check",
  }),
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
  org_code: Type.String({
    minLength: 1,
    description: "Kinde organisation code",
  }),
});

// ---------------------------------------------------------------------------
// Validation helper
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
// Module-level client cache
// Keyed by domain:clientId so the M2M token is never re-fetched across
// concurrent tool calls that share identical credentials.
// ---------------------------------------------------------------------------

const clientCache = new Map<string, KindeClient>();

function getClient(cfg: PluginConfig): KindeClient {
  const key = `${cfg.KINDE_DOMAIN}:${cfg.KINDE_CLIENT_ID}`;
  let client = clientCache.get(key);
  if (!client) {
    client = createKindeClient({
      domain: cfg.KINDE_DOMAIN,
      clientId: cfg.KINDE_CLIENT_ID,
      clientSecret: cfg.KINDE_CLIENT_SECRET,
    });
    clientCache.set(key, client);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const entry = defineToolPlugin({
  id: "kinde-gate",
  name: "Kinde Gate",
  description:
    "Gate OpenClaw tool calls against live Kinde roles, permissions, and feature flags. Guard mode enforces silently on every tool call. Tools mode exposes kinde_check_permission, kinde_get_flag, kinde_get_user, and kinde_get_org as callable agent tools.",
  configSchema: ConfigSchema,

  tools: (tool) => [
    tool({
      name: "kinde_check_permission",
      description:
        "Check whether a Kinde user currently holds a named permission. Returns granted status without exposing secrets.",
      parameters: CheckPermissionParams,
      execute(rawParams, _config, ctx) {
        const cfg = (ctx.api.pluginConfig ?? {}) as PluginConfig;
        const client = getClient(cfg);
        const params = validate<Static<typeof CheckPermissionParams>>(
          CheckPermissionParams,
          rawParams,
          "kinde_check_permission",
        );
        return client.getUserPermissions(params.user_id, params.org_code).then((permissions) => ({
          granted: permissions.includes(params.permission),
          user_id: params.user_id,
          permission: params.permission,
          org_code: params.org_code ?? null,
        }));
      },
    }),

    tool({
      name: "kinde_get_flag",
      description:
        "Retrieve the current value and type of a Kinde feature flag for a given user.",
      parameters: GetFlagParams,
      execute(rawParams, _config, ctx) {
        const cfg = (ctx.api.pluginConfig ?? {}) as PluginConfig;
        const client = getClient(cfg);
        const params = validate<Static<typeof GetFlagParams>>(
          GetFlagParams,
          rawParams,
          "kinde_get_flag",
        );
        return client.getUserFlag(params.user_id, params.flag_key);
      },
    }),

    tool({
      name: "kinde_get_user",
      description:
        "Fetch basic profile and organisation membership for a Kinde user.",
      parameters: GetUserParams,
      execute(rawParams, _config, ctx) {
        const cfg = (ctx.api.pluginConfig ?? {}) as PluginConfig;
        const client = getClient(cfg);
        const params = validate<Static<typeof GetUserParams>>(
          GetUserParams,
          rawParams,
          "kinde_get_user",
        );
        return client.getUser(params.user_id);
      },
    }),

    tool({
      name: "kinde_get_org",
      description:
        "Fetch organisation details and its active feature flags from Kinde.",
      parameters: GetOrgParams,
      execute(rawParams, _config, ctx) {
        const cfg = (ctx.api.pluginConfig ?? {}) as PluginConfig;
        const client = getClient(cfg);
        const params = validate<Static<typeof GetOrgParams>>(
          GetOrgParams,
          rawParams,
          "kinde_get_org",
        );
        return client.getOrg(params.org_code);
      },
    }),
  ],
});

// Augment the register callback to layer guard-mode on top of the tool
// registrations that defineToolPlugin produces.
// DefinedPluginEntry.register is not readonly so this assignment is safe.
const originalRegister = entry.register;
entry.register = (api: OpenClawPluginApi) => {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const guardMode = cfg.GUARD_MODE ?? true;
  const toolsMode = cfg.TOOLS_MODE ?? true;

  // originalRegister wires up all four tools; skip if tools mode is disabled.
  if (toolsMode) {
    originalRegister(api);
  }

  if (guardMode) {
    const client = getClient(cfg);
    setupGuard(api, client, {
      requiredPermission: cfg.KINDE_REQUIRED_PERMISSION,
    });
  }
};

export default entry;

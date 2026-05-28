import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type KindeClient, KindeTimeoutError } from "./kinde-client.js";

// Shapes verified from openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts.
// Not re-exported from any public SDK subpath, so we mirror them locally.
type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
};

type BeforeToolCallResult = {
  block?: boolean;
  blockReason?: string;
};

type ToolCallContext = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  toolCallId?: string;
  getSessionExtension?: (namespace: string) => unknown;
};

export interface GuardConfig {
  requiredPermission?: string | undefined;
}

export function setupGuard(
  api: OpenClawPluginApi,
  client: KindeClient,
  cfg: GuardConfig,
): void {
  const handler = async (
    rawEvent: unknown,
    rawCtx: unknown,
  ): Promise<BeforeToolCallResult | void> => {
    const event = rawEvent as BeforeToolCallEvent;
    const ctx = rawCtx as ToolCallContext;
    const { toolName, params } = event;
    const requiredPermission = cfg.requiredPermission;

    // Best-effort extraction: user_id may live in the tool params directly,
    // or the host may have stashed it in a session extension.
    const user_id =
      typeof params["user_id"] === "string"
        ? params["user_id"]
        : (ctx.getSessionExtension?.("kinde:user_id") as string | undefined);
    const org_code =
      typeof params["org_code"] === "string"
        ? params["org_code"]
        : (ctx.getSessionExtension?.("kinde:org_code") as string | undefined);

    if (!requiredPermission) {
      api.logger.info(
        JSON.stringify({
          plugin: "kinde-gate",
          event: "guard_skipped",
          reason: "no_required_permission_configured",
          tool: toolName,
          user_id: user_id ?? null,
          org_code: org_code ?? null,
        }),
      );
      return;
    }

    if (!user_id) {
      api.logger.warn(
        JSON.stringify({
          plugin: "kinde-gate",
          event: "guard_denied",
          reason: "no_authenticated_user",
          tool: toolName,
          required_permission: requiredPermission,
          session_key: ctx.sessionKey ?? null,
        }),
      );
      return {
        block: true,
        blockReason: `[kinde-gate] Tool '${toolName}' blocked: no authenticated user found in session context.`,
      };
    }

    let permissions: string[];
    try {
      permissions = await client.getUserPermissions(user_id, org_code);
    } catch (err) {
      const isTimeout = err instanceof KindeTimeoutError;
      api.logger.warn(
        JSON.stringify({
          plugin: "kinde-gate",
          event: "guard_denied",
          reason: isTimeout ? "permission_check_timeout" : "permission_check_error",
          tool: toolName,
          user_id,
          org_code: org_code ?? null,
          required_permission: requiredPermission,
          error: (err as Error).message,
        }),
      );
      return {
        block: true,
        blockReason: `[kinde-gate] Tool '${toolName}' blocked: permission check failed (${isTimeout ? "timeout" : "API error"}). Denying by default.`,
      };
    }

    const granted = permissions.includes(requiredPermission);

    api.logger.info(
      JSON.stringify({
        plugin: "kinde-gate",
        event: granted ? "guard_allowed" : "guard_denied",
        reason: granted ? "permission_granted" : "permission_missing",
        tool: toolName,
        user_id,
        org_code: org_code ?? null,
        required_permission: requiredPermission,
        user_permissions: permissions,
      }),
    );

    if (!granted) {
      return {
        block: true,
        blockReason: `[kinde-gate] Tool '${toolName}' blocked: user '${user_id}' does not hold the required permission '${requiredPermission}'.`,
      };
    }
  };

  // api.registerHook is typed with the low-level InternalHookHandler signature,
  // but the runtime dispatches the real typed event/context for before_tool_call
  // and reads the returned PluginHookBeforeToolCallResult for block decisions.
  api.registerHook(
    "before_tool_call",
    handler as unknown as Parameters<typeof api.registerHook>[1],
    { name: "kinde-gate:guard" },
  );
}

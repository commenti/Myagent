/**
 * src/ui/permissionPrompt.ts
 * --------------------------
 * Bridge between the non-React code (PermissionManager's prompt callback)
 * and the React TUI (which owns the actual y/n input box).
 *
 * The Renderer registers a handler on mount. Any other module can call
 * askPermission(req) and get back a Promise<boolean>. If no handler is
 * registered, the answer is always `false` (fail closed).
 */

import type { PermissionRequest } from "../policy/PermissionManager";

type Handler = (req: PermissionRequest) => Promise<boolean>;

let handler: Handler | null = null;

export function setPermissionPromptHandler(h: Handler | null): void {
  handler = h;
}

export async function askPermission(req: PermissionRequest): Promise<boolean> {
  if (!handler) return false;
  try {
    return await handler(req);
  } catch {
    return false;
  }
}
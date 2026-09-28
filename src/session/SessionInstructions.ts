/**
 * src/memory/SessionInstructions.ts
 * ---------------------------------
 * In-memory, session-scoped custom instructions.
 * They live only for the current process — never written to disk.
 */

let sessionText = "";

export function getSessionInstructions(): string {
  return sessionText;
}

export function setSessionInstructions(text: string): void {
  sessionText = text;
}

export function clearSessionInstructions(): void {
  sessionText = "";
}
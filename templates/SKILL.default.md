SKILL.md — Required Patterns for This Project

«This file is loaded only when needed — that is, whenever a task matches one of these skills.
Each "Skill" defines a specific method for correctly building or modifying a particular part of this project.»

---

Skill 1: Building a Provider Adapter

When it applies: Whenever an adapter file inside "src/providers/" is being created.

- Every adapter must implement the common interface defined in "AdapterBase.ts": "sendMessage()", "streamMessage()", "testHandshake()", and "classifyError()".
- An adapter must never contain hardcoded company-specific logic internally — it should only use the URL, key, and model provided by the user.
- The handshake test must always send a minimal-token request (for example, ""reply with OK"") so that an invalid key or URL can be detected without unnecessarily consuming the user's tokens.
- Streaming responses must emit events token-by-token so the UI can display the response live.
- Never leave errors as raw provider-specific errors — pass them through "ErrorClassifier.ts" and convert them into common types such as:
  - "quota_exceeded"
  - "model_not_found"
  - "auth_invalid"
  - "network_error"
  - "server_error"

---

Skill 2: Patch-Based File Editing (No Full Rewrite)

When it applies: "FilePatchEdit.ts" or any other location where an existing file needs to be modified.

- Every edit must use the "old_str" + "new_str" format. Never regenerate the entire existing file.
- Before applying a patch, freshly read the file from disk. Never rely on cached or previously loaded content.
- "old_str" must occur exactly once in the file. If it occurs zero times or more than once, return an error and do not apply the patch.
- After applying the patch, read the file again and perform a basic syntax check (for example, verify that braces and brackets are balanced).
- If the resulting file is invalid or broken, automatically roll back by restoring the previous content and report the error.

---

Skill 3: Building Live Activity UI Components

When it applies: Any file inside the "ui/" folder.

- The screen must never remain blank — as soon as any asynchronous operation begins, immediately display a status line (spinner + label), even if the actual result arrives later.
- Every status line must have three states:
  - Starting / running: "⠙"
  - Successful: "✓"
  - Failed: "✗" / red
- Text responses must always be displayed as a stream (token-by-token). Do not make the user wait for the complete response before displaying it.
- When handling large pasted input (bracketed paste mode), show only a short tag inside the input box, such as "[Pasted text: 12,000 chars]". Store the actual text separately in a variable. This prevents the UI from becoming overloaded or crashing.

---

Skill 4: Task Orchestration (Plan → Execute → Verify)

When it applies: The "orchestrator/" folder.

- A task is considered complete only when its acceptance check (test/build/lint command) has actually been executed and passed. The model saying "I completed it" is not sufficient.
- Record every task attempt in "FailureLedger", including what was attempted and what happened.
- If the same error fingerprint occurs again, repeating the previous approach is forbidden. A different approach must be attempted.
- After 3 failed attempts:
  1. Perform a git rollback.
  2. Start a completely fresh-context sub-task.
  3. Provide only the error and a summary of the previous failed attempts — do not send the entire confused/history-heavy context.

---

Skill 5: Path Safety and Permissions

When it applies: The "policy/" folder.

- Before every file operation, verify that the resolved path is inside the CLI's working directory. If it resolves outside the working directory, immediately block the operation without exception.
- This check must not depend on the AI or prompt. It must be enforced directly in code using checks such as "path.resolve()" + a safe "startsWith"/path-boundary validation.
- Read the permission mode ("all-allowed" / "ask-every-time") from ".agent-runtime/permission.json".
- In "ask-every-time" mode, display a "y/n" prompt before every sensitive operation and do not continue until the user provides an answer.

---

Skill 6: Summarizer + History Retrieval (Raw History Is Never Deleted)

When it applies: "context/Summarizer.ts" and "context/HistoryRetriever.ts".

"Summarizer.ts"

Whenever "Compaction" requests a summary:

- Perform a separate, isolated AI call.
- Do not add this summarization call to the main coding conversation's context.
- Send only the old conversation segment that needs to be compacted.
- Request the response in three structured sections:
  1. Decisions
  2. Progress
  3. Facts
- Append the resulting information directly to "DECISIONS.md" and/or "PROGRESS.md".

Raw History Archive

When Compaction removes old raw text from the active context:

- Never delete the raw text.
- Store it in "sessions/archive/*.jsonl".
- Record the following in "archive_index.json":
  - Archive ID
  - Short topic/task name
  - Date
- This allows the archived history to be searched later using keywords.

"HistoryRetriever.ts"

"HistoryRetriever.ts" provides a tool that:

1. Receives a query/keyword.
2. Searches "archive_index.json" for matches.
3. Opens only the relevant section of the matching archive file.
4. Returns only the necessary information instead of loading the entire archive.

The retrieved result must be added to the context temporarily for the current turn only.

It must not become permanent context. During the next compaction, it should naturally be removable again; otherwise the context could become unnecessarily large.

This tool may be called:

- Automatically by the model when the current summary is insufficient.
- Directly by the user, for example through "/plan" or a normal question.

---

Skill 7: Context Compaction

When it applies: "context/Compaction.ts"

Critical Rule

Compaction operates only on conversation history.

User Custom Instructions — including:

- "AGENTS.md"
- Global "/instruction"
- Project "/instruction"

must never be compacted or summarized.

They must always be sent completely and verbatim every time.

To prevent accidental compaction of instructions, the implementation must keep:

- Custom Instructions
- Conversation History

in separate objects/arrays so that the Compaction system cannot accidentally process the Instructions.

Compaction Rules

- Start compaction when approximately 75% of the token budget is used.
- Convert old conversation history into a structured summary containing:
  - Decisions that were made
  - Tasks that were completed
  - Relevant progress
- Persist this summary into ".agent-runtime/PROGRESS.md".
- Do not merely remove the old history from RAM/context without saving it permanently.
- If a file has already been read and has not changed, remove its full content from the active context and keep only a ""read""/""already_read"" marker.
- If the file is needed again later, read it from disk again.

---

Core Principle

The purpose of these skills is to keep the agent predictable, context-efficient, safe, and fully under the user's control.

The agent should preserve raw history, keep instructions immutable, minimize unnecessary context usage, make changes through controlled patches, verify actual results, and never claim completion without real verification.
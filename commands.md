# Slash Commands

This document describes the slash commands available in the opencode TUI prompt. Commands are intercepted on submit (before reaching the LLM) and routed to the server's session API.

All commands operate on the current session and its Dolt-backed storage branch. Output from a command renders inline in the chat as an ephemeral system message (it is not persisted to the database and is not included in the LLM context).

## Conventions

- `<...>` — required parameter.
- `[...]` — optional parameter.
- `|` — alternative forms.
- `[N]` (with a digit, e.g. `[3]`) — a prompt-index literal that refers to the Nth user prompt in the session, as numbered by `/history`.
- `BASE` (case-insensitive) — shorthand for the project's `base_branch`. Supported by commands that resolve refs server-side via Dolt's `AS OF` clause: `/context`, `/diff-stat`, `/diff-context`, `/history`.
- "Truncated commit hash" — any short pure-base32 string from `/log` (e.g. `7a1b2c3d`). Commands that accept a `<ref>` will fetch `/log`, expand the prefix to the full hash, and error if the prefix is ambiguous. Branch names, full hashes, and revision specs like `HEAD~1` pass through unchanged.

---

## Versioning & branch state

### `/commit <message>`

Commit the current Dolt working state with the given message.

**Parameters**
- `<message>` (required) — commit message. Everything after `/commit ` is the message; quotes are not needed.

**Behavior**
- Runs `dolt_commit('-m', <message>)` on the active branch.
- Fails if there is nothing to commit (working state is clean).

**Example**
```
/commit add login UI
```

---

### `/log`

Show the commit log for the active branch, newest first. The log is clipped at the project's `base_branch` creation commit so older base-bootstrap commits don't appear.

**Parameters** — none.

**Output** — one commit per line: `<hash>  <date>  <message>`. Hash width is the shortest prefix that uniquely identifies every commit in the result, with a minimum of 8 characters (matches `git`'s default abbrev width).

---

### `/branch`

Multiple forms — list branches, list with details, or create a branch.

#### `/branch`
List branches that fork from the project's `base_branch`. The current branch is marked with `►`.

#### `/branch -v`
Verbose list (`git branch -v` style). Marker + name + short hash + first line of the head commit message. Hash width auto-grows past 8 chars when needed for uniqueness.

#### `/branch <name> <ref>`
Create a new branch named `<name>` pointing at `<ref>`. Does **not** switch the session onto the new branch.
- `<ref>` can be a branch name, a full or truncated commit hash, `HEAD`, `HEAD~N`, or any other revision spec Dolt accepts.
- Truncated commit hashes are resolved against `/log`. Ambiguous prefixes are rejected.

#### `/branch <name> [N]`
Create a new branch named `<name>` capturing the conversation state immediately after user prompt N was completed.
- If a commit's cumulative prompt count is exactly N, the branch is created at that commit.
- Otherwise the `-m <message>` switch is **required** — the server forks from the closest prior commit, re-INSERTs the message/part rows between that commit and prompt N+1 (exclusive), commits with `<message>`, then points the new branch at that synthetic commit. The session's active branch is restored afterward.

**Switches**
- `-m <message>` — commit message used when synthesizing a commit for `/branch <name> [N]`. Everything after `-m` is the message.

**Examples**
```
/branch                           # list
/branch -v                        # list with hash + subject
/branch hotfix abc123             # create at truncated hash
/branch fork-at-3 [3]             # state after prompt 3 (direct commit)
/branch wip-3 [3] -m before tools # synthesize a commit if no direct one
```

---

### `/checkout <branch_name>` | `/checkout -b <branch_name>`

Switch the session onto an existing branch, or with `-b` create a new branch forked from the project's `base_branch` and switch onto it.

**Parameters**
- `<branch_name>` (required) — branch to switch to.

**Switches**
- `-b` — create the branch (must not already exist) and switch onto it.

**Notes**
- Without `-b` the branch must already exist.
- The TUI re-fetches the session's chat history from the new branch's database state on success.
- With `-b`, the TUI also navigates to home (fresh-session UX).

---

### `/new <branch_name>`

Create a new branch forked from the project's `base_branch` and switch the session onto it. `<branch_name>` must be a single word.

This is the same end state as `/checkout -b <branch_name>` and exists as a shorter alias for the common case.

---

### `/reset` | `/reset <ref>` | `/reset [N]`

Hard-reset the active branch.

#### `/reset`
Reset to `HEAD` — discards uncommitted changes on the working set.

#### `/reset <ref>`
Reset to the given ref. Accepts the same ref forms as `/branch <name> <ref>` (branches, full or truncated hashes, `HEAD~N`, etc.). Truncated hashes are resolved against `/log`; ambiguous prefixes are rejected.

#### `/reset [N]`
Reset to the conversation state immediately after user prompt N.
- If a commit's cumulative prompt count is exactly N, resets directly to that commit.
- Otherwise the server caches the message/part rows between the closest prior commit and prompt N+1 (exclusive), runs `dolt_reset --hard <priorCommit>`, then re-INSERTs the cached rows so the working state matches the post-prompt-N state. No new commit is created.

**Notes**
- After any reset the TUI re-fetches the session's chat history.
- Unlike `/branch [N]`, no `-m` is ever required — `/reset [N]` leaves the resulting state in the working set rather than committing it.

---

## Context & history

### `/context` | `/context --show` | `/context <ref>` | `/context BASE`

Show stats about the context that would be sent to the LLM on the next prompt: provider/model, message count by role, tool-call count, total characters, and an approximate token count.

**Forms**
- `/context` — stats for the current working state.
- `/context --show` — same stats plus a JSON dump of the full message array that would be sent.
- `/context <ref>` — build the context AS OF `<ref>`. Truncated commit hashes are NOT auto-expanded here; pass a full hash or a branch/revision spec.
- `/context BASE` — alias for "AS OF the project's base_branch" (case-insensitive).
- `/context --show <ref>` / `/context <ref> --show` — combinable.

**Behavior**
- AS OF time-travels every underlying read (session, messages, parts) using Dolt's `AS OF '<ref>'` clause. The model resolution also reflects the historical state because it derives from the read messages.

---

### `/diff-context` | `/diff-context <ref>` | `/diff-context <ref1> <ref2>`

Diff the LLM context between two refs. Renders two `/context` reports side-by-side, showing model change (if any), per-role counts before/after, tool-call delta, char/token delta, and a position-by-position diff (identical runs collapsed; individual indices listed as `added`/`removed`/`changed`).

**Default parameters**
- 0 args → `/diff-context HEAD WORKING`
- 1 arg `<ref>` → `/diff-context <ref> WORKING`
- 2 args → `/diff-context <ref1> <ref2>`

**Supported refs** — anything Dolt's AS OF accepts: branches, full commit hashes, `HEAD`, `HEAD~N`, `WORKING`, `STAGED`, timestamps, and `BASE`.

---

### `/diff-stat` | `/diff-stat <ref>` | `/diff-stat <ref1> <ref2>`

Show per-table diff stats between two refs for the session-context tables (`message`, `part`, `todo`). Reports row counts before/after, rows added/deleted/modified, cells added/deleted/modified, and (for tables with a `data` JSON column) byte sizes added/deleted/net.

**Default parameters**
- 0 args → `/diff-stat HEAD WORKING`
- 1 arg `<ref>` → `/diff-stat <ref> WORKING`
- 2 args → `/diff-stat <ref1> <ref2>`

**Supported refs** — same as `/diff-context`, including `BASE`.

---

### `/history` | `/history -v` | `/history <ref>`

List user prompts submitted in this session.

#### `/history`
Compact one-line-per-prompt list, oldest first:
```
[i]  YYYY-MM-DD HH:MM  <subject>
```
Long prompts are truncated to 100 chars; index column auto-widens to the digit count of the largest entry.

#### `/history -v`
Verbose interleaved view: prompts grouped under the commit that first contained them. Each section ends with a `Commit <hash> - <subject>` line. Prompts not yet committed render as a trailing section with no commit footer. Indices are global (1..N across all prompts).

#### `/history <ref>`
Show prompts as they existed AS OF `<ref>`. The header changes to `Prompts as of <ref> (oldest first):` so you can confirm which snapshot was queried.

**Supported refs**
- Branch names, full or truncated commit hashes, `HEAD`, `HEAD~N`, `WORKING`, `STAGED`, timestamps, and `BASE`.
- Truncated hashes are auto-expanded via `/log`. Ambiguous prefixes are rejected.

---

## Storage & introspection

### `/sql <statement>`

Run an arbitrary SQL statement against the storage and render the result.

**Parameters**
- `<statement>` (required) — the SQL to run. Everything after `/sql ` is the statement; multi-line statements are supported.

**Output**
- For SELECT-like queries: column headers and rows.
- For mutating queries: affected row count and any returned info.

**Notes**
- Runs on the session's MySQL/Dolt connection, so the active branch is whatever the session is currently on.
- Use cautiously — there are no guard rails against DDL or destructive statements.

---

## LLM-driven commands

These commands are registered with template prompts and dispatch through the LLM rather than running locally. The model executes the template using the rest of the input as `$ARGUMENTS`.

### `/init`

Guided AGENTS.md setup. Analyzes the current project's worktree and produces an `AGENTS.md` file with project-specific agent configuration.

**Parameters** — none.

---

### `/review [commit|branch|pr]`

Review changes. Defaults to reviewing uncommitted changes; pass `commit`, `branch`, or `pr` to scope the review differently.

**Parameters**
- Optional positional argument selecting what to review.

---

## Notes on output

- Slash-command output appears in the TUI as a chat-style system message tagged with the originating command (e.g. `[/log]`). It is **local only** — not persisted to the database, not included in future LLM context.
- Errors render as a toast at the bottom of the screen.
- After commands that change branch state (`/checkout`, `/new`, `/reset`), the TUI re-fetches the session's messages from the database so the view reflects the new state.

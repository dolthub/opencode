import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export interface HistoryPrompt {
  id: string
  time: number
  text: string
}

export interface HistoryCommit {
  commitHash: string
  date: string
  message: string
}

export interface HistoryCommitGroup {
  commit: HistoryCommit
  // Prompts that first appear in this commit — i.e. present at this commit's
  // hash but absent from the previous commit's hash (or, for the oldest
  // commit, all prompts present at it).
  prompts: HistoryPrompt[]
}

export interface HistoryWithCommits {
  // Every user prompt in the session's working state, oldest-first. Index N
  // in this array corresponds to display index N+1.
  allPrompts: HistoryPrompt[]
  // Commits on the session's branch, oldest-first, each paired with the
  // prompts that first appeared in it.
  groups: HistoryCommitGroup[]
  // Prompts present in working state but absent from the most recent commit
  // (or all prompts when there are no commits).
  uncommitted: HistoryPrompt[]
}

/**
 * Fetches the session's commit log and computes which prompts belong to which
 * commit by issuing one `/history` AS-OF read per commit (plus one for the
 * working state) in parallel. Prompt timestamps and commit dates aren't on
 * the same timeline — a prompt's `time` is its row insertion time, but a
 * commit's `date` is when the user ran `/commit` — so AS OF reads are the
 * source of truth for "which prompts are in which commit".
 *
 * All requests fire in parallel, so wall-clock cost is roughly one round trip
 * regardless of commit count.
 */
export async function fetchHistoryWithCommits(
  client: OpencodeClient,
  sessionID: string,
): Promise<HistoryWithCommits> {
  const logRes = await client.session.log({ sessionID }, { throwOnError: true })
  const commits = ((logRes.data ?? []) as HistoryCommit[]).slice().reverse() // oldest first
  const [allHist, ...commitHistories] = await Promise.all([
    client.session.history({ sessionID }, { throwOnError: true }),
    ...commits.map((c) =>
      client.session.history({ sessionID, as_of: c.commitHash }, { throwOnError: true }),
    ),
  ])
  const allPrompts = (allHist.data ?? []) as HistoryPrompt[]
  const groups: HistoryCommitGroup[] = []
  let prevIds = new Set<string>()
  for (let i = 0; i < commits.length; i++) {
    const cur = (commitHistories[i].data ?? []) as HistoryPrompt[]
    const added = cur.filter((p) => !prevIds.has(p.id))
    groups.push({ commit: commits[i], prompts: added })
    prevIds = new Set(cur.map((p) => p.id))
  }
  const uncommitted = allPrompts.filter((p) => !prevIds.has(p.id))
  return { allPrompts, groups, uncommitted }
}

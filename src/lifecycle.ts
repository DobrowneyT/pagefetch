/**
 * How much memory the browser is actually using.
 *
 * Measured over the process **tree**, not the launcher process: Chromium's
 * memory lives in its renderer and GPU children, and the parent's own RSS says
 * almost nothing about a leak. The container's cgroup total would be the other
 * candidate, but it counts page cache too and would restart the browser for
 * reasons that have nothing to do with the browser.
 */
import { readdir, readFile } from "node:fs/promises"

const PAGE_SIZE = 4096

interface ProcessInfo {
  ppid: number
  rssBytes: number
}

async function readProcessTable(): Promise<Map<number, ProcessInfo>> {
  const table = new Map<number, ProcessInfo>()
  const entries = await readdir("/proc")

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8")
      // The comm field is parenthesised and may itself contain spaces, so the
      // only safe place to start splitting is after the LAST closing paren.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const ppid = Number(fields[1])
      const rssPages = Number(fields[21])
      if (Number.isFinite(ppid) && Number.isFinite(rssPages)) {
        table.set(pid, { ppid, rssBytes: rssPages * PAGE_SIZE })
      }
    } catch {
      // The process exited between listing and reading. Normal; skip it.
    }
  }

  return table
}

/**
 * Find the browser process by a flag only our instance passes.
 *
 * Playwright does not expose the browser's pid for `chromium.launch()`, and
 * guessing by process name would find any Chromium on the host. The proxy
 * address is unique to this service and appears in the browser process's command
 * line, which makes it a precise handle.
 *
 * Renderers inherit some flags, so the root is the match whose parent is not
 * itself a match.
 */
async function findBrowserPid(marker: string): Promise<number | undefined> {
  const entries = await readdir("/proc")
  const matches = new Map<number, number>() // pid -> ppid

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8")
      if (!cmdline.includes(marker)) continue
      const stat = await readFile(`/proc/${pid}/stat`, "utf8")
      matches.set(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]))
    } catch {
      // Exited between listing and reading.
    }
  }

  for (const [pid, ppid] of matches) {
    if (!matches.has(ppid)) return pid
  }
  return undefined
}

export async function browserTreeRssBytes(marker: string): Promise<number> {
  try {
    return await processTreeRssBytes(await findBrowserPid(marker))
  } catch {
    return 0 // No /proc, so no opinion. Better than a wrong number.
  }
}

export async function processTreeRssBytes(rootPid: number | undefined): Promise<number> {
  if (rootPid === undefined) return 0

  let table: Map<number, ProcessInfo>
  try {
    table = await readProcessTable()
  } catch {
    return 0 // No /proc, so no opinion. Better than a wrong number.
  }

  const children = new Map<number, number[]>()
  for (const [pid, info] of table) {
    const siblings = children.get(info.ppid) ?? []
    siblings.push(pid)
    children.set(info.ppid, siblings)
  }

  let total = 0
  const queue = [rootPid]
  const seen = new Set<number>()

  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    total += table.get(pid)?.rssBytes ?? 0
    queue.push(...(children.get(pid) ?? []))
  }

  return total
}

/** A filename-safe form of a hostname, for the per-domain storage state files. */
export function stateFileName(host: string): string {
  return `${host.replace(/[^a-z0-9.-]/gi, "_")}.json`
}

// Telling whether a process is still the one we started.
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// When a process started (clock ticks since boot, from /proc/<pid>/stat; or
// ps's start time where there's no /proc, as on macOS, in one locale and
// zone whoever asks), or undefined if
// neither says. A pid plus its start time names one process, even after the
// pid is reused.
export function startedAt(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return f[0] === "Z" || f[0] === "X" ? "dead" : f[19]; // a zombie has exited
  } catch {}
  if (existsSync("/proc/self")) return undefined; // /proc is there, so the pid isn't
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: {...process.env, LC_ALL: "C", TZ: "UTC"}}).trim().replace(/\s+/g, "_") || undefined;
  } catch {
    return undefined;
  }
}

// Installs goog's agent skill (skill/SKILL.md) for the coding agents on this
// machine. With it, an agent asked to edit a doc knows the pull/edit/push
// steps and the format up front instead of reading `goog help` first.
//
// The skill is a symlink to this package's skill/ directory, so it updates
// along with goog.

import {existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync} from "node:fs";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const SOURCE = fileURLToPath(new URL("../skill", import.meta.url));

// Skill directories of the agents that are set up here (their config dir exists).
function agentDirs(): {agent: string; dir: string}[] {
  const home = process.env.GOOG_AGENT_HOME || homedir();
  return [
    {agent: "Claude Code", root: join(home, ".claude")},
    {agent: "Codex", root: join(home, ".codex")},
  ]
    .filter((a) => existsSync(a.root))
    .map((a) => ({agent: a.agent, dir: join(a.root, "skills", "goog")}));
}

export type SkillState = "installed" | "missing" | "other"; // other: a goog skill goog didn't put there

function stateOf(dir: string): SkillState {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() && resolve(join(dir, ".."), readlinkSync(dir)) === SOURCE) return "installed";
    return "other";
  } catch {
    return "missing";
  }
}

export function skillStatus(): {agent: string; dir: string; state: SkillState}[] {
  return agentDirs().map((a) => ({...a, state: stateOf(a.dir)}));
}

// True when some agent here could use the skill but doesn't have one.
export function skillMissing(): boolean {
  return skillStatus().some((s) => s.state === "missing");
}

export function installSkill(force = false): {agent: string; dir: string; state: SkillState; done: boolean}[] {
  return skillStatus().map((s) => {
    if (s.state === "installed" || (s.state === "other" && !force)) return {...s, done: false};
    rmSync(s.dir, {recursive: true, force: true});
    mkdirSync(join(s.dir, ".."), {recursive: true});
    symlinkSync(SOURCE, s.dir);
    return {...s, state: "installed", done: true};
  });
}

export function removeSkill(): {agent: string; dir: string; done: boolean}[] {
  return skillStatus().map((s) => {
    if (s.state !== "installed") return {...s, done: false};
    rmSync(s.dir);
    return {...s, done: true};
  });
}

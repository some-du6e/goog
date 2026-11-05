// goog's agent skill (skill/SKILL.md) is installed with Vercel's skills CLI
// (`npx skills add some-du6e/goog`), which copies it from GitHub into each
// agent's skill directory. With it, an agent asked to edit a doc knows the
// pull/edit/push steps and the format up front instead of reading `goog help`
// first. goog only checks whether it's there, to hint at it.

import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";

export const SKILL_INSTALL = "npx skills add some-du6e/goog -g -y";

// True when a coding agent is set up here (its config dir exists) but no goog
// skill is where agents look: their own skills/ or the shared ~/.agents/skills
// the skills CLI installs to.
export function skillMissing(): boolean {
  const home = process.env.GOOG_AGENT_HOME || homedir();
  const agents = [".claude", ".codex"].map((d) => join(home, d)).filter((d) => existsSync(d));
  if (!agents.length) return false;
  return ![...agents, join(home, ".agents")].some((d) => existsSync(join(d, "skills", "goog", "SKILL.md")));
}

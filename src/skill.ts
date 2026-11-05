// goog's agent skill (skill/SKILL.md) is installed with Vercel's skills CLI
// (`npx skills add some-du6e/goog`), which copies it from GitHub into each
// agent's skill directory. With it, an agent asked to edit a doc knows the
// pull/edit/push steps and the format up front instead of reading `goog help`
// first. goog only checks whether it's there, to hint at it.

import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";

// Without -a, -y only picks the agent running it and the "universal" ones
// (Codex, not Claude Code).
export const SKILL_INSTALL = "npx skills add some-du6e/goog -g -a claude-code -a codex -y";

// True when a coding agent is set up here (its config dir exists) but has no
// goog skill where it looks: Claude Code only reads its own skills/, Codex
// also reads the shared ~/.agents/skills the skills CLI installs to.
export function skillMissing(): boolean {
  const home = process.env.GOOG_AGENT_HOME || homedir();
  const has = (...dirs: string[]) => dirs.some((d) => existsSync(join(home, d, "skills", "goog", "SKILL.md")));
  return (existsSync(join(home, ".claude")) && !has(".claude"))
    || (existsSync(join(home, ".codex")) && !has(".codex", ".agents"));
}

import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {basename, dirname, join} from "node:path";

const xdg = (env: string, fallback: string) => process.env[env] || join(homedir(), fallback);

// GOOG_CONFIG_DIR / GOOG_CACHE_DIR override the locations (tests use them).
export const CONFIG_DIR = process.env.GOOG_CONFIG_DIR || join(xdg("XDG_CONFIG_HOME", ".config"), "goog");
export const CACHE_DIR = process.env.GOOG_CACHE_DIR || join(xdg("XDG_CACHE_HOME", ".cache"), "goog");

export interface Config {
  chrome?: {
    endpoint?: string; // CDP endpoint of a signed-in Chrome
    launch?: string[]; // command that starts it when it isn't running
  };
  broker?: string; // Apps Script web app URL that hands out OAuth tokens
  client?: {client_id: string; client_secret: string};
  pollSeconds?: number;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

let tmpSeq = 0;

// Writes via a temp file and rename, so readers never see half a file and two
// writers never interleave.
export function writeAtomic(path: string, data: string, mode?: number) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : {mode});
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, {force: true});
    throw e;
  }
}

// Secrets live here, so keep every file private to the user.
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeAtomic(path, JSON.stringify(value, null, 2) + "\n", 0o600);
}

export const configPath = join(CONFIG_DIR, "config.json");
export const loadConfig = (): Config => readJson<Config>(configPath, {});
export const saveConfig = (c: Config) => writeJson(configPath, c);

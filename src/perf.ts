// The extension's performance log (an option there, off unless the user turns it on): the lines it sends to /perf
// are appended to perf.log next to the config file, so that they can be read on the computer that runs the
// server (`local-mcp-bridge-server perf-log`). The file stays small: past 1 MB it becomes perf.log.1 (replacing
// the one before) and a new one begins.

import { appendFileSync, readFileSync, renameSync, statSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

export const PERF_MAX_BYTES = 1024 * 1024;
/** Bodies larger than this are refused (the extension sends a few lines every ten seconds). */
export const PERF_BODY_LIMIT = 64 * 1024;
const MAX_LINE = 2000;
const MAX_LINES = 500;

export function perfLogPath(configPath: string): string {
  return join(dirname(configPath), "perf.log");
}

/**
 * The lines of a body, with no control or direction characters (a line cannot pass for two, or move the cursor of
 * the terminal that shows the file), none longer than 2000 characters, at most 500.
 */
export function cleanLines(body: string): string[] {
  return body
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ").trimEnd().slice(0, MAX_LINE))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

/** Appends the lines; a file past `maxBytes` is moved to `<path>.1` first. Only its owner may read the file. */
export function appendPerf(path: string, lines: string[], maxBytes = PERF_MAX_BYTES): void {
  if (!lines.length) return;
  // a file that is not there yet is fine; one that cannot be moved aside is an error, or it would grow without end
  const st: Stats | undefined = statSync(path, { throwIfNoEntry: false });
  if (st && st.size > maxBytes) renameSync(path, `${path}.1`);
  appendFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** The file for `perf-log`: what is in it, or how to get something into it. */
export function showPerf(path: string): string {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // not written yet
  }
  if (text) return text;
  return `Nothing in ${path} yet. Turn on "Write the performance log" in the extension's options, and use the page in a tab where the extension is on.\n`;
}

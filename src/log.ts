// The server's log, on stdout (a service's log file gets the same lines): each request as it comes, each step of
// the work it asks for, and the reply as it goes out. A line has the time to the millisecond, a level, and the
// number of its request (#12), which all lines of that request share. WARN and ERROR say that something went wrong,
// at the moment it does.

/** Plain functions, not methods: they are passed around on their own (`quick ? log.warn : log.info`). */
export interface Logger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** "14:03:07.215", in local time. */
export function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Writes each line at once, after its time and level. */
export function consoleLogger(write: (text: string) => void = (t) => void process.stdout.write(t)): Logger {
  const at = (level: string) => (line: string) => write(`${stamp()} ${level} ${line}\n`);
  return { info: at("INFO "), warn: at("WARN "), error: at("ERROR") };
}

/** The lines of one request: each begins with its number. */
export function tagged(log: Logger, tag: string): Logger {
  return { info: (l) => log.info(`${tag} ${l}`), warn: (l) => log.warn(`${tag} ${l}`), error: (l) => log.error(`${tag} ${l}`) };
}

/** A value as JSON on one line: a string over 200 characters as its start and its length (a path stays whole), the
 * whole at most 400 characters. */
export function short(v: unknown): string {
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === "string" && x.length > 200 ? `${x.slice(0, 120)}…(${x.length} chars)` : x)) ?? String(v);
  return s.length > 400 ? `${s.slice(0, 397)}...` : s;
}

/** Text on one line with no control or direction characters (a terminal shows it as it is), at most `max` long. */
export function oneLine(s: string, max = 300): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

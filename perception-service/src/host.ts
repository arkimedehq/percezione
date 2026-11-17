import { isIP } from "node:net";

/**
 * Which names the UI answers to. A web page on the internet can make its own domain point at this machine (DNS
 * rebinding) and then talk to Percezione from the owner's browser as if it were the same site: the browser sends the
 * attacker's name in `Host`. So the UI answers only to names of the local network: an address, `localhost`, a name
 * without dots (`server`) or under a local domain (`.local`, `.lan`, `.home.arpa`…), and the names in
 * PERCEZIONE_HOSTS (e.g. a name of your own domain that points here).
 */
const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain", ".localhost", ".test"];

export function hostAllowed(host: string | undefined, extra: string[] = []): boolean {
  if (!host) return false;
  // "name:port", "[::1]:port"
  const name = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d+$/, "")).toLowerCase();
  if (!name) return false;
  if (isIP(name) || name === "localhost" || !name.includes(".")) return true;
  if (LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return extra.some((h) => h.toLowerCase() === name);
}

/**
 * A request that changes something comes from Percezione's own pages: a browser always says where a cross-site POST
 * comes from (`Origin`), and a form or a `text/plain` fetch from another site would otherwise get through without a
 * preflight (e.g. choosing the password at first start). Programs send no Origin.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === (host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

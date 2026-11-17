import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, pbkdf2Sync, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * The secrets of an installation (deploy/, docs/install.md), created on first start by the setup service and
 * kept in data/secrets/system.json (mode 600): go2rtc's login, shared by Frigate and Percezione, and the two MQTT
 * logins of the included broker. Nobody has to type them; the environment still wins when it sets them (our own
 * installation, or a broker of one's own).
 */
export interface SystemSecrets {
  go2rtc: Login;
  mqtt: { frigate: Login; percezione: Login };
}

export interface Login {
  user: string;
  password: string;
}

const secret = () => randomBytes(24).toString("base64url");
const fresh = (user: string): Login => ({ user, password: secret() });

/** Reads the file and adds what is missing (nothing is ever replaced). */
export function ensureSecrets(path: string): { secrets: SystemSecrets; created: boolean } {
  const have = readSecrets(path) ?? {};
  const secrets: SystemSecrets = {
    go2rtc: have.go2rtc ?? fresh("percezione"),
    mqtt: { frigate: have.mqtt?.frigate ?? fresh("frigate"), percezione: have.mqtt?.percezione ?? fresh("percezione") },
  };
  const created = JSON.stringify(secrets) !== JSON.stringify(have);
  if (created) writePrivate(path, JSON.stringify(secrets, null, 2) + "\n");
  return { secrets, created };
}

export function readSecrets(path: string): Partial<SystemSecrets> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Partial<SystemSecrets>;
}

/** Written whole or not at all, readable only by its owner. */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // a leftover temporary file would keep its mode: start from a new one
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * A line of Mosquitto's password file: `user:$7$iterations$salt$hash`, PBKDF2-SHA512 as mosquitto_passwd writes it
 * (Mosquitto 2.0, 101 iterations, 12-byte salt, 64-byte hash).
 */
export function mosquittoLine(user: string, password: string, salt = randomBytes(12), iterations = 101): string {
  const hash = pbkdf2Sync(password, salt, iterations, 64, "sha512");
  return `${user}:$7$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * The UI password chosen at first start, as an scrypt hash in data/secrets/ui.json. UI_PASSWORD in the environment
 * still works and wins (our own installation).
 */
export class UiPassword {
  constructor(
    private readonly path: string,
    private readonly fromEnv?: string,
  ) {}

  get isSet(): boolean {
    return !!this.fromEnv || existsSync(this.path);
  }

  /** Only the first time: afterwards it is changed by someone logged in (not yet in the UI). */
  set(password: string): void {
    if (this.isSet) throw new Error("the password is already set");
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    writePrivate(this.path, JSON.stringify({ scrypt: { salt: salt.toString("base64"), hash: hash.toString("base64") } }) + "\n");
  }

  /** Off the event loop: an scrypt takes tens of milliseconds, and the service has cameras to follow meanwhile. */
  async check(password: string): Promise<boolean> {
    if (this.fromEnv !== undefined) {
      const h = (s: string) => createHash("sha256").update(s).digest();
      return timingSafeEqual(h(password), h(this.fromEnv));
    }
    if (!existsSync(this.path)) return false;
    const stored = (JSON.parse(readFileSync(this.path, "utf8")) as { scrypt: { salt: string; hash: string } }).scrypt;
    const want = Buffer.from(stored.hash, "base64");
    const got = (await promisify(scrypt)(password, Buffer.from(stored.salt, "base64"), want.length)) as Buffer;
    return timingSafeEqual(got, want);
  }
}

export interface Endpoint {
  host: string;
  port: number;
}

export function parseAddrList(addr: string, defaultPort: number): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  for (const raw of addr.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    let host: string;
    let port: number;

    if (entry[0] === "[") {
      const close = entry.indexOf("]");
      if (close < 0) throw new Error(`missing closing ']' in IPv6 addr entry: ${entry}`);
      host = entry.slice(1, close);
      if (close === entry.length - 1) {
        port = defaultPort;
      } else if (entry[close + 1] !== ":") {
        throw new Error(`expected ':' after ']' in IPv6 addr entry: ${entry}`);
      } else {
        port = parsePort(entry.slice(close + 2), entry);
      }
    } else if (entry.indexOf(":") !== entry.lastIndexOf(":")) {
      // Unbracketed multi-colon: bare IPv6, default port. A custom port needs brackets.
      host = entry;
      port = defaultPort;
    } else {
      const colon = entry.indexOf(":");
      if (colon < 0) {
        host = entry;
        port = defaultPort;
      } else {
        host = entry.slice(0, colon).trim();
        port = parsePort(entry.slice(colon + 1), entry);
      }
    }

    if (!host) throw new Error(`empty host in addr entry: ${entry}`);
    const key = `${port}/${host}`;
    if (seen.has(key)) throw new Error(`duplicate addr entry: ${entry}`);
    seen.add(key);
    out.push({ host, port });
  }
  if (out.length === 0) throw new Error("addr is missing");
  return out;
}

function parsePort(s: string, entry: string): number {
  const p = Number.parseInt(s, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`invalid port in addr entry: ${entry}`);
  }
  return p;
}

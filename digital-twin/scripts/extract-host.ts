/**
 * Host-app extractors added in Stage 2: channels, routes, component nodes,
 * §9 gotchas, broadcast emitters. Imported by extract.ts and twin tests.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

export interface ChannelEntry {
  template: string;
  kind: "postgres_changes" | "broadcast";
  helper: string | null;
  sources: string[];
}

export interface RouteEntry {
  file: string;
  route: string;
  kind: "page" | "route" | "layout";
  audience: "organizer" | "player" | "public" | "dev";
}

export interface ComponentNode {
  file: string;
  kind: "component" | "hook" | "action";
  exported: string[];
}

export interface BroadcastEntry {
  event: string;
  payloadType: string;
  emitter: string;
  types?: string[];
}

export interface GotchaEntry {
  id: string;
  number: number | null;
  title: string;
  body: string;
  severity: "critical" | "warn" | "info";
  category: string;
  link?: string;
}

export interface SidecarRow {
  id: string;
  severity: "critical" | "warn" | "info";
  category: string;
  link?: string;
  title?: string;
  body?: string;
}

export interface SidecarFile {
  extras?: SidecarRow[];
  [n: string]: SidecarRow | SidecarRow[] | undefined;
}

export function walkFiles(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...walkFiles(full, pred));
    } else if (pred(name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Strip Next.js route groups `(full)` and collapse slashes. */
export function resolveAppRoute(relFromApp: string): string {
  const noFile = relFromApp.replace(/(?:^|\/)(page|route|layout)\.(tsx|ts|jsx|js)$/, "");
  const stripped = noFile
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/");
  const route = "/" + stripped.replace(/^\/+|\/+$/g, "");
  return route === "/" ? "/" : route.replace(/\/+/g, "/");
}

export function classifyRoute(route: string): RouteEntry["audience"] {
  if (
    route.startsWith("/sandbox") ||
    route.startsWith("/vip-preview") ||
    route === "/wrapped/preview"
  ) {
    return "dev";
  }
  if (route.includes("/organizer")) return "organizer";
  if (
    route.includes("/play") ||
    route.includes("/wrapped") ||
    route.includes("/tv") ||
    route.startsWith("/j/") ||
    route === "/j"
  ) {
    return "player";
  }
  return "public";
}

export function extractRoutes(appDir: string, hostRoot: string): RouteEntry[] {
  const files = walkFiles(appDir, (n) => /^(page|route|layout)\.(tsx|ts)$/.test(n));
  return files.map((file) => {
    const relApp = relative(appDir, file).split("\\").join("/");
    const kind: RouteEntry["kind"] = file.endsWith("layout.tsx")
      ? "layout"
      : file.includes("/route.ts")
        ? "route"
        : "page";
    const route = resolveAppRoute(relApp);
    return {
      file: relative(hostRoot, file).split("\\").join("/"),
      route,
      kind,
      audience: classifyRoute(route),
    };
  });
}

function kindFromPath(rel: string): ComponentNode["kind"] {
  if (rel.startsWith("src/hooks/")) return "hook";
  if (rel.startsWith("src/app/actions/")) return "action";
  return "component";
}

function exportedNames(src: string): string[] {
  const names = new Set<string>();
  const re = /export\s+(?:async\s+)?(?:function|const|class|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) names.add(m[1]);
  return [...names].sort();
}

export function extractComponents(
  hostRoot: string,
  dirs: { components: string; hooks: string; actions: string }
): ComponentNode[] {
  const files = [
    ...walkFiles(dirs.components, (n) => /\.(tsx|ts)$/.test(n) && !n.endsWith(".d.ts")),
    ...walkFiles(dirs.hooks, (n) => /\.(tsx|ts)$/.test(n) && !n.endsWith(".d.ts")),
    ...walkFiles(dirs.actions, (n) => /\.(tsx|ts)$/.test(n) && !n.endsWith(".d.ts")),
  ];
  return files.map((file) => {
    const rel = relative(hostRoot, file).split("\\").join("/");
    let src = "";
    try {
      src = readFileSync(file, "utf8");
    } catch {
      src = "";
    }
    return { file: rel, kind: kindFromPath(rel), exported: exportedNames(src) };
  });
}

function addChannel(
  map: Map<string, ChannelEntry>,
  template: string,
  kind: ChannelEntry["kind"],
  helper: string | null,
  source: string
): void {
  const existing = map.get(template);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (!existing.helper && helper) existing.helper = helper;
    return;
  }
  map.set(template, { template, kind, helper, sources: [source] });
}

/** Normalise a template literal to `{sessionId}` placeholders. */
export function normalizeChannelTemplate(raw: string): string {
  return raw
    .replace(/\$\{sessionId\}/g, "{sessionId}")
    .replace(/\$\{table\}/g, "{table}")
    .replace(/\$\{channelPrefix\}/g, "{prefix}");
}

export function extractChannels(hostRoot: string): ChannelEntry[] {
  const map = new Map<string, ChannelEntry>();
  const realtime = resolve(hostRoot, "src/lib/realtime.ts");
  const realtimeSrc = readFileSync(realtime, "utf8");
  const relRealtime = "src/lib/realtime.ts";

  const helperRe = /export function (subscribeTo\w+)\([\s\S]*?\{([\s\S]*?)\n\}/g;
  let hm: RegExpExecArray | null;
  while ((hm = helperRe.exec(realtimeSrc))) {
    const helper = hm[1];
    const body = hm[2];
    const kind: ChannelEntry["kind"] = body.includes('"broadcast"')
      ? "broadcast"
      : "postgres_changes";
    const tplMatch = body.match(/`([^`]+)`/) ?? body.match(/channelName\s*=\s*`([^`]+)`/);
    if (tplMatch) {
      addChannel(map, normalizeChannelTemplate(tplMatch[1]), kind, helper, relRealtime);
    }
  }

  // subscribeToTable default: `${table}:{sessionId}`
  addChannel(map, "{table}:{sessionId}", "postgres_changes", "subscribeToTable", relRealtime);
  addChannel(
    map,
    "{prefix}:{table}:{sessionId}",
    "postgres_changes",
    "subscribeToTable",
    relRealtime
  );

  const scanDirs = [
    resolve(hostRoot, "src/hooks"),
    resolve(hostRoot, "src/components"),
    resolve(hostRoot, "src/app"),
  ];
  for (const dir of scanDirs) {
    for (const file of walkFiles(dir, (n) => /\.(tsx|ts)$/.test(n))) {
      const rel = relative(hostRoot, file).split("\\").join("/");
      const src = readFileSync(file, "utf8");
      const chRe = /\.channel\(\s*[`'"]([^`'"]+)[`'"]/g;
      let cm: RegExpExecArray | null;
      while ((cm = chRe.exec(src))) {
        const tpl = normalizeChannelTemplate(cm[1]);
        const kind: ChannelEntry["kind"] = tpl.startsWith("session-events")
          ? "broadcast"
          : "postgres_changes";
        addChannel(map, tpl, kind, null, rel);
      }
      const prefixRe = /subscribeTo\w+\([\s\S]*?,\s*["'`]([^"'`]+)["'`]\s*[,)]/g;
      let pm: RegExpExecArray | null;
      while ((pm = prefixRe.exec(src))) {
        const prefix = pm[1];
        if (prefix.length > 40) continue;
        addChannel(map, `${prefix}:{table}:{sessionId}`, "postgres_changes", null, rel);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.template.localeCompare(b.template));
}

export function extractBroadcasts(path: string): BroadcastEntry[] {
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: BroadcastEntry[] = [];
  const re =
    /export async function (broadcast\w+)\([\s\S]*?postBroadcast\([^,]+,\s*["'`](\w+)["'`]/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(src))) {
    const emitter = m[1];
    const event = m[2];
    if (seen.has(event)) continue;
    seen.add(event);
    const payloadType =
      event
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("") + "Payload";
    const named = src.match(
      new RegExp(`export interface (\\w*${event.replace(/_/g, "")}\\w*Payload)`, "i")
    );
    const iface = src.match(
      new RegExp(
        `export interface (\\w+Payload)\\s*\\{[\\s\\S]*?\\}\\s*\\nexport async function ${emitter}`
      )
    );
    out.push({
      event,
      payloadType: iface?.[1] ?? named?.[1] ?? payloadType,
      emitter,
    });
  }

  const unionMatch = src.match(/OrganizerInterventionType\s*=\s*([\s\S]*?);/);
  if (unionMatch) {
    const members = [...unionMatch[1].matchAll(/["'`](\w+)["'`]/g)].map((x) => x[1]);
    const oi = out.find((b) => b.event === "organizer_intervention");
    if (oi) oi.types = members;
  }

  const payloadIfaces = [...src.matchAll(/export interface (\w+Payload)/g)].map((x) => x[1]);
  for (const b of out) {
    const guess = payloadIfaces.find(
      (p) => p.toLowerCase().replace(/payload$/, "") === b.event.split("_").join("").toLowerCase()
    );
    if (guess) b.payloadType = guess;
  }
  return out;
}

export function parseSection9(md: string): { n: number; title: string; body: string }[] {
  const start = md.search(/^## 9\. Known Gotchas\s*$/m);
  if (start < 0) throw new Error("[extract] APP_MANIFEST.md has no '## 9. Known Gotchas' heading");
  const rest = md.slice(start);
  const end = rest.search(/^## 10\./m);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const items: { n: number; title: string; body: string }[] = [];
  const re = /^(\d+)\.\s+/gm;
  const matches = [...section.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const n = Number(cur[1]);
    const chunkStart = (cur.index ?? 0) + cur[0].length;
    const chunkEnd =
      i + 1 < matches.length ? (matches[i + 1].index ?? section.length) : section.length;
    const chunk = section.slice(chunkStart, chunkEnd).trim();
    const dash = chunk.search(/\s[—–-]\s/);
    const head = dash >= 0 ? chunk.slice(0, dash) : chunk;
    const body =
      dash >= 0
        ? chunk
            .slice(dash)
            .replace(/^\s[—–-]\s/, "")
            .trim()
        : "";
    const title = head.replace(/\*\*/g, "").trim();
    items.push({ n, title, body });
  }
  return items;
}

export function extractGotchas(manifestPath: string, sidecarPath: string): GotchaEntry[] {
  const md = readFileSync(manifestPath, "utf8");
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as SidecarFile;
  const items = parseSection9(md);
  const out: GotchaEntry[] = [];
  for (const item of items) {
    const row = sidecar[String(item.n)];
    if (!row || Array.isArray(row)) {
      throw new Error(
        `[extract] §9 item ${item.n} has no sidecar row in digital-twin/src/data/gotcha-sidecar.json`
      );
    }
    out.push({
      id: row.id,
      number: item.n,
      title: item.title,
      body: item.body,
      severity: row.severity,
      category: row.category,
      ...(row.link ? { link: row.link } : {}),
    });
  }
  for (const extra of sidecar.extras ?? []) {
    out.push({
      id: extra.id,
      number: null,
      title: extra.title ?? extra.id,
      body: extra.body ?? "",
      severity: extra.severity,
      category: extra.category,
      ...(extra.link ? { link: extra.link } : {}),
    });
  }
  return out;
}

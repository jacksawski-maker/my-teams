const SITE = "https://jacksawski-maker.github.io";
const SCHEDULE = SITE + "/my-teams/schedule.json";
const NAME = { DEN: "Broncos", COL: "Avalanche", MIA: "Inter Miami", BAR: "Barcelona", LFC: "Liverpool" };
const CORS = { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };

const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function keys(env) {
  const saved = await env.SUBS.get("vapid");
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const o = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), priv: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await env.SUBS.put("vapid", JSON.stringify(o));
  return o;
}

async function token(aud, k) {
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const body = enc({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: SITE + "/my-teams" });
  const key = await crypto.subtle.importKey("jwk", k.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64u(sig);
}

async function notifyAll(env, title, body) {
  await env.SUBS.put("msg", JSON.stringify({ title, body, t: Date.now() }));
  const subs = JSON.parse((await env.SUBS.get("subs")) || "[]");
  if (!subs.length) return 0;
  const k = await keys(env);
  const keep = [];
  for (const s of subs) {
    try {
      const t = await token(new URL(s.endpoint).origin, k);
      const r = await fetch(s.endpoint, { method: "POST", headers: { Authorization: "vapid t=" + t + ", k=" + k.pub, TTL: "86400", Urgency: "high" } });
      if (r.status !== 404 && r.status !== 410) keep.push(s);
    } catch (e) { keep.push(s); }
  }
  await env.SUBS.put("subs", JSON.stringify(keep));
  return keep.length;
}

const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const day = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
function label(g) {
  const t = NAME[g[0]], o = g[3], home = g[2] === 1;
  if (g[0] === "DEN" || g[0] === "COL") return home ? o + " @ " + t : t + " @ " + o;
  return home ? t + " vs " + o : o + " vs " + t;
}
const keyOf = (g) => g[0] + "|" + g[3] + "|" + g[5];
const timeText = (g) => (g[6] ? day(g[1]) + ", time not set" : when(g[1]));

export async function run(env, now = Date.now()) {
  const r = await fetch(SCHEDULE + "?t=" + now);
  if (!r.ok) return;
  const games = (await r.json()).games || [];
  if (!games.length) return;
  const lines = [];

  const prevRaw = await env.SUBS.get("sched");
  if (prevRaw) {
    const prev = JSON.parse(prevRaw), pm = {}, nm = {};
    prev.forEach((g) => (pm[keyOf(g)] = g));
    games.forEach((g) => (nm[keyOf(g)] = g));
    for (const g of games) {
      if (new Date(g[1]).getTime() < now) continue;
      const o = pm[keyOf(g)];
      if (!o) lines.push("New game: " + label(g) + ", " + timeText(g));
      else if (o[1] !== g[1] || o[6] !== g[6] || o[2] !== g[2]) lines.push("Updated: " + label(g) + ", " + timeText(g));
    }
    for (const o of prev) {
      if (!nm[keyOf(o)] && new Date(o[1]).getTime() > now) lines.push("Removed: " + label(o));
    }
  }
  await env.SUBS.put("sched", JSON.stringify(games));

  const sent = JSON.parse((await env.SUBS.get("sent")) || "{}");
  for (const g of games) {
    if (g[6]) continue;
    const ko = new Date(g[1]).getTime(), id = keyOf(g) + "|" + g[1];
    if (ko > now && ko - now <= 24 * 3600e3 && !sent[id]) {
      sent[id] = now;
      lines.push("Game tomorrow: " + label(g) + ", " + when(g[1]));
    }
  }
  for (const k of Object.keys(sent)) if (now - sent[k] > 4 * 86400e3) delete sent[k];
  await env.SUBS.put("sent", JSON.stringify(sent));

  if (lines.length) {
    const title = lines.length === 1 ? "My Teams" : "My Teams (" + lines.length + ")";
    await notifyAll(env, title, lines.join("\n"));
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
    if (u.pathname === "/key") return json({ pub: (await keys(env)).pub });
    if (u.pathname === "/latest") return json(JSON.parse((await env.SUBS.get("msg")) || "{}"));
    if (u.pathname === "/subscribe" && req.method === "POST") {
      const s = JSON.parse(await req.text());
      if (!s || !s.endpoint) return json({ ok: false }, 400);
      const subs = JSON.parse((await env.SUBS.get("subs")) || "[]").filter((x) => x.endpoint !== s.endpoint);
      subs.push(s);
      await env.SUBS.put("subs", JSON.stringify(subs.slice(-10)));
      return json({ ok: true });
    }
    if (u.pathname === "/unsubscribe" && req.method === "POST") {
      const s = JSON.parse(await req.text());
      const subs = JSON.parse((await env.SUBS.get("subs")) || "[]").filter((x) => x.endpoint !== s.endpoint);
      await env.SUBS.put("subs", JSON.stringify(subs));
      return json({ ok: true });
    }
    if (u.pathname === "/test") {
      const n = await notifyAll(env, "My Teams", "Notifications are working.");
      return json({ sentTo: n });
    }
    return json({ app: "my-teams-push" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

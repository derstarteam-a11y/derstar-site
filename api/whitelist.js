// Arbitrum whitelist endpoint.
// POST { address }  -> adds the address (lowercased, deduplicated)
// GET  ?token=ADMIN_TOKEN -> CSV of all addresses (address,joined_at)
// Storage: Upstash Redis REST (Vercel Marketplace sets KV_REST_API_URL / KV_REST_API_TOKEN).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SET = "whitelist:arb";
const TS = "whitelist:arb:joined";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const MAX_PER_IP_PER_HOUR = 10;

async function redis(cmds) {
  const r = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).map((x) => x.result);
}

export default async function handler(req, res) {
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "Whitelist storage is not configured." });

  if (req.method === "GET") {
    if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    const [rows] = await redis([["HGETALL", TS]]);
    let csv = "address,joined_at\n";
    for (let i = 0; i < rows.length; i += 2) csv += `${rows[i]},${rows[i + 1]}\n`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="whitelist-arbitrum.csv"');
    return res.status(200).send(csv);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (process.env.WHITELIST_OPEN !== "1") return res.status(403).json({ error: "The whitelist opens soon." });

  const address = String((req.body && req.body.address) || "").trim();
  if (!ADDR.test(address)) return res.status(400).json({ error: "That is not a valid address. It should start with 0x and have 40 hex characters." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const [hits] = await redis([["INCR", `rl:wl:${ip}`], ["EXPIRE", `rl:wl:${ip}`, 3600, "NX"]]);
  if (hits > MAX_PER_IP_PER_HOUR) return res.status(429).json({ error: "Too many attempts. Try again later." });

  const a = address.toLowerCase();
  const [added, , count] = await redis([["SADD", SET, a], ["HSETNX", TS, a, new Date().toISOString()], ["SCARD", SET]]);
  return res.status(200).json({ ok: true, already: added === 0, count });
}

/**
 * vet-api — вычислительный API для вето-проектов (Cloudflare Workers).
 *
 * Архитектура: GitHub Pages = фронт (доставка), CF = чистые вычисления,
 * GitHub Actions = мост (крон → fetch к этому API → коммит JSON в репо).
 * РФ-посетители не достигают workers.dev — поэтому весь клиентский код
 * обязан иметь fallback на закоммиченный JSON.
 *
 * Эндпоинты:
 *   GET  /v1/health                 — живость (+ проверка KV)
 *   GET  /v1/meteo/slice            — live-срез станций (METAR + Open-Meteo → THI/BRD + 48ч)
 *   GET  /v1/meteo/latest           — KV-зеркало последнего среза → иначе live
 *   POST /v1/heatmap/merge     🔒   — merge+dedupe+upsert (порт run-all.ts [3/5]+[4/5])
 *   POST /v1/heatmap/mirror    🔒   — зеркалирование датасета в KV
 *   GET  /v1/heatmap/dataset        — KV-зеркало канонического датасета
 *   GET  /v1/heatmap/delta?since=   — дельта вспышек (для live-клиента)
 *
 * 🔒 = Authorization: Bearer $VET_API_TOKEN (секрет воркера).
 */
import { computeSlice } from "./meteo";
import { mergeHeatmap, type Outbreak, type OutbreakDataset, type SourceKey } from "./merge";
import { handleInsilico } from "./insilico";

export interface Env {
  VET_KV: KVNamespace;
  VET_API_TOKEN: string;
  /** Секрет (опционально): включает облачный AI-прокси /v1/insilico/ai/*. */
  HF_TOKEN?: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function raw(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

/** Constant-time сравнение строк (длина не утекает принципиально — hex фиксированной длины). */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authed(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  const token = env.VET_API_TOKEN ?? "";
  if (!token) return false;
  return h.startsWith("Bearer ") && timingSafeEq(h.slice(7), token);
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const t0 = Date.now();

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    /* ---------- health ---------- */
    if (req.method === "GET" && path === "/v1/health") {
      let kv = "ok";
      try {
        await env.VET_KV.get("health-probe");
      } catch (e) {
        kv = "error: " + String(e);
      }
      return json({ ok: true, service: "vet-api", kv, time: new Date().toISOString() });
    }

    /* ---------- meteo ---------- */
    if (req.method === "GET" && path === "/v1/meteo/slice") {
      const cache = (caches as unknown as { default: Cache }).default;
      const hit = await cache.match(req);
      if (hit) return hit;
      const out = await computeSlice();
      const resp = json(out, 200, {
        "cache-control": "public, max-age=60",
        "x-compute-ms": String(Date.now() - t0),
      });
      ctx.waitUntil(cache.put(req, resp.clone()));
      ctx.waitUntil(
        env.VET_KV.put("meteo:slice", JSON.stringify(out), { expirationTtl: 172800 }),
      );
      return resp;
    }

    if (req.method === "GET" && path === "/v1/meteo/latest") {
      const cached = await env.VET_KV.get("meteo:slice");
      if (cached) return raw(cached, 200, { "x-source": "kv", "cache-control": "public, max-age=60" });
      const out = await computeSlice();
      ctx.waitUntil(
        env.VET_KV.put("meteo:slice", JSON.stringify(out), { expirationTtl: 172800 }),
      );
      return json(out, 200, { "x-source": "live", "x-compute-ms": String(Date.now() - t0) });
    }

    /* ---------- heatmap ---------- */
    if (req.method === "POST" && path === "/v1/heatmap/merge") {
      if (!authed(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const body = await req.json<{ recent?: { source: SourceKey; outbreaks: Outbreak[] }[]; baseline?: OutbreakDataset | null }>().catch(() => null);
      if (!body || !Array.isArray(body.recent)) {
        return json({ ok: false, error: "body.recent[] required" }, 400);
      }
      const baselineOutbreaks = Array.isArray(body.baseline?.outbreaks) ? body.baseline!.outbreaks : null;
      const dataset = mergeHeatmap(body.recent, baselineOutbreaks);
      const hash = await sha256(JSON.stringify(dataset.outbreaks));
      const computeMs = Date.now() - t0;
      ctx.waitUntil(
        env.VET_KV.put("hm:latest", JSON.stringify(dataset), { expirationTtl: 2592000 }),
      );
      // hm:meta — компактный срез для /v1/insilico/status (без парсинга 2.7MB датасета)
      ctx.waitUntil(
        env.VET_KV.put("hm:meta", JSON.stringify({ total: dataset.total_outbreaks, updated: dataset.updated }), { expirationTtl: 2592000 }),
      );
      return json({ ok: true, dataset, hash, computeMs }, 200, { "x-compute-ms": String(computeMs) });
    }

    if (req.method === "POST" && path === "/v1/heatmap/mirror") {
      if (!authed(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const body = await req.json<{ dataset?: OutbreakDataset }>().catch(() => null);
      if (!body?.dataset || !Array.isArray(body.dataset.outbreaks)) {
        return json({ ok: false, error: "dataset.outbreaks[] required" }, 400);
      }
      ctx.waitUntil(
        env.VET_KV.put("hm:latest", JSON.stringify(body.dataset), { expirationTtl: 2592000 }),
      );
      ctx.waitUntil(
        env.VET_KV.put("hm:meta", JSON.stringify({ total: body.dataset.total_outbreaks ?? body.dataset.outbreaks.length, updated: body.dataset.updated }), { expirationTtl: 2592000 }),
      );
      return json({ ok: true, mirrored: true, total: body.dataset.outbreaks.length });
    }

    /* ---------- insilico (полу-динамика VetInSilico Hub) ---------- */
    const ins = await handleInsilico(req, env, url, t0, ctx);
    if (ins) return ins;

    if (req.method === "GET" && path === "/v1/heatmap/dataset") {
      const d = await env.VET_KV.get("hm:latest");
      if (!d) return json({ ok: false, error: "not seeded" }, 404);
      return raw(d, 200, { "x-source": "kv", "cache-control": "public, max-age=300" });
    }

    if (req.method === "GET" && path === "/v1/heatmap/delta") {
      const since = url.searchParams.get("since") ?? "";
      const d = await env.VET_KV.get("hm:latest");
      if (!d) return json({ ok: false, error: "not seeded" }, 404);
      const ds = JSON.parse(d) as OutbreakDataset;
      const items = since
        ? ds.outbreaks.filter((o) => (o.last_seen ?? o.date) > since)
        : ds.outbreaks;
      return json(
        { ok: true, generatedAt: ds.updated, count: items.length, outbreaks: items.slice(0, 500) },
        200,
        { "cache-control": "public, max-age=120" },
      );
    }

    return json(
      {
        ok: false,
        error: "not found",
        hint: "/v1/health, /v1/meteo/{slice,latest}, /v1/heatmap/{merge,mirror,dataset,delta}, /v1/insilico/{status,outbreaks,share,share/:id,ai/chat,ai/esm}",
      },
      404,
    );
  },
} satisfies ExportedHandler<Env>;

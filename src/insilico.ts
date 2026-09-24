/**
 * vet-api — insilico-модуль: полу-динамика для VetInSilico Hub (github.io/static).
 *
 * Эндпоинты:
 *   GET  /v1/insilico/status            — диагностика (kv, ai, outbreaks seeded)
 *   GET  /v1/insilico/outbreaks         — фильтр живого heatmap-датасета (KV hm:latest)
 *       ?q=&disease=&species=&since=&limit=
 *   POST /v1/insilico/share             — сохранить сценарий расчёта → короткий id
 *   GET  /v1/insilico/share/:id         — прочитать сценарий
 *   POST /v1/insilico/ai/chat           — LLM: канал 1 Workers AI (эдж, без токенов) → канал 2 HF router
 *   POST /v1/insilico/ai/esm            — ESM-2 fill-mask прокси (HF router, секрет HF_TOKEN)
 *
 * Принципы:
 *   - Чтение — публично (CORS *), запись/ML — с лимитами по IP (KV-счётчики).
 *   - AI: канал 1 — Workers AI (эдж-биндинг, бесплатно, без токенов), канал 2 — HF
 *     router (секрет HF_TOKEN; единственный путь для ESM-2). Нет ни одного →
 *     честный 501, фронт сам падает в фолбэк (свой токен → детерминированные алгоритмы).
 *   - Ответы ML кешируются в KV (24ч) — экономия кредитов upstream.
 *   - share: payload ≤ 24KB, TTL 90 дней, 10 записей/день/IP.
 */
import type { OutbreakDataset } from "./merge";

export interface InsilicoEnv {
  VET_KV: KVNamespace;
  /** Workers AI (эдж-биндинг [ai] в wrangler.toml): LLM без внешних токенов. */
  AI?: unknown;
  /** Опциональный секрет: HF-фолбэк (нужен прежде всего для ESM-2 — у эджа протеиновой LM нет). */
  HF_TOKEN?: string;
}

/* ---------- helpers ---------- */

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

/** Ответ из уже-сериализованного JSON (например, значения из KV без повторного парсинга). */
function rawJson(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Crockford base32 (без гласных/путающихся символов) — 8 символов ≈ 40 бит энтропии. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function shareId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += B32[b % 32];
  return id;
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anon";
}

/** Best-effort счётчик запросов в KV: ключ rl:<domain>:<YYYYMMDD>:<ip> → n. */
async function rateLimit(env: InsilicoEnv, domain: string, req: Request, max: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const key = `rl:${domain}:${day}:${clientIp(req)}`;
  const cur = parseInt((await env.VET_KV.get(key)) ?? "0", 10);
  if (Number.isNaN(cur) || cur < 0) return false;
  if (cur >= max) return false;
  // TTL: 2 суток — счётчики сами себя подчищают.
  await env.VET_KV.put(key, String(cur + 1), { expirationTtl: 172800 });
  return true;
}

/** Эдж-LLM на Workers AI: free tier ~10k neurons/день, ноль внешних токенов. */
const WA_LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** HF-фолбэк (и путь для ESM-2). */
const LLM_MODEL = "Qwen/Qwen2.5-Coder-3B-Instruct";
const ESM_MODEL_DEFAULT = "facebook/esm2_t12_35M_UR50D";
const AI_DAILY_LIMIT = 40;
const SHARE_DAILY_LIMIT = 10;
const SHARE_MAX_BYTES = 24_000;
const SHARE_TTL = 90 * 24 * 3600;
const AI_CACHE_TTL = 24 * 3600;

/* ---------- main router ---------- */

export async function handleInsilico(
  req: Request,
  env: InsilicoEnv,
  url: URL,
  t0: number,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/v1/insilico")) return null;
  const sub = path.slice("/v1/insilico".length) || "/";

  /* ----- status ----- */
  if (req.method === "GET" && sub === "/status") {
    let kv = "ok";
    try {
      await env.VET_KV.get("health-probe");
    } catch (e) {
      kv = "error";
    }
    let outbreaks: number | null = null;
    let updated: string | null = null;
    try {
      const meta = await env.VET_KV.get<unknown>("hm:meta", "json");
      if (meta && typeof meta === "object") {
        outbreaks = (meta as { total?: number }).total ?? null;
        updated = (meta as { updated?: string }).updated ?? null;
      }
    } catch {}
    return json({
      ok: true,
      service: "vet-api/insilico",
      kv,
      ai: Boolean(env.AI) || Boolean(env.HF_TOKEN),
      aiBackend: env.AI ? "workers-ai" : env.HF_TOKEN ? "hf" : "off",
      aiModel: env.AI ? WA_LLM_MODEL : LLM_MODEL,
      outbreaks,
      outbreaksUpdated: updated,
      ms: Date.now() - t0,
    });
  }

  /* ----- live outbreaks (фильтр hm:latest) ----- */
  if (req.method === "GET" && sub === "/outbreaks") {
    const raw = await env.VET_KV.get("hm:latest");
    if (!raw) return json({ ok: false, error: "not seeded" }, 404);
    const ds = JSON.parse(raw) as OutbreakDataset;
    const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
    const disease = (url.searchParams.get("disease") ?? "").toLowerCase().trim();
    const species = (url.searchParams.get("species") ?? "").toLowerCase().trim();
    const since = url.searchParams.get("since") ?? "";
    let limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 25;
    limit = Math.min(limit, 200);

    const match = (s: unknown, needle: string) =>
      needle !== "" && String(s ?? "").toLowerCase().includes(needle);

    const items = ds.outbreaks.filter((o) => {
      if (
        q &&
        !match(o.disease, q) &&
        !match(o.region, q) &&
        !match(o.region_geo, q) &&
        !match(o.species, q) &&
        !match(o.disease_key, q)
      )
        return false;
      if (disease && !match(o.disease, disease) && !match(o.disease_key, disease)) return false;
      if (species && !match(o.species, species)) return false;
      if (since && (o.last_seen ?? o.date) < since) return false;
      return true;
    });
    // Свежие сверху (по last_seen/date, затем по cases как тай-брейк).
    items.sort(
      (a, b) =>
        (b.last_seen ?? b.date).localeCompare(a.last_seen ?? a.date) ||
        (b.cases ?? 0) - (a.cases ?? 0),
    );

    return json(
      {
        ok: true,
        updated: ds.updated,
        totalInDataset: ds.total_outbreaks,
        matched: items.length,
        shown: Math.min(limit, items.length),
        outbreaks: items.slice(0, limit),
      },
      200,
      { "cache-control": "public, max-age=300" },
    );
  }

  /* ----- share: сохранить сценарий ----- */
  if (req.method === "POST" && sub === "/share") {
    if (!(await rateLimit(env, "share", req, SHARE_DAILY_LIMIT))) {
      return json({ ok: false, error: "rate limit exceeded (10/day)" }, 429);
    }
    const body = await req
      .json<{ app?: string; title?: string; payload?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.app !== "string" || body.app.length > 32) {
      return json({ ok: false, error: "body.app required (string ≤32)" }, 400);
    }
    if (body.payload === undefined || body.payload === null) {
      return json({ ok: false, error: "body.payload required" }, 400);
    }
    const payloadStr = JSON.stringify(body.payload);
    if (payloadStr.length > SHARE_MAX_BYTES) {
      return json({ ok: false, error: `payload too large (${payloadStr.length} > ${SHARE_MAX_BYTES})` }, 413);
    }
    const id = shareId();
    const record = {
      app: body.app,
      title: typeof body.title === "string" ? body.title.slice(0, 140) : "",
      payload: body.payload,
      created: new Date().toISOString(),
      v: 1,
    };
    await env.VET_KV.put(`share:${id}`, JSON.stringify(record), { expirationTtl: SHARE_TTL });
    return json({ ok: true, id, bytes: payloadStr.length, expiresInDays: 90 }, 200);
  }

  /* ----- share: прочитать сценарий /share/<id> ----- */
  if (req.method === "GET" && sub.startsWith("/share/")) {
    const id = sub.slice("/share/".length).toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!/^[0-9A-Z]{6,12}$/.test(id)) return json({ ok: false, error: "bad id" }, 400);
    const raw = await env.VET_KV.get(`share:${id}`);
    if (!raw) return json({ ok: false, error: "not found (или истёк 90-дневный TTL)" }, 404);
    return rawJson(raw, 200, { "cache-control": "public, max-age=60" });
  }

  /* ----- AI: LLM chat / ESM прокси ----- */
  if (req.method === "POST" && sub === "/ai/chat") {
    return handleAi(req, env, ctx, t0, "chat");
  }
  if (req.method === "POST" && sub === "/ai/esm") {
    return handleAi(req, env, ctx, t0, "esm");
  }

  return null; // не наш путь — отдаём наверх (404 корневого роутера)
}

/* ---------- AI: канал 1 Workers AI (эдж) → канал 2 HF router → честный отказ ---------- */

/** Вызов эдж-LLM (Workers AI). env.AI к моменту вызова уже проверен. */
async function waChat(
  env: InsilicoEnv,
  messages: { role: string; content: string }[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const ai = env.AI as unknown as {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  const out = (await ai.run(WA_LLM_MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature,
  })) as { response?: unknown };
  const text = typeof out?.response === "string" ? out.response.trim() : "";
  if (!text) throw new Error("пустой ответ модели");
  return text;
}

async function handleAi(
  req: Request,
  env: InsilicoEnv,
  ctx: ExecutionContext,
  t0: number,
  kind: "chat" | "esm",
): Promise<Response> {
  if (!(await rateLimit(env, `ai-${kind}`, req, AI_DAILY_LIMIT))) {
    return json({ ok: false, error: `rate limit exceeded (${AI_DAILY_LIMIT}/day)` }, 429);
  }

  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "json body required" }, 400);

  // Кеш: успешные ответы живут 24ч. Ключ — hash(kind + канонического тела).
  const cacheKey = `ai:${kind}:${await sha256(JSON.stringify(body))}`;
  const cached = await env.VET_KV.get(cacheKey);
  if (cached) {
    return json({ ...JSON.parse(cached), cached: true, ms: Date.now() - t0 }, 200, {
      "cache-control": "public, max-age=300",
    });
  }

  /* ----- канал 1: Workers AI (эдж) — только chat, бесплатно и без токенов ----- */
  if (kind === "chat" && env.AI) {
    const b = body as { messages?: unknown; maxTokens?: number; temperature?: number };
    if (Array.isArray(b.messages) && b.messages.length > 0) {
      try {
        const content = await waChat(
          env,
          b.messages as { role: string; content: string }[],
          clampNum(b.maxTokens, 1, 1024, 512),
          clampNum(b.temperature, 0, 2, 0.3),
        );
        const out = { ok: true, kind, content, backend: "workers-ai" };
        ctx.waitUntil(env.VET_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: AI_CACHE_TTL }));
        return json({ ...out, cached: false, ms: Date.now() - t0 }, 200);
      } catch (e) {
        if (!env.HF_TOKEN) {
          // эдж упал, HF-фолбэка нет — честная ошибка (фронт уйдёт в свой токен/эвристики)
          return json(
            { ok: false, backend: "workers-ai", error: `edge AI failed: ${String(e).slice(0, 140)}` },
            502,
          );
        }
        // HF_TOKEN задан — падаем в канал 2 ниже
      }
    }
  }

  if (!env.HF_TOKEN) {
    return json(
      {
        ok: false,
        enabled: false,
        error:
          kind === "chat"
            ? "cloud AI отключён (нет AI-биндинга и HF_TOKEN)"
            : "ESM-2 в облаке требует HF_TOKEN (на эдже нет протеиновой LM)",
        hint: "в режиме «Авто» фронт сам уйдёт в свой HF-токен или локальные эвристики",
      },
      501,
    );
  }

  let upstreamUrl: string;
  let upstreamBody: string;
  if (kind === "chat") {
    const b = body as { messages?: unknown; maxTokens?: number; temperature?: number };
    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      return json({ ok: false, error: "messages[] required" }, 400);
    }
    upstreamUrl = "https://router.huggingface.co/v1/chat/completions";
    upstreamBody = JSON.stringify({
      model: LLM_MODEL,
      messages: b.messages,
      max_tokens: clampNum(b.maxTokens, 1, 1024, 512),
      temperature: clampNum(b.temperature, 0, 2, 0.3),
    });
  } else {
    const b = body as { inputs?: unknown; model?: string };
    if (typeof b.inputs !== "string" || b.inputs.length === 0 || b.inputs.length > 4000) {
      return json({ ok: false, error: "inputs (string ≤4000) required" }, 400);
    }
    const model = /^[\w./-]{3,80}$/.test(b.model ?? "") ? b.model! : ESM_MODEL_DEFAULT;
    upstreamUrl = `https://router.huggingface.co/hf-inference/models/${model}`;
    upstreamBody = JSON.stringify({ inputs: b.inputs });
  }

  let res: Response;
  try {
    res = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HF_TOKEN}`,
        "Content-Type": "application/json",
        ...(kind === "chat" ? { "X-Provider": "nscale" } : {}),
      },
      body: upstreamBody,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return json({ ok: false, error: `upstream unreachable: ${String(e).slice(0, 120)}` }, 502);
  }

  const text = await res.text();
  if (!res.ok) {
    return json(
      { ok: false, upstream: res.status, error: text.slice(0, 300) },
      res.status === 429 ? 429 : 502,
    );
  }

  let out: Record<string, unknown>;
  if (kind === "chat") {
    let content = "";
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
    } catch {}
    if (!content) return json({ ok: false, upstream: res.status, error: "пустой ответ от LLM" }, 502);
    out = { ok: true, kind, content };
  } else {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ ok: false, upstream: res.status, error: "non-json upstream" }, 502);
    }
    out = { ok: true, kind, data };
  }

  ctx.waitUntil(env.VET_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: AI_CACHE_TTL }));
  return json({ ...out, cached: false, ms: Date.now() - t0 }, 200);
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Supabase Edge Function — релей-зеркало vet-api (обход РКН-блокировки
 * *.workers.dev в РФ, без VPN). Денo-вариант (../deno-proxy.ts) мёртв —
 * deno.dev тоже под блокировкой, а *.supabase.co на момент 2026-09 жив.
 *
 * Развёртывание: см. mirror/README.md → «Способ 2-бис».
 * URL функции: https://<project-ref>.supabase.co/functions/v1/vet-api/<path>
 *
 * ВАЖНО: деплоить с --no-verify-jwt (или выключить verify_jwt в дашборде),
 * иначе анонимные запросы фронта получат 401.
 */

const UPSTREAM = "https://vet-api.shray77.workers.dev";
// Релей-секрет = wrangler.toml [vars] RELAY_SECRET (public by design):
// воркер доверяет X-Forwarded-For только с этим заголовком — иначе все
// клиенты зеркала делят один rate-limit 40/день.
const RELAY_SECRET = "973d1b2057ea78b04768f4132abd1d05";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Supabase отдаёт функцию на /functions/v1/vet-api/<path>; CLI/будущие
  // версии гейтвея могут отдавать без префикса — срезаем любой сегмент.
  // ⚠️ НЕ вставляйте сюда deno-proxy.ts: его guard рассчитан на путь без
  // префикса и под Supabase всегда отвечает 404 "only /v1/* is proxied".
  const path = url.pathname.replace(/^\/functions\/v1\/[^/]+/, "") || "/";

  // Проксируем только публичный API — никаких чужих путей
  if (!path.startsWith("/v1/")) {
    return Response.json(
      { ok: false, error: "only /v1/* is proxied" },
      { status: 404, headers: CORS },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "anon";

  const fwd = new Headers();
  for (const h of ["content-type", "authorization", "accept"]) {
    const v = req.headers.get(h);
    if (v) fwd.set(h, v);
  }
  fwd.set("x-forwarded-for", ip);
  fwd.set("x-vetapi-relay", RELAY_SECRET);

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}${path}${url.search}`, {
      method: req.method,
      headers: fwd,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: `upstream unreachable: ${String(e).slice(0, 120)}` },
      { status: 502, headers: CORS },
    );
  }

  // CORS выставляем здесь; штатные CORS-заголовки воркера перезаписываем
  // (дубликаты Access-Control-Allow-Origin браузер не примет).
  const headers = new Headers();
  headers.set(
    "content-type",
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  );
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

  return new Response(upstream.body, { status: upstream.status, headers });
});

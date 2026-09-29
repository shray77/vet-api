/**
 * Зеркало vet-api для сетей, где *.workers.dev блокируется (РКН в РФ).
 *
 * Деплой за 5 минут (бесплатно, 1 млн запросов/мес):
 *   1. Открыть https://dash.deno.com → войти через GitHub.
 *   2. «New Playground» → вставить содержимое этого файла → Deploy.
 *   3. Имя ассет-а = ваш URL зеркала, например vet-api-mirror.deno.dev.
 *   4. Проверка: https://<имя>.deno.dev/v1/health → {"ok":true,...}
 *   5. Прислать URL → он добавляется в CLOUD_MIRRORS (src/lib/cloud.ts vet-insilico).
 *
 * Альтернатива без зеркала: бесплатный домен (например, dpdns.org) как зона
 * Cloudflare → воркер получает кастомный домен → РКН не при делах. См. README.md.
 */

const UPSTREAM = "https://vet-api.shray77.workers.dev";

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

  // Проксируем только публичный API — никаких чужих путей
  if (!url.pathname.startsWith("/v1/")) {
    return Response.json(
      { ok: false, error: "only /v1/* is proxied" },
      { status: 404, headers: CORS },
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": req.headers.get("content-type") ?? "application/json",
  };
  const auth = req.headers.get("authorization");
  if (auth) headers["Authorization"] = auth;

  try {
    const r = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "POST" ? await req.text() : undefined,
    });
    return new Response(r.body, {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": r.headers.get("cache-control") ?? "no-store",
        ...CORS,
      },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: `mirror upstream failed: ${String(e).slice(0, 120)}` },
      { status: 502, headers: CORS },
    );
  }
});

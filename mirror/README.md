# Зеркало vet-api — обход блокировки workers.dev (РФ, без VPN)

РКН блокирует `*.workers.dev` целиком. Сам воркер жив, но браузеры из РФ до него
не достучиваются. Три бесплатных способа починить, по возрастанию правильности:

## Способ 1 — публичный безключевой LLM (уже работает, ничего делать не надо)

Фронт (vet-insilico `src/lib/hf.ts`) сам падает на `text.pollinations.ai`, если
облако недоступно. Чат-AI работает в РФ без VPN и без токенов. Ограничения:
best-effort, только chat (ESM-2 нет), лимиты частоты публичного сервиса.

## Способ 2 — зеркало на Deno Deploy (5 минут, бесплатно)

1. https://dash.deno.com → Sign in with GitHub.
2. **New Playground** → вставить содержимое `deno-proxy.ts` → **Deploy**.
3. Имя, которое вы дали деплою, = URL зеркала: `https://<имя>.deno.dev`.
4. Проверка: `curl https://<имя>.deno.dev/v1/health` → `{"ok":true,...}`.
5. URL вписывается в `CLOUD_MIRRORS` в `src/lib/cloud.ts` репо vet-insilico
   (одна строка) — фронт начнёт пробовать зеркало сам, если workers.dev мёртв.

Free tier Deno Deploy: 1 млн запросов/мес — с запасом. Крон-воркфлоу зеркала не
нужен: проксируется всё, включая share и AI (лимиты и кеш считает сам vet-api).

## Способ 3 — бесплатный домен → кастомный домен воркера (правильный навсегда)

РКН блокирует домен `workers.dev`, а не Cloudflare целиком. Любой свой домен
в Cloudflare снимает вопрос полностью (и сайт, и API, и без зеркал):

1. Зарегистрировать бесплатный домен, например `ваше-имя.dpdns.org`
   (DigitalPlat, https://domain.digitalplat.org — регистрация через GitHub, 0₽).
   Альтернативы: `eu.org` (одобрение неделями), любой платный `.ru/.com` (~200-800₽/год).
2. Добавить домен как зону в Cloudflare (Free plan) → CF выдаст 2 NS-сервера.
3. Вписать NS у регистратора домена.
4. Cloudflare → Workers & Pages → `vet-api` → Settings → **Domains & Routes**
   → Add → Custom Domain → `api.ваше-имя.dpdns.org`.
5. Проверка: `curl https://api.ваше-имя.dpdns.org/v1/health`.
6. В `src/lib/cloud.ts` vet-insilico заменить `DEFAULT_CLOUD_URL` на новый
   (или добавить в `CLOUD_MIRRORS` — тогда workers.dev останется первым каналом).
7. Опционально: тот же домен на GitHub Pages (`Pages` → Custom domain) — сайт
   перестанет зависеть от доступности github.io.

После способа 3 фолбэки (зеркала, снимки, публичный LLM) остаются как страховка —
они не мешают, просто молчат.

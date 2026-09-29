# Зеркало vet-api — обход блокировки workers.dev (РФ, без VPN)

РКН блокирует `*.workers.dev` целиком. Сам воркер жив, но браузеры из РФ до него
не достучиваются. Актуальный статус каналов (2026-09):

| Канал | Статус в РФ |
|---|---|
| workers.dev, pages.dev, deno.dev, vercel.app, netlify.app | заблокированы |
| github.io (фронт), huggingface.co (веса/токен), text.pollinations.ai | работают |
| HF Docker/Gradio Spaces | требуют PRO ($9/мес) — больше не вариант |
| HF Static Spaces | бесплатны, но без вычислений — релей не сделать |

**ESM-2 в РФ больше не требует зеркала**: он выполняется целиком в браузере
(transformers.js, int8-веса ~34 МБ с huggingface.co, см. `src/lib/esm-browser.ts`
репо vet-insilico). Зеркало нужно только для Workers AI-чата, облачной
статистики и шаринга — всё это уже имеет фолбэки.

## Способ 1 — публичный безключевой LLM + браузерный ESM-2 (уже работает, ничего делать не надо)

Фронт сам падает на `text.pollinations.ai` (chat) и на браузерный ESM-2
(transformers.js), если облако недоступно. В РФ без VPN и без токенов работает
всё, кроме облачной статистики и облачных share-ссылок (у шаринга есть
автономный фолбэк через `#j=` фрагмент URL).

## Способ 2 — ~~Deno Deploy~~ (МЁРТВ)

`deno.dev` заблокирован РКН (проверено пользователем, 2026-09). Исходник
остался в `deno-proxy.ts` как референс — логика 1:1 переиспользована в
supabase-варианте ниже.

## Способ 2-бис — зеркало на Supabase Edge Functions (10 минут, бесплатно)

1. **Сначала проверь из РФ без VPN**: открой https://supabase.com — если не
   грузится, способ не твой.
2. supabase.com → Sign in with GitHub → **New project** (free tier, регион
   ближе — Europe). Запиши `<project-ref>` из URL проекта.
3. Dashboard → **Edge Functions** → Create a new function → имя `vet-api` →
   вставить содержимое `mirror/supabase/functions/vet-api/index.ts` (⚠️ именно
   его, НЕ `deno-proxy.ts` — денo-вариант под Supabase всегда отвечает
   404 "only /v1/* is proxied") → Deploy.
   У функции выключи **Verify JWT** (или деплой через CLI:
   `supabase functions deploy vet-api --no-verify-jwt`).
4. Проверка: `curl https://<project-ref>.supabase.co/functions/v1/vet-api/v1/health`
   → `{"ok":true,...}`.
5. Подключение к фронту — БЕЗ передеплоя сайта: на странице сайта открыть
   консоль браузера и выполнить
   `localStorage.setItem("vet:api_url", "https://<project-ref>.supabase.co/functions/v1/vet-api")`
   и перезагрузить страницу (сброс: `localStorage.removeItem("vet:api_url")`).
   Либо добавить URL в `CLOUD_MIRRORS` в `src/lib/cloud.ts` репо vet-insilico.
6. Keep-alive: free-проект Supabase паузится после недели неактивности —
   достаточно раз в неделю открыть сайт (или пинговать URL кроном).

Free tier: 500K вызовов/мес — с запасом. Лимиты и кеш считает сам vet-api:
зеркало передаёт реальный IP клиента в `X-Forwarded-For` и подписывает его
`x-vetapi-relay` (= `RELAY_SECRET` в `wrangler.toml`, public by design) —
40/день считаются по настоящему IP, а не по адресу зеркала.

## Способ 3 — бесплатный домен → кастомный домен воркера (правильный навсегда)

РКН блокирует домен `workers.dev`, а не Cloudflare целиком. Любой свой домен
в Cloudflare снимает вопрос полностью (и сайт, и API, и без зеркал):

1. Зарегистрировать бесплатный домен, например `ваше-имя.dpdns.org`
   (DigitalPlat, https://domain.digitalplat.org — регистрация email+пароль, 0₽,
   свои NS-серверы поддерживаются). Альтернативы: `eu.org` (одобрение
   неделями), любой платный `.ru/.com` (~200-800₽/год).
   ⚠️ `us.kg` заблокирован РКН ещё в 2024-м — не использовать; за
   `dpdns.org`/`qzz.io` ручаться нельзя (зоны бывают под нож целиком) —
   сначала проверь из РФ, открывается ли любой сайт на выбранной зоне.
2. Добавить домен как зону в Cloudflare (Free plan) → CF выдаст 2 NS-сервера.
3. Вписать NS у регистратора домена.
4. Cloudflare → Workers & Pages → `vet-api` → Settings → **Domains & Routes**
   → Add → Custom Domain → `api.ваше-имя.dpdns.org`.
5. Проверка: `curl https://api.ваше-имя.dpdns.org/v1/health`.
6. В `src/lib/cloud.ts` vet-insilico заменить `DEFAULT_CLOUD_URL` на новый
   (или добавить в `CLOUD_MIRRORS` — тогда workers.dev останется первым каналом).
7. Опционально: тот же домен на GitHub Pages (`Pages` → Custom domain) — сайт
   перестанет зависеть от доступности github.io.

После способа 3 фолбэки (зеркала, снимки, публичный LLM, браузерный ESM-2)
остаются как страховка — они не мешают, просто молчат.

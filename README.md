# vet-api

Вычислительный API для вето-проектов на Cloudflare Workers.

**Архитектура:** GitHub Pages = фронт/доставка (работает в РФ), Cloudflare = чистые
вычисления (Workers + KV), GitHub Actions = мост (крон → fetch к этому API →
валидация → коммит JSON в репо → пересборка Pages).

`*.workers.dev` заблокирован ТСПУ в РФ — клиентский код сайтов обязан иметь
fallback на закоммиченный JSON; GitHub Actions раннеры достигают workers.dev.

## Эндпоинты

| Метод | Путь | Auth | Что делает |
|---|---|---|---|
| GET | `/v1/health` | — | живость + KV-проба |
| GET | `/v1/meteo/slice` | — | live-срез 49 станций: METAR + Open-Meteo → THI/THIadj/THImax7/BRD + 48ч прогноз (порт `vet-meteo/tools/fetch_stations.mjs`), кэш 60с, зеркало в KV |
| GET | `/v1/meteo/latest` | — | KV-зеркало среза → иначе live-вычисление |
| POST | `/v1/heatmap/merge` | Bearer | merge+dedupe+upsert вспышек (порт `vet-heatmap/scripts/scrape/merge.ts` + шаг [4/5] run-all.ts), результат в KV |
| POST | `/v1/heatmap/mirror` | Bearer | зеркалирование датасета в KV |
| GET | `/v1/heatmap/dataset` | — | KV-зеркало канонического датасета |
| GET | `/v1/heatmap/delta?since=ISO` | — | дельта вспышек новее `since` (live-клиенты) |

POST-эндпоинты требуют `Authorization: Bearer $VET_API_TOKEN`
(секрет воркера, генерируется `openssl rand -hex 32`).

## Деплой

Автоматический: push в `main` → `deploy.yml` (wrangler-action) → smoke-test `/v1/health`.

Ручной: `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bunx wrangler deploy`

Секреты GitHub-репо: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Порты и паритет

`src/merge.ts` и `src/meteo.ts` — порты 1-в-1 из vet-heatmap / vet-meteo.
Любые изменения алгоритмов в тех репо требуют синхронного порта сюда,
иначе Actions-шаг `::warning::`-детектор дрейфа начнёт ругаться.

/**
 * Порт вычислительного ядра tools/fetch_stations.mjs из vet-meteo — семантика 1-в-1.
 * METAR (NOAA) + Open-Meteo (чанки ≤25, ретраи) → THI/THIadj (Mader 2006)/THImax7/BRD-лайт
 * + часовой прогноз 48 ч из тех же ответов Open-Meteo. Ветер — строго м/с.
 */
import STATIONS from "./stations.json";

interface Station { id: string; name: string; lat: number; lon: number; alt?: number }
interface MetarRef { icao: string; name: string; lat: number; lon: number }

const thi = (t: number, rh: number) => {
  const f = 1.8 * t + 32;
  return f - (0.55 - 0.0055 * rh) * (1.8 * t - 26);
};

/** THIadj (Mader et al. 2006): ветер обезветривает, радиация догружает. */
const thiMader = (t: number, rh: number, wind: number, swr: number) =>
  4.51 + thi(t, rh) - 1.992 * Math.max(0, wind) + 0.0068 * Math.max(0, swr || 0);

function rhFromTd(t: number, td: number) {
  const es = 6.112 * Math.exp((17.67 * t) / (t + 243.5));
  const e = 6.112 * Math.exp((17.67 * td) / (td + 243.5));
  return Math.max(1, Math.min(100, (e / es) * 100));
}

/** BRD-лайт (скрининг) */
function brdLite(d: any) {
  const amp = d.tMax - d.tMin;
  let s = 0;
  if (amp > 14) s += 25; else if (amp > 10) s += 14;
  if (d.rhMean > 78) s += 22; else if (d.rhMean > 70) s += 12;
  if (d.precipSum > 3) s += 18; else if (d.precipSum > 1) s += 9;
  if (d.windMean < 2.5) s += 15;
  if (d.tempDrop < -5) s += 20; else if (d.tempDrop < -3) s += 10;
  return Math.min(100, s);
}

async function fetchJson(url: string, ms = 25000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function fetchJsonRetry(url: string, ms = 30000, tries = 3) {
  let err: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetchJson(url, ms);
    } catch (e) {
      err = e;
      if (i < tries) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw err;
}

/* ---------- 1. METAR ---------- */
async function fetchMetar() {
  const ids = STATIONS.metar.map((m: MetarRef) => m.icao).join(",");
  try {
    const j = await fetchJson(
      `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&hours=1`,
    );
    const byIcao = new Map();
    for (const m of Array.isArray(j) ? j : []) {
      const temp = m.temp ?? null;
      const dewp = m.dewp ?? null;
      byIcao.set(m.icaoId, {
        icao: m.icaoId,
        t: temp,
        rh: temp != null && dewp != null ? Math.round(rhFromTd(temp, dewp)) : null,
        wdir: m.wdir ?? null,
        wspd: m.wspd != null ? Math.round(m.wspd * 0.514) : null, // kt → м/с
        raw: m.raw ?? "",
      });
    }
    return STATIONS.metar.map((m: MetarRef) => byIcao.get(m.icao) ?? { ...m, t: null, rh: null, wdir: null, wspd: null, raw: "нет данных" });
  } catch (e: any) {
    console.error("METAR недоступен:", e?.message);
    return STATIONS.metar.map((m: MetarRef) => ({ ...m, t: null, rh: null, wdir: null, wspd: null, raw: "ошибка сети" }));
  }
}

/* ---------- 2. Open-Meteo (чанками по 25, с ретраями) ---------- */
const OM_FIELDS: Record<string, string> = {
  current: "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation",
  hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,shortwave_radiation",
  daily: "temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,wind_speed_10m_mean,precipitation_sum",
  timezone: "Europe/Moscow",
  forecast_days: "7",
  // КРИТИЧНО: без этого Open-Meteo отдаёт ветер в км/ч — юнит-баг был закрыт 07.09.2026.
  windspeed_unit: "ms",
};

async function fetchOpenMeteo() {
  const all = [];
  const CH = 25;
  const stations: Station[] = STATIONS.stations;
  for (let i = 0; i < stations.length; i += CH) {
    const chunk = stations.slice(i, i + CH);
    const params = new URLSearchParams({
      ...OM_FIELDS,
      latitude: chunk.map((s) => s.lat).join(","),
      longitude: chunk.map((s) => s.lon).join(","),
    });
    const part = await fetchJsonRetry(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      45000,
      3,
    );
    all.push(...(Array.isArray(part) ? part : [part]));
  }
  return all;
}

export interface SliceResult {
  generatedAt: string;
  region: string;
  stations: any[];
  metar: any[];
  forecast?: { generatedAt: string; h0: string; hours: number; stations: any[] } | null;
}

export async function computeSlice(): Promise<SliceResult> {
  const now = new Date();
  const generatedAt = now.toISOString();

  const [metar, om] = await Promise.all([fetchMetar(), fetchOpenMeteo().catch(() => null)]);

  const stations: any[] = [];
  const fcSt: any[] = []; // часовой прогноз 48 ч — из тех же ответов Open-Meteo
  let fcH0: string | null = null;

  if (Array.isArray(om) && om.length === STATIONS.stations.length) {
    STATIONS.stations.forEach((st: Station, i: number) => {
      const w = om[i];
      const cur = w.current ?? {};
      const t = cur.temperature_2m ?? 0;
      const rh = cur.relative_humidity_2m ?? 60;
      const wind = cur.wind_speed_10m ?? 0;
      const wdir = cur.wind_direction_10m ?? null;
      // солнечная радиация текущего часа (ночь → 0/отсутствует)
      const hTimes: string[] = w.hourly?.time ?? [];
      // текущий час в МСК: cur.time или (фолбэк) сгенерированный момент +3 ч
      const curHour = cur.time
        ? String(cur.time).slice(0, 13) + ":00"
        : new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 13) + ":00";
      let hIdx = hTimes.indexOf(curHour);
      if (hIdx < 0 && hTimes.length) hIdx = hTimes.findIndex((tt) => tt >= curHour);
      const swr = hIdx >= 0 ? (w.hourly?.shortwave_radiation?.[hIdx] ?? 0) : 0;
      const thiAdj = thiMader(t, rh, wind, swr);
      const precip24 = (w.hourly?.precipitation ?? []).slice(0, 24).reduce((a: number, b: number) => a + (b ?? 0), 0);
      const daily = w.daily ?? {};
      let thiMax7 = -999;
      let tMaxPrev: number | null = null;
      let brd = 0;
      const days: string[] = daily.time ?? [];
      for (let d = 0; d < days.length; d++) {
        const tMax = daily.temperature_2m_max?.[d] ?? 0;
        const tMin = daily.temperature_2m_min?.[d] ?? 0;
        const rhM = daily.relative_humidity_2m_mean?.[d] ?? 60;
        thiMax7 = Math.max(thiMax7, thi(tMax, Math.max(30, rhM - 12)));
        if (d === 0) {
          const drop = tMaxPrev == null ? 0 : tMax - tMaxPrev;
          brd = brdLite({ tMax, tMin, rhMean: rhM, precipSum: daily.precipitation_sum?.[d] ?? 0, windMean: daily.wind_speed_10m_mean?.[d] ?? 3, tempDrop: drop });
        }
        tMaxPrev = tMax;
      }
      const row = {
        id: st.id,
        name: st.name,
        lat: st.lat,
        lon: st.lon,
        t: +t.toFixed(1),
        rh: Math.round(rh),
        wind: +wind.toFixed(1),
        wdir,
        precip24: +precip24.toFixed(1),
        thi: +thi(t, rh).toFixed(1),
        thiAdj: +thiAdj.toFixed(1),
        thiMaxToday: +(thi(daily.temperature_2m_max?.[0] ?? t, Math.max(30, (daily.relative_humidity_2m_mean?.[0] ?? 60) - 12))).toFixed(1),
        thiMax7: +thiMax7.toFixed(1),
        brd,
        source: "open-meteo",
      };
      stations.push(row);

      /* часовой прогноз 48 ч — из ЭТОГО ЖЕ ответа Open-Meteo (без доп. запросов) */
      if (hIdx >= 0) {
        const FH = 48;
        const rec: any = { id: st.id, name: st.name, thi: [], adj: [], t: [], rh: [], wind: [], wd: [], pr: [] };
        for (let k = 0; k < FH && hIdx + k < hTimes.length; k++) {
          const t2 = w.hourly?.temperature_2m?.[hIdx + k];
          const rh2 = w.hourly?.relative_humidity_2m?.[hIdx + k];
          if (t2 == null || rh2 == null) break; // горизонт кончился — обрезаем
          const wind2 = w.hourly?.wind_speed_10m?.[hIdx + k] ?? 0;
          rec.t.push(+t2.toFixed(1));
          rec.rh.push(Math.round(rh2));
          rec.wind.push(+wind2.toFixed(1));
          rec.wd.push(w.hourly?.wind_direction_10m?.[hIdx + k] ?? null);
          rec.pr.push(+(w.hourly?.precipitation?.[hIdx + k] ?? 0).toFixed(1));
          rec.thi.push(+thi(t2, rh2).toFixed(1));
          rec.adj.push(+thiMader(t2, rh2, wind2, w.hourly?.shortwave_radiation?.[hIdx + k] ?? 0).toFixed(1));
        }
        if (rec.thi.length) {
          fcSt.push(rec);
          if (!fcH0) fcH0 = hTimes[hIdx];
        }
      }
    });
  } else {
    console.error("Open-Meteo недоступен, срез будет пустым по метео (METAR остаётся)");
  }

  const out: SliceResult = { generatedAt, region: STATIONS.region, stations, metar };
  if (fcSt.length) {
    out.forecast = { generatedAt, h0: fcH0!, hours: fcSt[0].thi.length, stations: fcSt };
  }
  return out;
}

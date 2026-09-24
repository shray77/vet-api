/**
 * Порт scripts/scrape/merge.ts из vet-heatmap — семантика 1-в-1.
 * Merge + dedupe outbreak records from multiple sources.
 *
 * Strategy:
 *   1. Collect all Outbreak[] arrays from sources (fsvps, wahis, efsa, curated).
 *   2. Deduplicate by composite key: `${disease_key}|${region_geo or region}|${date_bucket}`
 *      where date_bucket floors the date to a 7-day window.
 *   3. Cross-source dedup: country-level vs specific-region (same disease, ≤14 days).
 *   4. On conflict: source priority fsvps > wahis > efsa > curated,
 *      max(cases/deaths), Ongoing wins, more specific region wins.
 *   5. Reassign sequential IDs.
 */

export type SourceKey = "fsvps" | "wahis" | "efsa" | "telegram" | "curated";

export interface Outbreak {
  id: number;
  disease_key: string;
  disease: string;
  disease_group: string;
  region: string;
  region_geo: string;
  date: string;
  last_seen?: string;
  species: string;
  cases: number;
  deaths: number;
  status: string;
  source_url?: string;
  source: SourceKey;
  lat?: number | null;
  lon?: number | null;
  notes?: string;
  municipality?: string;
  settlements?: string[];
  [k: string]: unknown;
}

export interface OutbreakDataset {
  updated: string;
  sources: SourceKey[];
  total_outbreaks: number;
  outbreaks: Outbreak[];
}

const SOURCE_PRIORITY: Record<string, number> = {
  fsvps: 4,   // most authoritative for RF, real-time
  wahis: 3,   // WOAH official
  efsa: 2,    // EU perspective (cross-border)
  curated: 1, // fallback
};

/** Floor a date to the start of its 7-day bucket (epoch days / 7). */
function dateBucket(isoDate: string): string {
  const d = new Date(isoDate);
  const epochDays = Math.floor(d.getTime() / (1000 * 60 * 60 * 24));
  const bucketStart = Math.floor(epochDays / 7) * 7;
  return String(bucketStart);
}

/** Check if a region is country-level (no specific region). */
function isCountryLevel(o: Outbreak): boolean {
  const r = (o.region_geo || o.region).toLowerCase().trim();
  return r === "" || r === "russia" || r === "russian federation" || r === "россия" || r === "рф";
}

/** Get the effective region key for dedup. */
export function dedupeKey(o: Outbreak): string {
  const region = isCountryLevel(o) ? "__country__" : (o.region_geo || o.region);
  return `${o.disease_key}|${region}|${dateBucket(o.date)}`;
}

/** Merge two outbreak records that share a dedupe key. */
function mergePair(a: Outbreak, b: Outbreak): Outbreak {
  const winner = SOURCE_PRIORITY[a.source] >= SOURCE_PRIORITY[b.source] ? a : b;

  // Prefer the more specific region (non-country-level)
  const regionFromA = !isCountryLevel(a);
  const regionFromB = !isCountryLevel(b);
  const regionSource = regionFromA ? a : (regionFromB ? b : winner);

  return {
    ...winner,
    // Take region from the more specific source
    region: regionSource.region,
    region_geo: regionSource.region_geo,
    // Take the maximums — different sources report partial data
    cases: Math.max(a.cases, b.cases),
    deaths: Math.max(a.deaths, b.deaths),
    // Prefer known geo coords
    lat: a.lat ?? b.lat,
    lon: a.lon ?? b.lon,
    // Ongoing beats Resolved (more recent info)
    status: a.status === "Ongoing" || b.status === "Ongoing" ? "Ongoing" : winner.status,
    // Combine notes
    notes: [a.notes, b.notes].filter(Boolean).join(" | ") || winner.notes,
    // Take the most recent date if sources disagree
    date: a.date > b.date ? a.date : b.date,
    // Municipality/settlements from FSVPS (if available)
    municipality: (a as any).municipality ?? (b as any).municipality,
    settlements: (a as any).settlements ?? (b as any).settlements,
  };
}

export function mergeOutbreaks(allSources: { source: SourceKey; outbreaks: Outbreak[] }[]): Outbreak[] {
  const all: Outbreak[] = allSources.flatMap((s) => s.outbreaks);

  // Phase 1: Group by exact dedupe key
  const grouped: Map<string, Outbreak[]> = new Map();
  for (const o of all) {
    const key = dedupeKey(o);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(o);
  }

  // Merge each exact group
  const merged: Outbreak[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
    } else {
      merged.push(group.reduce((acc, o) => mergePair(acc, o)));
    }
  }

  // Phase 2: Cross-source dedup — match country-level events with specific-region events
  const countryLevel: Outbreak[] = [];
  const regionLevel: Outbreak[] = [];

  for (const o of merged) {
    if (isCountryLevel(o)) {
      countryLevel.push(o);
    } else {
      regionLevel.push(o);
    }
  }

  const finalOutbreaks: Outbreak[] = [...regionLevel];
  let dedupedCountryCount = 0;

  for (const country of countryLevel) {
    let foundMatch = false;
    for (const region of regionLevel) {
      if (country.disease_key !== region.disease_key) continue;
      // Check date proximity (within 14 days — WAHIS notifications can be delayed)
      const countryDate = new Date(country.date);
      const regionDate = new Date(region.date);
      const diffDays = Math.abs((countryDate.getTime() - regionDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays <= 14) {
        // Match found — merge country-level data into region-level
        foundMatch = true;
        dedupedCountryCount++;
        // If country-level has more cases, update the region-level
        if (country.cases > region.cases) region.cases = country.cases;
        if (country.deaths > region.deaths) region.deaths = country.deaths;
        // Add source_url if region doesn't have one
        if (!region.source_url && country.source_url) {
          region.source_url = country.source_url;
        }
        break;
      }
    }
    if (!foundMatch) {
      finalOutbreaks.push(country);
    }
  }

  if (dedupedCountryCount > 0) {
    console.log(`[merge] Cross-source dedup: ${dedupedCountryCount} country-level events merged into region-level`);
  }

  // Sort by date ascending, then reassign IDs
  finalOutbreaks.sort((a, b) => a.date.localeCompare(b.date));
  finalOutbreaks.forEach((o, i) => {
    o.id = i + 1;
  });

  return finalOutbreaks;
}

export function buildDataset(
  merged: Outbreak[],
  contributingSources: SourceKey[],
): OutbreakDataset {
  return {
    updated: new Date().toISOString().slice(0, 10),
    sources: contributingSources,
    total_outbreaks: merged.length,
    outbreaks: merged,
  };
}

/**
 * Порт шага [4/5] из run-all.ts: инкрементальный upsert в baseline.
 * Бренд-new "Resolved" не изобретаем — только Ongoing→Resolved по факту закрытия.
 */
export function upsertIntoBaseline(baseline: Outbreak[], recentMerged: Outbreak[]): Outbreak[] {
  const map = new Map<string, Outbreak>();
  for (const o of baseline) map.set(dedupeKey(o), o);
  for (const o of recentMerged) {
    const key = dedupeKey(o);
    const existing = map.get(key);
    if (!existing && o.status === "Resolved") continue;
    map.set(key, o);
  }
  const finalOutbreaks = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  finalOutbreaks.forEach((o, i) => {
    o.id = i + 1;
  });
  return finalOutbreaks;
}

/** Полный CF-merge: recent-источники → dedupe → upsert в baseline → dataset. */
export function mergeHeatmap(
  recent: { source: SourceKey; outbreaks: Outbreak[] }[],
  baseline: Outbreak[] | null,
): OutbreakDataset {
  const cleanRecent = (recent ?? []).filter((r) => r && Array.isArray(r.outbreaks));
  const recentMerged = mergeOutbreaks(cleanRecent);
  const finalOutbreaks = upsertIntoBaseline(baseline ?? [], recentMerged);
  const contributingSources = Array.from(new Set(finalOutbreaks.map((o) => o.source))) as SourceKey[];
  return buildDataset(finalOutbreaks, contributingSources);
}

import { fetchJson, runIfMain } from '../../sdk/index.ts';
import type { FetcherContext, Item, Snapshot, Fetcher } from '../../sdk/index.ts';

export interface SundhedDkDoctorsInput {
  ids: number[];
}

type Doctor = { name: string };
type Practice = {
    id: number;
    name: string;
    openForPatients: boolean;
    doctors: Doctor[];
}

/** Our primary call-point: runs the fetcher, gathering all doctor data from sundhed.dk */
const collect: Fetcher<SundhedDkDoctorsInput, Practice> = async function({ input, log }) {
  const items: Item<Practice>[] = [];
  log("Fetching doctors", input.ids);
  let complete = true;
  for (const id of input.ids) {
    try {
      const data = await getDoctorsPracticeInfo(id, log);
      items.push({
        id: `doctorpractice__${data.id}`,
        title: data.name,
        url: `https://www.sundhed.dk/borger/guides/find-behandler/?orgId=${encodeURIComponent(data.id)}`,
        data,
      });
    } catch (err) {
      // One flaky entity must not look like "everything changed" or "it was removed".
      log(`could not fetch "${id}": ${err instanceof Error ? err.message : String(err)}`);
      complete = false;
    }
  }
  if (items.length === 0 && input.ids.length > 0) throw new Error('every entity failed to load');
  return { complete, items };
}

type PracticeApiData = {
    Identifier: number;
    Navn: string;
    AabenForTilgang: boolean;
    Personale: { Navn: string }[]
};
const isPracticeApiData = (data: unknown): data is PracticeApiData => {
    if (!(data instanceof Object)) return false;
    if (!("Identifier" in data) || !("Navn" in data) || !("AabenForTilgang" in data) || !("Personale" in data)) return false;
    if (typeof data.Identifier !== "number" || typeof data.Navn !== "string" || typeof data.AabenForTilgang !== "boolean" || !Array.isArray(data.Personale)) return false;
    if (!data.Personale.every(doctor => doctor instanceof Object && "Navn" in doctor && typeof doctor.Navn === "string")) return false;
    return true;
}

/** Fetches a single doctor's practice from sundhed.dk */
async function getDoctorsPracticeInfo(practiceId: number, log: FetcherContext<unknown>["log"]): Promise<Practice> {
    const data = await fetchJson(`https://www.sundhed.dk/app/findbehandlerv2/api/v1/findbehandlerv2/klinik/${encodeURIComponent(practiceId)}`);
    log(`Loaded practice data for ID ${practiceId} successfully`);
    if (!isPracticeApiData(data)) {
        log(`Unexpected data`, data);
        throw new Error(`Looked up practice ${practiceId}, got unexpected response`);
    }
    return {
        id: data.Identifier,
        name: data.Navn,
        openForPatients: data.AabenForTilgang,
        doctors: data.Personale.map(doctor => ({ name: doctor.Navn }))
    }
}

await runIfMain(import.meta.url, collect);

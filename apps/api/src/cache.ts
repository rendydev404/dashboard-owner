// Cache respons agregat di memori. Kunci menyertakan versi data, jadi begitu data berubah
// (sync, webhook, input manual) entri lama otomatis tidak terpakai lagi.
import { dataVersion } from "./db";

const MAX = 200, TTL = 60_000;
const store = new Map<string, { at: number; v: unknown }>();

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = dataVersion() + "|" + key;
  const hit = store.get(k);
  if (hit && Date.now() - hit.at < TTL) {
    store.delete(k); store.set(k, hit); // LRU: pindah ke belakang
    return hit.v as T;
  }
  const v = await fn();
  store.set(k, { at: Date.now(), v });
  if (store.size > MAX) store.delete(store.keys().next().value!);
  return v;
}
export const cacheSize = () => store.size;

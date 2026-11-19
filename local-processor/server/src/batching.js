export const MAX_BATCH_SIZE = 15000;
export function getBatchSizes(total, max = MAX_BATCH_SIZE) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Total WBN count must be a non-negative safe integer");
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("Batch size must be a positive safe integer");
  const sizes = [];
  for (let remaining = total; remaining > 0; remaining -= max) sizes.push(Math.min(max, remaining));
  return sizes;
}
export function splitIntoBatches(values, max = MAX_BATCH_SIZE) {
  if (!Array.isArray(values)) throw new Error("WBN values must be an array");
  return getBatchSizes(values.length, max).reduce((chunks, size) => {
    const offset = chunks.reduce((n, chunk) => n + chunk.length, 0);
    chunks.push(values.slice(offset, offset + size));
    return chunks;
  }, []);
}

/**
 * A moment as `YYYY-MM-DD HH:mm:ss`, in the machine's own zone.
 *
 * Local rather than UTC because every number this is compared against is
 * local: a deployment log, a chat message, a colleague's memory of when they
 * published. An ISO string ending in `Z` would be unambiguous and would turn
 * each of those comparisons into arithmetic.
 *
 * Assembled by hand rather than through `toLocaleString`, which gives one
 * moment a different shape on every machine -- and a column of timestamps is
 * read by scanning down it, which only works if they are all the same width.
 */
export function formatTimestamp(epochMillis: number): string {
  const at = new Date(epochMillis);
  const date = [at.getFullYear(), at.getMonth() + 1, at.getDate()].map(pad).join('-');
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map(pad).join(':');
  return `${date} ${time}`;
}

/** Four digits for the year, two for everything else -- padStart handles both. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

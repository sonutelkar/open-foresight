/** When a run started, in the reader's time zone: the time alone for today, and the day with the time otherwise. */
export function startedText(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const clock = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? clock : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock}`;
}

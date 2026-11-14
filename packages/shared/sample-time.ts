export const telemetryStaleMs = 45_000;
export function telemetryFresh(m?: { at: string; receivedAt?: string }, at = Date.now()) {
  if (!m) return false;
  const age = at - Date.parse(m.receivedAt ?? m.at);
  return Number.isFinite(age) && age >= -5000 && age <= telemetryStaleMs;
}

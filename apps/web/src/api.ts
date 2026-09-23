export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    signal,
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const result = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(result?.error || 'The request failed.');
  return result;
}
export const queryString = (values: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
export const number = (value: number) => value.toLocaleString();
export const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
export const bytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
export const navigate = (path: string) => {
  window.location.hash = `/${path}`;
};

export type FetchHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes globalThis.fetch through `handler`; `calls` records every request, `restore` puts fetch back. */
export function stubFetch(handler: FetchHandler): { calls: { url: URL; init?: RequestInit }[]; restore: () => void } {
  const previous = globalThis.fetch;
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

/** Runs `body` with fetch routed through `handler` and console.error silenced; restores both afterwards. */
export async function withFetch(handler: FetchHandler, body: () => Promise<void>): Promise<void> {
  const stub = stubFetch(handler);
  const prevErr = console.error;
  console.error = () => {};
  try {
    await body();
  } finally {
    stub.restore();
    console.error = prevErr;
  }
}

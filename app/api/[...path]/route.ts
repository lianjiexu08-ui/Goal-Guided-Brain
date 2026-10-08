export async function GET(request: Request) {
  return forward(request);
}
export async function POST(request: Request) {
  return forward(request);
}
export async function PUT(request: Request) {
  return forward(request);
}
export async function DELETE(request: Request) {
  return forward(request);
}
export async function HEAD(request: Request) {
  return forward(request);
}
async function forward(request: Request) {
  try {
    return await proxy(request);
  } catch (error) {
    if (
      request.signal.aborted &&
      (error === request.signal.reason ||
        (error instanceof Error && error.name === 'AbortError'))
    ) {
      // The client has already left; this response is discarded by the adapter.
      return new Response(null, { status: 499 });
    }
    throw error;
  }
}

async function proxy(request: Request) {
  const url = new URL(request.url);
  const uiPort = process.env.WORKBENCH_UI_PORT || '3088';
  const allowed = [`127.0.0.1:${uiPort}`, `localhost:${uiPort}`];
  if (process.env.WORKBENCH_PUBLIC_URL)
    allowed.push(new URL(process.env.WORKBENCH_PUBLIC_URL).host);
  if (!allowed.includes(url.host))
    return Response.json({ error: '只接受本地工作台请求。' }, { status: 403 });
  const headers = new Headers();
  for (const name of [
    'content-type',
    'origin',
    'cookie',
    'authorization',
    'accept',
    'mcp-session-id',
    'mcp-protocol-version',
    'last-event-id',
    'if-none-match',
    'x-ggb-state-delta',
    'x-ggb-state-view',
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(request.method)) {
    try {
      body = await request.text();
    } catch (error) {
      // Node reports an incomplete upload as ECONNRESET. Only translate it
      // when this request's client has actually disconnected.
      request.signal.throwIfAborted();
      throw error;
    }
  }
  const upstream = await fetch(
    `http://127.0.0.1:${process.env.WORKBENCH_API_PORT || 3089}${url.pathname}${url.search}`,
    {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: request.signal,
    },
  );
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of [
    'content-type',
    'content-disposition',
    'mcp-session-id',
    'etag',
    'x-ggb-state-format',
    'vary',
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('Set-Cookie', cookie);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

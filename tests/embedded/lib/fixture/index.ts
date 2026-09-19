export default {
  async fetch(request: Request, env: { TEST_TOKEN: string }): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Authorization') !== `Bearer ${env.TEST_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }
    if (url.pathname === '/health') return Response.json({ ok: true, token: 'seen' });
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<{ TEST_TOKEN: string }>;

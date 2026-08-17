import https from 'node:https';

const SUPABASE_HOST = 'ekmrqelctkejtsryuvv.supabase.co';
const DNS_URL = 'https://cloudflare-dns.com/dns-query';

async function resolveSupabaseIPv4() {
  const url = `${DNS_URL}?name=${encodeURIComponent(SUPABASE_HOST)}&type=A`;
  const r = await fetch(url, { headers: { accept: 'application/dns-json' } });
  if (!r.ok) throw new Error(`DNS resolver returned ${r.status}`);
  const data = await r.json();
  const ip = data?.Answer?.find(x => x.type === 1)?.data;
  if (!ip) throw new Error(`No A record found for ${SUPABASE_HOST}`);
  return ip;
}

function httpsRequest(ip, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      port: 443,
      path,
      method,
      servername: SUPABASE_HOST,
      headers: { ...headers, host: SUPABASE_HOST },
      lookup: (_hostname, _opts, cb) => cb(null, ip, 4),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 502,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (body && !['GET', 'HEAD'].includes(method)) req.write(body);
    req.end();
  });
}

export default async (request) => {
  try {
    const incoming = new URL(request.url);
    let path = incoming.pathname
      .replace(/^\/.netlify\/functions\/supabase/, '')
      .replace(/^\/supabase/, '');
    if (!path) path = '/';
    const targetPath = path + incoming.search;

    const headers = {};
    for (const [k, v] of request.headers.entries()) {
      if (!['host', 'content-length', 'connection'].includes(k.toLowerCase())) headers[k] = v;
    }

    const body = ['GET', 'HEAD'].includes(request.method)
      ? null
      : Buffer.from(await request.arrayBuffer());

    const ip = await resolveSupabaseIPv4();
    const upstream = await httpsRequest(ip, targetPath, request.method, headers, body);

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (!['content-length', 'content-encoding', 'connection', 'transfer-encoding'].includes(k.toLowerCase()) && v != null) {
        responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
    }
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.set('access-control-allow-origin', incoming.origin || '*');
    responseHeaders.set('access-control-allow-credentials', 'true');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Supabase proxy error',
      message: error?.message || String(error)
    }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
};

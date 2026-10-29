import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP(S) URLs on standard ports are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !isIP(host)) throw new Error('Local hostnames are not allowed');
  if (isIP(host) && !isPublicAddress(host)) throw new Error('Private or reserved network addresses are not allowed');
  url.hash = ''; return url;
}

export type SafeResponse = { status: number; text: string; url: string; contentType: string };

// Resolve once and pin that address into the socket. Every redirect is resolved and validated again.
export async function safeRequest(value: string, options: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; maxBytes?: number; redirects?: number } = {}): Promise<SafeResponse> {
  let url = validatePublicUrl(value);
  const maxRedirects = options.redirects ?? 3;
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([dnsLookup(host, { all: true, verbatim: true }), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('DNS timeout')), 5000); t.unref(); })]);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Destination resolves to a private or reserved address');
    const pinned = addresses[0]!;
    const result = await new Promise<{ status: number; text: string; location?: string; contentType: string }>((resolve, reject) => {
      const max = options.maxBytes ?? 1_500_000;
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(url, {
        method: options.method ?? 'GET', agent: false, signal: AbortSignal.timeout(12_000),
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
        },
        headers: { 'user-agent': 'RivalScopeBot/1.0', accept: 'text/html,text/plain,application/json', 'accept-encoding': 'identity', ...options.headers, ...(options.body ? { 'content-length': Buffer.byteLength(options.body) } : {}) },
      }, res => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) { res.resume(); resolve({ status, text: '', location: res.headers.location, contentType: '' }); return; }
        if (Number(res.headers['content-length'] || 0) > max || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(new Error('Response exceeds content policy')); return; }
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > max) { res.destroy(); reject(new Error('Response exceeds size limit')); } else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8'), contentType: res.headers['content-type'] ?? '' }));
      });
      req.on('error', reject); if (options.body) req.write(options.body); req.end();
    });
    if (result.status >= 300 && result.status < 400 && result.location) {
      if (options.method === 'POST') throw new Error('Webhook redirects are forbidden');
      url = validatePublicUrl(new URL(result.location, url).href); continue;
    }
    return { status: result.status, text: result.text, url: url.href, contentType: result.contentType };
  }
  throw new Error('Too many redirects');
}

export function robotsAllows(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: typeof groups[number] = { agents: [], rules: [] };
  for (const line of robots.split(/\r?\n/)) {
    const clean = line.split('#')[0]!.trim(); const colon = clean.indexOf(':'); if (colon < 0) continue;
    const key = clean.slice(0, colon).toLowerCase(); const val = clean.slice(colon + 1).trim();
    if (key === 'user-agent') { if (current.rules.length) { groups.push(current); current = { agents: [], rules: [] }; } current.agents.push(val.toLowerCase()); }
    if ((key === 'allow' || key === 'disallow') && val && current.agents.length) current.rules.push({ allow: key === 'allow', path: val });
  }
  groups.push(current);
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && 'rivalscopebot'.includes(a)));
  const rules = (specific.length ? specific : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
  const matches = rules.filter(rule => {
    const pattern = rule.path.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$');
    return new RegExp(`^${pattern}`).test(path);
  }).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matches[0]?.allow ?? true;
}

export async function assertRobotsAllowed(value: string) {
  const url = validatePublicUrl(value);
  const robots = await safeRequest(new URL('/robots.txt', url).href, { maxBytes: 100_000, redirects: 0 });
  if (robots.status !== 404 && robots.status !== 410 && (robots.status !== 200 || !robotsAllows(robots.text, url.pathname + url.search))) throw new Error('Crawling is disallowed or robots policy is unavailable');
}
export async function extractWebsite(value: string) {
  const url = validatePublicUrl(value);
  await assertRobotsAllowed(url.href);
  // Do not follow page redirects automatically: check robots on the new origin/path first.
  const response = await safeRequest(url.href, { redirects: 0 });
  if (response.status < 200 || response.status >= 300) throw new Error(`Source unavailable (HTTP ${response.status}); redirects require an explicit canonical URL`);
  if (!/text\/(html|plain)/i.test(response.contentType)) throw new Error('Only HTML and text sources are supported');
  const $ = load(response.text);
  const title = $('title').first().text().trim().slice(0, 300) || url.hostname;
  $('script,style,nav,footer,header,aside,noscript,svg,form').remove();
  const text = ($('main').text() || $('article').text() || $('body').text() || $.text()).replace(/\s+/g, ' ').trim().slice(0, 20_000);
  if (text.length < 100) throw new Error('Source has insufficient public text');
  return { url: response.url, title, text, contentHash: createHash('sha256').update(text).digest('hex') };
}

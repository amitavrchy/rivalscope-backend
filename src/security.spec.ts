import { can, hashToken, newToken } from './security.js';
import { isPublicAddress, robotsAllows, validatePublicUrl } from './safe-http.js';
import { analysisSchema, validateEvidence } from './research-schemas.js';

describe('network security', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.4.2', '192.168.0.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '0.0.0.0', '224.0.0.1'])('blocks non-public destination %s', address => expect(isPublicAddress(address)).toBe(false));
  it.each(['https://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd', 'https://user:password@example.com', 'https://example.com:8080', 'http://localhost'])('rejects unsafe URL %s', url => {
    expect(() => validatePublicUrl(url)).toThrow();
  });
  it('permits public addresses and normalizes URL fragments', () => { expect(isPublicAddress('1.1.1.1')).toBe(true); expect(validatePublicUrl('https://example.com/#section').hash).toBe(''); });
  it('honors longest robot rule and specific crawler groups', () => {
    const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/public\nUser-agent: RivalScopeBot\nDisallow: /pricing\nAllow: /pricing/free';
    expect(robotsAllows(robots, '/pricing')).toBe(false); expect(robotsAllows(robots, '/pricing/free')).toBe(true); expect(robotsAllows(robots, '/private')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*?token=', '/page?token=abc')).toBe(false);
  });
});
describe('permission boundaries', () => {
  it('prevents viewers, editors and billing managers from launching research', () => { for (const role of ['VIEWER', 'EDITOR', 'BILLING_MANAGER']) expect(can(role, 'research')).toBe(false); });
  it('keeps billing and platform access separate', () => { expect(can('ADMIN', 'billing')).toBe(false); expect(can('BILLING_MANAGER', 'read')).toBe(false); expect(can('ADMIN', 'owner')).toBe(false); expect(can('OWNER', 'owner')).toBe(true); expect(can('PLATFORM_ADMIN', 'read')).toBe(false); });
  it('hashes independent high-entropy credentials', () => { const first = newToken(); expect(first).not.toBe(newToken()); expect(hashToken(first)).not.toContain(first); expect(hashToken(first)).toHaveLength(64); });
});
describe('evidence integrity', () => {
  const source = { id: '9f3cfa04-49f3-484f-9c89-5c3855ed8b27', url: 'https://example.com', text: 'Our Starter subscription costs $19 each month and includes team workspaces.' };
  const make = () => analysisSchema.parse({ executiveSummary: 'Interpretation', competitors: [], findings: [{ category: 'PRICING', claim: 'Starter costs $19 per month.', kind: 'FACT', citations: [{ sourceId: source.id, quotation: source.text }] }], limitations: ['One source; not independently verified'] });
  it('accepts literal evidence in the same run', () => expect(validateEvidence(make(), [source])).toBeTruthy());
  it('rejects citations from another tenant or run', () => expect(() => validateEvidence(make(), [])).toThrow('unsupported'));
  it('rejects invented quotes', () => { const result = make(); result.findings[0]!.citations[0]!.quotation = 'This invented quotation is not in the source'; expect(() => validateEvidence(result, [source])).toThrow('quotation'); });
  it('rejects unsupported quantities', () => { const result = make(); result.findings[0]!.claim = 'Starter costs $99 per month.'; expect(() => validateEvidence(result, [source])).toThrow('Quantitative'); });
  it('labels strategic interpretation as inference', () => { const result = make(); result.findings[0]!.category = 'OPPORTUNITY'; expect(() => validateEvidence(result, [source])).toThrow('inference'); });
});

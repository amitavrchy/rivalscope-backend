import { randomUUID } from 'node:crypto';
import { catalogSchema, validateCatalog } from '../src/intelligence.js';
import { analysisSchema, validateEvidence } from '../src/research-schemas.js';

// Deterministic policy regression fixtures; they evaluate grounding checks, not model intelligence.
const id = randomUUID();
const source = { id, url: 'https://acme.example/pricing', text: 'Acme Starter costs USD 19 per month. It includes shared research and team collaboration. Enterprise pricing is available on request.' };
describe('evidence quality regressions', () => {
  it.each([
    ['correct source and price', 19, id, 'acme.example', true],
    ['invented price', 99, id, 'acme.example', false],
    ['foreign source ID', 19, randomUUID(), 'acme.example', false],
    ['wrong competitor domain', 19, id, 'other.example', false],
  ] as const)('%s', (_name, amount, sourceId, domain, accepted) => {
    const catalog = catalogSchema.parse({ products: [], features: [], prices: [{ name: 'Starter', amount, currency: 'USD', interval: 'MONTH', sourceId, domain, quotation: 'Acme Starter costs USD 19 per month.' }] });
    if (accepted) expect(validateCatalog(catalog, [source], [domain])).toEqual(catalog);
    else expect(() => validateCatalog(catalog, [source], [domain])).toThrow();
  });
  it('keeps unpublished pricing explicitly unavailable', () => {
    const catalog = catalogSchema.parse({ products: [], features: [], prices: [{ name: 'Enterprise', amount: null, currency: null, interval: null, sourceId: id, domain: 'acme.example', quotation: 'Enterprise pricing is available on request.' }] });
    expect(validateCatalog(catalog, [source], ['acme.example']).prices[0]?.amount).toBeNull();
  });
  it('rejects invented numeric claims and strategic conclusions labeled as facts', () => {
    const data = { executiveSummary: 'Interpretation', competitors: [], findings: [{ category: 'PRICING', claim: 'Acme charges USD 99 per month.', kind: 'FACT', citations: [{ sourceId: id, quotation: 'Acme Starter costs USD 19 per month.' }] }], limitations: ['Single source'] };
    expect(() => validateEvidence(analysisSchema.parse(data), [source])).toThrow('Quantitative');
    expect(() => validateEvidence(analysisSchema.parse({ ...data, findings: [{ ...data.findings[0], category: 'STRENGTH', claim: 'Acme has a defensible advantage.' }] }), [source])).toThrow('inference');
  });
});

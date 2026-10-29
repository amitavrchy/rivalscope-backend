import { phraseMatches } from './alert-rules.js';
describe('literal watch rules',()=>{
  it('matches a newly appearing phrase despite case and whitespace differences',()=>{expect(phraseMatches('APPEARED','Shared research','Old public description','New SHARED   research feature')).toBe(true);});
  it('does not turn unchanged text or unrelated changes into a watch alert',()=>{expect(phraseMatches('APPEARED','USD 19','Starter USD 19','Starter USD 19 with support')).toBe(false);expect(phraseMatches('DISAPPEARED','USD 19','Starter USD 19','Starter USD 19 with support')).toBe(false);});
  it('flags disappearance only when the exact normalized phrase was present',()=>{expect(phraseMatches('DISAPPEARED','USD 19','Starter USD 19 monthly','Starter USD 29 monthly')).toBe(true);expect(phraseMatches('DISAPPEARED','USD 19','Starter USD 29','Starter USD 39')).toBe(false);});
});

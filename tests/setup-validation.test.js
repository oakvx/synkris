import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateSalonConfig, assertSalonConfig} from '../src/services/setup-validation.js';
const valid = () => ({salonName:"Il salone d'esempio",professionals:{'team@salone.it':{name:'Persona di prova'}},services:{Manicure:{durationMin:30,price:25,professionals:['team@salone.it'],professionalDurations:{'team@salone.it':35},synonyms:['Mani']}},businessHours:{'1':['09:00','18:00']},closedDays:[7],lunchBreaks:{'1':['13:00','14:00']},unavailability:{}});

test('valid initial salon config is accepted unchanged', () => {
  const config = valid(); const snapshot = structuredClone(config);
  assert.deepEqual(validateSalonConfig(config), []);
  assert.equal(assertSalonConfig(config), config); assert.deepEqual(config, snapshot);
});
const cases = [
  ['root array', () => []], ['missing team', c => (delete c.professionals, c)],
  ['demonstration email', c => (c.professionals={'team@example.com':{name:'Demo'}},c)],
  ['case duplicate email', c => (c.professionals['TEAM@salone.it']={name:'Duplicate'},c)],
  ['missing name', c => (c.professionals['team@salone.it'].name='',c)],
  ['no services', c => (c.services={},c)],
  ['negative duration', c => (c.services.Manicure.durationMin=-1,c)],
  ['fractional duration', c => (c.services.Manicure.durationMin=1.5,c)],
  ['duration too long', c => (c.services.Manicure.durationMin=961,c)],
  ['price injection', c => (c.services.Manicure.price='not a number',c)],
  ['no assignments', c => (c.services.Manicure.professionals=[],c)],
  ['unknown assignment', c => (c.services.Manicure.professionals=['other@salone.it'],c)],
  ['duplicate assignment', c => (c.services.Manicure.professionals.push('team@salone.it'),c)],
  ['nonarray assignments', c => (c.services.Manicure.professionals={},c)],
  ['bad override', c => (c.services.Manicure.professionalDurations['team@salone.it']=0,c)],
  ['unknown override', c => (c.services.Manicure.professionalDurations['other@salone.it']=30,c)],
  ['bad synonym', c => (c.services.Manicure.synonyms=[{}],c)],
  ['duplicate service', c => (c.services.manicure=structuredClone(c.services.Manicure),c)],
  ['reserved service key', c => (c.services.constructor=structuredClone(c.services.Manicure),c)],
  ['no opening day', c => (c.businessHours={},c)],
  ['invalid time', c => (c.businessHours['1']=['29:00','30:00'],c)],
  ['reversed opening', c => (c.businessHours['1']=['18:00','09:00'],c)],
  ['closed and open', c => (c.closedDays=[1],c)],
  ['bad closed day', c => (c.closedDays=[8],c)],
  ['pause outside opening', c => (c.lunchBreaks['1']=['06:00','07:00'],c)],
  ['pause on closed day', c => (c.lunchBreaks['7']=['13:00','14:00'],c)],
  ['unknown unavailable team member', c => (c.unavailability['other@salone.it']=[{type:'day',days:[1]}],c)],
  ['bad unavailable weekday', c => (c.unavailability['team@salone.it']=[{type:'day',days:[8]}],c)],
];
for (const [label, change] of cases) test('setup validation rejects ' + label, () => {
  const config = change(valid());
  assert.ok(validateSalonConfig(config).length > 0);
  assert.throws(() => assertSalonConfig(config), /Configurazione salone:/);
});
test('errors are indexed and never echo salon names or email addresses', () => {
  const config = valid(); config.services.Manicure.professionals = ['private@customer.it'];
  const text = JSON.stringify(validateSalonConfig(config));
  assert.doesNotMatch(text, /private@customer|team@salone|Manicure|Il salone/);
});
test('bootstrap validates before initial DB migration but preserves database-managed settings', () => {
  const source = fs.readFileSync(new URL('../scripts/deploy/bootstrap.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('checkConfig(existsSync(destination)') < source.indexOf("run('scripts/db/init.mjs')"));
  assert.match(source, /if \(!existsSync\(marker\)\) \{/);
});

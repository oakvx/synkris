// Validation shared by the initial importer and the offline installation doctor.
// Never include submitted values (names, emails or credentials) in diagnostics.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const email = value => text(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value === value.trim();
const duration = value => Number.isInteger(value) && value >= 1 && value <= 960;
const money = value => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9_999_999);
const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const pair = value => Array.isArray(value) && value.length === 2 && value.every(time) && value[0] < value[1];
const day = value => /^[1-7]$/.test(String(value));
const reserved = value => ['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase());

export function validateSalonConfig(config) {
  const issues = [];
  const add = (field, message) => issues.push({field, message});
  if (!record(config)) return [{field:'config', message:'La configurazione deve essere un oggetto JSON.'}];
  if (config.salonName !== undefined && !text(config.salonName)) add('salonName', 'Inserisci un nome del salone tra 1 e 120 caratteri.');
  const professionals = record(config.professionals) ? Object.entries(config.professionals) : [];
  if (professionals.length < 1 || professionals.length > 100) add('professionals', 'Configura da 1 a 100 persone del team.');
  const seenEmails = new Set();
  professionals.forEach(([address, person], index) => {
    const field = `professionals[${index + 1}]`;
    if (!email(address) || /@(?:example\.(?:com|org|net)|invalid|test)$/i.test(address)) add(field, 'Inserisci un indirizzo email reale, non dimostrativo.');
    if (seenEmails.has(address.toLowerCase())) add(field, 'Le email del team non possono essere duplicate, neppure per maiuscole/minuscole.');
    seenEmails.add(address.toLowerCase());
    if (!record(person) || !text(person.name)) add(field + '.name', 'Inserisci il nome della persona, massimo 120 caratteri.');
  });
  const services = record(config.services) ? Object.entries(config.services) : [];
  if (services.length < 1 || services.length > 500) add('services', 'Configura da 1 a 500 trattamenti.');
  const seenServices = new Set();
  services.forEach(([name, service], index) => {
    const field = `services[${index + 1}]`;
    const normalized = name.trim().toLocaleLowerCase('it');
    if (!text(name) || name !== name.trim() || reserved(name)) add(field, 'Il nome del trattamento deve essere valido, senza spazi esterni, massimo 120 caratteri.');
    if (seenServices.has(normalized)) add(field, 'I nomi dei trattamenti non possono essere duplicati.');
    seenServices.add(normalized);
    if (!record(service)) { add(field, 'Il trattamento deve essere un oggetto.'); return; }
    if (!duration(service.durationMin ?? service.duration)) add(field + '.durationMin', 'La durata deve essere un intero tra 1 e 960 minuti.');
    if (!money(service.price) || !money(service.materialsCost)) add(field + '.price', 'Prezzi e costi devono essere numeri non negativi entro 9999999.');
    const assigned = service.professionals;
    if (!Array.isArray(assigned) || assigned.length < 1 || new Set(assigned).size !== assigned.length || assigned.some(address => typeof address !== 'string' || !Object.hasOwn(config.professionals || {}, address))) {
      add(field + '.professionals', 'Assegna almeno una persona del team, senza duplicati o indirizzi sconosciuti.');
    }
    if (service.professionalDurations !== undefined) {
      if (!record(service.professionalDurations) || Object.entries(service.professionalDurations).some(([address, minutes]) => !Array.isArray(assigned) || !assigned.includes(address) || !duration(minutes))) add(field + '.professionalDurations', 'Le durate personalizzate devono riferirsi a persone abilitate ed essere tra 1 e 960 minuti.');
    }
    for (const key of ['synonyms', 'allergens']) {
      if (service[key] !== undefined && (!Array.isArray(service[key]) || service[key].length > 100 || service[key].some(value => !text(value)))) add(field + '.' + key, 'Usa al massimo 100 testi non vuoti, ciascuno entro 120 caratteri.');
    }
  });
  const closed = config.closedDays ?? config.daysOff ?? [];
  const closedDays = Array.isArray(closed) ? closed : record(closed) ? Object.keys(closed) : null;
  if (!closedDays || closedDays.some(value => !day(value))) add('closedDays', 'I giorni di chiusura devono essere numeri da 1 (lunedi) a 7 (domenica).');
  const hours = record(config.businessHours) ? Object.entries(config.businessHours) : [];
  const isClosed = weekday => closedDays?.some(value => String(value) === weekday);
  if (!hours.some(([weekday, spec]) => day(weekday) && pair(spec) && !isClosed(weekday))) add('businessHours', 'Configura almeno un giorno aperto con orari HH:mm validi.');
  for (const [weekday, spec] of hours) {
    if (!day(weekday) || !pair(spec)) add('businessHours', 'Gli orari devono essere coppie HH:mm in ordine, per giorni da 1 a 7.');
    if (isClosed(weekday)) add('businessHours', 'Un giorno non puo essere contemporaneamente aperto e chiuso.');
  }
  if (config.lunchBreaks !== undefined && !record(config.lunchBreaks)) add('lunchBreaks', 'Le pause devono essere un oggetto.');
  for (const [weekday, spec] of Object.entries(record(config.lunchBreaks) ? config.lunchBreaks : {})) {
    const opening = config.businessHours?.[weekday];
    if (!day(weekday) || !pair(spec) || !pair(opening) || spec[0] < opening[0] || spec[1] > opening[1] || isClosed(weekday)) add('lunchBreaks', 'Ogni pausa deve rientrare negli orari di un giorno aperto.');
  }
  if (config.unavailability !== undefined) {
    if (!record(config.unavailability)) add('unavailability', 'Le indisponibilita devono essere un oggetto.');
    else for (const [address, rules] of Object.entries(config.unavailability)) {
      if (!Object.hasOwn(config.professionals || {}, address) || !Array.isArray(rules) || rules.some(rule => !record(rule) || rule.type !== 'day' || !Array.isArray(rule.days) || rule.days.some(value => !day(value)))) add('unavailability', 'Le assenze iniziali devono essere regole day per persone del team e giorni da 1 a 7.');
    }
  }
  return issues;
}

export function assertSalonConfig(config) {
  const issues = validateSalonConfig(config);
  if (issues.length) throw new Error('Configurazione salone: ' + issues.map(issue => issue.field + ': ' + issue.message).join(' '));
  return config;
}

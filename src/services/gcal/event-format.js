/** Google Calendar event-format domain. */
export function createModule(dependencies, shared) {
  const {  } = dependencies;

function deriveNameFromEmail(email) {
  try {
    if (!email) return '';
    const local = String(email).split('@')[0];
    const cleaned = local.replace(/[._-]+/g, ' ').replace(/\d+/g, ' ').trim();
    return cleaned
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || String(email);
  } catch {
    return String(email || '');
  }
}

function buildTreatmentEvent(opts) {
  const {
    serviceName,
    professionalEmail,
    professionalName = null,
    clientPhone,
    clientName = null,
    startTime,
    durationMin,
    price = null,
    serviceDetails = null,
    allergies = null, // string | string[] | null
    allergic = null, // true | false | null (non dichiarato)
    reminders = [{
      method: 'popup',
      minutes: 1440
    }],
    allergicWarning = null // legacy string support
  } = opts || {};

  if (!serviceName || !professionalEmail || !clientPhone || !startTime || !durationMin) {
    throw new Error('Parametri obbligatori mancanti per buildTreatmentEvent');
  }

  const start = new Date(startTime);
  const end = new Date(start.getTime() + Number(durationMin) * 60000);

  // Title: "Servizio - Nome Professionista"
  const proName = professionalName || deriveNameFromEmail(professionalEmail);
  const summary = `${serviceName} - ${proName}`;

  // Format allergy section
  function fmtAllergies(allergies) {
    if (Array.isArray(allergies)) {
      const list = allergies.filter(Boolean).map(s => String(s).trim()).filter(Boolean);
      return list.length ? list.join(', ') : 'sì (non specificate)';
    }
    if (typeof allergies === 'string' && allergies.trim()) return allergies.trim();
    return 'sì (non specificate)';
  }
  let allergyLine;
  if (allergic === true) {
    allergyLine = `Allergie: ${fmtAllergies(allergies)}`;
  } else if (allergic === false) {
    allergyLine = 'Allergie: nessuna riferita';
  } else if (allergicWarning) {
    allergyLine = `Allergie: ${allergicWarning}`;
  } else {
    allergyLine = 'Allergie: non dichiarate';
  }

  const priceLine = (price !== null && price !== undefined && price !== '') ? `€${price}` : '—';
  const durationLine = `${Number(durationMin)} min`;

  const lines = [
    '— Dettagli cliente —',
    `• Nome: ${clientName || '—'}`,
    `• Telefono: ${clientPhone}`,
    `• ${allergyLine}`,
    '',
    '— Dettagli servizio —',
    `• Servizio: ${serviceName}`,
    `• Professionista: ${proName}`,
    `• Durata: ${durationLine}`,
    `• Prezzo: ${priceLine}`,
    serviceDetails ? `• Note: ${serviceDetails}` : null
  ].filter(Boolean);

  const description = lines.join('\n');

  return {
    summary,
    description,
    start: {
      dateTime: start.toISOString()
    },
    end: {
      dateTime: end.toISOString()
    },
    reminders: {
      useDefault: false,
      overrides: reminders
    }
  };
}

function extractResponse(input, opts = {}) {
  const options = {
    keys: ['response', 'StringResponse'],
    all: false,
    ...opts
  };
  const items = Array.isArray(input) ? input : [input];
  const results = [];

  /**
   * Best‑effort JSON normalisation so JSON.parse succeeds more often.
   * @param {string} str
   * @returns {string}
   */
  const fixJson = (str) => str
    // smart quotes → regular quotes
    .replace(/[“”‘’]/g, '"')
    // single‑quoted keys/values → double quotes (shallow heuristic)
    .replace(/([{,]\s*)'(\w+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'((?:[^'\\]|\\.)*)'/g, ': "$1"')
    // trailing commas → removed
    .replace(/,(\s*[}\]])/g, '$1');

  /**
   * Extract from a raw string (may include noise around the JSON block).
   * @param {string} txt
   * @returns {string|null}
   */
  const fromString = (txt) => {
    // isolate first {...} if surrounded by text
    const candidate = (txt.match(/({[\s\S]*?})/) || [])[1] || txt;

    // Try strict parse first
    try {
      const obj = JSON.parse(fixJson(candidate));
      for (const k of options.keys)
        if (typeof obj[k] === 'string') return obj[k];
    } catch {
      /* fall through */
    }

    // Fallback regex (handles escapes + single/double quotes)
    const keyGroup = options.keys.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const re = new RegExp(
      `["'](?:${keyGroup})["']\\s*:\\s*(["'])(?<val>(?:\\\\.|(?!\\1).)*?)\\1`
    );

    const m = candidate.match(re);
    return m?.groups?.val ?? null;
  };

  for (const itm of items) {
    // 1. Direct object access
    if (typeof itm === 'object' && itm !== null && !Array.isArray(itm)) {
      for (const k of options.keys) {
        if (typeof itm[k] === 'string') {
          if (options.all) {
            results.push(itm[k]);
            continue;
          }
          return itm[k];
        }
      }
      // Serialise object for fallback parsing
      try {
        const val = fromString(JSON.stringify(itm));
        if (val !== null) {
          if (options.all) results.push(val);
          else return val;
        }
      } catch { }
    }
    // 2. Raw string input
    else if (typeof itm === 'string') {
      const val = fromString(itm);
      if (val !== null) {
        if (options.all) results.push(val);
        else return val;
      }
    }
  }

  return options.all ? results : null;
}

  return { deriveNameFromEmail, buildTreatmentEvent, extractResponse };
}

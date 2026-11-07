/** Private operational alerts: no client data, opt-in SMTP, bounded frequency. */
const DEFAULT_COOLDOWN_MS=60*60*1000;

export function findOperationalAnomalies(state,{now=Date.now(),graceMs=10*60*1000,calendarMaintenance=false}={}) {
  const failures=[];
  if(calendarMaintenance)failures.push('calendar_reconciliation_required');
  if(state.dbOnline===false)failures.push('database_offline');
  if(now-Number(state.startedAt||now)>graceMs && state.online===false)failures.push('whatsapp_offline');
  if(state.lastInboundSyncStatus==='error')failures.push('calendar_sync_error');
  return failures;
}

export function createAlertMonitor({state,send,clock=()=>Date.now(),graceMs=10*60*1000,
  cooldownMs=DEFAULT_COOLDOWN_MS,requiredTicks=3,logger=()=>{}}) {
  const streak=new Map(),sentAt=new Map();
  return async function check({attention=false}={}) {
    const now=clock();
    const problems=new Set(findOperationalAnomalies(state,{now,graceMs}));
    if(attention) problems.add('calendar_outbox_attention');
    for(const key of streak.keys())if(!problems.has(key))streak.delete(key);
    for(const problem of problems) {
      streak.set(problem,(streak.get(problem)||0)+1);
      if(streak.get(problem)<requiredTicks || now-(sentAt.get(problem)??-Infinity)<cooldownMs)continue;
      // Limit repeated attempts when SMTP is unavailable, without blocking the bot.
      sentAt.set(problem,now);
      try{await send({type:problem,occurredAt:new Date(now).toISOString()});}
      catch(error){logger('warn','alert_delivery_failed',{code:error.code||'smtp_unavailable'});}
    }
    return [...problems];
  };
}

export function smtpSettings(env=process.env){
  if(env.ALERT_EMAIL_ENABLED!=='1')return null;
  const port=Number(env.SMTP_PORT||587);
  if(!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM || !env.ALERT_EMAIL_TO ||
    !Number.isInteger(port)||port<1||port>65535 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ALERT_EMAIL_TO))throw new Error('Configurazione SMTP per gli avvisi incompleta');
  return {host:env.SMTP_HOST,port,secure:port===465,auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD},
    from:env.SMTP_FROM,to:env.ALERT_EMAIL_TO};
}
export async function sendOperationalAlert({type,occurredAt},config){
  if(!config)return false;
  const {default:nodemailer}=await import('nodemailer');
  const transport=nodemailer.createTransport({host:config.host,port:config.port,
    secure:config.secure,requireTLS:!config.secure,auth:config.auth,
    tls:{rejectUnauthorized:true},connectionTimeout:10000,socketTimeout:12000});
  try {
    await transport.sendMail({from:config.from,to:config.to,subject:'synk · problema operativo',
      text:`synk ha rilevato: ${type}\nOra: ${occurredAt}\nApri il Centro operativo sul PC del salone.\nNessun dato cliente incluso.`});
  } finally {transport.close();}
  return true;
}

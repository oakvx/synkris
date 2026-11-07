/** Consent-first waitlist. Only a verified slot may trigger an offer.
 * No automatically confirmed booking; customer must accept through the normal booking flow.
 */
export function validateWaitlistRequest({chatId, earliestAt, latestAt, consent}) {
 if(consent!==true || typeof chatId!=='string' || !/^\d{5,20}@c\.us$/.test(chatId)) throw new Error('Explicit opt-in and valid WhatsApp address required');
 const from=Date.parse(earliestAt),until=Date.parse(latestAt);
 if(!Number.isFinite(from) || !Number.isFinite(until) || until<=from || from<Date.now()-60_000 || until-from>30*86_400_000) throw new Error('Invalid waitlist window');
 return {chatId,from:new Date(from).toISOString(),until:new Date(until).toISOString()};
}
export async function addToWaitlist(db,{chatId,earliestAt,latestAt,professionalId=null,serviceId=null,consent=false}) {
 const valid=validateWaitlistRequest({chatId,earliestAt,latestAt,consent});
 const svc=Number(serviceId),pro=professionalId==null||professionalId===''?null:Number(professionalId);
 if(!Number.isSafeInteger(svc)||svc<1 || (pro!==null&&(!Number.isSafeInteger(pro)||pro<1)))
  throw new Error('Trattamento obbligatorio e operatrice valida');
 const check=await db.query('SELECT service_id FROM public.services WHERE service_id=$1 AND is_active=true',[svc]);
 if(!check.rows.length)throw new Error('Trattamento inesistente o disattivato');
 if(pro!==null){
  const linked=await db.query('SELECT 1 FROM public.professional_services WHERE service_id=$1 AND professional_id=$2',[svc,pro]);
  if(!linked.rows.length)throw new Error('Operatrice non abilitata per questo trattamento');
 }
 const expiry=new Date(Math.min(Date.now()+30*86_400_000,Date.parse(valid.until))).toISOString();
 const result=await db.query(`INSERT INTO public.waitlist_requests
 (chat_id,earliest_at,latest_at,professional_id,service_id,consent_at,expires_at)
 VALUES($1,$2,$3,$4,$5,now(),$6) RETURNING request_id`,
 [chatId,valid.from,valid.until,pro,svc,expiry]);
 return result.rows[0].request_id;
}
export async function withdrawFromWaitlist(db,chatId) {
 const result=await db.query(`UPDATE public.waitlist_requests SET status='revoked'
 WHERE chat_id=$1 AND status IN ('active','offered')`,[chatId]);
 return result.rowCount;
}
export async function findWaitlistCandidates(db,{start,end,professionalId,serviceId}) {
 if(!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||Date.parse(end)<=Date.parse(start)) throw new Error('Invalid slot');
 const response=await db.query(`SELECT request_id,chat_id,service_id,professional_id FROM public.waitlist_requests
 WHERE status='active' AND expires_at>now() AND earliest_at<=$1 AND latest_at>=$2
 AND (professional_id IS NULL OR professional_id=$3) AND service_id=$4
 ORDER BY created_at LIMIT 20`,[start,end,professionalId,serviceId]);
 return response.rows;
}
export async function offerVerifiedSlot({ db, start, end, professionalId, serviceId, verifyAvailability, notify }) {
 if(typeof verifyAvailability!=='function'||typeof notify!=='function') throw new Error('Provider availability and notification are required');
 const candidates=await findWaitlistCandidates(db,{start,end,professionalId,serviceId});
 if (!candidates.length || !(await verifyAvailability({start,end,professionalId,serviceId}))) return {offered:0};
 // Only one offer for each newly freed slot. It is an invitation, NOT a reservation.
 const candidate=candidates[0];
 const changed=await db.query(`UPDATE public.waitlist_requests SET status='offered'
 WHERE request_id=$1 AND status='active' RETURNING request_id`,[candidate.request_id]);
 if(!changed.rowCount) return {offered:0};
 const expires=new Date(Date.now()+15*60_000).toISOString();
 try {
  // Do not send the same offer twice after an ambiguous delivery failure.
  const inserted=await db.query(`INSERT INTO public.waitlist_offers(request_id,start_time,end_time,expires_at)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING offer_id`,
    [candidate.request_id,start,end,expires]);
  if (!inserted.rowCount) {
    await db.query(`UPDATE public.waitlist_requests SET status='active'
      WHERE request_id=$1 AND status='offered'`,[candidate.request_id]);
    return {offered:0};
  }
  await notify(candidate.chat_id, `Si è liberato un orario: ${new Date(start).toLocaleString('it-IT',{timeZone:'Europe/Rome'})}. Rispondi per verificarne la disponibilità. L'orario non è riservato.`);
 } catch(error) {
  // Do not leave the request stuck as 'offered' on failed DB/send actions.
  // Preserve the offer record: in an ambiguous send we must not resend blindly.
  await db.query(`UPDATE public.waitlist_requests SET status='active'
    WHERE request_id=$1 AND status='offered'`,[candidate.request_id]);
  throw error;
 }
 return {offered:1};
}
export async function pruneWaitlist(db) {
 // A 15-minute offer is not a permanent withdrawal from the waiting list.
 // Return unanswered offers to the pool until the original opt-in expires.
 await db.query(`UPDATE public.waitlist_requests w
   SET status=CASE WHEN w.expires_at<=now() THEN 'expired' ELSE 'active' END
   WHERE w.status='offered'
     AND EXISTS (SELECT 1 FROM public.waitlist_offers o
       WHERE o.request_id=w.request_id AND o.expires_at<=now())
     AND NOT EXISTS (SELECT 1 FROM public.waitlist_offers o
       WHERE o.request_id=w.request_id AND o.expires_at>now())`);
 await db.query(`UPDATE public.waitlist_requests SET status='expired'
   WHERE expires_at<now() AND status IN ('active','offered')`);
 await db.query(`DELETE FROM public.waitlist_requests WHERE expires_at < now() - interval '7 days' OR
   (status IN ('revoked','expired','accepted') AND created_at<now()-interval '7 days')`);
}

/** Choices always reflect active services/operators in the same PostgreSQL database. */
export async function listWaitlistOptions(db) {
 const [services,professionals]=await Promise.all([
  db.query('SELECT service_id,service_name FROM public.services WHERE is_active=true ORDER BY service_name LIMIT 300'),
  db.query('SELECT professional_id,full_name FROM public.professionals WHERE is_active=true ORDER BY full_name LIMIT 100'),
 ]);
 return {services:services.rows,professionals:professionals.rows};
}

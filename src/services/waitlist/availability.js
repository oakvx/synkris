/** Validate a newly freed slot against both PG and Google free/busy before notifying. */
async function createReadOnlyCalendarApi() {
 const module = await import('../reconciliation/runner.js');
 return module.createReadOnlyCalendarApi();
}
export async function verifyReleasedSlot({db,start,end,professionalId,professionalEmail,apiFactory=createReadOnlyCalendarApi}) {
 const first=Date.parse(start),last=Date.parse(end);
 const id=Number(professionalId);
 if(!Number.isSafeInteger(id)||id<1||typeof professionalEmail!=='string'||!professionalEmail.trim()||
   !Number.isFinite(first)||!Number.isFinite(last)||first<=Date.now()||last<=first||
   last-first>16*60*60*1000) return false;
 const existing=await db.query(`SELECT EXISTS (SELECT 1 FROM public.appointments
 WHERE professional_id=$1 AND tstzrange(start_time,end_time,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
 AND lower(status) NOT IN ('cancelled','canceled','annullato','completed','completato','done','no_show')) AS occupied`,
 [professionalId,start,end]);
 if(existing.rows[0]?.occupied) return false;
 try {
  const api=await apiFactory();
  const calendarIds=[...new Set([professionalEmail,process.env.CALENDAR_ID].filter(Boolean))];
  if (!calendarIds.length) return false;
  const response=await api.freebusy.query({requestBody:{timeMin:start,timeMax:end,
    items:calendarIds.map(id=>({id}))}});
  return calendarIds.every(id=>{
    const calendar=response.data?.calendars?.[id];
    return !!calendar && !calendar.errors?.length && Array.isArray(calendar.busy) && calendar.busy.length===0;
  });
 }catch {return false;}
}

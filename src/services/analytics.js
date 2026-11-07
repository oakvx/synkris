/** Aggregate only; no clients, phone numbers, chat content or employee-level ranking. */
export async function salonSnapshot(db, {months=6}={}) {
 const n=Math.max(1,Math.min(24,Math.floor(Number(months)||6)));
 const res=await db.query(`SELECT to_char(date_trunc('month', start_time AT TIME ZONE 'Europe/Rome'),'YYYY-MM') AS month,
 COUNT(*)::integer AS total,
 COUNT(*) FILTER (WHERE lower(status) IN ('cancelled','canceled','annullato'))::integer AS cancelled,
 COUNT(*) FILTER (WHERE lower(status) IN ('confirmed','confermato'))::integer AS confirmed,
 COUNT(*) FILTER (WHERE lower(status) IN ('completed','completato','done'))::integer AS completed
 FROM public.appointments WHERE start_time>=now()-($1::int*interval '1 month')
 GROUP BY 1 ORDER BY 1`,[n]);
 return res.rows.map(row=>({month:row.month,total:Number(row.total),cancelled:Number(row.cancelled),
 confirmed:Number(row.confirmed),completed:Number(row.completed)}));
}

/** Most requested services, counting each appointment once per service. */
export async function topServices(db, {months=6,limit=10}={}) {
 const n=Math.max(1,Math.min(24,Math.floor(Number(months)||6)));
 const max=Math.max(1,Math.min(20,Math.floor(Number(limit)||10)));
 const res=await db.query(`SELECT s.service_id, s.service_name,
 COUNT(DISTINCT a.appointment_id)::integer AS bookings,
 COUNT(DISTINCT a.appointment_id) FILTER
 (WHERE lower(a.status) IN ('cancelled','canceled','annullato'))::integer AS cancelled
 FROM public.appointments a
 JOIN public.services s ON s.service_id=a.service_id OR
  EXISTS(SELECT 1 FROM public.appointment_services aps
   WHERE aps.appointment_id=a.appointment_id AND aps.service_id=s.service_id)
 WHERE a.start_time >= now()-($1::int*interval '1 month')
 GROUP BY s.service_id,s.service_name ORDER BY bookings DESC,s.service_name LIMIT $2`,[n,max]);
 return res.rows.map(r=>({id:Number(r.service_id),name:r.service_name,
 bookings:Number(r.bookings),cancelled:Number(r.cancelled)}));
}

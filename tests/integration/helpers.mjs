import fs from 'node:fs';
import pg from 'pg';
export function testPool() {
  const connectionString=process.env.TEST_DATABASE_URL;
  if(!connectionString||process.env.SYNK_TEST_DB_ALLOW_RESET!=='1')throw new Error('TEST_DATABASE_URL and SYNK_TEST_DB_ALLOW_RESET=1 are required. Never use a salon DB.');
  const url=new URL(connectionString);
  if(decodeURIComponent(url.pathname)!=='/synk_test')throw new Error('Refusing to reset any database not named synk_test.');
  return new pg.Pool({connectionString,max:5});
}
export async function resetDatabase(pool) {
  const result=await pool.query('SELECT current_database() AS name');
  if(result.rows[0].name!=='synk_test')throw new Error('Database identity mismatch.');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(fs.readFileSync(new URL('../../scripts/db/schema.sql',import.meta.url),'utf8'));
}
export async function seed(pool) {
  const pro=(await pool.query("INSERT INTO public.professionals(full_name,email) VALUES('Synthetic operator','operator@example.com') RETURNING professional_id")).rows[0].professional_id;
  await pool.query('INSERT INTO public.professional_emails(professional_id,email) VALUES($1,$2)',[pro,'operator@example.com']);
  const client=(await pool.query("INSERT INTO public.clients(full_name) VALUES('Synthetic client') RETURNING client_id")).rows[0].client_id;
  const service=(await pool.query("INSERT INTO public.services(service_name,default_duration_min,buffer_after_min) VALUES('Synthetic treatment',30,10) RETURNING service_id")).rows[0].service_id;
  await pool.query('INSERT INTO public.professional_services(professional_id,service_id) VALUES($1,$2)',[pro,service]);
  await pool.query('INSERT INTO public.professional_service_durations(professional_id,service_id,duration_min) VALUES($1,$2,45)',[pro,service]);
  await pool.query("INSERT INTO public.salon_business_hours(weekday,open_time,close_time) SELECT n,'09:00'::time,'18:00'::time FROM generate_series(1,7) n");
  return{pro:Number(pro),client:Number(client),service:Number(service)};
}

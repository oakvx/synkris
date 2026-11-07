/** Public operational preferences only. Never store passwords or API tokens here. */
export const SETTINGS = Object.freeze({
 salon_name: {max:80}, salon_phone:{max:35, pattern:/^[+\d ()-]*$/},
 review_url:{max:300, pattern:/^https:\/\/[^\s]+$/},
 appointment_notice:{max:500}, ai_info_disclaimer:{max:300},
});
export function validateSetting(key,value) {
 const rule=SETTINGS[key];
 if(!rule||typeof value!=='string'||!value.trim()||value.length>rule.max || (rule.pattern&&!rule.pattern.test(value))) throw new Error('Invalid salon setting');
 return value.trim();
}
export async function setSalonSetting(db,key,value) {
 const accepted=validateSetting(key,value);
 await db.query(`INSERT INTO public.salon_settings(setting_key,setting_value) VALUES($1,$2)
 ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()`,[key,accepted]);
}
export async function getSalonSettings(db) {
 const result=await db.query(`SELECT setting_key,setting_value FROM public.salon_settings
 WHERE setting_key=ANY($1::text[])`,[Object.keys(SETTINGS)]);
 return Object.fromEntries(result.rows.map(row=>[row.setting_key,row.setting_value]));
}

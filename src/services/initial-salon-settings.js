import {validateSetting} from './salon-settings.js';

// Runs on the importer's transaction. Never replace preferences already edited
// in the dashboard, including on a manual repeat of the initial import.
export async function seedInitialSalonSettings(db, config) {
  if (config.salonName === undefined) return;
  const name = validateSetting('salon_name', config.salonName);
  await db.query(`INSERT INTO public.salon_settings(setting_key,setting_value)
    VALUES($1,$2) ON CONFLICT(setting_key) DO NOTHING`, ['salon_name',name]);
}

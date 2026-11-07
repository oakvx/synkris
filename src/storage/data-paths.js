import path from 'node:path';

// A single location for configuration, credentials and persistent runtime files.
// Keep the historical directory as the default for existing installations.
export function resolveDataDir(env = process.env, cwd = process.cwd()) {
  const configured = env.APP_DATA_DIR || env.DATA_DIR || env.CONFIG_DIR;
  return path.resolve(cwd, configured || 'configs & dashboard');
}

export const DATA_DIR = resolveDataDir();

export function resolveLicenseDir(env = process.env, cwd = process.cwd()) {
  return env.LICENSE_STORE_DIR
    ? path.resolve(cwd, env.LICENSE_STORE_DIR)
    : path.join(resolveDataDir(env, cwd), 'licenses');
}

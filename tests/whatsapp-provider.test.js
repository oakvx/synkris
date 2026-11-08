import test from 'node:test';
import assert from 'node:assert/strict';
import {whatsappOptions,isWhatsAppConnectedState,stopWhatsAppClient} from '../src/services/whatsapp-options.js';

test('OpenWA v4 launches with explicit browser arguments and never leaks QR to logs',()=>{
  const options=whatsappOptions({SESSION_PATH:'/synthetic/session',PUPPETEER_EXECUTABLE_PATH:'/usr/bin/chromium'});
  assert.deepEqual(options.args,options.chromiumArgs);
  for(const flag of ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-web-security','--disable-site-isolation-trials'])assert.equal(options.args.includes(flag),false);
  assert.equal(options.qrLogSkip,true);assert.equal(options.popup,false);assert.equal(options.logFile,false);assert.equal(options.multiDevice,true);
  assert.equal(options.killProcessOnBrowserClose,false);
});
test('sandbox bypass requires an explicit host-level opt-in and cannot bypass TLS checks',()=>{
  const options=whatsappOptions({CHROME_NO_SANDBOX:'1'});
  assert.ok(options.args.includes('--no-sandbox'));
  assert.equal(options.args.includes('--ignore-certificate-errors'),false);
});
test('readiness uses the installed v4 CONNECTED state, never pairing/disconnected',()=>{
  assert.equal(isWhatsAppConnectedState('CONNECTED'),true);
  for(const state of ['READY','PAIRING','DISCONNECTED',null,undefined,{}])assert.equal(isWhatsAppConnectedState(state),false);
});
test('graceful shutdown closes the v4 browser through kill without logging out its session',async()=>{
  const calls=[];await stopWhatsAppClient({kill:async reason=>calls.push(reason)});
  assert.deepEqual(calls,['SYNK_SHUTDOWN']);
  await stopWhatsAppClient(null);
});

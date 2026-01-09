// generate-keys.js - Script per generare chiavi Ed25519
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';

const KEYS_DIR = './keys';
const PRIV_KEY_PATH = path.join(KEYS_DIR, 'private_key.pem');
const PUB_KEY_PATH = path.join(KEYS_DIR, 'public_key.pem');

async function generateKeys() {
  // Crea la cartella keys se non esiste
  await fs.mkdir(KEYS_DIR, { recursive: true });

  // Verifica se le chiavi esistono già
  try {
    await fs.access(PRIV_KEY_PATH);
    await fs.access(PUB_KEY_PATH);
    console.log('⚠️  Le chiavi esistono già in:', KEYS_DIR);
    console.log('   Se vuoi rigenerarle, elimina prima i file esistenti.');
    return;
  } catch {
    // Le chiavi non esistono, procedi con la generazione
  }

  console.log('🔐 Genero chiavi Ed25519...');

  // Genera la coppia di chiavi
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Esporta in formato PEM
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  // Salva i file
  await fs.writeFile(PRIV_KEY_PATH, privPem);
  await fs.writeFile(PUB_KEY_PATH, pubPem);

  console.log('✅ Chiavi generate con successo!');
  console.log('');
  console.log('📁 Percorsi:');
  console.log('   Privata:', PRIV_KEY_PATH);
  console.log('   Pubblica:', PUB_KEY_PATH);
  console.log('');
  console.log('⚠️  IMPORTANTE:');
  console.log('   - La chiave PRIVATA deve rimanere SEGRETA');
  console.log('   - La chiave PUBBLICA va distribuita con l\'app');
  console.log('');
  console.log('📋 Prossimi passi:');
  console.log('   1. Copia public_key.pem nella cartella della tua app');
  console.log('   2. Configura LICENSE_PUBLIC_KEY_FILE o LICENSE_PUBLIC_KEY_PEM');
  console.log('   3. Genera licenze con license-generator.js');
  console.log('');
  console.log('🔑 Chiave pubblica per .env:');
  console.log('LICENSE_PUBLIC_KEY_PEM="' + pubPem.replace(/\n/g, '\\n') + '"');
}

generateKeys().catch(err => {
  console.error('❌ Errore:', err.message);
  process.exit(1);
});
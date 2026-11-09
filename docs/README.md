# Documentazione tecnica SYNKRIS

Questa cartella contiene il materiale di **sviluppo, progettazione e audit**.
Non entra nel pacchetto runtime per Windows. Per avviare il bot utilizzare
i documenti della radice del repository e il wizard `INSTALLA_SYNK.bat`.

## Percorsi

| Area | Dove | Funzione |
| --- | --- | --- |
| Prima installazione e uso | [PRIMO_AVVIO.txt](../PRIMO_AVVIO.txt), [LEGGIMI.txt](../LEGGIMI.txt), [deploy/PRIMI_PASSI.md](../deploy/PRIMI_PASSI.md) | Guide incluse nello ZIP |
| Releases e aggiornamenti | [RELEASE.md](../RELEASE.md), [PRIMO_RILASCIO.md](PRIMO_RILASCIO.md) | Packaging, prerelease a ogni commit e Release pubblica settimanale |
| Collaudo e sicurezza | [COLLAUDO.md](../COLLAUDO.md), [SECURITY.md](../SECURITY.md) | Vincoli di utilizzo e dati |
| Distribuzione/licenza | [OPEN_SOURCE_READINESS.md](OPEN_SOURCE_READINESS.md) | Situazione legale e limiti |
| Windows plug-and-play | [PLUG_AND_PLAY.md](PLUG_AND_PLAY.md) | Contratti e test del wizard |
| WhatsApp | [WHATSAPP_MIGRATION.md](WHATSAPP_MIGRATION.md) | Migrazione tecnica |
| Immagini e screenshot | [readme/README.md](readme/README.md), [readme/brand-guide.md](readme/brand-guide.md) | Asset correnti del README |
| Report storici | [history/README.md](history/README.md) | RC4, RC5 e ricostruzione RC6 |

## Confini del repository

- `src/` — bot Node.js, intent, conversazioni e integrazioni.
- `dashboard/`, `dashboard.php`, `bridge.php` — frontend e backend PHP.
- `scripts/db/`, `scripts/deploy/` — schema, migrazioni e bootstrap.
- `scripts/release/` — verifica della allowlist, ZIP e checksum.
- `deploy/`, `strumenti/` — Docker e strumenti PowerShell per Windows.
- `assets/` — risorse usate dal runtime. **Non** confondere con `docs/assets/`.
- `docs/assets/` — sei SVG viola/fucsia e tre anteprime WebP documentali.
- `tests/` — test automatici e regressioni di versioni precedenti.
- `.github/workflows/` — CI, prerelease pubbliche per commit e Release settimanale di collaudo.

**Da non eliminare solo per il nome:** `src/legacy/` e i moduli
`dashboard/assets/bookings-*.js` contengono compatibilità o blocchi
di sicurezza dei vecchi percorsi. Le suite `rc2-rc5` impediscono regressioni.
Questi file vanno rimossi soltanto dopo analisi delle dipendenze e test.

I file `.env`, `runtime/`, `secrets/` e `setup/config.json` con dati reali
non devono essere versionati. Il pacchetto pubblicabile è costruito da una
**allowlist**, non clonando tutto l'albero Git.

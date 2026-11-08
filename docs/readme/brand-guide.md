# Identità visiva SYNKRIS / synk

**Obiettivo:** presentare synk a potenziali clienti senza sacrificare la correttezza tecnica della documentazione.

## Naming

- **SYNKRIS:** identità del progetto/repository.
- **synk:** nome del prodotto operativo per i saloni, come riportato nel software e nella licenza.
- **Voce:** concreta, affidabile, professionale; non promettere funzioni non collaudate.

## Palette README

| Ruolo | Colore |
| --- | --- |
| Fondo notturno | `#120923` |
| Viola primario | `#8B5CF6` |
| Viola profondo | `#211044` |
| Fucsia accento | `#FC3BC4` |
| Fucsia chiaro | `#F472D0` |
| Testo su fondo scuro | `#FFFFFF` |
| Testo secondario | `#DACCEA` |

La palette serve a creare un'identità riconoscibile. Non usare il solo colore per distinguere stati operativi: aggiungere sempre etichette esplicite.

## Asset

- `synkris-hero.svg`: banner di copertina, **illustrazione concettuale**.
- `synkris-benefits.svg`: benefici funzionali, senza statistiche inventate.
- `synkris-journey.svg`: flusso concettuale di una prenotazione.
- `synkris-architecture.svg`: versione cromatica del diagramma tecnico esistente.
- `synkris-stack.svg`: versione cromatica dello stack esistente.
- `synkris-booking-flow.svg`: versione cromatica del percorso transazionale esistente.

Gli SVG del refresh sono sorgenti versionati: vengono serviti dal repository senza script o riferimenti a CDN. Mantengono descrizioni testuali con `title`/`desc` e fallback di carattere di sistema. Sono **distinti** dai nove asset storici prodotti da `docs/readme/generate-assets.py`. Rigenerare gli asset storici non rigenera o sovrascrive questi sei file.

Le screenshot `dashboard-*.webp` rimangono quelle derivate dal frontend con **fixture sintetiche**, come descritto in [README degli asset](README.md). Non sono screenshot di un'installazione reale.

## Principi per le prossime modifiche

1. Il primo schermo del README deve spiegare **cosa fa** il sistema e **per chi**.
2. Le immagini concettuali devono essere distinguibili dalle screenshot applicative.
3. La disponibilità di WhatsApp, Google Calendar, installazione e AI non va dichiarata come collaudata prima delle prove reali.
4. Nessuna metrica di clienti, percentuale di crescita o testimonianza senza fonte verificabile.
5. Stato release, licenza e rischi di sicurezza devono rimanere facilmente raggiungibili dalla pagina principale.
6. Non associare l'uso del colore viola/fucsia a un livello di conformità, sicurezza o privacy certificato.

## Tipografia delle immagini

La nuova direzione evita il tipico layout da landing page con icone, card arrotondate, mockup con KPI inventati e font generici.

- **Titoli:** condensato pesante `Impact / Nimbus Sans Narrow / DejaVu Sans Condensed`, con composizione editoriale; gerarchia definita da dimensioni e allineamento, non da effetti glow.
- **Annotazioni e microcopy:** `Consolas / DejaVu Sans Mono`; tono da pannello tecnico.
- **Forme:** griglie leggere, filetti, numerazione e pannelli rettangolari; viola e fucsia usati per gerarchia e identificazione.
- **Immagini:** nessuna percentuale inventata, nessun conteggio clienti fittizio spacciato per risultato, nessuna screenshot sintetica presentata come produzione.

I nomi dei font sono semplici fallback di sistema; **il repository non incorpora né distribuisce font**. Il rendering dei testi può variare in base al sistema dell'utente.

## Statistiche GitHub

Il README mostra badge `Shields.io` per metriche **dinamiche** (stelle, fork, issue, ultimo commit), più il badge ufficiale del workflow CI. Un badge da un contatore di terze parti stima il numero di **richieste alla propria immagine**: non è il numero di persone che hanno visitato il repository. La metrica ufficiale GitHub Insights → Traffic è accessibile ai gestori autorizzati; il README rimanda a quella schermata senza inventare un numero di visite.

Questi badge sono **risorse esterne**: richiedono Internet, possono non caricarsi e i fornitori ricevono le richieste necessarie a servirli. Le immagini SVG principali e gli screenshot del progetto rimangono locali nel repository.

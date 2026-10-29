# Technische Dokumentation — WhatsApp-Backup

Ablaufbeschreibung von `backup.js`. Genannte Funktionsnamen finden sich dort.

Es gibt zwei Backup-Quellen mit identischem Ausgabeformat:

- **WhatsApp Web** (`backup.js`) — Abschnitte 1–10.
- **USB, offline** (`usb-backup.js`) — Abschnitt 11.

## 1. Komponenten

| Komponente | Aufgabe |
|---|---|
| `Node-finden.bat` | findet die portable oder installierte Node.js-Laufzeit für alle Starter |
| `Backup-starten.bat` | startet das Web-Backup; fehlende npm-Pakete werden nur für diesen Ablauf installiert |
| `usb-decrypt.js` | prüft den Python-Einstiegspunkt, entschlüsselt über `wa_crypt_tools.wadecrypt` und prüft SQLite |
| `usb-contacts.js` | liest Kontakte aus `wa.db` (Adressbuchname, WhatsApp-Name, Nummer) und verknüpft `@lid`-IDs mit Telefonnummern |
| `usb-wal.js` | wertet das Write-Ahead-Log der Live-Datenbanken aus und schreibt `wal-bericht.html/.json` |
| `backup.js` | Steuerprogramm (Web-Backup) + Ausgabe-Funktionen |
| `web-history.js` | öffnet Chats, scrollt zurück, wiederholt das Nachladen und hält Nachrichtenschnappschüsse bis zum Export vor |
| `web-media.js` | lädt Medien mit Snapshot-Fallback, Wiederholungen und Fehlerdiagnose |
| `build-exe.ps1` / `windows/Launcher.cs` | erstellt eine EXE mit Node.js, Paketen und Chrome; entpackt Programmdateien beim ersten Start |
| whatsapp-web.js | steuert WhatsApp Web, liest dessen interne Datenmodelle |
| Puppeteer + Chrome | startet den Browser, in dem WhatsApp Web läuft |
| `usb-backup.js` | Offline-Backup per ADB (Abschnitt 11) |
| `Backup-pruefen.bat` | Integritätsprüfung (Abschnitt 9) |

Das Web-Backup kommuniziert nicht direkt mit WhatsApp-Servern. Es liest das in
Chrome geladene, normale WhatsApp Web aus.

## 2. Start

- Argumente: `--pruefen [ordner]` (nur Integritätsprüfung, ohne Browser),
  `--alle`, `--chats N`, `--limit N`, `--wait N` (Standard 30 s).
- Watchdog: kein QR-Scan bzw. kein „ready" innerhalb von 5 Minuten → Abbruch.
  Jeder neue QR-Code setzt den Timer zurück.

## 3. Anmeldung

- Chrome (von Puppeteer mitgeliefert) lädt `web.whatsapp.com` sichtbar.
- Keine Sitzungsspeicherung (NoAuth): jeder Start verlangt einen QR-Scan.
  Dadurch sind wechselnde Geräte/Konten möglich.
- Nach „ready" wartet das Programm `--wait` Sekunden, da WhatsApp die Historie
  erst nach und nach vom Handy überträgt.
- „ready" kann mehrfach feuern (Reload der Seite); ein Flag verhindert
  Mehrfachstarts.

## 4. Vorbereitung

- `patchChatSerialization`: ersetzt `getChatModel` der Bibliothek durch eine
  fehlertolerante Variante. Das Original wirft bei aktuellen
  WhatsApp-Versionen beim Auflösen der „letzten Nachricht" einen
  IndexedDB-Fehler; ein defekter Chat bricht sonst die gesamte Chat-Liste ab.
- Zielordner: `backup/<Kontonummer>_<Profilname>_<JJJJ-MM-TT_HH-MM-SS>/`,
  Daten aus der aktiven Sitzung.

## 5. Chat-Liste und Auswahl

- Kontakte laden → Namens-Cache (ID → Name).
- `getAllChats`: `getChats()` der Bibliothek; bei Fehler Fallback über
  Chat-IDs aus `WAWebCollections` mit Einzelabruf (defekte Chats werden
  übersprungen). Systemeintrag `0@c.us` wird entfernt.
- Auswahl (`selectChatsGui`): Tab im selben Chrome mit Checkbox-Liste,
  Suchfeld, Alle/Keine, Nachrichten-Limit. Rückgabe per `exposeFunction`.
  Fenster schließen = Abbruch. `--alle`/`--chats N` überspringen die GUI;
  Fallback ist eine Konsolenauswahl.

## 6. Automatische Ladephase und Sicherung pro Chat (backupChat)

Vor dem Export läuft `prepareHistories` aus `web-history.js` über **alle**
ausgewählten Chats. Jeder Chat wird geöffnet und, sofern möglich, seine
Historien-Synchronisierung angefordert. Das Öffnen kann den Lesestatus verändern.
Anschließend wird der Nachrichtenbereich nach oben gescrollt und über dieselbe
interne Funktion wie `fetchMessages` (`WAWebChatLoadMessages.loadEarlierMsgs`)
schrittweise nachgeladen. Auch nach leeren Ergebnissen wird weiter versucht:
Erst fünf Versuche ohne ältere Nachrichten mit drei Sekunden Abstand beenden
die Ladephase dieses Chats. Neue eingehende Nachrichten verlängern diese
Wartephase nicht. Einzelne Schritte sind auf 60 Sekunden begrenzt; Ladefehler
brechen vor dem Export ab.

Nachrichten werden anhand ihrer ID dedupliziert und je Chat als temporäre
JSON-Datei im Benutzer-Tempordner zwischengespeichert. So bleiben Nachrichten
auch bei Verdrängung aus dem Browsermodell erhalten; nur ein Chat muss zur Zeit
im Arbeitsspeicher gehalten werden. Die temporären Dateien werden nach dem
Export oder bei Fehlern entfernt (bei erzwungenem Prozessabbruch können sie
zurückbleiben). Es werden keine Nachrichten gesendet.

`history-ladebericht.json` im Backup enthält Anzahl und ältestes Datum pro Chat,
Warnungen und den Status `web-history-end` (WhatsApp meldet keine früheren
Nachrichten) oder `stalled` (kein Fortschritt, Verlaufsanfang unbestätigt).
Beides ist kein Nachweis, dass der gesamte Handy-Verlauf verfügbar war.
Der Bericht wird durch das Prüfsummen-Manifest mit abgesichert.

1. Ordner `<Chatname>/` (Sonderzeichen → `_`, Namenskollision → ID-Suffix)
   mit Unterordner `media/`.
2. Die vorgeladenen Schnappschüsse werden als `Message`-Objekte rekonstruiert,
   chronologisch sortiert und auf die neuesten N Nachrichten begrenzt (0 = alle).
   Ist ein Stichtag gesetzt (`--seit` oder Feld „ab Datum"), werden
   Nachrichten mit älterem Zeitstempel verworfen — gesichert wird nur der
   Zeitraum ab dem Stichtag, der in Dokumentation und Beweis-Deckblatt steht.
3. `resolveNames`: Absender und Gruppenereignis-Beteiligte (auch `@lid`-IDs)
   über die internen Kontaktfunktionen auflösen.
   Reihenfolge: Kontaktname → Absender-Anzeigename → Telefonnummer → ID.
4. Datensatz je Nachricht (Felder siehe unten). Vorher wird
   `id._serialized` ergänzt, falls WhatsApp nur `$1` liefert — sonst
   scheitert der Mediendownload.
   Sondertypen: `call_log` → Video/Dauer/verpasst (+ Rohfelder in
   `call.raw`); `vcard` → Name/Telefonnummern aus dem vCard-Text;
   `gp2` → Untertyp, Auslöser, Betroffene.
5. Medien: `web-media.js` versucht zuerst `downloadMedia()` der Bibliothek.
   Fehlt nach der Ladephase das Live-Modell oder dessen `mediaData`, wird
   alternativ der WhatsApp-DownloadManager mit den im Schnappschuss erhaltenen
   Download-/Entschlüsselungsmetadaten aufgerufen. Die Entschlüsselung erfolgt
   weiterhin im Browser. Medientypen werden auch ohne `hasMedia`-Flag erkannt.
   Seit Version 1.0.1 wird `mimetype` ausdrücklich an `downloadAndMaybeDecrypt`
   übergeben, um den bei neueren WhatsApp-Versionen dokumentierten Fehler
   `InvalidMediaFileType` zu vermeiden (wwebjs/whatsapp-web.js#201908).
   Vorübergehende Fehler werden bis zu dreimal versucht; HTTP 404/410 gelten als
   nicht verfügbare Serverdatei. Fehler werden ohne Schlüssel oder signierte URLs
   in `media-fehler.json` und im jeweiligen Datensatz (`mediaError`) protokolliert,
   einschließlich der Phase (`metadata` bzw. `download-decrypt`).
   Ablage erfolgreicher Downloads als
   `JJJJ-MM-TT_<NachrichtenID>.<endung>`. Vorhandene Dateien werden
   übersprungen, abgelaufene als „nicht verfügbar" gezählt.
6. Ausgabe: `messages.json` (chronologisch) und `chat.html`
   (Blasenansicht, Medien eingebettet, Suchfeld, Anker `#m<Nr>` je
   Nachricht).

## 7. Übersichtsseite

`index.html`: Tabelle aller Chats plus Volltextsuche. Die Nachrichtentexte
sind in die Datei eingebettet, weil Browser bei lokal geöffneten Dateien
(`file://`) kein Nachladen erlauben — die Suche funktioniert dadurch offline.
Treffer verlinken auf `chat.html#m<Nr>`.

## 8. Beweise

`beweise.html`:

- Markierung per ⚖️: einzelne Nachrichten (im Chat oder Suchtreffer),
  ganze Chats (Übersicht).
- Speicherung im localStorage des Browsers unter `wab:marks:<Backup-ID>`;
  die Backup-Dateien bleiben unverändert, das Manifest bleibt gültig.
- Darstellung mit Herkunft: Chat, Datum, Absender, Position im Verlauf,
  Link zur Originalnachricht.
- PDF-Export über die Druckfunktion des Browsers („Als PDF speichern"):
  Deckblatt mit Konto- und Backup-Angaben, alle Beweise, Anhang = diese
  Dokumentation.

## 9. Integritäts-Manifest

- `writeManifest`: SHA-256 je Datei → `manifest.json`; `manifest.sha256`
  enthält den Hash des Manifests.
- Prüfung: `Backup-pruefen.bat` (Doppelklick = neuestes Backup, Ordner
  auf die Datei ziehen = dieser Ordner) oder
  `node backup.js --pruefen [ordner]`.
- Gemeldet werden veränderte, fehlende und zusätzliche Dateien sowie ein
  verändertes Manifest. Exit-Codes: 0 = unversehrt, 1 = Abweichungen,
  2 = kein Backup gefunden.
- Grenze: Wer Dateien und Manifest zusammen neu berechnet, bleibt
  unentdeckt. Dagegen hilft nur, den Inhalt von `manifest.sha256` separat
  aufzubewahren.

## 10. Ende

- Chrome wird geschlossen. Windows-Meldungen über nicht beendbare
  Chrome-Prozesse sind folgenlos.
- Das verknüpfte Gerät bleibt im WhatsApp-Konto gelistet. Trennen:
  Handy → WhatsApp → Einstellungen → Verknüpfte Geräte → Abmelden.
  Das Programm erinnert am Ende daran.

## 11. USB-Backup (usb-backup.js)

Offline-Weg ohne Internet; erzeugt dasselbe Ausgabeformat wie das Web-Backup
(die HTML-/JSON-/Manifest-Funktionen aus `backup.js` werden wiederverwendet).

Ablauf:

1. `adb`-Prüfung: Gerät verbunden und autorisiert?
2. **Gerootetes Handy (`--root`): aktueller Stand direkt aus der App.**
   `msgstore.db` und `wa.db` werden aus `/data/data/com.whatsapp/databases`
   gelesen, jeweils mit `-wal` und `-shm` in einem einzigen tar-Strom
   (`adb exec-out "su -c '… tar -cf - …'"`), damit alle Dateien denselben
   Zeitpunkt zeigen. Am Handy wird nichts verändert; kein Schlüssel nötig.
   - Die Dateien liegen unverändert im Backup unter `rohdaten/` (SHA-256 im
     Manifest; Größe, Änderungszeit und Rechte am Handy im WAL-Bericht).
   - In einer Arbeitskopie wird das Write-Ahead-Log eingearbeitet
     (`PRAGMA wal_checkpoint(TRUNCATE)`, danach `PRAGMA quick_check`); bei
     einer uneinheitlichen Kopie wird bis zu dreimal neu gelesen.
   - **WAL-Bericht** (`wal-bericht.html` + `wal-bericht.json`): Aufbau des Logs
     (Kopf, Salt, Prüfsummenkette je Frame nach SQLite-Spezifikation), Status
     jedes Frames (festgeschrieben / nicht festgeschrieben / veraltet, mit
     Byte-Position), betroffene Seiten und Tabellen (`dbstat`) und der
     inhaltliche Vergleich Stand A (Hauptdatei allein) gegen Stand B
     (Hauptdatei + Log): neue, geänderte und gelöschte Zeilen je Tabelle, bei
     Nachrichten mit Zeit, Chat und Text. Nachrichten, deren Stand aus dem Log
     kommt, tragen im Chat die Marke „WAL“ und in `messages.json` das Feld
     `walHerkunft`. Veraltete Frames fließen nicht in den Export ein, bleiben
     aber in `rohdaten/` erhalten.
   - Nur wenn der direkte Zugriff scheitert: Sicherungsdatei wie unten, mit
     der per Root kopierten Schlüsseldatei (`files/key` bzw.
     `files/encrypted_backup.key`).
3. Ohne Root — Schlüssel: standardmäßig per `adb shell uiautomator dump`: der offene
   Schlüssel-Screen wird als UI-XML ausgelesen und der 64-Hex-Wert extrahiert
   (mit Bestätigung); Fallback ist die Eingabe von Hand. Grund: USB-Debugging
   erlaubt keinen Zugriff auf die private Schlüsseldatei (Sandbox), wohl aber
   das Auslesen des angezeigten Texts — sofern der Screen nicht FLAG_SECURE
   gesetzt hat.
4. Ohne Root — Pull: `msgstore.db.crypt15` (bzw. crypt14; Stand der letzten
   WhatsApp-Sicherung) aus dem öffentlichen Speicher
   (`/sdcard/Android/media/com.whatsapp/...`), Entschlüsselung über
   `wa-crypt-tools` (Python). crypt14 geht nur mit der Schlüsseldatei selbst.
5. `Media`-Ordner aus dem öffentlichen Speicher.
6. Auslesen mit dem eingebauten `node:sqlite`: Tabellen `chat`, `jid`,
   `message`, `message_media`, `call_log`. Nachrichtentyp aus `message_type`
   und MIME abgeleitet. Namen aus `wa.db` (`wa_contacts`, `wa_address_book`);
   neuere Chats laufen unter `@lid`-IDs und werden über `jid_map` der
   Telefonnummer zugeordnet. Anzeigename: Adressbuch, sonst „~WhatsApp-Name“,
   sonst Nummer. Die Übersicht zeigt Adressbuchname, WhatsApp-Name und Nummer
   getrennt. Medien werden in die Chat-Ordner kopiert.
   Systemnachrichten (`message_type` 7) werden über `message_system`
   (`action_type`) und die `message_system_*`-Tabellen (Beteiligte, eigener
   Beitritt, Nummernwechsel, Datenschutz-Anbieter) dekodiert, z. B. „Du hast
   die Gruppe „X“ erstellt“ oder der Verschlüsselungshinweis am Chatbeginn.
   Codes ohne belastbare Quelle werden nicht gedeutet, sondern als
   „Systemereignis (WhatsApp-Code N)“ mit den Beteiligten ausgegeben.
7. Ausgabe wie beim Web-Backup, Zielordner `backup/USB_<Zeitstempel>/`; die
   Datenquelle (Live-Datenbank oder Sicherungsdatei) steht im Infoblock.

Grenzen: Das Schema variiert je WhatsApp-Version; sehr alte/neue Versionen
können abweichen. Ohne `wa.db` (kein Root) erscheinen unbekannte Absender als
Telefonnummer. Der Live-Abzug ist eine logische Kopie der Datenbankdateien,
kein Abbild der Partition: Inhalte, die SQLite bereits überschrieben hat
(freie Seiten der Hauptdatei ausgenommen, die in `rohdaten/` mitkommen), sind
nicht wiederherstellbar.

## Ergebnisstruktur

```
backup/
└── 491700000000_Beispielkonto_2026-07-16_17-35-52/
    ├── index.html          Übersicht + Volltextsuche
    ├── beweise.html        markierte Beweise + PDF-Export
    ├── dokumentation.html  diese Dokumentation
    ├── manifest.json       SHA-256 aller Dateien + Metadaten
    ├── manifest.sha256     Hash des Manifests
    ├── wal-bericht.html    nur USB mit Root: was im Write-Ahead-Log stand
    ├── wal-bericht.json    dasselbe maschinenlesbar (inkl. aller Frames)
    ├── rohdaten/           nur USB mit Root: msgstore.db/wa.db (+ -wal, -shm) unverändert vom Handy
    ├── Klasse_3d/
    │   ├── messages.json   alle Nachrichten, maschinenlesbar
    │   ├── chat.html       Chat-Ansicht mit Suche
    │   └── media/          2026-06-30_<ID>.jpg, …
    └── …
```

## Felder in messages.json

| Feld | Bedeutung |
|---|---|
| `id` | WhatsApp-Nachrichten-ID |
| `timestamp` / `date` | Unix-Zeit / lesbares Datum |
| `fromMe` | von diesem Konto gesendet |
| `senderId` / `senderName` | Absender-ID / aufgelöster Name |
| `type` | `chat`, `image`, `video`, `ptt`, `document`, `sticker`, `call_log`, `vcard`, `gp2`, `revoked`, … |
| `body` | Nachrichtentext (bei `vcard`: roher vCard-Text) |
| `hasMedia`, `mediaFile`, `mediaMimetype` | Anhang vorhanden / Dateiname in `media/` / Dateityp |
| `call` | nur `call_log`: `{video, duration, missed, raw}` |
| `contacts` | nur `vcard`: `[{name, phones}]` |
| `group` | nur `gp2`: `{subtype, actor, members}` |

## Workarounds

WhatsApp Web ändert sich laufend; diese Abweichungen fängt `backup.js` ab:

1. `getChats()` bricht bei einem defekten Chat komplett ab →
   Laufzeit-Patch von `getChatModel` + Einzelabruf-Fallback.
2. Nachrichten-ID-Feld heißt teils `$1` statt `_serialized` →
   Feld wird vor Mediendownloads ergänzt.
3. `Infinity` als Limit wird bei Browser-Übergabe zu `null` →
   große endliche Zahl.
4. `ready`-Ereignis feuert mehrfach → Sperr-Flag.
5. Seiten-Reload während der Initialisierung wirft eine unbehandelte
   Ausnahme → wird abgefangen, die Bibliothek injiziert sich selbst neu.

## Grenzen

- Gesichert wird der Stand des Web-Clients. Direkt nach der Anmeldung ist
  die Historie unvollständig; längeres `--wait` oder späterer zweiter Lauf
  holt mehr.
- Abgelaufene Medien sind nicht mehr beschaffbar.
- Anruf- und Gruppenereignis-Details existieren nur in Backups ab der
  Version, die sie erfasst.
- WhatsApp erlaubt Automatisierung offiziell nicht; ein WhatsApp-Update
  kann das Tool vorübergehend brechen.
- Das Backup liegt unverschlüsselt auf der Festplatte.

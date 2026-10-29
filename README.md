# WhatsApp-Backup

Sichert alle WhatsApp-Chats inklusive Mediendateien lokal auf diesen Rechner.

## Schnellstart

**[Windows-EXE herunterladen](https://github.com/AndroidIosForensik/WhatsAppWebBackup/releases/latest)**
– anschließend `WhatsApp-Backup.exe` in einem beschreibbaren Ordner starten.

**Als Windows-EXE:** `dist/WhatsApp-Backup.exe` doppelklicken. Node.js, die
Programmpakete und Chrome sind enthalten; eine Node.js-Installation ist nicht nötig.
Beim ersten Start entpackt sich das Programm neben die EXE in
`WhatsApp-Backup-Dateien/`. Backups landen daneben unter `backup/`.
Die einzelne EXE kann in einen beliebigen beschreibbaren Ordner kopiert werden.
USB benötigt weiterhin ADB und Python mit `wa-crypt-tools`.

EXE neu bauen: `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-exe.ps1`.
Der Build benötigt vorhandene npm-Pakete, den Puppeteer-Browser, Node.js und den
C#-Compiler des .NET Frameworks. Er bündelt ausschließlich Programmdateien,
keine vorhandenen Backups oder Anmeldesitzungen.
Offline-Selbsttest: `dist\WhatsApp-Backup.exe --self-test`.

**`Start.bat` doppelklicken.** Das ist der geführte Assistent, der durch alles
leitet — er findet Node.js (auch portabel) und fragt
dann, was du tun möchtest:

1. **WhatsApp Web sichern** — QR-Code scannen, kein Kabel. Daten laufen
   Ende-zu-Ende-verschlüsselt über die WhatsApp-Server.
2. **USB sichern (offline)** — zieht die Datenbank per Kabel, ohne Internet,
   und entschlüsselt sie. Siehe [USB-Backup (offline)](#usb-backup-offline).
3. **Lesende Zustandssicherung** — bewahrt den jetzigen Stand, ohne am Handy
   etwas zu verändern.
4. **Integrität prüfen** — rechnet die SHA-256-Prüfsummen eines Backups nach.
5. **Backup öffnen** — zeigt die Übersicht (Suche/Beweise) im Browser.

Der Assistent prüft Voraussetzungen, stellt die nötigen Rückfragen und startet
den passenden Ablauf. Jede Funktion gibt es weiterhin auch einzeln als
`.bat`-Datei (`Backup-starten.bat`, `USB-Backup.bat`, `Lesend-sichern.bat`,
`Backup-pruefen.bat`) oder per Kommandozeile.

> 📖 Wie das Backup technisch im Detail abläuft, steht in der
> [technischen Dokumentation](DOKUMENTATION.md).

### Ohne Node.js-Installation starten

Die Anwendung benötigt weiterhin die Node.js-Laufzeit, aber keine systemweite
Installation und keine Administratorrechte:

1. Auf der [offiziellen Downloadseite](https://nodejs.org/en/download) **Node.js
   24 LTS für Windows als ZIP** auswählen (passend zu x64 oder ARM64).
2. Den Inhalt des ZIP-Unterordners in einen Ordner `runtime` neben `Start.bat`
   entpacken. Danach muss `runtime/node.exe` existieren.
3. `Start.bat` oder einen der einzelnen Starter doppelklicken.

Für USB-Sicherung und Integritätsprüfung genügt auch eine einzelne `node.exe`
neben `Start.bat`. Für WhatsApp Web den vollständigen ZIP-Inhalt einschließlich
npm verwenden; dessen Pakete werden erst beim ersten Web-Backup installiert.
USB benötigt weiterhin ADB sowie Python mit `wa-crypt-tools`, aber keine npm-Pakete.

### Fehler „No module named wa_crypt_tools.decrypt“

Das ist ein Programmaufruf-Fehler, kein Nachweis für einen falschen Schlüssel.
Der richtige Einstiegspunkt heißt `wa_crypt_tools.wadecrypt`. Der USB-Ablauf
prüft jetzt diesen Einstiegspunkt vor dem Kopieren und verwendet denselben
Python-Interpreter zur Entschlüsselung. Zur Prüfung/Reparatur:

```powershell
python -m wa_crypt_tools.wadecrypt --help
python -m pip install --upgrade wa-crypt-tools
```

Der Hex-Schlüssel wird direkt an das Werkzeug übergeben; es wird keine
`key.hex`-Textdatei mehr angelegt. Erfolg setzt einen erfolgreichen Werkzeuglauf
und eine gültige SQLite-Datenbank voraus. Erst danach werden Medien kopiert.

### Kontaktnamen beim USB-Backup (offline, ohne Root)

Zusätzlich zur Nachrichtensicherung nimmt der Export automatisch
`WhatsApp/Backups/wa.db.crypt15` aus demselben WhatsApp-Verzeichnis mit und
entschlüsselt sie mit demselben E2E-Schlüssel. Namen aus `wa_contacts` werden
für Chat-Titel und Absender verwendet, auch für direkt gespeicherte `@lid`-IDs.
Das funktioniert ohne WhatsApp Web und ohne Root.

Der Export meldet die Anzahl gelesener Kontakte. Die Datei kann vorhanden sein,
aber keine Kontaktnamen enthalten; dann bleibt die Anzeige bei Telefonnummern
oder ausdrücklich als **WhatsApp-ID** bezeichneten internen IDs. Fehlende oder
defekte Kontaktsicherungen werden gemeldet, der Chat-Export läuft weiter.
Bei `--root` wird zusätzlich die zugängliche interne `wa.db` verwendet.
Die temporären Datenbankkopien werden nach erfolgreichem Export gelöscht.

## WhatsApp Web (Detail)

Direkt ohne Assistent: **`Backup-starten.bat`** oder per Kommandozeile:

```powershell
npm start
```

1. Es öffnet sich ein Browser-Fenster mit WhatsApp Web.
2. **Bei jedem Start**: QR-Code mit dem Handy scannen
   (WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen).
   Es wird **keine** Sitzung gespeichert — so kann sich jedes Mal ein
   beliebiges Gerät/Konto anmelden.
3. Nach dem Anmelden öffnet sich im selben Browser ein **Auswahlfenster** (siehe
   unten): Chats anhaken, Nachrichten-Limit setzen, „Sicherung starten" klicken.
4. Das Tool öffnet nacheinander alle ausgewählten Chats, scrollt automatisch
   nach oben und lädt ältere Nachrichten nach. Ein leeres Zwischenergebnis
   beendet das Laden nicht sofort: Es folgen bis zu fünf Versuche mit jeweils
   drei Sekunden Abstand. Der Fortschritt zeigt Anzahl und ältestes Datum.
5. Erst nach dieser Ladephase aller ausgewählten Chats beginnt der Export der
   Nachrichten und Medien. Limit und Stichtag begrenzen nur den Export.
   Am Ende beendet es sich selbst.

`history-ladebericht.json` dokumentiert pro Chat das älteste geladene Datum und
ob WhatsApp Web das Ende des verfügbaren Verlaufs meldet oder das Nachladen
ohne Fortschritt stehen blieb. Eine vollständige Übereinstimmung mit dem Handy
kann WhatsApp Web nicht garantieren. Handy während der Ladephase online lassen;
im Browser nicht selbst zwischen Chats wechseln. Das automatische Öffnen von
Chats kann deren Lesestatus in WhatsApp verändern.
Ein Ladefehler oder ein einzelner Ladeschritt über 60 Sekunden bricht den Lauf
vor dem Export ab. Temporäre Nachrichtenkopien werden anschließend entfernt.

### Chats auswählen (Auswahlfenster)

Nach der Anmeldung erscheint eine anklickbare Liste aller Chats:

- **Chats anhaken**, die gesichert werden sollen (Zeile klicken genügt).
- **Suchfeld** oben grenzt die Liste nach Namen ein.
- **„Alle" / „Keine"** markiert alle gerade angezeigten Chats bzw. hebt die
  Auswahl auf. (Bei aktivem Suchfilter wirkt „Alle" nur auf die Treffer.)
- **„Nachrichten/Chat"** legt fest, wie viele Nachrichten je Chat gesichert
  werden (`0` = alle).
- **„Sicherung starten"** beginnt das Backup der markierten Chats.

Wird das Auswahlfenster geschlossen, ohne zu starten, bricht der Lauf ab, ohne
etwas zu sichern.

Jeder Lauf legt einen **eigenen neuen Unterordner** an (benannt nach der
Kontonummer, dem Profilnamen und dem Zeitstempel), sodass sich die Backups
verschiedener Geräte nie gegenseitig überschreiben.

Optionen (auch an `Backup-starten.bat` anhängbar) für den **nicht-interaktiven**
Betrieb, wenn kein Auswahlfenster erscheinen soll:

```powershell
node backup.js --alle        # alle Chats ohne Auswahlfenster
node backup.js --chats 10    # nur die 10 zuletzt aktiven Chats
node backup.js --limit 200   # max. 200 Nachrichten pro Chat (schneller Test)
node backup.js --wait 90     # 90 s auf History-Sync warten (Standard: 30 s)
```

**Tipp:** Da bei jedem Start neu angemeldet wird, überträgt WhatsApp die
Chat-Historie erst nach und nach vom Handy. Wenn ein Backup zu wenige alte
Nachrichten enthält, hilft eine höhere Wartezeit, z. B. `--wait 120`, und das
Handy während des Laufs online zu lassen.

### Zeitraum eingrenzen (nur ab einem Stichtag sichern)

Statt des gesamten Verlaufs lässt sich das Backup auf **Nachrichten ab einem
Datum** beschränken — z. B. um nur ab einem festgelegten Zeitpunkt zu erheben:

- Im Auswahlfenster das Feld **„ab Datum"** setzen, oder
- per Argument: `node backup.js --seit 2026-06-20`
  (auch mit Uhrzeit: `--seit "2026-06-20 08:00"`).

Der gesicherte Zeitraum wird oben in der Dokumentation, im Deckblatt der
Beweise-Seite und im Konsolenprotokoll ausdrücklich vermerkt. Beim USB-Backup
funktioniert `--seit` genauso (dort filtert bereits die Datenbankabfrage, es
werden also gar keine älteren Nachrichten ausgelesen).

## Ergebnis

Jeder Lauf legt unter `backup/` einen eigenen Unterordner an:

```
backup/
├── 491700000000_Beispielname_2026-07-16_14-30-05/   ← ein Lauf / ein Gerät
│   ├── index.html          ← Übersicht + Volltextsuche (im Browser öffnen)
│   ├── Max_Mustermann/
│   │   ├── chat.html        ← Chat-Ansicht im WhatsApp-Stil
│   │   ├── messages.json    ← alle Nachrichten als strukturierte Daten
│   │   └── media/           ← Bilder, Videos, Sprachnachrichten, Dokumente
│   └── Familiengruppe/
│       └── ...
└── 491700000001_AnderesGerät_2026-07-16_15-02-11/
    └── ...
```

Der Ordnername besteht aus **Kontonummer, Profilname und Zeitstempel**. So bleibt
jedes Backup — auch von verschiedenen Geräten — getrennt und wird nie überschrieben.

### Sondernachrichten

Neben Text und Medien werden auch dargestellt:

- **Anrufe** — 📞 Sprachanruf / 📹 Videoanruf, mit Dauer (`1:23`) bei
  angenommenen und rot als „Verpasster Anruf" bei verpassten.
- **Kontaktkarten** — 👤 Name — Telefonnummer (statt des rohen vCard-Texts).
- **Gruppen-Ereignisse** — 👥 als zentrierte Systemzeile, z. B. „Bob wurde
  hinzugefügt", „Bob wurde entfernt", „Bob ist jetzt Admin", „Bob ist kein
  Admin mehr", „Bob hat die Gruppe verlassen", „Gruppenname geändert".
- **Gelöschte Nachrichten** — 🚫 als Hinweis.

> Hinweis: Details zu Anrufen (Video/verpasst/Dauer) und Gruppen-Ereignissen
> (wer wen hinzugefügt/entfernt/befördert hat) stehen nur in Backups zur
> Verfügung, die **ab dieser Version** erstellt wurden. In älteren Backups fehlt
> die Information; solche Einträge werden vereinfacht dargestellt.

## Suchen

Die `index.html` eines Backups hat oben eine **Suchleiste**. Sie durchsucht
sowohl Chatnamen als auch **alle Nachrichteninhalte**:

- Tippen genügt — die Treffer erscheinen sofort (mehrere Wörter = UND-Suffix,
  Groß-/Kleinschreibung und Umlaute egal).
- Jeder Treffer zeigt Chat, Datum, Absender und einen Ausschnitt mit
  hervorgehobenem Suchwort. Ein Klick springt direkt zur passenden Nachricht im
  Chat und markiert sie kurz.
- Jede Chat-Ansicht (`chat.html`) hat zusätzlich oben ein eigenes Suchfeld, das
  nur diesen Chat filtert.

Die Suche funktioniert komplett offline im Browser — es müssen keine Dateien
nachgeladen werden, ein Doppelklick auf `index.html` reicht.

## Beweise markieren und als PDF exportieren

Nachrichten oder ganze Chats lassen sich als **Beweis** markieren:

- **Einzelne Nachricht:** im Chat (`chat.html`) mit der Maus über die Nachricht
  fahren und **⚖️** anklicken — auch direkt in den Suchtreffern der Übersicht
  möglich. Markierte Nachrichten bekommen einen goldenen Rahmen.
- **Ganzer Chat:** in der Übersicht (`index.html`) auf das **⚖️** vor dem
  Chatnamen klicken.

Alle Markierungen landen in der Seite **`beweise.html`** (verlinkt oben in der
Übersicht und in jedem Chat). Dort ist jeder Beweis vollständig zu sehen —
Bilder inklusive — und bei Einzelnachrichten steht immer die **Herkunft**
dabei: Chat, Datum, Absender, Position im Verlauf und ein Link zur
Originalnachricht.

**Als PDF exportieren:** Auf der Beweise-Seite den Knopf
„Als PDF exportieren (inkl. Dokumentation)" klicken und im Druckdialog des
Browsers **„Als PDF speichern"** wählen. Das PDF enthält ein Deckblatt
(Backup, Konto, Datum, Umfang), alle markierten Beweise mit Herkunftsangaben
und als Anhang die komplette technische Dokumentation.

> Markierungen werden lokal im Browser gespeichert (localStorage), getrennt je
> Backup — sie verändern die Backup-Dateien selbst **nicht** (wichtig für die
> Integritätsprüfung). Am selben Rechner/Browser bleiben sie beim erneuten
> Öffnen erhalten.

## Nach dem Backup: Gerät wieder trennen

Nach jedem Lauf bleibt der Backup-Browser als „verknüpftes Gerät" in deinem
WhatsApp-Konto gelistet. Zum Trennen: **Handy → WhatsApp → Einstellungen →
Verknüpfte Geräte → Eintrag antippen → Abmelden.** Das Tool erinnert am Ende
jedes Laufs daran.

## USB-Backup (offline)

Zieht die WhatsApp-Datenbank direkt per USB-Kabel vom Android-Handy und
entschlüsselt sie lokal — **ohne Internet**. Ergebnis ist dasselbe wie beim
Web-Backup (index.html, chat.html, Suche, Beweise, Manifest, Doku).

**Voraussetzungen:**

- Android-Handy per USB verbunden, **entsperrt**, **USB-Debugging an**
  (Entwickleroptionen), die adb-Anfrage am Handy bestätigen.
- **adb** (Android Platform-Tools) im PATH:
  <https://developer.android.com/tools/releases/platform-tools>
- **Python + wa-crypt-tools** für die Entschlüsselung: `pip install wa-crypt-tools`
- Den **64-stelligen E2E-Schlüssel** in der App sichtbar machen: WhatsApp →
  Einstellungen → Chats → Backup → E2E-verschlüsseltes Backup →
  **Schlüssel anzeigen**.

**Start:** `USB-Backup.bat` doppelklicken. Ablauf: DB + Medien werden gezogen,
das Skript beschafft den Schlüssel, entschlüsselt und exportiert.

**Schlüssel — drei Wege:**

1. **Vom Bildschirm ablesen (Standard):** Den Schlüssel-Screen in der App
   öffnen und im Skript `[Enter]` drücken. Das Skript liest den Schlüssel per
   `adb shell uiautomator` direkt vom Bildschirm und zeigt ihn zur Bestätigung
   an — kein Abtippen. Klappt nicht immer (manche Screens sind gegen Auslesen
   geschützt, FLAG_SECURE); dann Weg 2.
2. **Von Hand einfügen:** Schlüssel direkt ins Skript eingeben (Leerzeichen egal).
3. **Automatisch (`--root`):** Auf einem gerooteten Handy liest das Skript den
   lokalen Schlüssel selbst aus.

```powershell
node usb-backup.js            # Schlüssel vom Bildschirm ablesen oder eingeben
node usb-backup.js --root     # Schlüssel selbst auslesen (Handy muss gerootet sein)
node usb-backup.js --key <64hex>
node usb-backup.js --no-media # nur Texte, keine Mediendateien
node usb-backup.js --limit 500
```

> **Hinweis:** USB-Debugging gibt keinen Zugriff auf die private
> Schlüsseldatei (Android-Sandbox). Das Ablesen vom Bildschirm (Weg 1)
> umgeht das, indem es den ohnehin angezeigten Schlüssel ausliest — sofern
> der Screen nicht gegen Auslesen gesperrt ist.

**Wenn kein E2E-Backup aktiv ist:** Dann legt WhatsApp lokal eine `.crypt14`
statt `.crypt15` an. Die ist mit der lokalen Schlüsseldatei verschlüsselt, die
**nur mit Root** lesbar ist — und es gibt keinen 64-Zeichen-Schlüssel-Screen.
Das Skript erkennt das und bricht mit einer Erklärung ab. Zwei Auswege:

1. **E2E-Backup aktivieren** (empfohlen, kein Root): in WhatsApp einschalten,
   „Jetzt sichern" antippen → es entsteht eine `.crypt15`, danach läuft der
   USB-Weg normal.
2. **`--root`** auf einem gerooteten Handy: entschlüsselt auch `.crypt14`
   über die lokale Schlüsseldatei.

## Zustand sichern, ohne etwas zu verändern (--preserve)

Bevor du am Handy etwas umstellst (z. B. E2E-Backup aktivierst), kannst du den
aktuellen Stand **rein lesend** sichern:

```powershell
node usb-backup.js --preserve              # nur den WhatsApp-Ordner
node usb-backup.js --preserve --all-sdcard # gesamten oeffentlichen Speicher
```

Oder `Lesend-sichern.bat` doppelklicken. Es wird per `adb pull` kopiert (nichts
am Gerät verändert), dazu ein **`PROTOKOLL.txt`** (Datum, Gerät, Android-/
WhatsApp-Version, Quelle, Umfang) und ein **SHA-256-Manifest** geschrieben.
Ergebnis in `backup/PRESERVE_<Zeitstempel>/`.

> Das ist **kein** bit-genaues Voll-Image (das ist auf einem nicht gerooteten
> Handy nicht möglich, und ein Rohabbild wäre wegen der Datenverschlüsselung
> ohnehin unlesbar). Es ist eine logische Kopie des öffentlichen Speichers plus
> lückenloser Nachweis — der praktikable „Vorher-Zustand".

## Integrität prüfen

Am Ende jedes Backups wird automatisch ein Prüfsummen-Manifest erstellt:
`manifest.json` enthält für **jede Datei** einen SHA-256-Hash (plus Größe,
Konto, Datum), `manifest.sha256` sichert das Manifest selbst ab.

Prüfen — z. B. nach dem Kopieren auf eine externe Platte oder Jahre später:

- **`Backup-pruefen.bat` doppelklicken** → prüft das neueste Backup.
- **Einen Backup-Ordner auf `Backup-pruefen.bat` ziehen** → prüft genau diesen.
- Kommandozeile: `node backup.js --pruefen [ordner]`
  (Exit-Code 0 = in Ordnung, 1 = Abweichungen — praktisch für Skripte).

Gemeldet wird jede **veränderte**, **fehlende** oder **zusätzliche** Datei sowie
ein manipuliertes Manifest. Läuft komplett offline und braucht nur Sekunden.

> Grenze des Verfahrens: Prüfsummen erkennen jede unbeabsichtigte Veränderung
> (Bitfehler, fehlgeschlagene Kopien, versehentliches Löschen). Ein Angreifer,
> der den Ordner besitzt, könnte jedoch Dateien **und** Manifest konsistent
> neu berechnen. Wer das ausschließen will, notiert sich den Inhalt von
> `manifest.sha256` (eine Zeile) separat — z. B. ausgedruckt oder in einer
> Passwort-Datenbank.

## Wichtige Hinweise

- **Es wird gesichert, was WhatsApp Web sieht.** Sehr alte Nachrichten, die auf
  dem Handy noch nicht mit dem Web-Client synchronisiert sind, können fehlen.
  Nach der Anmeldung synchronisiert WhatsApp den Verlauf nach und nach — WhatsApp
  auf dem Handy online lassen und ggf. kurz warten, bevor das Backup läuft.
- Alte Medien, die nicht mehr auf den WhatsApp-Servern liegen, können nicht
  heruntergeladen werden (im Log als „nicht verfügbar" gezählt).
- Es wird **keine Sitzung gespeichert**: Jeder Start zeigt einen neuen QR-Code,
  damit sich ein beliebiges Gerät anmelden kann.
- Das Tool nutzt die inoffizielle Bibliothek [whatsapp-web.js](https://wwebjs.dev).
  WhatsApp erlaubt Automatisierung offiziell nicht; bei normalem Backup-Gebrauch
  ist das Risiko gering, eine Garantie gibt es aber nicht.

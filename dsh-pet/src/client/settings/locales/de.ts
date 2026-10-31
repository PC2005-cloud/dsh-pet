/**
 * 设置页德语文案；键集与 zh 完全一致。
 */
import type { Key } from './zh.ts';

export const de: Record<Key, string> = {
  nav: 'Desktop-Pet-Konfiguration',
  intro: 'Mehrere Pets verwalten: Jedes Pet hat eigene Größe und Position (gilt sofort nach dem Speichern).',
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: 'Pet-Konfiguration',
  petCardHint:
    'Einstellungen pro Pet: Name / Größe / Anzeige / Position / Offsets / die vier Funktionsschalter. Nach dem Ändern unten auf „Speichern" klicken – gilt sofort.',
  globalTitle: 'Globale Schalter',
  globalHint:
    'Gilt für alle Pets (ein Pet-Pack kann dies in seiner Art-Datei überschreiben). Diese Schalter ändern nur den lokalen Zustand und werden beim „Speichern" mit in die Benutzerkonfiguration geschrieben (kein sofortiges Schreiben); Systembenachrichtigungen werden nach dem Speichern sofort neu eingelesen, ohne Neuladen der Seite.',
  cornerHint: 'An welcher Bildschirmecke das Pet klebt (im Desktop-Modus pro Monitor-Arbeitsbereich).',
  marginXHint: 'Horizontaler Abstand zur gewählten Ecke (px), beliebige Zahl.',
  marginYHint: 'Vertikaler Abstand zur gewählten Ecke (px), beliebige Zahl.',
  // 「/」命令菜单的行标题（图标由 app.ts 经 command-faces.ts 补上）。
  'cmd.chat': 'Chat',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Guthaben',
  'shortcut.open': 'Pet-Chat öffnen',
  'shortcut.chat': 'Chatfenster öffnen',
  'shortcut.hear': 'Spracheingabe',
  shortcutCardTitle: 'Tastenkürzel',
  shortcutCardHint: 'Die erste Taste wirkt nur mit dem Zeiger auf dem Pet; Tasten mit Ctrl sind global.',
  shortcutRowChat: 'Chat öffnen',
  shortcutRowHear: 'Spracheingabe',
  shortcutRowTodo: 'Aufgaben',
  shortcutRowSleep: 'Schlafen / Aufwachen',
  shortcutRowSidebar: 'Seitenleisten-Chat öffnen',
  shortcutNoteDesktop:
    'Globale Kürzel gelten nicht im Desktop-Fenster; änderbar unter Einstellungen → Allgemein → Tastenkürzel.',
  petsLabel: 'Pet-Liste',
  add: 'Pet hinzufügen',
  remove: 'Entfernen',
  confirmRemove: 'Pet „{id}" wirklich löschen?',
  confirmTitle: 'Aktion bestätigen',
  cancel: 'Abbrechen',
  ok: 'Verstanden',
  atLeastOne: 'Mindestens ein Pet muss erhalten bleiben.',
  emptyPets: 'Noch keine Pets – auf „Pet hinzufügen" klicken, um eines zu erstellen.',
  sizeLabel: 'Größe (Breite px)',
  sizeHint: 'Höhe automatisch = Breite × 9/16.',
  sizePercentLabel: 'Max. Bildschirmbreite (%)',
  sizePercentHint:
    'Wie viel der Bildschirmbreite der Pet höchstens einnimmt: 100 = nie breiter als ein Bildschirm (bei breiten Fenstern identisch mit px); 30–40 macht ihn auf dem Handy deutlich kleiner, ohne den Desktop zu verändern. Wird beim Laden einmal berechnet; nach Größenänderung neu laden.',
  nameLabel: 'Name',
  nameHint:
    'Anzeigename: erscheint beim Hovern über dem Pet und fließt in die KI-Persona ein („Dein Name ist X"). Doppelt erlaubt; leer = es gilt die Pet-ID.',
  personaLabel: 'Persona (optional)',
  personaHint:
    'Gilt nur für dieses Pet. Leer lassen = Persona des Eintrags übernehmen – der graue Text im Feld ist genau diese. Das tatsächlich an das Modell gesendete System = dieser Text + automatisch angehängtem Hinweis „Dein Name ist <Name>" + aktuellem Zeitkontext; Name und Datum hier also nicht wiederholen.',
  personaCount: '{n} Zeichen',
  balanceEnabled: 'Guthaben-Funktion',
  balanceEnabledHint: 'Wenn aktiv, spielt dieses Pet Guthaben-Animationen und zeigt die Guthaben-Blase.',
  whisperEnabled: 'Flüstern',
  whisperEnabledHint:
    'Wenn aktiv, erzeugt dieses Pet regelmäßig per KI einen Satz und spielt die Flüstern-Animation (Persona siehe Feld „Persona" unten; leer = Eintrag übernehmen).',
  workStatusEnabled: 'Arbeitsstatus-Kopplung',
  workStatusEnabledHint:
    'Wenn aktiv, folgt dieses Pet dem DSH-Arbeitsstatus: Denken / Arbeiten / Warten auf Bestätigung / Fertig / Fehler wechseln automatisch die passende Animation und zeigen eine Blase (Animationspool in der Top-Level-Konfiguration; nur Zuhören, keine Modellaufrufe).',
  fixedEnabled: 'Pet fixieren',
  fixedEnabledHint:
    'Wenn aktiv, dreht sich das Pet bei Zufallsanimationen nicht mehr selbst um und läuft nicht weg – es spielt nur Leerlauf und kleine Aktionen am Platz. Rechtsklick-Auswahl, API-Auslöser sowie Guthaben-/Flüstern-/Arbeitsstatus-Animationen sind nicht betroffen.',
  displayLabel: 'Anzeige',
  displayHint: 'web = nur Browser / desktop = nur Desktop / both = beides / none = nichts',
  'display.web': 'Nur Browser',
  'display.desktop': 'Nur Desktop',
  'display.both': 'Beides',
  'display.none': 'Nichts',
  cornerLabel: 'Position',
  'corner.top-left': 'Oben links',
  'corner.top-right': 'Oben rechts',
  'corner.bottom-left': 'Unten links',
  'corner.bottom-right': 'Unten rechts',
  marginX: 'Horizontaler Versatz',
  marginY: 'Vertikaler Versatz',
  save: 'Speichern',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: 'Synchronisieren',
  confirmSync:
    'Wirklich synchronisieren? Die mitgelieferte Standardkonfiguration (alle Felder + Kommentare) überschreibt die Benutzerkonfiguration; Ihre aktuellen Anpassungen gehen verloren.',
  corruptTitle: 'Benutzerkonfiguration beschädigt – nicht gespeichert',
  corruptConfirm: 'Trotzdem speichern',
  corruptBody:
    'Die Benutzerkonfigurationsdatei ist nicht lesbar (beschädigt, kein gültiges JSON/JSONC): {path}. Beim Weiterspeichern wird die Datei anhand der Whitelist neu aufgebaut – alle aktuellen Inhalte (animations / physics / memes und weitere eigene Felder) gehen verloren. Abbrechen = Datei unverändert lassen (zuerst die Konfiguration reparieren, dann speichern); Bestätigen = trotzdem speichern (vorhandene Inhalte verwerfen).',
  syncHint:
    '„Synchronisieren" schreibt die mitgelieferte Standardkonfiguration (inkl. Kommentare und aller erweiterten Felder) in die Benutzerkonfigurationsdatei und überschreibt die aktuellen Anpassungen; danach ist die Datei direkt bearbeitbar. Zwei Hinweise: (1) Sobald die Datei existiert, ist sie eine explizite Override-Schicht – spätere Änderungen an den mitgelieferten Standards greifen nicht automatisch (außer bei erneuter Synchronisierung oder Löschen der Datei); (2) „Speichern" auf dieser Seite schreibt die Datei anhand der Whitelist neu (Feldwerte bleiben, Kommentare entfallen).',
  configMeta: 'Erweitert (Dateien)',
  configMetaHint:
    'Die Benutzerkonfiguration kann Pet-Liste / Animationspools / Wiedergabegewichtung überschreiben; Änderungen greifen nach Aktualisieren oder Neustart: im Browser die Seite neu laden, im Desktop-Modus Rechtsklick auf das Pet → „Konfiguration neu laden" (lädt alle Desktop-Pet-Fenster neu); die Standardkonfiguration ist die vollständige Referenz.',
  defaultConfig: 'Standardkonfiguration (schreibgeschützt, vollständige Referenz)',
  userConfig: 'Benutzerkonfiguration (eigene Überschreibungen)',
  todosFile: 'To-do-Daten (Listentext, Fälligkeit und Erledigt-Status; Löschen entspricht alle To-dos leeren)',
  animationDir: 'Verzeichnis der Animations-Assets (Animationen anpassen/ergänzen)',
  memesDir: 'Verzeichnis der Meme-Bilder (Bilder anpassen/ergänzen)',
  logFile: 'Protokolldatei (für die Fehlersuche; kann geleert werden)',
  logFileNote:
    'Die Desktop-Version hat keine Konsole, daher gehen alle Laufzeitprotokolle des Plugins (Start, Absturz/Neustart des Desktop-Pets, Fehler und Warnungen) in diese eine Datei; bitte bei Problemmeldungen anhängen. Maximal 1 MB pro Datei, danach bleiben nur die letzten 512 KB erhalten.',
  saved: 'Gespeichert – die Pets gelten sofort.',
  loadError: 'Konfiguration konnte nicht geladen werden',
  saveError:
    'Konfiguration konnte nicht gespeichert werden. Bitte Serververbindung, Schreibrechte im Konfigurationsverzeichnis und Serverprotokoll prüfen.',
  saveInvalid: 'Konfiguration konnte nicht gespeichert werden: Inhalt ungültig. Bitte prüfen und erneut versuchen.',
  syncError:
    'Synchronisieren fehlgeschlagen. Bitte Serververbindung und Schreibrechte im Konfigurationsverzeichnis prüfen.',
  loading: 'Konfiguration wird geladen…',
  retry: 'Erneut versuchen',
  invalid: 'Bitte Eingaben prüfen: Größe muss positiv sein, Ränder dürfen beliebige Zahlen sein.',
  busy: 'Wird gespeichert…',
  extraPetsHint:
    'Weitere {n} Art(en) stammen aus Dateien im Verzeichnis pet/ (<Name>-config.json + <Name>-animation/); oben in der Zeile „Arten" umschalten und bearbeiten. Speichern schreibt jeweils in die eigene Paketkonfiguration, nie in main-config.jsonc.',
  kindLabel: 'Arten',
  kindMain: 'Integriert',
  lastOfKind:
    '„{entry}" hat nur noch dieses eine Pet – beim Löschen verschwindet die ganze Art. Zum vollständigen Entfernen die Pet-Pack-Dateien löschen.',
  savePartial:
    'Haupt-Pets gespeichert, aber {names} konnten nicht zurückgeschrieben werden: Prüfen Sie, ob die Pack-Konfiguration gültig und das Verzeichnis beschreibbar ist.',
  notifyToggle: 'Systembenachrichtigungen',
  notifyToggleHint:
    'System-Toasts (unten rechts auf dem Desktop) bei Abschluss einer Konversation, Fehlern, Berechtigungsanfragen und Rückfragen – nur wenn das Fenster nicht fokussiert ist.',
  clickSoundToggle: 'Klick-Sound',
  clickSoundToggleHint:
    'Beim Klick auf ein Pet ertönt der integrierte Klick-Sound (assets/sound/click-duck.wav, Lautstärke 0.5); Klicks innerhalb von 100 ms werden nur einmal abgespielt, auch bei mehreren Pets überlagert sich nichts. Aus = völlig stumm. Wird beim „Speichern" in die Benutzerkonfiguration geschrieben.',
  whisperImageToggle: 'Flüstern-Bilder',
  whisperImageToggleHint:
    'Hängt an jede Flüstern-Zeile ein zufälliges Meme aus dem Pool (Bildzuordnung im Top-Level-Feld `memes` der Konfiguration). Token: Flüstern ruft ohnehin pro Zyklus das Modell auf, das Bild fügt nur Name + Beschreibung des gezogenen Memes (ca. 100 Zeichen / ≈60 Token) an dieselbe Anfrage an – vernachlässigbar.',
  chatImageToggle: 'Chat-Bilder',
  chatImageToggleHint:
    'Die KI wählt im Chat passend zum Kontext ein Meme aus dem Pool (optional; Zuordnung im Top-Level-Feld `memes`). Token: Jede Nachricht führt den gesamten Katalog mit – aktuell ca. 1,1k Zeichen (≈650 Token, etwa 11-mal so viel wie beim Flüstern) und linear mit der Bildanzahl wachsend; aus = es wird kein Zeichen angehängt.',
  chatAnimationToggle: 'Chat-Aktionen',
  chatAnimationToggleHint:
    'Wenn an, enthält die Chat-Anfrage die Liste der spielbaren Animationen (alle Aktionen unter animations.categories): Hält das Modell die Zeile für eine tatsächliche Aufführung, spielt das Pet sie sofort; sonst antwortet es nur mit Text. Token: Jede Nachricht führt die ganze Liste mit; aus = es wird nichts angehängt. Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner eigenen Konfigurationsdatei überschreiben).',
  confineToggle: 'Auf aktuellen Bildschirm begrenzen',
  confineToggleHint:
    'Mehrere Monitore: Wenn an, bleibt das Pet auf dem Bildschirm, auf dem es sich gerade befindet – ein geworfenes Pet prallt nur innerhalb des Bildschirms ab, auf dem es losgelassen wurde (Bildschirmfugen wirken als Wände, es fliegt nicht zum Nachbarmonitor), und autonomes Umherlaufen bleibt auf dem aktuellen Bildschirm (ein Schritt über die Fuge wird einfach verworfen). Aus = Überqueren der Bildschirme wie gewohnt. Nur Desktop-Modus – das Browser-Overlay bleibt ohnehin im Viewport.',
  trayToggle: 'System-Tray',
  trayToggleHint:
    'Zeigt im Desktop-Modus ein Tray-Symbol (Windows: Infobereich, macOS: Menüleiste). Es listet alle Pets der Konfiguration und schaltet die Anzeige um – auch für Pets, die gerade nicht auf dem Desktop sind und kein Fenster zum Rechtsklicken haben. Ohne Tray lässt sich ein Pet nur über den Browser (Einstellungsseite oder Rechtsklick auf das Web-Pet) zurück auf den Desktop holen. Windows blendet das Symbol ohnehin in die „ausgeblendeten Symbole" aus. Nur Desktop-Modus.',
  voiceTitle: 'Sprachausgabe',
  voiceHint:
    'Drei Schalter und eine Stimme: Der Hauptschalter steuert die automatische Ausgabe, die beiden Unterschalter je eine Art proaktiver Meldung. Standardmäßig alle aus; wird beim „Speichern" in die Benutzerkonfiguration geschrieben (kein sofortiges Schreiben).',
  voiceEnabled: 'Sprachausgabe aktivieren',
  voiceEnabledHint:
    'Hauptschalter für die automatische Sprachausgabe. Aus = regelmäßige Flüstern-Sätze und To-do-Erinnerungen werden nicht gesprochen (die beiden Unterschalter unten wirken dann nicht). Manuelles Flüstern, Chat-Antworten und die Lautsprecher-Schaltfläche im Chat-Panel sind nicht betroffen – die haben Sie selbst ausgelöst, die sprechen direkt. Es betrifft nur das Sprechen: Blasen, Chat-Gedächtnis und Systembenachrichtigungen bleiben unberührt; eine fehlgeschlagene Synthese wird nur protokolliert und unterbricht den Chat nicht.',
  voiceWhisperEnabled: 'Flüstern sprechen',
  voiceWhisperEnabledHint:
    'Spricht den regelmäßig erzeugten Flüstern-Satz (manuelles Flüstern per Rechtsklick bleibt unberührt). Unterliegt dem Hauptschalter oben: Ist er aus, wirkt dieser Schalter nicht. Standardmäßig aus – Flüstern ist Hintergrundbegleitung und sollte nicht ungefragt Geräusche machen.',
  voiceTodoEnabled: 'To-do-Erinnerungen sprechen',
  voiceTodoEnabledHint:
    'Spricht eine fällige To-do-Erinnerung (die Blase erscheint weiterhin; dieser Schalter entscheidet nur, ob gesprochen wird). Unterliegt dem Hauptschalter oben. Standardmäßig aus.',
  voiceNameLabel: 'Stimme',
  physicsTitle: 'Physik (Zieh- und Wurfgefühl)',
  physicsHint:
    'Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben); wird beim „Speichern" in die Benutzerkonfiguration geschrieben (kein sofortiges Schreiben). Im Browser sofort wirksam, im Desktop-Modus, sobald das Speichern die Pet-Fenster neu lädt.',
  mobileTitle: 'Mobil-Effekte',
  mobileHint:
    'Nur im Handy-Browser sinnvoll: Vibration braucht einen Motor, die beiden Bewegungs-Schalter brauchen Neigungs-/Beschleunigungssensoren, und Sensoren gibt es nur über HTTPS oder localhost.',
  'physics.gravity': 'Schwerkraft',
  'physics.gravityHint': 'px/s², größer = fällt schneller; 0 = schwerelos (fliegt geradeaus weiter)',
  'physics.restitution': 'Elastizität',
  'physics.restitutionHint':
    '0–1, Geschwindigkeitsanteil beim Abprallen von Wand/Boden (1 = voll elastisch, 0 = bleibt sofort stehen)',
  'physics.groundFriction': 'Kontaktreibung',
  'physics.groundFrictionHint':
    '/s, Abklingen der Geschwindigkeit entlang jeder Kontaktfläche (Wand, Boden, Decke); 0 = überall eisglatt',
  'physics.throwPower': 'Wurfkraft',
  'physics.throwPowerHint':
    '> 0, Gesamtfaktor für Federfolge und Abwurfgeschwindigkeit (1 = Standard; höher = folgt enger, wirft härter)',
  physicsCeilingBounce: 'Deckenabprall',
  physicsCeilingBounceHint: 'Aus: Würfe können oben aus dem Bildschirm fliegen (die Schwerkraft holt sie zurück)',
  physicsPetCollision: 'Pet-Kollisionen',
  physicsPetCollisionHint: 'Ein fliegendes Pet prallt mit Impulserhaltung von anderen ab (Masse ∝ Größe²)',
  physicsHaptic: 'Kollisions-Vibration',
  physicsHapticHint:
    'Ein Impuls pro Treffer (Wand, Boden, Decke, andere Pets). Funktioniert in Chrome/Edge; nicht auf iOS oder in WebView-Hüllen wie Via. „Nicht stören“ blockiert die Vibration.',
  physicsTilt: 'Schwerkraft per Neigung',
  physicsTiltHint:
    'Handy neigen: die Schwerkraft folgt der Neigung (Betrag = der Wert oben). Bei Schwerkraft 0 bewirkt Neigen nichts. Benötigt HTTPS/localhost.',
  physicsShake: 'Schütteln zum Werfen',
  physicsShakeHint:
    'Schütteln schleudert den Pet in Wurfrichtung; die Stärke folgt throwPower. Unabhängig von der Schwerkraft, funktioniert also auch bei 0. Benötigt HTTPS/localhost.',
  invalidPhysics: 'Bitte Physikwerte prüfen: Schwerkraft / Bodenreibung ≥ 0, Elastizität 0–1, Wurfkraft > 0.',
  fontTitle: 'Aussehen & Schrift',
  fontHint:
    'Die Schriftart gilt für alle Texte, die derzeit die Candy-Schrift nutzen: Pet-Blase, Hover-Tooltip, Chat-Fenster, Score-Popup; die Schriftgröße gilt nur für Pet-Blase und Hover-Tooltip (Chat- und Score-Popup behalten ihre Größe). Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben); wird beim „Speichern" in die Benutzerkonfiguration geschrieben – im Browser sofort wirksam, im Desktop-Modus, sobald das Speichern die Pet-Fenster neu lädt.',
  fontFamilyLabel: 'Schriftart',
  fontFamilyHint:
    '„Candy (integriert)" wird mit dem Plugin geliefert; die übrigen sind Systemschriften. Fehlt eine Schrift auf diesem Rechner, greift die nächste im Stapel (nie leer, kein Fehler).',
  fontSizeLabel: 'Schriftgröße (px)',
  fontSizeHint:
    'Schriftgröße des Blasentexts; Tooltip und kleinere Zeilen in der Blase skalieren anteilig. Bereich 4–200.',
  fontFollowToggle: 'Schriftgröße mit Pet-Größe skalieren',
  fontFollowToggleHint:
    'An (Standard): die Schrift wächst mit dem Pet – bei 462 px Breite entspricht sie genau der obigen Größe. Aus: die Größe bleibt unabhängig von der Pet-Größe konstant.',
  invalidFont:
    'Bitte Schrifteinstellungen prüfen: Die Schriftart muss in der Liste stehen, die Größe eine Zahl zwischen 4 und 200 sein.',
  'font.candy': 'Candy (integriert)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'Systemstandard',
  modelTitle: 'Chat & Modelle',
  modelHint:
    'Welches Modell Flüstern und Chat jeweils nutzen und wie viel Verlauf jeder Chat-Aufruf mitführt. „Aktueller Konversation folgen" = das Modell, das Ihre aktuelle Konversation verwendet (Standard). Globaler Standard: gilt für alle Pets, ein Pet-Pack kann ihn in seiner Art-Datei überschreiben. Die Optionen stammen aus derselben Quelle wie die Modellauswahl von DSH und werden vom Host live geliefert.',
  modelFollow: 'Aktueller Konversation folgen',
  modelSearch: 'Modelle suchen…',
  modelEmpty: 'Keine passenden Modelle.',
  modelNoModels: 'Keine Modelle verfügbar.',
  modelLoading: 'Modellliste wird aktualisiert…',
  modelTriggerAria: 'Modell wählen, aktuell {model}',
  modelUnknown: ' (aktuelle Konfiguration, nicht in der Liste)',
  modelNone: 'Für diesen Anbieter sind keine Modelle verfügbar',
  whisperModelLabel: 'Flüstern-Modell',
  chatModelLabel: 'Chat-Modell',
  modelFieldHint:
    '„Aktueller Konversation folgen" = Modell der aktuellen Konversation; schlägt ein gewähltes Modell fehl, fällt das Plugin auf das Modell der aktuellen Konversation zurück und versucht es einmal erneut.',
  invalidModel:
    'Bitte Modelleinstellungen prüfen: Anbieter und Modell entweder beide wählen oder beide leer lassen (aktuelle Konversation folgen).',
  modelCatalogFailed:
    'Modellliste konnte nicht geladen werden (Seite neu laden für einen neuen Versuch); die aktuellen Konfigurationswerte bleiben unverändert erhalten.',
  chatMemory: 'Chat-Verlaufsrunden',
  chatMemoryHint:
    'Wie viele der letzten Runden jeder Chat-Aufruf mitführt (1 Runde = 1 Frage + 1 Antwort; 0 = kein Verlauf, jede Nachricht ist neu). Das Gedächtnis selbst behält alles – dieser Wert bestimmt nur, wie viel in den Kontext kommt: mehr merkt mehr und kostet mehr Token. Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben).',
  invalidChatMemory: 'Bitte Chat-Verlaufsrunden prüfen: Zahl ≥ 0 erforderlich.',
  chatImageLimit: 'Max. Chat-Bilder',
  chatImageLimitHint:
    'Wie viele Memes beim Chat höchstens an das Modell gelistet werden („erste N" = die ersten N in der Konfiguration; was bevorzugt gesendet werden soll, nach vorne verschieben). Die ganze Liste wird an jede Nachricht angehängt, Token wachsen linear mit der Anzahl – eine lange Liste kostet nur. Mit der Grenze auf die ersten N wählt das Modell nur daraus. 0 = keine Grenze (alles senden). Integrierter Standard 10. Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben). Nur Chat-Auswahl: Flüstern führt nur das gezogene Meme mit.',
  invalidChatImageLimit: 'Bitte das Limit für Chat-Bilder prüfen: Zahl ≥ 0 erforderlich (0 = keine Grenze).',
  notifyTest: 'Testbenachrichtigung',
  notifyTestOk: 'Testbenachrichtigung gesendet – bitte unten rechts auf dem Desktop prüfen.',
  notifyDenyUnsupported:
    'Systembenachrichtigungen werden in dieser Umgebung nicht unterstützt (keine Notification-API).',
  notifyDenyBlocked: 'Die Benachrichtigungsberechtigung ist im Browser blockiert.',
  notifyDenyRejected: 'Sie haben im Berechtigungsdialog „Blockieren" gewählt.',
  notifyDenyError: 'Fehler beim Anfordern der Berechtigung',
  notifyGuide:
    'Anleitung: links neben der Adressleiste auf 🔒/ⓘ klicken → „Website-Einstellungen" → „Benachrichtigungen" → auf „Zulassen" setzen, Seite neu laden und erneut versuchen.',
  storageTitle: 'Deinstallation & Speicher',
  storageHint:
    'Alle Orte, an denen das Plugin auf diesem Rechner Daten ablegt. Cache löschen ist unschädlich (wird automatisch neu geladen/neu aufgebaut); „Plugin-Benutzerdaten" löschen kostet Konfiguration und Chat-Gedächtnis.',
  'storage.userData':
    'Plugin-Benutzerdaten: eigene Konfiguration main-config.jsonc, Chat-Gedächtnis memory.json, eigene Animations-Assets main-animation/, Datei-Pets pet/',
  'storage.electron':
    'Electron-Laufzeit für das Desktop-Pet (groß; wird beim nächsten Start des Desktop-Modus automatisch neu heruntergeladen)',
  'storage.desktopCache':
    'Cache der Desktop-Pet-Fenster und Skalierungs-Cache des Hauptbildschirms (löschbar, wird automatisch neu aufgebaut)',
  'storage.electronCache': 'Download-Cache des Electron-Installers (löschbar, wird bei Bedarf neu geladen)',
  'storage.package': 'Das Plugin selbst (von DSH verwaltet – mit dem Befehl unten entfernen, nicht von Hand löschen)',
  storageMissing: ' (noch nicht erstellt)',
  uninstallTitle: 'So deinstallieren Sie',
  uninstallStep1:
    '1. Zuerst DSH beenden (das Desktop-Pet beendet sich mit); die obigen Dateien nicht löschen, während das Pet läuft.',
  uninstallStep2:
    '2. Das Plugin selbst entfernen (im Terminal ausführen; entfernt es auch aus der Bundle-Schicht des Profils):',
  uninstallStep3:
    '3. Die obigen Orte nach Bedarf löschen: Caches sind unschädlich; „Plugin-Benutzerdaten" löschen kostet Konfiguration und Chat-Gedächtnis (vorher main-config.jsonc sichern, wenn Sie es behalten wollen).',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};

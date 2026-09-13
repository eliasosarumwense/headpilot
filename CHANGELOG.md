# Headpilot – Änderungsprotokoll

Zusammenfassung aller Änderungen aus der Entwicklungs-Session September 2026.

---

## 1. UI-Redesign (minimalistisch)

**Ziel:** Weniger Farben, kein Emoji, einheitliches Erscheinungsbild.

- Komplett neues [style.css](public/style.css) mit CSS-Variablen (`--bg`, `--surface`, `--border`, `--text`, `--danger`, `--success`) statt hartkodierter Farben.
- Einheitliches Button-System: `.btn` (neutral, umrandet), `.btn-primary` (schwarz gefüllt), `.btn-danger` (rot – **nur** für echte Löschaktionen). Vorher: 5+ verschiedene Button-Farben.
- Alle Emojis aus UI-Texten und `alert()`-Meldungen entfernt (app.js).
- Dashboard-Statistik-Karten von dunklen/bunten Kacheln auf helle, einheitliche Karten umgestellt.
- **Bugfix:** `.modal-overlay { display: flex }` überschrieb das `hidden`-Attribut (Autoren-CSS schlägt UA-Default) → SSH-Login-Modal war beim Laden der Seite immer sichtbar. Fix: explizite `.modal-overlay[hidden] { display: none }`-Regel.

## 2. Seitenwechsel/Navigation

- View-Cache (`viewCache`) in [app.js](public/js/app.js): einmal geladene Views werden nicht erneut vom Server angefordert.
- Sanfter Fade-Out/Fade-In beim Wechsel zwischen Reitern (`is-switching`-Klasse) statt hartem Sprung.
- `viewToken`-Mechanismus verhindert, dass schnelles Hin-und-Herklicken zu vertauschten Ansichten führt.

## 3. Docker-Integration

**Eigener Reiter "Docker Dienste"** (getrennt von "Geräte/Nodes", da inhaltlich eigenständig).

- Backend ([server.js](server.js)): `POST /api/nodes/ssh-docker` verbindet sich per SSH (`ssh2`) mit einer Node und führt `docker ps -a --format '{{json .}}'` aus (Dockers eigenes JSON-Format statt fehleranfälligem manuellem String-Bau).
  - Automatischer `sudo`-Fallback, falls der SSH-User nicht in der `docker`-Gruppe ist (Passwort geht sicher über stdin, nicht als Kommandozeilen-Argument).
  - `readyTimeout: 20000` (SSH-Handshake kann bei manchen Geräten länger dauern).
- **Sichere Zugangsdaten-Speicherung** ([sshVault.js](sshVault.js)): AES-256-GCM-Verschlüsselung, Schlüssel per `scrypt` aus `SSH_VAULT_SECRET` (.env) abgeleitet, zufälliger Salt pro Installation. Ohne gesetztes Secret bleibt die Funktion deaktiviert (kein unsicherer Default). Datei liegt unter `data/ssh-vault.json`, `chmod 600`, in `.gitignore`.
  - Login wird automatisch übersprungen, sobald für eine Node gespeicherte Zugangsdaten existieren – Scan startet direkt beim Öffnen des Reiters.
- Docker-Karten zeigen pro Container: Name, Image, Status (mit Detailtext wie "Up 3 hours"), Ports – laufende Container zuerst sortiert.

**Wichtige Debugging-Erkenntnisse** (falls das Problem wieder auftaucht):
- `nodemon` hat versehentlich bei jedem Speichern der Zugangsdaten neu gestartet, weil es das `data/`-Verzeichnis mitüberwacht hat → mitten in der Anfrage abgebrochene Verbindung ("Load failed" im Browser). Fix: `nodemonConfig.ignore` in [package.json](package.json).
- SSH-Timeout zu einer Node lag an keinem der vermuteten Gründe (DNS/Firewall), sondern schlicht daran, dass von `localhost` (Mac, nicht im Tailnet) statt vom VPS aus getestet wurde.

## 4. Node-Ping

- Neuer Endpoint `POST /api/nodes/ping` ([server.js](server.js)): `execFile('ping', ...)` (kein Shell-Aufruf, kein Injection-Risiko), plattformabhängige Flags (macOS vs. Linux).
- UI: runder Icon-Button oben rechts in der Node-Karte (Feather-Style-SVG), Ripple-Animation am Status-Punkt während des Pingens (dasselbe Prinzip wie Tailwinds `animate-ping`), Latenz erscheint dezent daneben.

## 5. Uptime Kuma Integration ("Status"-Reiter)

Zeigt Kuma-Monitore direkt in Headpilot an, inkl. Anlegen/Bearbeiten/Löschen.

### Architektur-Entscheidung
Kuma bietet **keine normale REST-API** – nur eine öffentliche, anonyme Status-Page-API (`/api/status-page/:slug`) oder die Socket.IO-Schnittstelle, die auch das Kuma-Webinterface selbst nutzt. Nach Problemen mit der Status-Page-Variante (siehe unten) wurde auf **echten Login per Socket.IO** mit `KUMA_USER`/`KUMA_PASS` umgestellt – zeigt alle Monitore, kein Status-Page-Setup in Kuma nötig.

### Backend ([server.js](server.js))
- `withKumaLogin(work)`: zentrale Hilfsfunktion – verbindet, loggt sich ein, führt eine Aktion aus, trennt danach sauber. Wird von allen Kuma-Routen genutzt.
- `GET /api/status`: liefert `{configured: false}` (Variablen fehlen, kein Request), `{configured: true, available: false}` (Timeout/Fehler) oder `{configured: true, available: true, monitors: [...]}`.
- `POST /api/status/monitors`, `PUT /api/status/monitors/:id`, `DELETE /api/status/monitors/:id`: Anlegen/Bearbeiten/Löschen von Monitoren. Unterstützte Typen: HTTP(S), TCP-Port, Ping.
- 3-Sekunden-Timeout für alle Kuma-Anfragen, damit ein nicht erreichbarer Kuma-Server das restliche Dashboard nie blockiert.

### Frontend
- [status.html](public/views/status.html) + [app.js](public/js/app.js): Kachel-Grid, Skeleton-Ladezustand, Polling alle 30s (aktualisiert nur die Kacheln, kein Full-Page-Reload).
- Modal zum Anlegen/Bearbeiten (Name, Typ, Ziel, Port, Prüfintervall) – wiederverwendet das gleiche `.modal`-CSS wie das SSH-Login-Modal.

### Konfiguration (.env)
```
KUMA_URL=<Basis-URL von Kuma>
KUMA_USER=<Kuma-Benutzername>
KUMA_PASS=<Kuma-Passwort>
```
Alle drei leer lassen → "nicht konfiguriert" (kein Netzwerk-Request). Siehe [.env.example](.env.example) für alle Varianten (gleicher Host, Tailscale-IP, öffentliche Domain).

### Wichtige Debugging-Erkenntnisse (lehrreich für künftige Probleme!)

1. **macOS + Tailscale MagicDNS + Node.js:** `dns.lookup()` (von `fetch`/`socket.io` intern genutzt) findet manche Domains nicht (`ENOTFOUND`), obwohl `dns.resolve4()` sie problemlos auflöst. Bekanntes, dokumentiertes Problem, wenn eine VPN-App die DNS-Auflösung dynamisch über macOS' System Configuration verwaltet statt über eine statische `/etc/resolv.conf`. **Fix:** `dns.lookup` in server.js so gepatcht, dass bei `ENOTFOUND` automatisch auf `dns.resolve4/6` zurückgefallen wird (nur nötig, wenn `KUMA_URL` eine Domain statt einer IP ist).
2. **Docker-Port-Bindung:** Der Kuma-Container auf dem VPS published seinen Port nur auf `127.0.0.1` (`docker ps` zeigt `127.0.0.1:3001->3001/tcp`). Das ist für Produktion korrekt (Headpilot läuft auf demselben Host), verhindert aber Zugriff von anderen Tailnet-Geräten (z.B. zum lokalen Testen vom Mac). Lösung dafür: Port stattdessen auf die Tailscale-IP binden (`100.x.x.x:3001:3001`) statt auf `0.0.0.0` (sonst öffentlich erreichbar).
3. Es gab **keine echte Status-Page** in der Kuma-Installation (nur die normale Admin-Oberfläche unter der öffentlichen Domain) – deshalb hing die ursprüngliche Status-Page-API-Variante (`/api/status-page/default`) komplett, statt sauber 404 zurückzugeben. Der Wechsel auf echten Login umgeht dieses Problem komplett.
4. Kuma hat eingebautes Rate-Limiting auf Login-Versuche – bei zu vielen Testverbindungen in kurzer Zeit können weitere Verbindungsversuche vorübergehend fehlschlagen ("xhr poll error").

## 5a. Sicherheits-/Robustheits-Verbesserungen

- Globale `process.on('unhandledRejection'/'uncaughtException')`-Handler in [server.js](server.js): ein unerwarteter Fehler killt nie mehr den ganzen Prozess (und damit alle offenen Verbindungen) – wird stattdessen geloggt, Server läuft weiter.
- SSH-Docker-Fehlermeldungen unterscheiden jetzt klar zwischen "Server erreicht die VPN-IP gar nicht" (ETIMEDOUT) und "TCP stand, SSH-Handshake kam nicht rechtzeitig" (client-timeout) statt einer generischen Meldung.

## 6. Pre-Auth-Keys: "Löschen" hat nie wirklich funktioniert

**Bug:** Ein Klick auf "Ablaufen lassen" meldete Erfolg, aber der Key blieb aktiv.

**Ursache** (über die echte Swagger/OpenAPI-Spec der Headscale-Instanz verifiziert): `POST /api/v1/preauthkey/expire` identifiziert den Key über seine **ID** (`{id: "..."}`), nicht über `{user, key}`. Die App schickte bisher `{user, key}` – und der `key`-Wert aus der Liste ist ohnehin nur maskiert (`hskey-...-***`), da Headscale den vollen Wert nur einmalig bei der Erstellung preisgibt. Headscale beantwortete den falschen Aufruf mit `200 OK`, ohne intern irgendetwas zu ändern – ein stiller Fehlschlag ohne Fehlermeldung.

**Fix:** [app.js](public/js/app.js) `expireKey()` schickt jetzt `{id: keyId}`. Live gegen die echte Headscale-Instanz nachgewiesen: Test-Key angelegt → alter Aufruf ändert nichts → neuer Aufruf setzt die Ablaufzeit sofort auf "jetzt" und der Key verschwindet aus der aktiven Liste.

**UI:** [keys.html](public/views/keys.html) von Tabelle auf Karten-Grid umgestellt (gleiche Klassen wie die Node-Karten). Zeigt jetzt außerdem **alle** aktiven Keys direkt an, ohne dass man vorher einen Benutzer auswählen muss (der Benutzer-Dropdown dient nur noch zum Anlegen neuer Keys).

## 7. Subnet Routes (neuer Reiter)

Zeigt von Geräten per `--advertise-routes` angekündigte Subnetze an, mit Genehmigen/Deaktivieren.

**Wichtiger Architektur-Fund:** Die ursprünglich angenommene API (`GET /api/v1/routes`, `POST /api/v1/routes/:id/enable`/`disable`) existiert in dieser Headscale-Version **nicht mehr** (`404 Not Found` – über die echte OpenAPI-Spec verifiziert). Das hatte übrigens auch die "Aktive Routen"-Kachel im Dashboard die ganze Zeit über lautlos auf 0 gehalten. Stattdessen leben Routen direkt am Node-Objekt:
- `availableRoutes`: vom Gerät angekündigte CIDRs
- `approvedRoutes`: von einem Admin genehmigte CIDRs
- Genehmigen/Deaktivieren läuft über `POST /api/v1/node/{nodeId}/approve_routes`, das **immer die komplette Liste** der genehmigten Routen für diesen Node ersetzt (kein Toggle für eine einzelne Route) – das Backend holt sich daher vor jeder Änderung erst den aktuellen Stand frisch vom Server, bevor es die Zielroute hinzufügt/entfernt und zurückschickt.

**Backend** ([server.js](server.js)): `GET /api/routes` (baut die flache Liste aus den Node-Daten), `POST /api/routes/approve` und `POST /api/routes/disable` (beide mit `{nodeId, route}` statt einer Routen-ID, da Routen keine eigenen IDs mehr haben). Live gegen die echte Headscale-Instanz getestet: Route genehmigt → erscheint in `approvedRoutes` → wieder entfernt → weg.

**Frontend**: [routes.html](public/views/routes.html) + [app.js](public/js/app.js), gleiches Karten-Layout wie der Status-Reiter (`.status-grid`/`.status-card`, Skeleton-Ladezustand). Gelber Punkt (neue `--warning`-Variable, ausschließlich hier verwendet) für "wartet auf Genehmigung", grün für genehmigt.

## 8. Audit Log (neuer Reiter)

Protokolliert sicherheitsrelevante Aktionen (wer hat was wann gemacht) in Postgres.

**Backend** ([audit.js](audit.js), neu): `pg`-Pool aus `DATABASE_URL`, `logAudit({actor, action, target, details, ip})` schreibt einen Eintrag in `headpilot.audit_log` und wirft dabei **nie** einen Fehler nach außen (ein Logging-Fehler darf niemals die eigentliche Aktion, z.B. "Node löschen", verhindern - wird nur geloggt). `getAuditLog({limit, offset})` liest die letzten Einträge. Gleiches Drei-Zustands-Prinzip wie bei Kuma: ohne `DATABASE_URL` bleibt alles deaktiviert, kein Verbindungsversuch.

**Actor-Ermittlung:** Es gibt in server.js kein `req.user` (kein Passport o.ä. im Einsatz) - die Session speichert nur die rohen OIDC-Tokens (`req.session.tokens`). Neue Hilfsfunktion `getActor(req)` dekodiert das bereits validierte `id_token` (JWT) und liest `preferred_username` daraus aus.

**Instrumentierte Routen** ([server.js](server.js)): `LOGIN_SUCCESS` (OIDC-Callback), `NODE_RENAME`, `NODE_DELETE`, `USER_CREATE`, `USER_DELETE`, `PREAUTHKEY_CREATE`, `ROUTE_APPROVE`, `MONITOR_CREATE`, `MONITOR_EDIT`, `MONITOR_DELETE` - jeweils erst geloggt, nachdem die eigentliche Aktion bei Headscale/Kuma erfolgreich war.

**Frontend (überarbeitet):** Ursprünglich als eigener "Audit Log"-Reiter mit Tabelle gebaut, dann auf Wunsch wieder entfernt und stattdessen als Log-Feed direkt auf der Startseite ergänzt - eine breite Kachel im Dashboard-Grid mit dunkler, monospace Log-Konsole (`.audit-log-console` in [style.css](public/style.css), Zeilen im Format `[Zeitstempel] actor  ACTION  target`), zeigt die letzten 10 Einträge. Kein separater Nav-Eintrag mehr.

**Nicht live testbar:** Anders als bei Headscale/Kuma lief hier keine echte Postgres-Instanz zum Gegentesten zur Verfügung (Docker-Container läuft nur auf dem VPS) - SQL wurde sorgfältig geprüft, aber die tatsächliche DB-Interaktion muss auf dem VPS verifiziert werden. Auf dem VPS in der dortigen `.env`: `DATABASE_URL=postgres://<user>:<passwort>@127.0.0.1:5432/headpilot` (Schema `headpilot`, Tabelle `audit_log` muss bereits existieren).

## 9. Karte (gebaut, dann wieder entfernt)

Kurz gebaut und live getestet (funktionierte), dann auf Wunsch wieder komplett entfernt.

**Für später festgehalten, falls das Thema nochmal aufkommt:** Headscales Admin-API gibt für keinen Node eine öffentliche/WAN-IP preis (nur die interne Tailscale-IP, z.B. `100.64.0.2`, nicht geolokalisierbar - komplettes Node-JSON gegen die echte Instanz geprüft, kein "Endpoint"-Feld vorhanden). Funktionierender Workaround wäre: für Nodes mit gespeicherten SSH-Zugangsdaten ([sshVault.js](sshVault.js)) per SSH `curl api.ipify.org` die echte öffentliche IP abfragen und über ip-api.com geolokalisieren (live getestet: SSH → echte IP → korrekt "Vienna, Austria"). Einschränkung dabei: nur Geräte mit SSH-Zugriff abdeckbar, und IP-Geolocation ist ohnehin nur ungefähr (Provider-Standort, keine exakte Adresse).

**Grund für die Entfernung:** Nutzer mochte das Feature nicht.

## 10. Discord-Benachrichtigung für Kuma-Dienste

Ermöglicht das Ein-/Ausschalten einer Discord-Benachrichtigung bei Downtimes direkt aus Headpilot, ohne Kumas eigenes Interface öffnen zu müssen. Ursprünglich als volle Liste (mehrere benannte Benachrichtigungen, je mit Anlegen/Bearbeiten/Löschen) gebaut, dann auf Wunsch radikal vereinfacht: **es gibt nur eine einzige Benachrichtigung, die man ein- oder ausschaltet** - kein Verwalten mehrerer Einträge.

**Wichtiger Fund beim Vereinfachen:** Kumas `active`-Feld auf einer Benachrichtigung lässt sich über die API **nicht** wirklich setzen - es wird beim Anlegen immer stillschweigend auf `true` zurückgesetzt, egal was man mitschickt (live gegengetestet: `active:false` geschickt, `active:true` kam zurück). Ein echter "pausieren ohne Config-Verlust"-Schalter existiert in Kuma für einzelne Benachrichtigungen also nicht.

**Lösung:** Der Schalter wird über Anlegen/Löschen simuliert. "Aus" löscht die Benachrichtigung komplett aus Kuma (stoppt sofort alle Alerts), "Ein" legt sie mit der zuletzt gespeicherten URL neu an. Headpilot merkt sich die Webhook-URL selbst lokal (`data/notification-config.json`, analog zu sshVault.js, aber ohne Verschlüsselung - Kuma selbst speichert dieselbe URL ohnehin im Klartext), damit man sie beim Wiedereinschalten nicht erneut eintippen muss. Anhand eines festen Namens (`Headpilot Discord`) identifiziert, damit andere, manuell in Kuma angelegte Benachrichtigungen (der Nutzer hatte bereits zwei eigene: "My Discord Alert (1)" und "Test") unangetastet bleiben.

**Backend** ([server.js](server.js)): `GET/POST /api/status/notification` (Singular!). Live gegen die echte Instanz getestet: Ein → Bearbeiten (URL ändern, bleibt dieselbe ID, kein Duplikat) → Aus (gelöscht) → die zwei bereits vorhandenen echten Benachrichtigungen des Nutzers waren danach unverändert vorhanden. `NOTIFICATION_SAVE` im Audit-Log.

**Frontend**: Kein Modal, keine Liste mehr - eine einzelne Karte im Status-Reiter ([status.html](public/views/status.html)) mit Checkbox "Aktiviert", Webhook-URL-Feld und einem "Speichern"-Button.

## 11. Bugfix: Dienst (Monitor) anlegen/bearbeiten schlug fehl ("Cannot read properties of undefined (reading 'every')")

**Symptom:** In Headpilot einen neuen Ping-Dienst für `192.168.178.37` anlegen scheiterte mit `Fehler: Cannot read properties of undefined (reading 'every')`. Derselbe Monitor ließ sich in Kumas eigenem Interface aber problemlos anlegen.

**Root Cause (live nachvollzogen):** Kumas `add`/`editMonitor`-Socket-Handler verarbeiten intern ein deutlich größeres Feld-Set, als Headpilot bisher geschickt hat - Felder für praktisch alle Monitor-Typen (Kafka, RADIUS, gRPC, MQTT, OAuth, Datenbank, ...), unabhängig vom tatsächlich gewählten Typ. Fehlt eines davon im gesendeten Objekt, crasht Kuma intern beim Validieren mit genau dieser Fehlermeldung. Kumas eigenes Frontend schickt immer das komplette Objekt mit allen Feldern - Headpilot schickte bisher nur die drei tatsächlich benötigten (name/url oder hostname/port, interval), daher der Unterschied zum Verhalten in Kumas UI.

Herausgefunden, indem live ein echter, vollständiger Monitor (der bestehende "iPhone"-Ping-Monitor) per `getMonitor` abgerufen und schrittweise auf die tatsächlich nötigen Felder reduziert wurde. Ein reiner Klon dieses Objekts löste dabei einen *zweiten*, andersartigen Fehler aus (SQL: `no column named children_i_ds`) - Kumas Datenbank-Schicht akzeptiert beim Schreiben also umgekehrt bestimmte reine Ausgabe-/Berechnungsfelder nicht, die `getMonitor` aber mitliefert. Per automatisiertem Skript (SQL-Fehler parsen → Feldname snake_case→camelCase konvertieren → Feld entfernen → erneut versuchen) wurde die vollständige Liste dieser abgelehnten Felder ermittelt: `childrenIDs`, `pathName`, `parent`, `forceInactive`, `includeSensitiveData`, `maintenance`, `screenshot`, `tags` - sowie zusätzlich `id`, aber **nur** beim Anlegen (`add`); `editMonitor` braucht `id` im Objekt selbst, um den richtigen Datensatz zu finden, und schlägt ohne es mit `Undefined binding(s) detected ... id = ?` fehl (das war zunächst ein eigener Fehler in dieser Fix-Iteration, da `id` versehentlich mit in die gemeinsame Ausschlussliste aufgenommen wurde).

**Fix** ([server.js](server.js)):
- `kumaMonitorDefaults({type, interval})`: liefert neutrale Default-Werte für **alle** von Kuma verarbeiteten Monitor-Felder, nicht nur die drei von Headpilot angebotenen Typen (http/port/ping).
- `buildKumaMonitorPayload(...)`: baut daraus das komplette `add`-Payload für den gewünschten Typ.
- `KUMA_MONITOR_READONLY_FIELDS` + `stripReadonlyMonitorFields(monitor)`: entfernt die von Kumas DB-Schicht abgelehnten Felder vor jedem Schreibzugriff (ohne `id` - siehe oben).
- `applyKumaMonitorFields(existing, {...})`: überträgt beim Bearbeiten nur die geänderten Formularfelder auf das vollständige, per `getMonitor` geladene Bestandsobjekt (Kumas `editMonitor` erwartet immer das komplette Objekt, kein Teil-Update) und bereinigt es anschließend über `stripReadonlyMonitorFields`.

**Live verifiziert:** Anlegen von HTTP-, Port- und Ping-Monitoren erfolgreich, Bearbeiten (Umbenennen) eines bestehenden Monitors erfolgreich, alle dabei angelegten Test-Monitore (`HEADPILOT-*-TEST*`) wieder gelöscht. Kumas finaler Monitor-Bestand nach dem Test unverändert: `Headpilot Dashboard`, `Home Assistant Webpage`, `iPhone` (alle drei echte, bereits vorher vorhandene Geräte des Nutzers).

## 12. Netzwerk-Reiter (Graph-Visualisierung des Tailnets)

Neuer Nav-Bereich "Netzwerk" (unter Headscale einsortiert, da rein auf Headscale-Registrierungsdaten basierend), zeigt Nodes und ihre genehmigten Subnet-Routes als interaktiven Graphen: Headscale im Zentrum, davon Linien zu jedem registrierten Node, von Nodes mit genehmigter Route eine gestrichelte Linie zu einem eigenen Route-Knoten mit der CIDR als Label.

**Wichtige Einschränkung (bewusst so gebaut):** Das ist **keine** Live-Verbindungsvisualisierung. Headscale/Tailscale ist ein Full-Mesh-Netzwerk - es gibt keine zentral gespeicherte Peer-zu-Peer-Verbindungsinfo, die man abfragen könnte. Der Graph zeigt ausschließlich reale Registrierungs- (welche Nodes gibt es, online/offline, letzter Kontakt, IP) und Routing-Daten (genehmigte Subnet-Routes), wie sie auch über `headscale nodes list` abrufbar wären. Das steht auch als Hinweistext direkt im UI.

**Backend** ([server.js](server.js)): `GET /api/network-graph`, baut aus der bestehenden Node-Liste `{ nodes: [{id, name, online, lastSeen, ipAddresses}], routes: [{nodeId, cidr}] }` (nur *genehmigte* Routes - eine bloß angekündigte, aber nicht freigegebene Route führt zu keinem tatsächlichen Traffic und gehört daher nicht ins Bild). Live gegen die echte Instanz getestet (6 registrierte Nodes, davon einer mit einer genehmigten Route).

**Frontend**: [network.html](public/views/network.html) (neu) + `initNetworkView()` in [app.js](public/js/app.js). Nutzt [vis-network](https://visjs.github.io/vis-network/) 10.1.2 über CDN (cdnjs, kein npm nötig). Farben werden direkt aus den bestehenden CSS-Variablen gelesen (`--success`/`--border-strong` für online/offline, `--accent` für den Headscale-Knoten), damit der Graph ohne eigene Farbpalette auskommt. Klick auf einen Geräte-Knoten (nicht auf Headscale oder eine Route) zeigt ein Popup mit Status, IP und letztem Kontakt - bewusst ein eigenes, an den restlichen App-Stil angeglichenes Popup-Element statt vis-networks Standard-Hover-Tooltip, da laut Vorgabe ein Klick das Popup auslösen soll. Ohne registrierte Nodes erscheint statt eines leeren Graphen ein Hinweistext.

**Bugfix + Redesign für den Präsentations-Einsatz:** Ursprünglich per Physik-Simulation (`barnesHut`) angeordnet - dabei zwei Probleme entdeckt: (1) `.network-empty-hint { display: flex }` überschrieb das `hidden`-Attribut (derselbe Fehlerklasse wie beim SSH-Modal, siehe Abschnitt 1) - der "Keine Geräte registriert"-Hinweis war dadurch immer sichtbar, auch mit echten Nodes im Graph. (2) Ohne fest vorgegebene Koordinaten würfelt vis-network bei jedem Laden neue Startpositionen aus - der Graph sah bei jedem Seitenaufruf anders aus, was für eine Live-Präsentation störend war. Fix: `[hidden]`-Regel ergänzt; die Physik-Simulation komplett durch feste, deterministische Koordinaten ersetzt (Geräte-Nodes gleichmäßig im Kreis um Headscale, nach ID sortiert; Routes am selben Winkel wie ihr Node, weiter außen, bei mehreren Routes leicht aufgefächert). Dadurch sieht der Graph bei jedem Neuladen exakt identisch aus, bleibt aber weiterhin frei ziehbar. Der zunächst ergänzte "Neu anordnen"-Button wurde auf Wunsch wieder entfernt.

## 13. Netzwerk-Graph: Docker-Dienste und Kuma-Monitore als Ebenen (gebaut, dann wieder entfernt)

Testweise um zwei per Toggle zuschaltbare Ebenen erweitert: laufende Docker-Container (über die bestehende SSH-Vault-Anbindung) und Uptime-Kuma-Monitore, jeweils dem passenden Node zugeordnet (Kuma per Text-Abgleich auf IP/Gerätename, nicht zuordenbare Monitore an einem eigenen "Kuma"-Hub). Funktionierte technisch (live gegen den echten NAS-Node mit 20 Docker-Containern und die echte Kuma-Instanz getestet), wurde aber auf Wunsch wieder komplett entfernt - optisch hat es nicht überzeugt.

**Für später festgehalten, falls das Thema nochmal aufkommt:** Das eigentliche Problem war gelöst - ein einzelner Host kann sehr viele Docker-Container haben (20 im Live-Test), eine direkte 1:1-Darstellung als Knoten wäre unlesbar. Funktionierender Ansatz dafür war ein Schwellenwert (bis 3 Elemente direkt als Punkte, darüber eine einzige einklappbare Gruppe mit Anzahl im Label, die sich per Klick fächerförmig aufklappt). Falls Docker/Kuma im Graphen nochmal gewünscht werden, lohnt es sich eher, an der *Optik* der Gruppen/Zweige anzusetzen (z.B. weniger zusätzliche Farben/Formen, engere Integration ins bestehende Kreis-Layout) statt an der zugrundeliegenden Logik - die hat funktioniert.

## 14. Netzwerk-Graph: LAN-Erkennung per nmap-Scan (gebaut, dann wieder entfernt)

Testweise um eine automatische Erkennung der erreichbaren Geräte hinter einer genehmigten Subnet-Route ergänzt: per `execFile('nmap', [...])` (nie als Shell-String, CIDR streng validiert, nur tatsächlich genehmigte Routes scanbar, 5-Minuten-Cache). Funktionierte technisch einwandfrei - live gegen das echte Heimnetz getestet (192.168.178.0/24, 4 gefundene Geräte) - wurde aber auf Wunsch wieder komplett entfernt.

**Für später festgehalten, falls das Thema nochmal aufkommt:** Ein echter Testlauf zeigte, dass ein normaler, erfolgreicher `/24`-Scan bereits 28-32 Sekunden braucht (weil `--host-timeout` nur einen einzelnen nicht antwortenden Host begrenzt, nicht die Gesamtlaufzeit) - ein Node-Timeout müsste also spürbar über den vorgegebenen 30s liegen, um normale Scans nicht selbst abzuwürgen. Falls das Feature nochmal gewünscht wird, ist der sicherheitsrelevante Teil (Validierung, execFile-Array, Route-Whitelist, Cache) bereits durchdacht und live getestet - die genaue Umsetzung liegt in der Git-Historie.

## 15. Netzwerk-Graph: mehr Details direkt sichtbar

Der Graph wirkte ohne die LAN-Erkennung wieder recht leer ("blank") - dafür jetzt mehr Kontext direkt im Bild, ohne die entfernten Features zurückzuholen:

- **Kennzahlen-Leiste über dem Graphen** ([network.html](public/views/network.html)): Anzahl Geräte, davon online, sowie Anzahl genehmigter Routes - auf einen Blick sichtbar, bevor man überhaupt einen Knoten anklickt.
- **Zweizeiliges Node-Label**: Name und primäre IP direkt unter dem Knoten (z.B. "elias-nas" / "100.64.0.4"), nicht erst nach einem Klick.
- **Erweitertes Klick-Popup**: zusätzlich zu Status/IP/letztem Kontakt jetzt auch **Besitzer** (Headscale-User, der das Gerät registriert hat) und **Sitzungsablauf** (`expiry`) - beides bereits Teil der echten Headscale-Node-Antwort, aber bisher ungenutzt (live gegen die echte Instanz geprüft: liefert z.B. korrekt "Elias Osarumwense" als Besitzer für alle aktuell registrierten Geräte).

**Backend** ([server.js](server.js)): `/api/network-graph` liefert pro Node jetzt zusätzlich `owner` (`user.displayName` bzw. `user.name`) und `expiry`.

## 16. Netzwerk-Graph auf die Startseite verschoben, eigener Nav-Reiter entfernt

Der Netzwerk-Graph war als eigener Vollbild-Reiter ("Netzwerk") ohne die Docker-/Kuma-/LAN-Erweiterungen zu leer/wenig genutzt - jetzt stattdessen als zusätzliche, volle Breite einnehmende Kachel direkt auf der Startseite (analog zur "Letzte Aktivität"-Log-Kachel), der eigene Nav-Eintrag ist weg.

- `public/views/network.html` **gelöscht** - der Graph lebt jetzt direkt in [dashboard.html](public/views/dashboard.html) (`.network-graph-card`).
- Die zwischenzeitlich ergänzte separate Kennzahlen-Leiste (Geräte/Online/Routen) über dem Graphen wurde wieder entfernt (`updateNetworkStats()` in [app.js](public/js/app.js)) - auf der Startseite liefern die ohnehin vorhandenen Stat-Karten ("Registrierte Geräte", "Aktuell Online", "Aktive Routen") exakt dieselben Zahlen bereits mit, eine zweite Anzeige wäre nur Redundanz gewesen.
- `initNetworkView()` wird jetzt beim Laden der Startseite aufgerufen (zusammen mit `fetchDashboardStats()`/`fetchDashboardAuditLog()`), nicht mehr über einen eigenen `loadView('network')`-Zweig.
- Graph-Höhe von der ehemals viewport-abhängigen Formel (`min(640px, calc(100vh - 260px))` - war für eine Vollbild-Seite gedacht) auf eine feste, kachel-taugliche Höhe (380px) vereinfacht; der doppelte Schatten (Kachel + Graph-Rahmen) wurde entfernt, damit sich der Graph optisch sauber in die bestehende `.stat-card`-Optik einfügt statt wie ein eigenständiges Element zu wirken.
- **Layout-Feinschliff:** Netzwerk-Graph und "Letzte Aktivität" teilen sich jetzt eine gemeinsame Zeile statt jeweils die volle Breite zu belegen - Graph 2/3, Log-Feed 1/3 (`.network-graph-card { grid-column: span 2 }`, `.audit-feed-card { grid-column: span 1 }`, direkt aufeinanderfolgend im Grid). `.audit-log-console` bekam dafür `flex: 1` statt einer festen `max-height`, damit der Log-Feed die Kachel exakt bis zur Höhe des Graphen daneben ausfüllt statt darunter Leerraum zu lassen.

## 17. Bugfix: Headscale-Knoten nicht exakt mittig im Netzwerk-Graph

**Symptom:** Der schwarze "Headscale"-Punkt saß nicht exakt in der Mitte der Graph-Kachel.

**Ursache:** `network.fit()` zentriert auf den Mittelpunkt der Bounding-Box **aller** Knoten - bei ungleich verteilten Routes (z.B. nur ein Node mit einer Route, alle anderen ohne) liegt dieser Mittelpunkt nicht bei Headscale selbst (immer fest bei `x:0, y:0`), sondern leicht in Richtung der vorhandenen Route(n) verschoben.

**Fix** ([app.js](public/js/app.js)): `fit()` durch ein explizites `moveTo({ position: {x:0, y:0}, scale })` ersetzt - zentriert immer exakt auf Headscale. Der Zoom-Faktor wird selbst berechnet (größte Distanz irgendeines Knotens zu `(0,0)`, passend zur Kachel-Größe skaliert), damit trotzdem alle Knoten sichtbar bleiben. Durchgerechnet mit der echten Node/Route-Konstellation (6 Geräte, 1 Route) - der am weitesten entfernte Punkt landet exakt am berechneten Rand, Headscale exakt im Zentrum.

**Zoom-Feinschliff (zwei Nachbesserungsrunden):** Der berechnete Zoom wirkte danach zu weit herausgezoomt. Grund: die Kachel ist deutlich breiter als hoch, die Skalierung richtet sich aber (um vertikales Abschneiden zu vermeiden) nach der kleineren der beiden Dimensionen (der Höhe) - dadurch bleibt der Großteil der verfügbaren Breite ungenutzt, was optisch wie "viel Leerraum, kleiner Graph" wirkt. Zwei Stellschrauben nachgezogen: der Rand-Puffer (`edgePaddingPx`, erst 50→24, dann 24→18) und die Kachel-Höhe (380px→440px, mehr nutzbare Höhe = mehr Zoom bei gleichbleibendem Seitenverhältnis-Nachteil). Rechnerisch verifiziert: der am weitesten entfernte Knoten liegt mit den finalen Werten bei 202px Abstand vom Zentrum (statt zuvor 166px, davor 140px) - der Sicherheitsabstand zum Rand bleibt dabei exakt `edgePaddingPx`, unabhängig vom gewählten Wert, es wird also nie etwas abgeschnitten.

## 18. Kurzanleitung mit Copy-Befehlen auf der Subnet-Routes-Seite

Headpilot kann Routes nur genehmigen/deaktivieren - das eigentliche Ankündigen einer Route passiert auf dem Zielgerät selbst und war bisher nirgends erklärt. Jetzt eine minimale, eingeklappte Anleitung (natives `<details>`/`<summary>`, kein eigenes JS fürs Auf-/Zuklappen nötig) direkt über der Routes-Liste, mit zwei fertigen Copy-Befehlen:

1. IP-Forwarding aktivieren (Linux, Voraussetzung fürs Routing).
2. `tailscale up --advertise-routes=<CIDR>` zum Ankündigen der Route.

**Frontend**: [routes.html](public/views/routes.html) (`.route-howto`), neue `.code-box`-Komponente (dunkler Terminal-Look wie beim Audit-Log-Feed) mit "Kopieren"-Button pro Befehl. `copyCodeBox()` in [app.js](public/js/app.js) nutzt `navigator.clipboard.writeText()`, kurzes Feedback direkt am Button ("Kopiert") statt eines zusätzlichen Toasts/Alerts.

## 19. Angemeldeter Benutzer in der Sidebar

Zeigt jetzt unten in der Sidebar (über "Abmelden") an, wer gerade eingeloggt ist - Avatar mit Anfangsbuchstabe + Name/Benutzername, wie bei den meisten Web-Apps üblich.

**Backend** ([server.js](server.js)): Die bestehende `getActor()`-Logik (liest den Benutzernamen aus dem gespeicherten OIDC-`id_token` fürs Audit-Log) wurde in `decodeIdTokenPayload()` aufgeteilt (liefert die komplette Token-Payload) - `getActor()` nutzt das für den Audit-Log-Benutzernamen wie bisher, neu dazu der Endpoint `GET /api/me`, der `{ username, name }` fürs Frontend liefert (keine neue Logik, nur bereits vorhandene, vertrauenswürdige Session-Claims wiederverwendet).

**Frontend**: `fetchCurrentUser()` in [app.js](public/js/app.js) läuft einmalig beim App-Start (nicht bei jedem Reiterwechsel, der Benutzer ändert sich ja währenddessen nicht). Neuer `.sidebar-user`-Block in [index.html](public/index.html), bleibt `hidden`, bis die echten Daten da sind (kein kurzes Aufblitzen eines leeren Avatars) bzw. komplett ausgeblendet, falls aus irgendeinem Grund kein Name ermittelbar ist.

## 20. Benutzerverwaltung: Karten-Grid-Redesign + mehr Details

Die "Benutzer"-Seite war noch die letzte mit einer klassischen Tabelle im Rest-der-App-fremden Stil - jetzt auf dasselbe Karten-Grid wie Nodes/Keys umgestellt (`.node-card`, dieselben Klassen wiederverwendet statt eigener neuer CSS).

**Mehr Details pro Benutzer** (alles, was Headscale tatsächlich zu einem User liefert, live gegen die echte Instanz mit allen 4 vorhandenen Benutzern durchgerechnet):
- **Geräte-Anzahl**: neu berechnet, indem `GET /api/users` ([server.js](server.js)) zusätzlich die Node-Liste abfragt und pro `user.id` zählt, wie viele Geräte diesem Benutzer gehören (live verifiziert: der Hauptbenutzer mit 6 registrierten Geräten zeigt korrekt "6", die anderen drei Konten ohne eigene Geräte "0").
- **Anmeldeart**: "OIDC-Login" vs. "Manuell angelegt" (aus dem `provider`-Feld - leer bedeutet meist per `headscale users create` oder vor der OIDC-Einrichtung angelegt).
- **Anzeigename**: falls über OIDC bekannt (z.B. "Elias Osarumwense" statt nur "elias"), als Untertitel zur Karte.
- **E-Mail**: nur angezeigt, wenn tatsächlich vorhanden (Headscale liefert bei diesem Setup meist einen leeren String, kein Platzhalter für "nicht vorhanden" nötig).
- Erstellt-Datum und interne ID weiterhin sichtbar wie zuvor.

**Nebenbei aufgeräumt:** Die generischen, unstyled `table`/`th`/`td`-Regeln und `.action-cell` in [style.css](public/style.css) waren nach diesem Umbau nirgends mehr referenziert (Benutzer war die letzte Seite mit einer echten `<table>`) und wurden entfernt.

## Neue/geänderte Dateien im Überblick

| Datei | Änderung |
|---|---|
| `server.js` | Docker-Scan, SSH-Vault-Routen, Ping-Endpoint, Kuma-Integration (Status + CRUD + Discord-Benachrichtigungen), Subnet-Routes-CRUD, Netzwerk-Graph-Endpoint (inkl. Besitzer/Sitzungsablauf pro Node), `/api/me`, Benutzer-Endpoint inkl. Geräte-Anzahl, Pre-Auth-Key-Fix, Audit-Log-Aufrufe, Sicherheitsnetz |
| `audit.js` | **Neu** – Postgres-Audit-Log (pg-Pool, logAudit/getAuditLog) |
| `sshVault.js` | **Neu** – verschlüsselte SSH-Zugangsdaten-Speicherung |
| `public/style.css` | Komplett überarbeitet (minimalistisch), neue Sektionen für Docker/Status/Ping/Modal/Routes/Audit-Feed/Discord-Benachrichtigungs-Karte/Netzwerk-Graph, `--warning`-Variable, Sidebar-Kategorie-Labels |
| `public/js/app.js` | View-Router mit Cache/Transitions, Docker-Scan-UI, Ping, Kuma-Status-UI inkl. CRUD-Modal, Keys-Grid-Redesign + ID-Fix, Subnet-Routes-UI, Audit-Log-Feed auf der Startseite, Discord-Benachrichtigungs-Toggle, Netzwerk-Graph (vis-network) auf der Startseite |
| `public/index.html` | Neue Nav-Einträge (Docker, Status, Subnet Routes) in zwei Kategorien (Headscale / Weitere Dienste), SSH- und Monitor-Modal, vis-network-CDN-Einbindung |
| `public/views/docker.html` | **Neu** |
| `public/views/status.html` | **Neu** |
| `public/views/routes.html` | **Neu** |
| `public/views/dashboard.html` | Neue Audit-Log-Feed-Kachel, neue Netzwerk-Graph-Kachel |
| `public/views/keys.html` | Tabelle → Karten-Grid |
| `public/views/users.html` | Tabelle → Karten-Grid |
| `.env.example` | **Neu** – dokumentiert alle benötigten Umgebungsvariablen |
| `.gitignore` | `/data/` (SSH-Vault) ergänzt |
| `package.json` | `nodemonConfig.ignore` für `data/`, neue Dependency `pg` |

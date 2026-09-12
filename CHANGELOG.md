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

**Frontend**: [audit.html](public/views/audit.html) + [app.js](public/js/app.js) - klassische Tabelle (Zeitstempel/Actor/Action/Target) mit "Neu laden"-Button, kein Polling.

**Nicht live testbar:** Anders als bei Headscale/Kuma lief hier keine echte Postgres-Instanz zum Gegentesten zur Verfügung (Docker-Container läuft nur auf dem VPS) - SQL wurde sorgfältig geprüft, aber die tatsächliche DB-Interaktion muss auf dem VPS verifiziert werden. Auf dem VPS in der dortigen `.env`: `DATABASE_URL=postgres://<user>:<passwort>@127.0.0.1:5432/headpilot` (Schema `headpilot`, Tabelle `audit_log` muss bereits existieren).

## Neue/geänderte Dateien im Überblick

| Datei | Änderung |
|---|---|
| `server.js` | Docker-Scan, SSH-Vault-Routen, Ping-Endpoint, Kuma-Integration (Status + CRUD), Subnet-Routes-CRUD, Pre-Auth-Key-Fix, Audit-Log-Aufrufe, Sicherheitsnetz |
| `audit.js` | **Neu** – Postgres-Audit-Log (pg-Pool, logAudit/getAuditLog) |
| `sshVault.js` | **Neu** – verschlüsselte SSH-Zugangsdaten-Speicherung |
| `public/style.css` | Komplett überarbeitet (minimalistisch), neue Sektionen für Docker/Status/Ping/Modal/Routes, `--warning`-Variable |
| `public/js/app.js` | View-Router mit Cache/Transitions, Docker-Scan-UI, Ping, Kuma-Status-UI inkl. CRUD-Modal, Keys-Grid-Redesign + ID-Fix, Subnet-Routes-UI, Audit-Log-Tabelle |
| `public/index.html` | Neue Nav-Einträge (Docker, Status, Subnet Routes, Audit Log), SSH- und Monitor-Modal |
| `public/views/docker.html` | **Neu** |
| `public/views/status.html` | **Neu** |
| `public/views/routes.html` | **Neu** |
| `public/views/audit.html` | **Neu** |
| `public/views/keys.html` | Tabelle → Karten-Grid |
| `.env.example` | **Neu** – dokumentiert alle benötigten Umgebungsvariablen |
| `.gitignore` | `/data/` (SSH-Vault) ergänzt |
| `package.json` | `nodemonConfig.ignore` für `data/`, neue Dependency `pg` |

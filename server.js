require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session'); // Für das Session-Management
const { execFile } = require('child_process');

// Sicherheitsnetz: Ein unerwarteter Fehler (z.B. eine abgelehnte Promise irgendwo tief in
// einer Bibliothek) soll NIE den ganzen Prozess killen und damit alle offenen Verbindungen
// mitten in der Anfrage kappen (im Browser sieht man das dann nur als "Load failed").
// Stattdessen wird der Fehler geloggt und der Server läuft weiter.
process.on('unhandledRejection', (err) => {
    console.error('Unbehandelte Promise-Ablehnung (Server läuft weiter):', err);
});
process.on('uncaughtException', (err) => {
    console.error('Unerwarteter Fehler (Server läuft weiter):', err);
});

const app = express();
app.set('trust proxy', 1);
// Basis-Middleware
app.use(cors());
app.use(express.json());

// Variablen aus der .env Datei
const PORT = process.env.PORT || 3000;
const HEADSCALE_URL = process.env.HEADSCALE_URL;

// FIX 1: Akzeptiert HEADSCALE_API_KEY oder das einfache API_KEY aus deiner .env
const API_KEY = process.env.HEADSCALE_API_KEY || process.env.API_KEY; 

const KEYCLOAK_URL = process.env.KEYCLOAK_REALM_URL;
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID;
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://vpn.elias-osarumwense.com/login/callback';

app.use(session({
    // FIX 2: Fallback-String verhindert einen HTTP 500 Absturz, falls SESSION_SECRET mal temporär fehlt
    secret: process.env.SESSION_SECRET || 'headpilot-vienna-fallback-secret-string', 
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 60 * 60 * 1000 
    }
}));

// =========================================================================
// 1. ÖFFENTLICHE ROUTEN (Müssen VOR der Schranke liegen!)
// =========================================================================

// Login-Startpunkt: Leitet den Browser zu Keycloak weiter
app.get('/login', (req, res) => {
    const authUrl = `${KEYCLOAK_URL}/protocol/openid-connect/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid+profile+email`;
    res.redirect(authUrl);
});

// Callback: Hier landet der User nach dem Keycloak-Login
app.get('/login/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Kein Authorization Code erhalten.');

    try {
        // Tausche den Code bei Keycloak gegen ein echtes Token
        const response = await fetch(`${KEYCLOAK_URL}/protocol/openid-connect/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            })
        });

        if (!response.ok) throw new Error('Token-Austausch bei Keycloak failed');

        const tokenData = await response.json();
        
        // Sitzung im Server-Speicher als verifiziert markieren
        req.session.isAuthenticated = true;
        req.session.tokens = tokenData;

        // HIER IST DIE GEÄNDERTE ZEILE: Weiterleitung exklusiv auf den Unterpfad /dashboard
        res.redirect('/dashboard');
    } catch (error) {
        console.error('OIDC Fehler:', error.message);
        res.status(500).send('Authentifizierungsfehler: ' + error.message);
    }
});

// Logout-Route: Beendet die lokale Session und loggt den User aus Keycloak aus
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        const logoutUrl = `${KEYCLOAK_URL}/protocol/openid-connect/logout?client_id=${CLIENT_ID}`;
        res.redirect(logoutUrl);
    });
});

// =========================================================================
// 2. DIE AUTH-SCHRANKE (MIDDLEWARE)
// =========================================================================
const JEDER_ZUGRIFF_ERFORDERT_LOGIN = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next(); // User ist eingeloggt, fahre fort
    }
    res.redirect('/login'); // Nicht eingeloggt? Ab zu Keycloak!
};

// Schranke für alle folgenden Routen und statischen Dateien aktivieren!
app.use(JEDER_ZUGRIFF_ERFORDERT_LOGIN);

// Das Frontend wird erst NACH erfolgreichem Login freigegeben
app.use(express.static('public'));

app.get('/dashboard', (req, res) => {
    res.redirect('/');
});

// =========================================================================
// 3. GESCHÜTZTE API-ROUTEN (Alle ab hier erfordern eine gültige Session)
// =========================================================================

// Route: Holt alle Nodes von Headscale
app.get('/api/nodes', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`Headscale API Fehler: ${response.status}`);
        res.json(await response.json());
    } catch (error) {
        console.error("API Fehler:", error.message);
        res.status(500).json({ error: 'Fehler beim Abrufen der VPN-Daten' });
    }
});

// 1. Node umbenennen
app.post('/api/nodes/:id/rename/:newName', async (req, res) => {
    try {
        const { id, newName } = req.params;
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node/${id}/rename/${newName}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. Node löschen
app.delete('/api/nodes/:id', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node/${req.params.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. Node-Sitzung ablaufen lassen (Expire)
app.post('/api/nodes/:id/expire', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node/${req.params.id}/expire`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 4. Node per ICMP anpingen (der Headpilot-Server ist ja selbst Tailnet-Peer, siehe SSH-Docker-Feature)
app.post('/api/nodes/ping', (req, res) => {
    const { ip } = req.body;

    // Nur echte IPv4/IPv6-Zeichen zulassen - execFile geht zwar ohne Shell (kein Injection-Risiko),
    // aber so bekommen wir bei Unsinn sofort einen sauberen 400 statt eines kryptischen ping-Fehlers.
    if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) {
        return res.status(400).json({ error: 'Ungültige IP-Adresse.' });
    }

    // Ein Ping-Versuch, max. 2 Sekunden Wartezeit auf Antwort. macOS (Entwicklung) und
    // Linux (Produktion) haben leicht unterschiedliche Flags für die Timeout-Angabe.
    const args = process.platform === 'darwin'
        ? ['-c', '1', '-t', '2', ip]
        : ['-c', '1', '-W', '2', ip];

    execFile('ping', args, { timeout: 4000 }, (err, stdout) => {
        const match = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
        if (match) {
            return res.json({ reachable: true, timeMs: Math.round(parseFloat(match[1])) });
        }
        res.json({ reachable: false });
    });
});

// 1. Alle Benutzer abrufen
app.get('/api/users', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/user`, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`Fehler: ${response.status}`);
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. Neuen Benutzer erstellen
app.post('/api/users', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/user`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ name: req.body.name })
        });
        if (!response.ok) throw new Error(`Fehler: ${response.status}`);
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. Benutzer umbenennen
app.post('/api/users/:id/rename/:newName', async (req, res) => {
    try {
        const { id, newName } = req.params;
        const response = await fetch(`${HEADSCALE_URL}/api/v1/user/${id}/rename/${newName}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 4. Benutzer löschen
app.delete('/api/users/:id', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/user/${req.params.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- PRE-AUTH KEYS ROUTEN ---
app.get('/api/keys', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/preauthkey`, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/keys', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/preauthkey`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(req.body)
        });
        if (!response.ok) {
            const errorText = await response.text(); 
            throw new Error(`Headscale API-Fehler ${response.status}: ${errorText}`);
        }
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/keys/expire', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/preauthkey/expire`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(req.body)
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Headscale Fehler beim Ablaufen: ${errorText}`);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/routes', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/routes`, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: error.message }); }
});

const { Client } = require('ssh2');
const sshVault = require('./sshVault');

// docker ps -a listet ALLE Container (auch gestoppte). {{json .}} lässt Docker selbst
// sauber escaptes JSON pro Zeile ausgeben, statt es uns per Hand (fehleranfällig) zusammenzubauen.
const DOCKER_PS_CMD = "docker ps -a --format '{{json .}}'";

// Führt einen Befehl über eine bestehende SSH-Verbindung aus und sammelt stdout/stderr/exit-code.
// Optional kann etwas auf stdin geschrieben werden (z.B. das Passwort für "sudo -S").
function execOverSsh(conn, cmd, stdinData) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);

            let stdout = '';
            let stderr = '';
            stream.on('data', (chunk) => { stdout += chunk; });
            stream.stderr.on('data', (chunk) => { stderr += chunk; });
            stream.on('close', (code) => resolve({ code, stdout, stderr }));

            if (stdinData) stream.write(stdinData);
            stream.end();
        });
    });
}

// Typische Meldung, wenn der SSH-User zwar eingeloggt ist, aber nicht auf den Docker-Socket darf
// (sehr häufig auf frisch aufgesetzten Servern, wenn der User nicht in der "docker"-Gruppe ist)
function isPermissionDenied(stderr) {
    return /permission denied|dial unix.*docker\.sock/i.test(stderr);
}

function isDockerNotFound(stderr) {
    return /command not found|no such file/i.test(stderr);
}

// Metadaten zu gespeicherten SSH-Zugangsdaten für eine Node - liefert NIE das Passwort zurück
app.get('/api/nodes/:id/ssh-credentials', (req, res) => {
    // Ohne das würde der Browser eine frühere "saved: false"-Antwort (von vor dem Speichern)
    // cachen und nach einem Reload weiter anzeigen, dass nichts gespeichert sei.
    res.set('Cache-Control', 'no-store');
    res.json(sshVault.getCredentialsInfo(req.params.id));
});

// Entfernt gespeicherte SSH-Zugangsdaten für eine Node wieder
app.delete('/api/nodes/:id/ssh-credentials', (req, res) => {
    sshVault.deleteCredentials(req.params.id);
    res.json({ ok: true });
});

// Route: SSH Login und Docker Container abfragen
app.post('/api/nodes/ssh-docker', (req, res) => {
    const { ip, nodeId, remember } = req.body;
    let { username, password } = req.body;

    if (!ip) {
        return res.status(400).json({ error: 'IP wird benötigt.' });
    }

    // Keine Zugangsdaten im Request? Dann schauen, ob für diese Node welche im Vault liegen
    if ((!username || !password) && nodeId) {
        const saved = sshVault.getCredentials(nodeId);
        if (saved) {
            username = saved.username;
            password = saved.password;
        }
    }

    if (!username || !password) {
        return res.status(400).json({ error: 'Benutzername und Passwort werden benötigt.' });
    }

    // Verhindert "Cannot set headers after they are sent", falls 'error' nach 'ready' feuert
    let responded = false;
    let credentialsSaved = false;
    const respond = (status, body) => {
        if (responded) return;
        responded = true;
        res.status(status).json({ ...body, ...(remember ? { credentialsSaved } : {}) });
    };

    const conn = new Client();

    conn.on('ready', async () => {
        // Erst JETZT (nach erfolgreicher SSH-Authentifizierung) auf Wunsch verschlüsselt speichern -
        // so landen nie falsche/ungeprüfte Zugangsdaten im Vault.
        if (remember && nodeId) {
            try {
                sshVault.saveCredentials(nodeId, username, password);
                credentialsSaved = true;
            } catch (e) {
                console.error('SSH-Vault: Speichern fehlgeschlagen:', e.message);
            }
        }

        try {
            let result = await execOverSsh(conn, DOCKER_PS_CMD);

            // Kein Zugriff auf den Docker-Socket? Automatisch mit sudo erneut versuchen
            // (Passwort wird direkt über stdin an "sudo -S" übergeben, landet also nicht im Prozess-Log).
            if (result.code !== 0 && isPermissionDenied(result.stderr)) {
                result = await execOverSsh(conn, `sudo -S -p '' ${DOCKER_PS_CMD}`, password + '\n');
            }

            conn.end();

            // Kein Output UND ein Fehler-Code -> Docker ist vermutlich nicht installiert
            // oder nicht im PATH der (nicht-interaktiven) SSH-Session (häufig bei NAS-Systemen)
            if (result.code !== 0 && result.stdout.trim() === '') {
                console.error(`Docker-Befehl auf ${ip} fehlgeschlagen (Exit ${result.code}): ${result.stderr.trim()}`);
                return respond(500, {
                    error: isDockerNotFound(result.stderr)
                        ? 'Docker wurde auf diesem Gerät nicht gefunden (evtl. nicht installiert).'
                        : isPermissionDenied(result.stderr)
                            ? 'Kein Zugriff auf den Docker-Dienst (Benutzer weder in der "docker"-Gruppe, noch per sudo berechtigt).'
                            : `Docker-Befehl fehlgeschlagen: ${result.stderr.trim() || 'Unbekannter Fehler'}`
                });
            }

            try {
                // Docker gibt pro Zeile ein eigenes JSON-Objekt aus
                const containers = result.stdout.trim().split('\n')
                    .filter(line => line.length > 0)
                    .map(line => JSON.parse(line))
                    .map(c => ({
                        id: c.ID,
                        name: c.Names,
                        state: c.State,       // z.B. "running", "exited", "paused", "restarting"
                        status: c.Status,     // z.B. "Up 3 hours" oder "Exited (0) 2 days ago"
                        image: c.Image,
                        ports: c.Ports,
                        runningFor: c.RunningFor
                    }));

                respond(200, { containers });
            } catch (parseError) {
                console.error('Docker-Ausgabe konnte nicht geparst werden:', result.stdout);
                respond(500, { error: 'Konnte Docker-Daten nicht verarbeiten.' });
            }
        } catch (execErr) {
            conn.end();
            respond(500, { error: 'Docker-Befehl konnte nicht ausgeführt werden.' });
        }
    }).on('error', (err) => {
        // Genauere Fehlerursache loggen, statt sie hinter einer generischen Meldung zu verstecken
        console.error(`SSH-Fehler bei ${username}@${ip}: [${err.level || err.code || 'unknown'}] ${err.message}`);

        let message = `SSH-Verbindung fehlgeschlagen: ${err.message}`;
        if (err.level === 'client-authentication') {
            message = 'SSH Login fehlgeschlagen: Benutzername oder Passwort falsch (oder Passwort-Login für diesen User deaktiviert).';
        } else if (err.code === 'ETIMEDOUT') {
            // TCP-Verbindung kam nie zustande -> der Headpilot-Server selbst hat keine Route zur VPN-IP
            // des Geräts (er müsste dafür selbst als Tailscale/Headscale-Client im gleichen Tailnet hängen).
            message = 'Zeitüberschreitung: Der Headpilot-Server erreicht diese VPN-IP nicht (keine TCP-Verbindung möglich). Läuft auf dem Server, der Headpilot hostet, selbst ein verbundener Tailscale/Headscale-Client?';
        } else if (err.level === 'client-timeout') {
            // TCP hat verbunden, aber die SSH-Handshake kam nicht rechtzeitig zustande
            message = 'Zeitüberschreitung: TCP-Verbindung stand, aber der SSH-Handshake wurde nicht abgeschlossen (Port 22 offen, aber evtl. kein SSH-Dienst oder sehr langsame Antwort).';
        } else if (err.code === 'ECONNREFUSED') {
            message = 'Verbindung abgelehnt: Auf Port 22 läuft kein SSH-Dienst (ist SSH auf dem Gerät aktiviert?).';
        } else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') {
            message = 'Gerät über das VPN nicht erreichbar.';
        } else if (err.level === 'client-dns' || err.code === 'ENOTFOUND') {
            message = 'Host konnte nicht aufgelöst werden.';
        }

        respond(401, { error: message });
    }).connect({
        host: ip,
        port: 22,
        username: username,
        password: password,
        // Manche Geräte (v.a. NAS-Systeme) hängen erst mal am Reverse-DNS-Lookup der
        // anfragenden IP, bevor sie das SSH-Banner senden - über Tailscale-IPs (kein PTR-Eintrag)
        // kann das mehrere Sekunden dauern. 8s war dafür oft zu knapp.
        readyTimeout: 20000
    });
});

// Server starten
app.listen(PORT, () => {
    console.log(`🚀 Headpilot Backend läuft gesichert auf http://localhost:${PORT}`);
});
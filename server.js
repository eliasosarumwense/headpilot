require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session'); // Für das Session-Management
const { execFile } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const audit = require('./audit');

// Liest den eingeloggten Benutzernamen aus dem gespeicherten OIDC-id_token (JWT).
// Keine erneute Signatur-Prüfung nötig - das Token wurde bereits einmal beim Token-
// Austausch mit Keycloak (über HTTPS + Client-Secret) verifiziert, wir lesen hier nur
// den bereits vertrauenswürdigen Claim aus der Session wieder aus.
function getActor(req) {
    try {
        const idToken = req.session?.tokens?.id_token;
        if (!idToken) return 'unknown';
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
        return payload.preferred_username || payload.email || 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

// Workaround für ein bekanntes macOS/Tailscale-Problem: Wenn Tailscale MagicDNS die DNS-
// Auflösung dynamisch über die System Configuration verwaltet (statt einer statischen
// /etc/resolv.conf), findet Node's OS-basiertes dns.lookup() (das fetch/http/socket.io intern
// für JEDEN Hostnamen nutzt) manche Domains nicht (ENOTFOUND), obwohl sie ganz normal per DNS
// auflösbar sind - dns.resolve4/6 (fragt den Nameserver direkt ab, ohne über die OS-Ebene zu
// gehen) findet sie hingegen problemlos. Reine Lokal-macOS-Eigenheit, betrifft die
// VPS-Produktion nicht, schadet dort aber auch nicht (Fallback greift nur, wenn die normale
// Auflösung tatsächlich fehlschlägt).
const originalDnsLookup = dns.lookup;
dns.lookup = function patchedDnsLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    originalDnsLookup(hostname, options, (err, address, family) => {
        if (!err) return callback(null, address, family);
        if (err.code !== 'ENOTFOUND') return callback(err);

        const wantAll = options && options.all;
        Promise.allSettled([dns.promises.resolve4(hostname), dns.promises.resolve6(hostname)])
            .then(([v4, v6]) => {
                const addrs = [];
                if (v4.status === 'fulfilled') addrs.push(...v4.value.map(a => ({ address: a, family: 4 })));
                if (v6.status === 'fulfilled') addrs.push(...v6.value.map(a => ({ address: a, family: 6 })));
                if (addrs.length === 0) return callback(err); // ursprünglichen Fehler zurückgeben
                if (wantAll) return callback(null, addrs);
                callback(null, addrs[0].address, addrs[0].family);
            });
    });
};

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

        await audit.logAudit({ actor: getActor(req), action: 'LOGIN_SUCCESS', ip: req.ip });

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
        const data = await response.json();
        await audit.logAudit({ actor: getActor(req), action: 'NODE_RENAME', target: id, details: { newName }, ip: req.ip });
        res.json(data);
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
        await audit.logAudit({ actor: getActor(req), action: 'NODE_DELETE', target: req.params.id, ip: req.ip });
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
        const data = await response.json();
        await audit.logAudit({ actor: getActor(req), action: 'USER_CREATE', target: data.user?.id, details: { name: req.body.name }, ip: req.ip });
        res.json(data);
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
        await audit.logAudit({ actor: getActor(req), action: 'USER_DELETE', target: req.params.id, ip: req.ip });
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
        const data = await response.json();
        await audit.logAudit({
            actor: getActor(req),
            action: 'PREAUTHKEY_CREATE',
            target: data.preAuthKey?.id,
            details: { user: req.body.user, reusable: req.body.reusable },
            ip: req.ip
        });
        res.json(data);
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

// =========================================================================
// SUBNET ROUTES
// =========================================================================
// Diese Headscale-Version hat keine eigenständige "/api/v1/routes"-Liste mit IDs mehr
// (Aufruf liefert 404) - Routen leben stattdessen direkt am Node: "availableRoutes"
// (per --advertise-routes vom Gerät angekündigt) und "approvedRoutes" (von einem Admin
// genehmigt, per POST .../approve_routes gesetzt - ersetzt dabei IMMER die komplette
// Liste für diesen Node, kein Toggle für eine einzelne Route). Wir bauen daraus pro
// Node/Route-Kombination eine flache Liste, wie sie das Frontend braucht.
app.get('/api/routes', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node`, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        const data = await response.json();

        const routes = [];
        (data.nodes || []).forEach(n => {
            const advertised = n.availableRoutes || [];
            const approved = n.approvedRoutes || [];
            // Auch eine genehmigte, aber nicht mehr angekündigte Route mit anzeigen -
            // sonst könnte man sie nie mehr über die UI wieder deaktivieren.
            const allRoutes = [...new Set([...advertised, ...approved])];

            allRoutes.forEach(route => {
                routes.push({
                    nodeId: n.id,
                    nodeName: n.givenName || n.name,
                    route,
                    advertised: advertised.includes(route),
                    approved: approved.includes(route)
                });
            });
        });

        res.json({ routes });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// Holt den aktuellen (frischen!) approvedRoutes-Stand eines Nodes und setzt ihn mit
// der Ziel-Route hinzugefügt oder entfernt neu - approve_routes ersetzt immer die
// komplette Liste, daher muss hier immer der volle, aktuelle Stand mitgeschickt werden.
async function setNodeRouteApproval(nodeId, route, shouldApprove) {
    const nodeRes = await fetch(`${HEADSCALE_URL}/api/v1/node/${nodeId}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
    });
    if (!nodeRes.ok) throw new Error(`Node nicht gefunden: ${await nodeRes.text()}`);
    const { node } = await nodeRes.json();

    const current = node.approvedRoutes || [];
    const updated = shouldApprove
        ? [...new Set([...current, route])]
        : current.filter(r => r !== route);

    const approveRes = await fetch(`${HEADSCALE_URL}/api/v1/node/${nodeId}/approve_routes`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ routes: updated })
    });
    if (!approveRes.ok) throw new Error(`Headscale-Fehler: ${await approveRes.text()}`);
}

app.post('/api/routes/approve', async (req, res) => {
    const { nodeId, route } = req.body;
    if (!nodeId || !route) return res.status(400).json({ error: 'nodeId und route werden benötigt.' });
    try {
        await setNodeRouteApproval(nodeId, route, true);
        await audit.logAudit({ actor: getActor(req), action: 'ROUTE_APPROVE', target: nodeId, details: { route }, ip: req.ip });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/routes/disable', async (req, res) => {
    const { nodeId, route } = req.body;
    if (!nodeId || !route) return res.status(400).json({ error: 'nodeId und route werden benötigt.' });
    try {
        await setNodeRouteApproval(nodeId, route, false);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// =========================================================================
// UPTIME KUMA STATUS
// =========================================================================
// Direkter Login mit echten Zugangsdaten (statt einer öffentlichen Status-Page mit Slug) -
// Kuma bietet dafür keine normale REST-API, sondern nur seine Socket.IO-Schnittstelle
// (dieselbe, die auch das Kuma-Webinterface selbst benutzt).
// KUMA_URL zeigt direkt auf Kuma im Tailnet (z.B. http://100.x.x.x:3001) bzw. auf dem
// VPS selbst auf http://127.0.0.1:3001. Bewusst KEIN Default: Fehlt eine der drei
// Variablen, antwortet die Route sofort mit "configured: false" - ganz ohne Netzwerk-Request.
const { io: kumaIo } = require('socket.io-client');
const KUMA_URL = process.env.KUMA_URL;
const KUMA_USER = process.env.KUMA_USER;
const KUMA_PASS = process.env.KUMA_PASS;
const KUMA_TIMEOUT_MS = 3000;

// Kuma-Heartbeat-Status-Codes: 0 = down, 1 = up, 2 = pending, 3 = maintenance
const KUMA_STATUS_MAP = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

// Öffnet eine Socket.IO-Verbindung zu Kuma, loggt sich ein und übergibt den fertig
// eingeloggten Socket an "work" (muss ein Promise zurückgeben). Kümmert sich zentral um
// Verbindungsfehler, Login-Fehler, Timeout und sauberes Trennen danach - jede Kuma-Aktion
// (lesen, anlegen, bearbeiten, löschen) nutzt dieselbe Grundlage.
function withKumaLogin(work) {
    return new Promise((resolve, reject) => {
        if (!KUMA_URL || !KUMA_USER || !KUMA_PASS) {
            return reject(new Error('Kuma ist nicht konfiguriert.'));
        }

        const socket = kumaIo(KUMA_URL, { reconnection: false, timeout: KUMA_TIMEOUT_MS });
        let settled = false;

        const timer = setTimeout(() => finish(new Error('Timeout bei der Verbindung zu Kuma')), KUMA_TIMEOUT_MS);

        function finish(err, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.disconnect();
            if (err) reject(err); else resolve(result);
        }

        socket.on('connect_error', (err) => finish(err));

        socket.on('connect', () => {
            socket.emit('login', { username: KUMA_USER, password: KUMA_PASS, token: '' }, (loginRes) => {
                if (!loginRes || !loginRes.ok) {
                    return finish(new Error(loginRes && loginRes.msg ? loginRes.msg : 'Kuma-Login fehlgeschlagen'));
                }
                work(socket).then((result) => finish(null, result)).catch(finish);
            });
        });
    });
}

// Sammelt für jeden Monitor Name, Typ, Ziel, aktuellen Status, 24h-Uptime% und letzte
// Antwortzeit. Kuma schickt diese Infos nach dem Login nicht auf einen Schlag, sondern über
// mehrere einzelne Events pro Monitor, deshalb sammeln wir, bis wir für jeden bekannten
// Monitor sowohl Heartbeat als auch Uptime haben (oder der Timeout zuerst greift).
// Wie viele der letzten Heartbeats für die Verlaufs-Leiste (wie im Kuma-Dashboard) mitgeschickt werden
const KUMA_HEARTBEAT_BAR_LENGTH = 50;

function fetchKumaMonitors() {
    return withKumaLogin((socket) => new Promise((resolve) => {
        const monitorsById = {}; // monitorId -> { name, type, target, port }
        const heartbeatLists = {}; // monitorId -> voller Heartbeat-Verlauf (neueste zuletzt)
        const uptimes = {};      // monitorId -> 24h-Uptime (0-1)
        let expectedIds = null;

        function finish() {
            resolve(Object.keys(monitorsById).map(id => {
                const beats = heartbeatLists[id] || [];
                const lastBeat = beats[beats.length - 1];
                return {
                    id: Number(id),
                    name: monitorsById[id].name,
                    type: monitorsById[id].type,
                    target: monitorsById[id].target,
                    port: monitorsById[id].port,
                    status: lastBeat ? (KUMA_STATUS_MAP[lastBeat.status] || 'unknown') : 'unknown',
                    uptime24h: typeof uptimes[id] === 'number' ? Math.round(uptimes[id] * 1000) / 10 : null,
                    responseTimeMs: lastBeat && typeof lastBeat.ping === 'number' ? lastBeat.ping : null,
                    // Verlaufs-Leiste wie im Kuma-Dashboard: die letzten N Heartbeats als einfache Status-Liste
                    heartbeatBar: beats.slice(-KUMA_HEARTBEAT_BAR_LENGTH).map(b => KUMA_STATUS_MAP[b.status] || 'unknown')
                };
            }));
        }

        function checkComplete() {
            if (expectedIds && expectedIds.every(id => heartbeatLists[id] !== undefined && uptimes[id] !== undefined)) {
                finish();
            }
        }

        socket.on('monitorList', (list) => {
            expectedIds = Object.keys(list);
            expectedIds.forEach(id => {
                monitorsById[id] = {
                    name: list[id].name,
                    type: list[id].type,
                    target: list[id].type === 'http' ? list[id].url : list[id].hostname,
                    port: list[id].type === 'port' ? list[id].port : null
                };
            });
            if (expectedIds.length === 0) finish(); // keine Monitore vorhanden
        });

        socket.on('heartbeatList', (monitorId, list) => {
            heartbeatLists[monitorId] = Array.isArray(list) ? list : [];
            checkComplete();
        });

        socket.on('uptime', (monitorId, duration, percent) => {
            if (duration === 24) {
                uptimes[monitorId] = percent;
                checkComplete();
            }
        });
    }));
}

// Baut aus den vereinfachten Formularfeldern (Name/Typ/Ziel/Port/Intervall) das Monitor-
// Objekt im von Kuma erwarteten Format. Bewusst nur die 3 gängigsten Typen unterstützt.
// Kuma verarbeitet beim Anlegen/Bearbeiten offenbar ALLE möglichen Monitor-Felder (auch die für
// ganz andere Typen wie Kafka/RADIUS/gRPC/MQTT/OAuth/Datenbank), unabhängig vom gewählten Typ -
// fehlt eines davon, crasht Kuma intern ("Cannot read properties of undefined (reading 'every')").
// Live herausgefunden, indem ein echtes, komplettes Monitor-Objekt aus Kuma schrittweise auf die
// tatsächlich nötigen Felder reduziert wurde. Deshalb hier ein vollständiges Set neutraler
// Defaults für alle Typen, nicht nur für die drei (http/port/ping), die wir selbst anbieten.
function kumaMonitorDefaults({ type, interval }) {
    const checkInterval = Number(interval) || 60;
    return {
        description: null,
        url: 'https://',
        method: 'GET',
        hostname: null,
        port: null,
        maxretries: 0,
        weight: 2000,
        active: true,
        type,
        timeout: 48,
        interval: checkInterval,
        retryInterval: checkInterval,
        resendInterval: 0,
        keyword: null,
        invertKeyword: false,
        expiryNotification: false,
        ignoreTls: false,
        upsideDown: false,
        packetSize: 56,
        maxredirects: 10,
        accepted_statuscodes: ['200-299'],
        dns_resolve_type: 'A',
        dns_resolve_server: '1.1.1.1',
        dns_last_result: null,
        docker_container: '',
        docker_host: null,
        proxyId: null,
        notificationIDList: {},
        mqttTopic: '',
        mqttSuccessMessage: '',
        databaseQuery: null,
        authMethod: null,
        grpcUrl: null,
        grpcProtobuf: null,
        grpcMethod: null,
        grpcServiceName: null,
        grpcEnableTls: false,
        radiusCalledStationId: null,
        radiusCallingStationId: null,
        game: null,
        gamedigGivenPortOnly: true,
        httpBodyEncoding: null,
        jsonPath: null,
        expectedValue: null,
        kafkaProducerTopic: null,
        kafkaProducerBrokers: [],
        kafkaProducerSsl: false,
        kafkaProducerAllowAutoTopicCreation: false,
        kafkaProducerMessage: null,
        kafkaProducerSaslOptions: { mechanism: 'None' },
        headers: null,
        body: null,
        grpcBody: null,
        grpcMetadata: null,
        basic_auth_user: null,
        basic_auth_pass: null,
        oauth_client_id: null,
        oauth_client_secret: null,
        oauth_token_url: null,
        oauth_scopes: null,
        oauth_auth_method: 'client_secret_basic',
        pushToken: null,
        databaseConnectionString: null,
        radiusUsername: null,
        radiusPassword: null,
        radiusSecret: null,
        mqttUsername: '',
        mqttPassword: '',
        authWorkstation: null,
        authDomain: null,
        tlsCa: null,
        tlsCert: null,
        tlsKey: null
    };
}

// Reine Ausgabe-/Berechnungsfelder, die getMonitor zwar mitliefert, "editMonitor" aber weder
// kennt noch akzeptiert (führt sonst zu SQL-Fehlern à la "no column named ..."). Ebenfalls live
// herausgefunden, indem jedes einzelne verursachende Feld nacheinander entfernt wurde.
// WICHTIG: "id" bewusst NICHT in dieser Liste - editMonitor braucht sie im Objekt selbst, um zu
// wissen, welcher Datensatz gemeint ist (führt sonst zu "Undefined binding(s) ... id = ?").
const KUMA_MONITOR_READONLY_FIELDS = [
    'childrenIDs', 'pathName', 'parent',
    'forceInactive', 'includeSensitiveData', 'maintenance', 'screenshot', 'tags'
];

function stripReadonlyMonitorFields(monitor) {
    const clean = { ...monitor };
    KUMA_MONITOR_READONLY_FIELDS.forEach(f => delete clean[f]);
    return clean;
}

function buildKumaMonitorPayload({ type, name, target, port, interval }) {
    if (!['http', 'port', 'ping'].includes(type)) throw new Error('Unbekannter Monitor-Typ.');

    const payload = { ...kumaMonitorDefaults({ type, interval }), name };
    if (type === 'http') payload.url = target;
    if (type === 'port') { payload.hostname = target; payload.port = Number(port); }
    if (type === 'ping') payload.hostname = target;
    return payload;
}

// Überträgt die vereinfachten Formularfelder auf ein bereits bestehendes, vollständiges
// Kuma-Monitor-Objekt (Kumas "editMonitor" erwartet immer das komplette Objekt zurück,
// kein Teil-Update - alle nicht angefassten Felder bleiben also einfach wie sie waren).
function applyKumaMonitorFields(existing, { name, target, port, interval }) {
    const updated = { ...existing };
    if (name !== undefined && name !== '') updated.name = name;
    if (interval !== undefined && interval !== '') {
        updated.interval = Number(interval);
        updated.retryInterval = Number(interval);
    }
    if (existing.type === 'http') {
        if (target !== undefined && target !== '') updated.url = target;
    } else {
        if (target !== undefined && target !== '') updated.hostname = target;
        if (existing.type === 'port' && port !== undefined && port !== '') updated.port = Number(port);
    }
    return stripReadonlyMonitorFields(updated);
}

function validateMonitorInput(body) {
    const { type, name, target } = body || {};
    if (!['http', 'port', 'ping'].includes(type)) return 'Ungültiger Monitor-Typ.';
    if (!name || !String(name).trim()) return 'Name wird benötigt.';
    if (!target || !String(target).trim()) return 'Ziel (URL/Host) wird benötigt.';
    if (type === 'port' && (!body.port || isNaN(Number(body.port)))) return 'Für TCP-Port wird eine gültige Portnummer benötigt.';
    return null;
}

// Route: Uptime-Kuma-Status für die "Status"-Ansicht
app.get('/api/status', async (req, res) => {
    if (!KUMA_URL || !KUMA_USER || !KUMA_PASS) {
        return res.json({ configured: false });
    }

    try {
        const monitors = await fetchKumaMonitors();
        res.json({ configured: true, available: true, monitors });
    } catch (error) {
        // Timeout, Verbindungsfehler oder falsche Zugangsdaten - Dashboard bleibt in
        // jedem Fall nutzbar, wir melden nur "nicht erreichbar".
        console.error('Uptime Kuma nicht erreichbar:', error.message);
        res.json({ configured: true, available: false });
    }
});

// Route: neuen Kuma-Monitor anlegen
app.post('/api/status/monitors', async (req, res) => {
    const validationError = validateMonitorInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        const result = await withKumaLogin((socket) => new Promise((resolve, reject) => {
            socket.emit('add', buildKumaMonitorPayload(req.body), (addRes) => {
                if (addRes && addRes.ok) resolve(addRes);
                else reject(new Error(addRes && addRes.msg ? addRes.msg : 'Anlegen fehlgeschlagen.'));
            });
        }));
        await audit.logAudit({ actor: getActor(req), action: 'MONITOR_CREATE', target: result.monitorID, details: { name: req.body.name, type: req.body.type }, ip: req.ip });
        res.json({ ok: true, monitorID: result.monitorID });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Route: bestehenden Kuma-Monitor bearbeiten (der Typ selbst bleibt fix, nur Name/Ziel/Port/Intervall änderbar)
app.put('/api/status/monitors/:id', async (req, res) => {
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'Name wird benötigt.' });
    if (!req.body.target || !String(req.body.target).trim()) return res.status(400).json({ error: 'Ziel (URL/Host) wird benötigt.' });

    try {
        await withKumaLogin((socket) => new Promise((resolve, reject) => {
            socket.emit('getMonitor', Number(req.params.id), (getRes) => {
                if (!getRes || !getRes.ok) return reject(new Error(getRes && getRes.msg ? getRes.msg : 'Monitor nicht gefunden.'));
                const updated = applyKumaMonitorFields(getRes.monitor, req.body);
                socket.emit('editMonitor', updated, (editRes) => {
                    if (editRes && editRes.ok) resolve(editRes);
                    else reject(new Error(editRes && editRes.msg ? editRes.msg : 'Ändern fehlgeschlagen.'));
                });
            });
        }));
        await audit.logAudit({ actor: getActor(req), action: 'MONITOR_EDIT', target: req.params.id, details: { name: req.body.name }, ip: req.ip });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Route: Kuma-Monitor löschen
app.delete('/api/status/monitors/:id', async (req, res) => {
    try {
        await withKumaLogin((socket) => new Promise((resolve, reject) => {
            socket.emit('deleteMonitor', Number(req.params.id), (delRes) => {
                if (delRes && delRes.ok) resolve(delRes);
                else reject(new Error(delRes && delRes.msg ? delRes.msg : 'Löschen fehlgeschlagen.'));
            });
        }));
        await audit.logAudit({ actor: getActor(req), action: 'MONITOR_DELETE', target: req.params.id, ip: req.ip });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =========================================================================
// DISCORD-BENACHRICHTIGUNG (Status-Reiter)
// =========================================================================
// Bewusst nur EINE Discord-Benachrichtigung, ein/aus schaltbar - mehr braucht es nicht.
// Kuma selbst hat kein "aktiv/pausiert"-Feld, das über die API wirklich funktioniert (das
// "active"-Feld wird beim Anlegen immer stillschweigend auf true zurückgesetzt, egal was man
// schickt - live gegengetestet). Der Schalter wird deshalb über Anlegen/Löschen simuliert:
// "Aus" entfernt die Benachrichtigung komplett aus Kuma (stoppt sofort alle Alerts), "Ein"
// legt sie mit der gemerkten URL neu an. Die URL selbst merkt sich Headpilot lokal (Datei
// unter data/), damit man sie beim Wiedereinschalten nicht erneut eintippen muss.
const NOTIFICATION_CONFIG_PATH = path.join(__dirname, 'data', 'notification-config.json');
const HEADPILOT_NOTIFICATION_NAME = 'Headpilot Discord';

function readNotificationConfig() {
    try {
        return JSON.parse(fs.readFileSync(NOTIFICATION_CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { webhookUrl: '', enabled: false };
    }
}

function writeNotificationConfig(config) {
    fs.mkdirSync(path.dirname(NOTIFICATION_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(NOTIFICATION_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function fetchKumaNotifications() {
    return withKumaLogin((socket) => new Promise((resolve) => {
        // Kuma schickt "notificationList" von selbst direkt nach dem Login.
        // "config" ist bei Kuma ein JSON-STRING (nicht verschachteltes Objekt).
        socket.on('notificationList', (list) => resolve(list || []));
    }));
}

// Legt Headpilots eigene Discord-Benachrichtigung an oder bearbeitet sie - anhand des festen
// Namens identifiziert, damit andere, manuell in Kuma angelegte Benachrichtigungen (falls
// vorhanden) unangetastet bleiben. "isDefault"/"applyExisting" wenden sie automatisch auf
// alle (auch künftige) Dienste an, ohne manuelle Zuweisung pro Monitor.
async function syncHeadpilotNotification({ webhookUrl, enabled }) {
    const existing = (await fetchKumaNotifications()).find(n => n.name === HEADPILOT_NOTIFICATION_NAME);

    if (!enabled || !webhookUrl) {
        if (existing) {
            await withKumaLogin((socket) => new Promise((resolve, reject) => {
                socket.emit('deleteNotification', existing.id, (res) => {
                    if (res && res.ok) resolve(res);
                    else reject(new Error(res && res.msg ? res.msg : 'Deaktivieren fehlgeschlagen.'));
                });
            }));
        }
        return;
    }

    await withKumaLogin((socket) => new Promise((resolve, reject) => {
        const notification = {
            name: HEADPILOT_NOTIFICATION_NAME,
            type: 'discord',
            isDefault: true,
            applyExisting: true,
            discordWebhookUrl: webhookUrl,
            discordUsername: 'Headpilot',
            discordPrefixMessage: ''
        };
        socket.emit('addNotification', notification, existing ? existing.id : null, (res) => {
            if (res && res.ok) resolve(res);
            else reject(new Error(res && res.msg ? res.msg : 'Speichern fehlgeschlagen.'));
        });
    }));
}

app.get('/api/status/notification', (req, res) => {
    if (!KUMA_URL || !KUMA_USER || !KUMA_PASS) {
        return res.json({ configured: false });
    }
    const config = readNotificationConfig();
    res.json({ configured: true, webhookUrl: config.webhookUrl || '', enabled: !!config.enabled });
});

app.post('/api/status/notification', async (req, res) => {
    const enabled = !!req.body.enabled;
    const webhookUrl = (req.body.webhookUrl || '').trim();

    if (enabled && !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(webhookUrl)) {
        return res.status(400).json({ error: 'Gültige Discord-Webhook-URL wird benötigt (https://discord.com/api/webhooks/...), um sie zu aktivieren.' });
    }

    try {
        await syncHeadpilotNotification({ webhookUrl, enabled });
        writeNotificationConfig({ webhookUrl, enabled });
        await audit.logAudit({ actor: getActor(req), action: 'NOTIFICATION_SAVE', details: { enabled }, ip: req.ip });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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

// =========================================================================
// AUDIT LOG
// =========================================================================
// Gleiches Drei-Zustands-Prinzip wie bei Kuma: "configured: false" ohne DATABASE_URL
// (kein Verbindungsversuch), "available: false" bei einem echten DB-Fehler, sonst die
// Einträge.
app.get('/api/audit', async (req, res) => {
    if (!audit.isConfigured()) {
        return res.json({ configured: false });
    }

    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;
        const entries = await audit.getAuditLog({ limit, offset });
        res.json({ configured: true, available: true, entries });
    } catch (error) {
        console.error('Audit-Log nicht erreichbar:', error.message);
        res.json({ configured: true, available: false });
    }
});

// Server starten
app.listen(PORT, () => {
    console.log(`🚀 Headpilot Backend läuft gesichert auf http://localhost:${PORT}`);
});
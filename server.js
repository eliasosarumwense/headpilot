require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session'); // für das session-management
const { execFile } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const audit = require('./audit');

// dekodiert das gespeicherte oidc-id_token (jwt), schon beim login bei keycloak verifiziert.
function decodeIdTokenPayload(req) {
    try {
        const idToken = req.session?.tokens?.id_token;
        if (!idToken) return null;
        return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    } catch (e) {
        return null;
    }
}

// liest den eingeloggten benutzernamen fürs audit-log aus (siehe decodeidtokenpayload oben).
function getActor(req) {
    const payload = decodeIdTokenPayload(req);
    return payload?.preferred_username || payload?.email || 'unknown';
}

// workaround für ein macos/tailscale-dns-problem: dns.lookup() findet manche domains nicht
// (enotfound), obwohl dns.resolve4/6 sie problemlos auflöst. betrifft nur lokal, vps unberührt.
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
                if (addrs.length === 0) return callback(err); // ursprünglichen fehler zurückgeben
                if (wantAll) return callback(null, addrs);
                callback(null, addrs[0].address, addrs[0].family);
            });
    });
};

// sicherheitsnetz: ein unerwarteter fehler soll nie den ganzen prozess killen, nur loggen.
process.on('unhandledRejection', (err) => {
    console.error('Unbehandelte Promise-Ablehnung (Server läuft weiter):', err);
});
process.on('uncaughtException', (err) => {
    console.error('Unerwarteter Fehler (Server läuft weiter):', err);
});

const app = express();
app.set('trust proxy', 1);
// basis-middleware
app.use(cors());
app.use(express.json());

// variablen aus der .env datei
const PORT = process.env.PORT || 3000;
const HEADSCALE_URL = process.env.HEADSCALE_URL;

// fix 1: akzeptiert headscale_api_key oder das einfache api_key aus deiner .env
const API_KEY = process.env.HEADSCALE_API_KEY || process.env.API_KEY; 

const KEYCLOAK_URL = process.env.KEYCLOAK_REALM_URL;
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID;
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://vpn.elias-osarumwense.com/login/callback';

app.use(session({
    // fix 2: fallback-string verhindert einen http 500 absturz, falls session_secret mal temporär fehlt
    secret: process.env.SESSION_SECRET || 'headpilot-vienna-fallback-secret-string', 
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 60 * 60 * 1000 
    }
}));

// --- 1. öffentliche routen (müssen vor der schranke liegen!) ---

// login-startpunkt: leitet den browser zu keycloak weiter
app.get('/login', (req, res) => {
    const authUrl = `${KEYCLOAK_URL}/protocol/openid-connect/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid+profile+email`;
    res.redirect(authUrl);
});

// callback: hier landet der user nach dem keycloak-login
app.get('/login/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Kein Authorization Code erhalten.');

    try {
        // tausche den code bei keycloak gegen ein echtes token
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
        
        // sitzung im server-speicher als verifiziert markieren
        req.session.isAuthenticated = true;
        req.session.tokens = tokenData;

        await audit.logAudit({ actor: getActor(req), action: 'LOGIN_SUCCESS', ip: req.ip });

        // hier ist die geänderte zeile: weiterleitung exklusiv auf den unterpfad /dashboard
        res.redirect('/dashboard');
    } catch (error) {
        console.error('OIDC Fehler:', error.message);
        res.status(500).send('Authentifizierungsfehler: ' + error.message);
    }
});

// logout-route: beendet die lokale session und loggt den user aus keycloak aus
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        const logoutUrl = `${KEYCLOAK_URL}/protocol/openid-connect/logout?client_id=${CLIENT_ID}`;
        res.redirect(logoutUrl);
    });
});

app.post('/api/test-alarm-event', (req, res) => {
    const receivedAt = Date.now();
    console.log('[TEST-ALARM] Empfangen:', JSON.stringify(req.body), 'um', receivedAt);
    res.json({ status: 'received', receivedAt });
});

// --- 2. die auth-schranke (middleware) ---
const JEDER_ZUGRIFF_ERFORDERT_LOGIN = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next(); // user ist eingeloggt, fahre fort
    }
    res.redirect('/login'); // nicht eingeloggt? ab zu keycloak!
};

// schranke für alle folgenden routen und statischen dateien aktivieren!
app.use(JEDER_ZUGRIFF_ERFORDERT_LOGIN);

// das frontend wird erst nach erfolgreichem login freigegeben
app.use(express.static('public'));

app.get('/dashboard', (req, res) => {
    res.redirect('/');
});

// --- 3. geschützte api-routen (alle ab hier erfordern eine gültige session) ---

// liefert den aktuell eingeloggten benutzer fürs frontend (anzeige in der sidebar) -
// dieselben claims, die getactor() auch fürs audit-log verwendet.
app.get('/api/me', (req, res) => {
    const payload = decodeIdTokenPayload(req);
    res.json({
        username: payload?.preferred_username || payload?.email || null,
        name: payload?.name || null
    });
});

// route: holt alle nodes von headscale
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

// 1. node umbenennen
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

// 2. node löschen
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

// 3. node-sitzung ablaufen lassen (expire)
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

// 4. node per icmp anpingen (der headpilot-server ist ja selbst tailnet-peer, siehe ssh-docker-feature)
app.post('/api/nodes/ping', (req, res) => {
    const { ip } = req.body;

    // nur echte ipv4/ipv6-zeichen zulassen, sonst gibt's sauber 400 statt kryptischem ping-fehler
    if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) {
        return res.status(400).json({ error: 'Ungültige IP-Adresse.' });
    }

    // ein ping-versuch, max. 2 sekunden wartezeit auf antwort. macos (entwicklung) und
    // linux (produktion) haben leicht unterschiedliche flags für die timeout-angabe.
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

// 1. alle benutzer abrufen, inkl. geräte-anzahl pro user (0 falls node-fetch fehlschlägt)
app.get('/api/users', async (req, res) => {
    try {
        const [userResponse, nodeResponse] = await Promise.all([
            fetch(`${HEADSCALE_URL}/api/v1/user`, { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' } }),
            fetch(`${HEADSCALE_URL}/api/v1/node`, { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' } })
        ]);
        if (!userResponse.ok) throw new Error(`Fehler: ${userResponse.status}`);
        const userData = await userResponse.json();

        const nodeCountByUserId = {};
        if (nodeResponse.ok) {
            const nodeData = await nodeResponse.json();
            (nodeData.nodes || []).forEach(n => {
                const uid = n.user?.id;
                if (uid) nodeCountByUserId[uid] = (nodeCountByUserId[uid] || 0) + 1;
            });
        }

        const users = (userData.users || []).map(u => ({ ...u, nodeCount: nodeCountByUserId[u.id] || 0 }));
        res.json({ users });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. neuen benutzer erstellen
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

// 3. benutzer umbenennen
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

// 4. benutzer löschen
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

// --- pre-auth keys routen ---
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

// --- subnet routes ---
// kein eigener "/api/v1/routes"-endpoint mehr, routen leben am node selbst ("availableroutes"
// und "approvedroutes"). approve_routes ersetzt immer die ganze liste, kein einzel-toggle.
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
            // auch eine genehmigte, aber nicht mehr angekündigte route mit anzeigen -
            // sonst könnte man sie nie mehr über die ui wieder deaktivieren.
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

// approve_routes ersetzt immer die ganze liste, daher erst den aktuellen stand holen
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

// --- uptime kuma status ---
// login per socket.io (kuma hat keine normale rest-api). fehlt eine der drei env-variablen,
// antwortet die route sofort mit "configured: false", ganz ohne netzwerk-request.
const { io: kumaIo } = require('socket.io-client');
const KUMA_URL = process.env.KUMA_URL;
const KUMA_USER = process.env.KUMA_USER;
const KUMA_PASS = process.env.KUMA_PASS;
const KUMA_TIMEOUT_MS = 3000;

// kuma-heartbeat-status-codes: 0 = down, 1 = up, 2 = pending, 3 = maintenance
const KUMA_STATUS_MAP = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

// login bei kuma, übergibt den socket an "work" (promise), trennt danach sauber wieder.
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

// sammelt name/typ/status/uptime/antwortzeit pro monitor. kuma schickt das über mehrere
// events statt auf einmal, deshalb sammeln bis alles da ist (oder timeout)
// länge der heartbeat-verlaufs-leiste (wie im kuma-dashboard)
const KUMA_HEARTBEAT_BAR_LENGTH = 50;

function fetchKumaMonitors() {
    return withKumaLogin((socket) => new Promise((resolve) => {
        const monitorsById = {}; // monitorid -> { name, type, target, port }
        const heartbeatLists = {}; // monitorid -> voller heartbeat-verlauf (neueste zuletzt)
        const uptimes = {};      // monitorid -> 24h-uptime (0-1)
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
                    // verlaufs-leiste wie im kuma-dashboard: die letzten n heartbeats als einfache status-liste
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
            if (expectedIds.length === 0) finish(); // keine monitore vorhanden
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

// baut das monitor-objekt im kuma-format. kuma braucht beim anlegen alle möglichen
// felder (auch fremder typen), sonst crasht es intern, daher volle defaults für alle typen
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

// felder, die getmonitor mitliefert, editmonitor aber ablehnt (sql-fehler sonst). "id" bleibt
// draußen, weil editmonitor die braucht um den datensatz zu finden
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

// überträgt die formularfelder auf das bestehende monitor-objekt (editmonitor erwartet
// immer das ganze objekt zurück, kein teil-update).
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

// route: uptime-kuma-status für die "status"-ansicht
app.get('/api/status', async (req, res) => {
    if (!KUMA_URL || !KUMA_USER || !KUMA_PASS) {
        return res.json({ configured: false });
    }

    try {
        const monitors = await fetchKumaMonitors();
        res.json({ configured: true, available: true, monitors });
    } catch (error) {
        // timeout, verbindungsfehler oder falsche zugangsdaten, dashboard bleibt trotzdem
        // nutzbar, wir melden nur "nicht erreichbar"
        console.error('Uptime Kuma nicht erreichbar:', error.message);
        res.json({ configured: true, available: false });
    }
});

// route: neuen kuma-monitor anlegen
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

// route: bestehenden kuma-monitor bearbeiten (der typ selbst bleibt fix, nur name/ziel/port/intervall änderbar)
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

// route: kuma-monitor löschen
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

// --- discord-benachrichtigung (status-reiter) ---
// nur eine, ein/aus schaltbar. kumas "active"-feld wirkt nicht, schalter simuliert
// das über anlegen/löschen, die url merkt sich headpilot lokal unter data/
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
        // kuma schickt "notificationlist" von selbst direkt nach dem login.
        // "config" ist bei kuma ein json-string (nicht verschachteltes objekt).
        socket.on('notificationList', (list) => resolve(list || []));
    }));
}

// legt headpilots discord-benachrichtigung an/bearbeitet sie, per festem namen erkannt,
// damit andere, manuell angelegte kuma-benachrichtigungen unangetastet bleiben.
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

// docker ps -a listet alle container (auch gestoppte). {{json .}} lässt docker selbst
// sauber escaptes json pro zeile ausgeben, statt es uns per hand (fehleranfällig) zusammenzubauen.
const DOCKER_PS_CMD = "docker ps -a --format '{{json .}}'";

// führt einen befehl über eine bestehende ssh-verbindung aus und sammelt stdout/stderr/exit-code.
// optional kann etwas auf stdin geschrieben werden (z.b. das passwort für "sudo -s").
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

// typische meldung, wenn der ssh-user zwar eingeloggt ist, aber nicht auf den docker-socket darf
// (sehr häufig auf frisch aufgesetzten servern, wenn der user nicht in der "docker"-gruppe ist)
function isPermissionDenied(stderr) {
    return /permission denied|dial unix.*docker\.sock/i.test(stderr);
}

function isDockerNotFound(stderr) {
    return /command not found|no such file/i.test(stderr);
}

// metadaten zu gespeicherten ssh-zugangsdaten, liefert nie das passwort zurück
app.get('/api/nodes/:id/ssh-credentials', (req, res) => {
    // ohne das würde der browser eine frühere "saved: false"-antwort (von vor dem speichern)
    // cachen und nach einem reload weiter anzeigen, dass nichts gespeichert sei.
    res.set('Cache-Control', 'no-store');
    res.json(sshVault.getCredentialsInfo(req.params.id));
});

// entfernt gespeicherte ssh-zugangsdaten für eine node wieder
app.delete('/api/nodes/:id/ssh-credentials', (req, res) => {
    sshVault.deleteCredentials(req.params.id);
    res.json({ ok: true });
});

// route: ssh login und docker container abfragen
app.post('/api/nodes/ssh-docker', (req, res) => {
    const { ip, nodeId, remember } = req.body;
    let { username, password } = req.body;

    if (!ip) {
        return res.status(400).json({ error: 'IP wird benötigt.' });
    }

    // keine zugangsdaten im request? dann schauen, ob für diese node welche im vault liegen
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

    // verhindert "cannot set headers after they are sent", falls 'error' nach 'ready' feuert
    let responded = false;
    let credentialsSaved = false;
    const respond = (status, body) => {
        if (responded) return;
        responded = true;
        res.status(status).json({ ...body, ...(remember ? { credentialsSaved } : {}) });
    };

    const conn = new Client();

    conn.on('ready', async () => {
        // erst jetzt (nach erfolgreicher ssh-authentifizierung) auf wunsch verschlüsselt speichern -
        // so landen nie falsche/ungeprüfte zugangsdaten im vault.
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

            // kein zugriff auf den docker-socket? automatisch mit sudo erneut versuchen
            // (passwort wird direkt über stdin an "sudo -s" übergeben, landet also nicht im prozess-log).
            if (result.code !== 0 && isPermissionDenied(result.stderr)) {
                result = await execOverSsh(conn, `sudo -S -p '' ${DOCKER_PS_CMD}`, password + '\n');
            }

            conn.end();

            // kein output und ein fehler-code -> docker ist vermutlich nicht installiert
            // oder nicht im path der (nicht-interaktiven) ssh-session (häufig bei nas-systemen)
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
                // docker gibt pro zeile ein eigenes json-objekt aus
                const containers = result.stdout.trim().split('\n')
                    .filter(line => line.length > 0)
                    .map(line => JSON.parse(line))
                    .map(c => ({
                        id: c.ID,
                        name: c.Names,
                        state: c.State,       // z.b. "running", "exited", "paused", "restarting"
                        status: c.Status,     // z.b. "up 3 hours" oder "exited (0) 2 days ago"
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
        // genauere fehlerursache loggen, statt sie hinter einer generischen meldung zu verstecken
        console.error(`SSH-Fehler bei ${username}@${ip}: [${err.level || err.code || 'unknown'}] ${err.message}`);

        let message = `SSH-Verbindung fehlgeschlagen: ${err.message}`;
        if (err.level === 'client-authentication') {
            message = 'SSH Login fehlgeschlagen: Benutzername oder Passwort falsch (oder Passwort-Login für diesen User deaktiviert).';
        } else if (err.code === 'ETIMEDOUT') {
            // tcp-verbindung kam nie zustande -> der headpilot-server selbst hat keine route zur vpn-ip
            // des geräts (er müsste dafür selbst als tailscale/headscale-client im gleichen tailnet hängen).
            message = 'Zeitüberschreitung: Der Headpilot-Server erreicht diese VPN-IP nicht (keine TCP-Verbindung möglich). Läuft auf dem Server, der Headpilot hostet, selbst ein verbundener Tailscale/Headscale-Client?';
        } else if (err.level === 'client-timeout') {
            // tcp hat verbunden, aber die ssh-handshake kam nicht rechtzeitig zustande
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
        // manche geräte (nas) brauchen wegen reverse-dns-lookup länger fürs ssh-banner
        readyTimeout: 20000
    });
});

// --- netzwerk-graph ---
// liefert nodes und genehmigte routes für den "netzwerk"-graphen, keine live-verbindungsanzeige
// (full-mesh, keine zentrale peer-info), nur registrierungs- und routingdaten
app.get('/api/network-graph', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node`, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fehler ${response.status}: ${errorText}`);
        }
        const data = await response.json();

        const nodes = [];
        const routes = [];
        (data.nodes || []).forEach(n => {
            nodes.push({
                id: n.id,
                name: n.givenName || n.name,
                online: !!n.online,
                lastSeen: n.lastSeen || null,
                expiry: n.expiry || null,
                ipAddresses: n.ipAddresses || [],
                owner: n.user?.displayName || n.user?.name || null
            });
            // nur genehmigte routes gehören ins bild, eine bloß angekündigte route bringt ja keinen traffic
            (n.approvedRoutes || []).forEach(cidr => routes.push({ nodeId: n.id, cidr }));
        });

        res.json({ nodes, routes });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- audit log ---
// wie bei kuma: "configured: false" ohne database_url, "available: false" bei db-fehler.
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


// server starten
app.listen(PORT, () => {
    console.log(`🚀 Headpilot Backend läuft gesichert auf http://localhost:${PORT}`);
});
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session'); // Für das Session-Management

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

// Server starten
app.listen(PORT, () => {
    console.log(`🚀 Headpilot Backend läuft gesichert auf http://localhost:${PORT}`);
});
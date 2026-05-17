require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Sagt dem Server, wo die HTML-Datei liegt

// Variablen aus der .env Datei
const PORT = process.env.PORT || 3000;
const HEADSCALE_URL = process.env.HEADSCALE_URL;
const API_KEY = process.env.HEADSCALE_API_KEY;

// Route: Holt alle Nodes von Headscale
app.get('/api/nodes', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/node`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Headscale API Fehler: ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 1. Alle Benutzer abrufen
app.get('/api/users', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/user`, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`Fehler: ${response.status}`);
        res.json(await response.json());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Neuen Benutzer erstellen
app.post('/api/users', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/user`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${API_KEY}`, 
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify({ name: req.body.name })
        });
        if (!response.ok) throw new Error(`Fehler: ${response.status}`);
        res.json(await response.json());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Benutzer umbenennen (Jetzt mit ID!)
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Benutzer löschen (Jetzt mit ID!)
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Neuen Key generieren
app.post('/api/keys', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/preauthkey`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${API_KEY}`, 
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify(req.body)
        });
        
        // HIER IST DER FIX: Wir lesen aus, was Headscale genau zu meckern hat
        if (!response.ok) {
            const errorText = await response.text(); 
            throw new Error(`Headscale API-Fehler ${response.status}: ${errorText}`);
        }
        res.json(await response.json());
    } catch (error) {
        console.error("API Error bei Key-Generierung:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. Key vorzeitig ablaufen lassen
app.post('/api/keys/expire', async (req, res) => {
    try {
        const response = await fetch(`${HEADSCALE_URL}/api/v1/preauthkey/expire`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${API_KEY}`, 
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Headscale Fehler beim Ablaufen: ${errorText}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Expire Error:", error.message);
        res.status(500).json({ error: error.message });
    }
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Server starten
app.listen(PORT, () => {
    console.log(`🚀 Headpilot Backend läuft auf http://localhost:${PORT}`);
});
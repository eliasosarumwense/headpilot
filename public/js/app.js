// --- DYNAMISCHER ROUTER ---
async function loadView(viewName) {
    try {
        // 1. Markierungen in der Sidebar aktualisieren
        document.querySelectorAll('.nav-links a').forEach(el => el.classList.remove('active'));
        document.getElementById(`nav-${viewName}`).classList.add('active');

        // 2. Das HTML-Schnipsel aus dem views-Ordner laden
        const response = await fetch(`/views/${viewName}.html`);
        if (!response.ok) throw new Error("View nicht gefunden");
        const html = await response.text();

        // 3. Das HTML in den Hauptbereich einfügen
        document.getElementById('app-content').innerHTML = html;

        // 4. Die passenden API-Daten laden
        if (viewName === 'dashboard') fetchDashboardStats();
        if (viewName === 'nodes') fetchNodes();
        if (viewName === 'users') fetchUsers();
        if (viewName === 'keys') initKeysView(); // <-- DAS IST NEU

    } catch (error) {
        document.getElementById('app-content').innerHTML = `<h1>Fehler</h1><p>Konnte Ansicht nicht laden.</p>`;
    }
}

// --- API LOGIK: NODES ---
async function fetchNodes() {
    try {
        const res = await fetch('/api/nodes');
        const data = await res.json();
        const tbody = document.getElementById('nodes-table-body');
        tbody.innerHTML = '';
        
        if (data.nodes && data.nodes.length > 0) {
            data.nodes.forEach(n => {
                const ips = n.ipAddresses ? n.ipAddresses.join(', ') : '-';
                const lastSeen = new Date(n.lastSeen).toLocaleString();
                
                // Wir nehmen den echten, gesetzten Namen
                const name = n.givenName || n.name;
                
                // Zeigt visuell an, ob das Gerät online ist
                const isOnline = n.online ? '🟢' : '🔴';
                
                tbody.innerHTML += `<tr>
                    <td>${n.id}</td>
                    <td><strong>${isOnline} ${name}</strong><br><small style="color: #6c757d;">Besitzer: ${n.user.name}</small></td>
                    <td><code>${ips}</code></td>
                    <td>${lastSeen}</td>
                    <td class="action-cell">
                        <button class="btn-warning" onclick="renameNode(${n.id}, '${name}')">Umbenennen</button>
                        <button class="btn-danger" style="background: #e67e22;" onclick="expireNode(${n.id}, '${name}')">Sitzung beenden</button>
                        <button class="btn-danger" onclick="deleteNode(${n.id}, '${name}')">Löschen</button>
                    </td>
                </tr>`;
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="5">Keine Geräte registriert.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:red;">Fehler beim Laden!</td></tr>';
    }
}

// 1. Gerät umbenennen
async function renameNode(id, oldName) {
    const rawName = prompt(`Neuen Namen für Gerät "${oldName}" eingeben:\n\n(Hinweis: Wird automatisch für DNS in Kleinbuchstaben & Bindestriche umgewandelt)`);
    if (!rawName || rawName.trim() === "") return;
    
    // FIX: Wir machen den Namen automatisch "Headscale-sicher" (DNS-konform)
    // 1. trim(): Entfernt Leerzeichen am Anfang und Ende
    // 2. toLowerCase(): Macht alles klein
    // 3. replace(/\s+/g, '-'): Ersetzt alle Leerzeichen in der Mitte durch einen Bindestrich
    // 4. replace(/[^a-z0-9-]/g, ''): Wirft alle komischen Sonderzeichen (!, ?, etc.) raus
    const safeName = rawName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    try {
        const res = await fetch(`/api/nodes/${id}/rename/${safeName}`, { method: 'POST' });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Fehler beim Umbenennen");
        }
        fetchNodes(); // Tabelle neu laden
    } catch (e) {
        alert("🚨 Fehler: " + e.message);
    }
}

// 2. Sitzung zwingend beenden (Das Gerät verliert das VPN und muss neu in Keycloak einloggen)
async function expireNode(id, name) {
    if (!confirm(`Sitzung für Gerät "${name}" wirklich sofort beenden?\n\nDas Gerät wird aus dem VPN geworfen und muss sich neu authentifizieren!`)) return;
    
    try {
        const res = await fetch(`/api/nodes/${id}/expire`, { method: 'POST' });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Fehler beim Beenden der Sitzung");
        }
        fetchNodes();
    } catch (e) {
        alert("🚨 Fehler: " + e.message);
    }
}

// 3. Gerät dauerhaft löschen
async function deleteNode(id, name) {
    if (!confirm(`Gerät "${name}" wirklich komplett aus dem VPN löschen?\n\nAchtung: Das kann nicht rückgängig gemacht werden!`)) return;
    
    try {
        const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Fehler beim Löschen");
        }
        fetchNodes();
    } catch (e) {
        alert("🚨 Echter Fehlerbericht vom Server:\n\n" + e.message);
    }
}

async function fetchUsers() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();
        const tbody = document.getElementById('users-table-body');
        tbody.innerHTML = ''; 
        if (data.users && data.users.length > 0) {
            data.users.forEach(u => {
                // FIX: Wir übergeben bei onclick jetzt u.id UND u.name!
                tbody.innerHTML += `<tr>
                    <td>${u.id}</td>
                    <td><strong>${u.name}</strong></td>
                    <td>${new Date(u.createdAt).toLocaleString()}</td>
                    <td class="action-cell">
                        <button class="btn-warning" onclick="renameUser(${u.id}, '${u.name}')">Umbenennen</button>
                        <button class="btn-danger" onclick="deleteUser(${u.id}, '${u.name}')">Löschen</button>
                    </td>
                </tr>`;
            });
        } else tbody.innerHTML = '<tr><td colspan="4">Keine Benutzer.</td></tr>';
    } catch (e) { tbody.innerHTML = '<tr><td colspan="4" style="color:red;">Fehler beim Laden!</td></tr>'; }
}

async function createUser() {
    const name = document.getElementById('new-user-name').value.trim();
    if (!name) return alert("Name eingeben!");
    try {
        await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        document.getElementById('new-user-name').value = '';
        fetchUsers();
    } catch (e) { alert("Fehler beim Erstellen"); }
}

// FIX: Die Funktion nimmt jetzt ID und Name an
async function renameUser(id, oldName) {
    const newName = prompt(`Neuer Name für "${oldName}":`);
    if (!newName || newName.trim() === "") return;
    try {
        const res = await fetch(`/api/users/${id}/rename/${newName.trim()}`, { method: 'POST' });
        if (!res.ok) throw new Error("Fehler beim Umbenennen");
        fetchUsers();
    } catch (e) { alert("🚨 Fehler: " + e.message); }
}

// FIX: Die Funktion nimmt jetzt ID und Name an
async function deleteUser(id, name) {
    if (!confirm(`Benutzer "${name}" wirklich löschen?`)) return;
    try {
        // Wir schicken die ID an unser Node.js Backend
        const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "Unbekannter Fehler");

        fetchUsers();
    } catch (e) {
        alert("🚨 Echter Fehlerbericht vom Server:\n\n" + e.message);
    }
}

// --- API LOGIK: DASHBOARD / ÜBERSICHT ---
// --- API LOGIK: DASHBOARD / ÜBERSICHT ---
async function fetchDashboardStats() {
    try {
        // Wir laden jetzt alle 4 Datenquellen auf einmal!
        const [nodesRes, usersRes, routesRes, keysRes] = await Promise.all([
            fetch('/api/nodes'),
            fetch('/api/users'),
            fetch('/api/routes'),
            fetch('/api/keys') // <-- NEU: Alle Keys abrufen
        ]);
        
        const nodesData = await nodesRes.json();
        const usersData = await usersRes.json();
        const routesData = await routesRes.json();
        const keysData = await keysRes.json(); // <-- NEU

        const formatList = (arr) => {
            if (!arr || arr.length === 0) return "Keine Einträge";
            if (arr.length <= 3) return arr.join(', ');
            return `${arr.slice(0, 3).join(', ')} und ${arr.length - 3} weitere`;
        };

        const jetzt = new Date();

        // 1. Benutzer
        const usersList = usersData.users ? usersData.users.map(u => u.name) : [];
        document.getElementById('stat-users').innerText = usersList.length;
        document.getElementById('detail-users').innerText = formatList(usersList);

        // 2. Nodes & Online & Ablauf
        const nodesList = [];
        const onlineList = [];
        const expiringList = [];
        let totalNodes = 0;

        if (nodesData.nodes) {
            totalNodes = nodesData.nodes.length;
            nodesData.nodes.forEach(node => {
                const nodeName = node.givenName || node.name;
                nodesList.push(nodeName);

                if (node.online === true) onlineList.push(nodeName);

                const expiry = new Date(node.expiry);
                if (expiry.getFullYear() > 2000) {
                    const diffTage = (expiry - jetzt) / (1000 * 60 * 60 * 24);
                    if (diffTage > 0 && diffTage <= 7) expiringList.push(nodeName);
                }
            });
        }

        document.getElementById('stat-nodes').innerText = totalNodes;
        document.getElementById('detail-nodes').innerText = formatList(nodesList);

        document.getElementById('stat-online').innerText = `${onlineList.length} / ${totalNodes}`;
        document.getElementById('detail-online').innerText = onlineList.length > 0 ? formatList(onlineList) : "Alle Geräte offline";

        document.getElementById('stat-expiring').innerText = expiringList.length;
        document.getElementById('detail-expiring').innerText = expiringList.length > 0 ? formatList(expiringList) : "Keine baldigen Abläufe";
        if (expiringList.length > 0) document.getElementById('stat-expiring').classList.add('color-danger');

        // 3. Routen
        const routesList = [];
        if (routesData.routes) {
            routesData.routes.filter(r => r.enabled).forEach(r => routesList.push(r.prefix));
        }
        document.getElementById('stat-routes').innerText = routesList.length;
        document.getElementById('detail-routes').innerText = routesList.length > 0 ? formatList(routesList) : "Keine aktiven Subnetze";

        // 4. Keys (FIXED!)
        let activeKeysCount = 0;
        const usersWithKeys = new Set();
        
        if (keysData.preAuthKeys) {
            keysData.preAuthKeys.forEach(k => {
                // Ist der Key in der Zukunft?
                if (new Date(k.expiration) > jetzt) {
                    activeKeysCount++;
                    // Headscale liefert uns mit, wem der Key gehört
                    if (k.user && k.user.name) {
                        usersWithKeys.add(k.user.name);
                    }
                }
            });
        }

        document.getElementById('stat-keys').innerText = activeKeysCount;
        const keysUsersArr = Array.from(usersWithKeys);
        document.getElementById('detail-keys').innerText = activeKeysCount > 0 ? `Ausstehend für: ${formatList(keysUsersArr)}` : "Keine offenen Keys";
        if (activeKeysCount > 0) document.getElementById('stat-keys').classList.add('color-warning');

    } catch (e) {
        console.error("Fehler beim Laden", e);
    }
}

// --- API LOGIK: KEYS ---

async function initKeysView() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();
        const select = document.getElementById('key-user-select');
        
        select.innerHTML = '<option value="">-- Benutzer wählen --</option>';
        if (data.users && data.users.length > 0) {
            data.users.forEach(u => {
                // FIX: Wir speichern die ID (Zahl) versteckt im Attribut "data-id"!
                select.innerHTML += `<option value="${u.name}" data-id="${u.id}">${u.name}</option>`;
            });
        }
    } catch (e) {
        console.error("Fehler beim Laden", e);
    }
}

async function fetchKeys() {
    const select = document.getElementById('key-user-select');
    const userName = select.value;
    const tbody = document.getElementById('keys-table-body');
    
    if (!userName) {
        tbody.innerHTML = '<tr><td colspan="4">Bitte wähle oben einen Benutzer aus.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="4">Lade Keys...</td></tr>';

    try {
        // Wir laden alle Keys vom Server
        const res = await fetch(`/api/keys`);
        const data = await res.json();
        tbody.innerHTML = '';
        
        if (data.preAuthKeys && data.preAuthKeys.length > 0) {
            const jetzt = new Date();
            jetzt.setSeconds(jetzt.getSeconds() + 10); // 10 Sekunden Puffer
            
            // FIX: Wir filtern nach Keys, die aktiv sind UND exakt diesem User gehören!
            const activeKeys = data.preAuthKeys.filter(k => {
                const isRightUser = (k.user && k.user.name === userName);
                const isNotExpired = new Date(k.expiration) > jetzt;
                return isRightUser && isNotExpired;
            });
            
            if(activeKeys.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4">Keine aktiven Keys für diesen Benutzer gefunden.</td></tr>';
                return;
            }

            activeKeys.forEach(k => {
                tbody.innerHTML += `<tr>
                    <td><code>${k.key}</code></td>
                    <td>${k.reusable ? 'Ja' : 'Nein'}</td>
                    <td>${new Date(k.expiration).toLocaleString()}</td>
                    <td><button class="btn-danger" onclick="expireKey('${userName}', '${k.key}')">Ablaufen lassen</button></td>
                </tr>`;
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="4">Keine Keys auf dem Server gefunden.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:red;">Fehler beim Laden!</td></tr>';
    }
}

async function createKey() {
    const select = document.getElementById('key-user-select');
    const userName = select.value;
    const reusable = document.getElementById('key-reusable').checked;
    
    if (!userName) return alert("Bitte wähle zuerst einen Benutzer aus!");

    // FIX: Wir lesen die ID aus und machen zwingend eine Zahl (Integer) daraus!
    const userId = parseInt(select.options[select.selectedIndex].getAttribute('data-id'), 10);

    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);
    const safeExpiration = expirationDate.toISOString().split('.')[0] + "Z";

    try {
        const res = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user: userId, // <-- HIER SCHICKEN WIR JETZT DIE ZAHL STATT DEM NAMEN
                reusable: reusable,
                ephemeral: false,
                expiration: safeExpiration
            })
        });
        
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error || data.message || "Unbekannter Fehler");
        
        alert(`WICHTIG! Neuer Key generiert:\n\nKopiere ihn jetzt. Er wird danach nie wieder komplett angezeigt!\n\n${data.preAuthKey.key}`);
        fetchKeys();
    } catch (e) {
        alert("🚨 Fehlerbericht vom Server:\n\n" + e.message);
    }
}

async function expireKey(userName, key) {
    if (!confirm(`Möchtest du den Key ${key.substring(0,8)}... wirklich deaktivieren?`)) return;
    
    try {
        const res = await fetch('/api/keys/expire', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Wir probieren es hier wieder mit dem userName (String)
            body: JSON.stringify({ user: userName, key: key })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Server lehnte das Ablaufen ab.");
        }
        
        // WICHTIG: Kurz warten, damit Headscale Zeit hat, die DB zu aktualisieren
        setTimeout(() => {
            fetchKeys();
        }, 500);

    } catch (e) {
        alert("🚨 Fehler beim Deaktivieren: " + e.message);
    }
}
// Wenn das Skript geladen ist, starte mit der "nodes" Ansicht
window.onload = () => loadView('dashboard');
// --- DYNAMISCHER ROUTER ---
const viewCache = {}; // hält bereits geladene View-Schnipsel, damit ein erneuter Wechsel ohne Netzwerk-Roundtrip auskommt
let viewToken = 0; // verhindert, dass eine langsame alte Anfrage eine neuere Ansicht überschreibt

async function loadView(viewName) {
    const requestId = ++viewToken;
    const content = document.getElementById('app-content');

    try {
        // 1. Markierungen in der Sidebar aktualisieren
        document.querySelectorAll('.nav-links a').forEach(el => el.classList.remove('active'));
        document.getElementById(`nav-${viewName}`).classList.add('active');

        // 2. Aktuellen Inhalt sanft ausblenden, bevor er ersetzt wird
        content.classList.add('is-switching');
        await new Promise(resolve => setTimeout(resolve, 110));
        if (requestId !== viewToken) return; // Nutzer hat inzwischen weitergeklickt

        // 3. Das HTML-Schnipsel laden (aus Cache, falls schon einmal besucht)
        let html = viewCache[viewName];
        if (!html) {
            const response = await fetch(`/views/${viewName}.html`);
            if (!response.ok) throw new Error("View nicht gefunden");
            html = await response.text();
            viewCache[viewName] = html;
        }
        if (requestId !== viewToken) return;

        // 4. Das HTML einfügen und wieder einblenden
        content.innerHTML = html;
        content.classList.remove('is-switching');

        // 5. Die passenden API-Daten laden
        if (viewName === 'dashboard') fetchDashboardStats();
        if (viewName === 'nodes') fetchNodes();
        if (viewName === 'docker') fetchDockerNodes();
        if (viewName === 'users') fetchUsers();
        if (viewName === 'keys') initKeysView();

    } catch (error) {
        if (requestId !== viewToken) return;
        content.innerHTML = `<h1>Fehler</h1><p>Konnte Ansicht nicht laden.</p>`;
        content.classList.remove('is-switching');
    }
}

// --- API LOGIK: NODES ---

// Escaped einen String fürs sichere Einbetten in einfache JS-Anführungszeichen (onclick="...")
function jsStr(str) {
    return String(str ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function fetchNodes() {
    const grid = document.getElementById('nodes-grid');
    try {
        const res = await fetch('/api/nodes');
        const data = await res.json();
        grid.innerHTML = '';

        if (data.nodes && data.nodes.length > 0) {
            data.nodes.forEach(n => {
                const ipList = n.ipAddresses || [];
                const ipChips = ipList.length > 0
                    ? ipList.map(ip => `<span class="ip-chip">${escapeHtml(ip)}</span>`).join('')
                    : '<span class="ip-chip">-</span>';
                const lastSeen = new Date(n.lastSeen).toLocaleString();

                // Wir nehmen den echten, gesetzten Namen
                const name = n.givenName || n.name;
                const owner = n.user?.name || '-';
                const statusClass = n.online ? 'online' : '';
                const statusLabel = n.online ? 'Online' : 'Offline';

                grid.innerHTML += `
                <div class="node-card">
                    <div class="node-card-header">
                        <span class="status-dot ${statusClass}" title="${statusLabel}"></span>
                        <div>
                            <div class="node-name">${escapeHtml(name)}</div>
                            <div class="node-owner">Besitzer: ${escapeHtml(owner)}</div>
                        </div>
                    </div>

                    <div class="node-meta">
                        <div class="ip-chips">${ipChips}</div>
                        <div>Letzter Kontakt: ${lastSeen}</div>
                    </div>

                    <div class="node-card-footer">
                        <button class="btn" onclick="renameNode(${n.id}, '${jsStr(name)}')">Umbenennen</button>
                        <button class="btn" onclick="expireNode(${n.id}, '${jsStr(name)}')">Sitzung beenden</button>
                        <button class="btn btn-danger" onclick="deleteNode(${n.id}, '${jsStr(name)}')">Löschen</button>
                    </div>
                </div>`;
            });
        } else {
            grid.innerHTML = '<p>Keine Geräte registriert.</p>';
        }
    } catch (e) {
        grid.innerHTML = '<p style="color:#b91c1c;">Fehler beim Laden!</p>';
    }
}

// --- API LOGIK: DOCKER DIENSTE ---

async function fetchDockerNodes() {
    const list = document.getElementById('docker-list');
    try {
        const res = await fetch('/api/nodes');
        const data = await res.json();

        if (data.nodes && data.nodes.length > 0) {
            // Erst alle Karten als Strings sammeln und EINMAL einfügen, statt bei jeder
            // Node per "+=" das komplette Grid neu zu parsen/aufzubauen.
            const cardsHtml = data.nodes.map(n => {
                const ipList = n.ipAddresses || [];
                const firstIp = ipList[0] || '';
                const name = n.givenName || n.name;
                const statusClass = n.online ? 'online' : '';
                const statusLabel = n.online ? 'Online' : 'Offline';

                return `
                <div class="docker-node">
                    <div class="docker-node-header">
                        <div class="docker-node-identity">
                            <span class="status-dot ${statusClass}" title="${statusLabel}"></span>
                            <div>
                                <div class="docker-node-name">${escapeHtml(name)}</div>
                                <div class="docker-node-ip">${escapeHtml(firstIp || '-')}</div>
                            </div>
                        </div>
                        <div class="docker-node-actions" id="docker-actions-${n.id}">
                            <span class="docker-node-summary" id="docker-summary-${n.id}">Noch nicht gescannt</span>
                            <button class="btn" onclick="openSshModal('${jsStr(firstIp)}', '${jsStr(n.id)}', '${jsStr(name)}')">Scannen</button>
                        </div>
                    </div>
                    <div class="docker-node-body" id="docker-services-${n.id}">
                        <p class="docker-state-msg">Noch nicht gescannt. Klicke auf "Scannen" und melde dich per SSH an.</p>
                    </div>
                </div>`;
            });

            list.innerHTML = cardsHtml.join('');

            // Prüft je Node im Hintergrund, ob schon gespeicherte Zugangsdaten vorliegen,
            // und passt die Buttons entsprechend an (kein Modal mehr nötig)
            data.nodes.forEach(n => {
                const firstIp = (n.ipAddresses || [])[0] || '';
                refreshNodeActions(n.id, firstIp, n.givenName || n.name);
            });
        } else {
            list.innerHTML = '<p>Keine Geräte registriert.</p>';
        }
    } catch (e) {
        list.innerHTML = '<p style="color:#b91c1c;">Fehler beim Laden!</p>';
    }
}

// Zeigt je nachdem, ob für die Node bereits sicher gespeicherte SSH-Zugangsdaten
// existieren, entweder einen direkten "Scannen"-Button oder einen, der erst das Login-Modal öffnet
async function refreshNodeActions(nodeId, ip, name) {
    const actionsDiv = document.getElementById(`docker-actions-${nodeId}`);
    if (!actionsDiv) return;

    const summaryHtml = `<span class="docker-node-summary" id="docker-summary-${nodeId}">Noch nicht gescannt</span>`;

    try {
        // cache: 'no-store' zusätzlich zum Cache-Control-Header vom Server - sonst könnte der
        // Browser nach dem Speichern noch die alte "saved: false"-Antwort von vorher zeigen
        const res = await fetch(`/api/nodes/${nodeId}/ssh-credentials`, { cache: 'no-store' });
        const info = await res.json();

        actionsDiv.innerHTML = info.saved
            ? `${summaryHtml}
               <button class="btn" onclick="scanDockerSSH('${jsStr(ip)}', '${jsStr(nodeId)}', '${jsStr(name)}')">Neu scannen</button>
               <button class="btn" title="Gespeicherte Zugangsdaten für '${escapeHtml(info.username)}' entfernen" onclick="forgetSshCredentials('${jsStr(nodeId)}', '${jsStr(ip)}', '${jsStr(name)}')">Zugang vergessen</button>`
            : `${summaryHtml}
               <button class="btn" onclick="openSshModal('${jsStr(ip)}', '${jsStr(nodeId)}', '${jsStr(name)}')">Scannen</button>`;

        // Für Geräte mit gespeicherten Zugangsdaten direkt automatisch laden,
        // ohne dass erst auf "Scannen" geklickt werden muss
        if (info.saved) scanDockerSSH(ip, nodeId, name);
    } catch (e) {
        // Bei Fehler bleibt einfach der Standard-Button (mit Modal) stehen
    }
}

// Entfernt gespeicherte Zugangsdaten wieder (nach Rückfrage) und schaltet den Button zurück aufs Modal
async function forgetSshCredentials(nodeId, ip, name) {
    if (!confirm('Gespeicherte SSH-Zugangsdaten für dieses Gerät wirklich entfernen?')) return;
    try {
        await fetch(`/api/nodes/${nodeId}/ssh-credentials`, { method: 'DELETE' });
    } catch (e) {
        // Ignorieren - refreshNodeActions zeigt danach ohnehin den aktuellen Stand
    }
    refreshNodeActions(nodeId, ip, name);
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
        alert("Fehler: " + e.message);
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
        alert("Fehler: " + e.message);
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
        alert("Fehler vom Server:\n\n" + e.message);
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
                        <button class="btn" onclick="renameUser(${u.id}, '${u.name}')">Umbenennen</button>
                        <button class="btn btn-danger" onclick="deleteUser(${u.id}, '${u.name}')">Löschen</button>
                    </td>
                </tr>`;
            });
        } else tbody.innerHTML = '<tr><td colspan="4">Keine Benutzer.</td></tr>';
    } catch (e) { tbody.innerHTML = '<tr><td colspan="4" style="color:#b91c1c;">Fehler beim Laden!</td></tr>'; }
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
    } catch (e) { alert("Fehler: " + e.message); }
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
        alert("Fehler vom Server:\n\n" + e.message);
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
                    <td><button class="btn btn-danger" onclick="expireKey('${userName}', '${k.key}')">Ablaufen lassen</button></td>
                </tr>`;
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="4">Keine Keys auf dem Server gefunden.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:#b91c1c;">Fehler beim Laden!</td></tr>';
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
        alert("Fehlerbericht vom Server:\n\n" + e.message);
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
        alert("Fehler beim Deaktivieren: " + e.message);
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// --- SSH-MODAL (Docker-Scan) ---

let sshModalContext = null; // { ip, nodeId, nodeName }

function openSshModal(ip, nodeId, nodeName) {
    if (!ip || ip === '-') return alert('Dieses Gerät hat keine gültige IP-Adresse.');

    sshModalContext = { ip, nodeId, nodeName };
    document.getElementById('ssh-modal-subtitle').textContent = `${nodeName} (${ip})`;
    document.getElementById('ssh-username').value = 'root';
    document.getElementById('ssh-password').value = '';
    document.getElementById('ssh-remember').checked = false;

    const overlay = document.getElementById('ssh-modal-overlay');
    overlay.hidden = false;
    document.getElementById('ssh-username').focus();
}

function closeSshModal() {
    document.getElementById('ssh-modal-overlay').hidden = true;
    sshModalContext = null;
}

document.addEventListener('submit', (e) => {
    if (e.target.id !== 'ssh-form') return;
    e.preventDefault();

    const ctx = sshModalContext;
    if (!ctx) return;

    const username = document.getElementById('ssh-username').value.trim();
    const password = document.getElementById('ssh-password').value;
    const remember = document.getElementById('ssh-remember').checked;
    closeSshModal();

    if (username && password) scanDockerSSH(ctx.ip, ctx.nodeId, ctx.nodeName, username, password, remember);
});

document.addEventListener('click', (e) => {
    if (e.target.id === 'ssh-modal-overlay') closeSshModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSshModal();
});

// --- DOCKER-SCAN ÜBER SSH ---

// Deutsche Kurzbezeichnung für die Docker-Zustände
const DOCKER_STATE_LABELS = {
    running: 'Läuft',
    exited: 'Gestoppt',
    paused: 'Pausiert',
    restarting: 'Startet neu',
    created: 'Erstellt',
    dead: 'Fehlgeschlagen'
};

// username/password/remember sind optional: fehlen sie, versucht der Server, gespeicherte
// (verschlüsselte) Zugangsdaten für diese Node zu verwenden - kein erneutes Login nötig.
async function scanDockerSSH(ip, nodeId, nodeName, username, password, remember) {
    const bodyDiv = document.getElementById(`docker-services-${nodeId}`);
    let summarySpan = document.getElementById(`docker-summary-${nodeId}`);
    if (!bodyDiv) return;

    if (summarySpan) summarySpan.textContent = 'Verbinde...';
    bodyDiv.innerHTML = `<p class="docker-state-msg docker-loading">Verbinde über SSH mit ${escapeHtml(nodeName)}...</p>`;

    try {
        const res = await fetch('/api/nodes/ssh-docker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, nodeId, username, password, remember: !!remember })
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Scan fehlgeschlagen.');

        renderDockerContainers(bodyDiv, summarySpan, data.containers || []);

        if (remember) {
            if (data.credentialsSaved) {
                refreshNodeActions(nodeId, ip, nodeName);
            } else {
                alert('Der Scan war erfolgreich, aber die Zugangsdaten konnten nicht gespeichert werden (SSH_VAULT_SECRET ist auf dem Server nicht konfiguriert).');
            }
        }

    } catch (e) {
        if (summarySpan) summarySpan.textContent = 'Fehlgeschlagen';
        bodyDiv.innerHTML = `<p class="docker-state-msg docker-error">${escapeHtml(e.message)}</p>`;
    }
}

// Baut die Container-Tabelle auf: laufende Dienste zuerst, mit Image, Status-Detail und Ports
function renderDockerContainers(bodyDiv, summarySpan, containers) {
    if (containers.length === 0) {
        if (summarySpan) summarySpan.textContent = 'Keine Container gefunden';
        bodyDiv.innerHTML = '<p class="docker-state-msg">Keine Docker-Container auf diesem Gerät gefunden.</p>';
        return;
    }

    const sorted = [...containers].sort((a, b) => {
        const runningRank = (c) => (c.state === 'running' ? 0 : 1);
        return runningRank(a) - runningRank(b) || String(a.name).localeCompare(String(b.name));
    });

    const runningCount = sorted.filter(c => c.state === 'running').length;
    if (summarySpan) summarySpan.textContent = `${runningCount} von ${sorted.length} laufen`;

    const rows = sorted.map(c => {
        const isRunning = c.state === 'running';
        const stateLabel = DOCKER_STATE_LABELS[c.state] || escapeHtml(c.state || 'Unbekannt');

        return `
        <tr>
            <td>
                <div class="docker-container-name">${escapeHtml(c.name)}</div>
                <div class="docker-container-image">${escapeHtml(c.image || '-')}</div>
            </td>
            <td>
                <div class="docker-status-cell">
                    <span class="docker-status-dot ${isRunning ? 'running' : ''}"></span>
                    <div class="docker-status-text">
                        <span>${stateLabel}</span>
                        <span class="docker-status-detail">${escapeHtml(c.status || '')}</span>
                    </div>
                </div>
            </td>
            <td class="docker-ports">${escapeHtml(c.ports || '-')}</td>
        </tr>`;
    }).join('');

    bodyDiv.innerHTML = `
        <table class="docker-table">
            <thead>
                <tr>
                    <th>Container</th>
                    <th>Status</th>
                    <th>Ports</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// Wenn das Skript geladen ist, starte mit der "nodes" Ansicht
window.onload = () => loadView('dashboard');
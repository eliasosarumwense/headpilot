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
        if (viewName === 'dashboard') { fetchDashboardStats(); fetchDashboardAuditLog(); }
        if (viewName === 'nodes') fetchNodes();
        if (viewName === 'docker') fetchDockerNodes();
        if (viewName === 'status') initStatusView();
        if (viewName === 'users') fetchUsers();
        if (viewName === 'keys') initKeysView();
        if (viewName === 'routes') fetchRoutes();

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

                const firstIp = ipList[0] || '';

                grid.innerHTML += `
                <div class="node-card">
                    <div class="node-card-header">
                        <span class="status-dot ${statusClass}" id="status-dot-${n.id}" title="${statusLabel}"></span>
                        <div class="node-identity">
                            <div class="node-name">${escapeHtml(name)}</div>
                            <div class="node-owner">Besitzer: ${escapeHtml(owner)}</div>
                        </div>
                        <div class="node-ping">
                            <span class="ping-result" id="ping-result-${n.id}"></span>
                            <button class="ping-icon-btn" id="ping-btn-${n.id}" title="Ping" aria-label="Node anpingen" onclick="pingNode('${jsStr(firstIp)}', '${jsStr(n.id)}')">
                                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                                </svg>
                            </button>
                        </div>
                    </div>

                    <div class="node-meta">
                        <div class="ip-chips">${ipChips}</div>
                        <div>Letzter Kontakt: ${lastSeen}</div>
                    </div>

                    <div class="node-card-footer">
                        <button class="btn" onclick="renameNode('${jsStr(n.id)}', '${jsStr(name)}')">Umbenennen</button>
                        <button class="btn" onclick="expireNode('${jsStr(n.id)}', '${jsStr(name)}')">Sitzung beenden</button>
                        <button class="btn btn-danger" onclick="deleteNode('${jsStr(n.id)}', '${jsStr(name)}')">Löschen</button>
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

// --- PING (Nodes-Ansicht) ---

async function pingNode(ip, nodeId) {
    if (!ip || ip === '-') return alert('Dieses Gerät hat keine gültige IP-Adresse.');

    const dot = document.getElementById(`status-dot-${nodeId}`);
    const btn = document.getElementById(`ping-btn-${nodeId}`);
    const resultSpan = document.getElementById(`ping-result-${nodeId}`);
    if (!resultSpan) return;

    if (dot) dot.classList.add('pinging');
    if (btn) { btn.disabled = true; btn.classList.add('pinging'); }
    resultSpan.className = 'ping-result';
    resultSpan.textContent = '';

    try {
        const res = await fetch(`/api/nodes/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip })
        });
        const data = await res.json();

        if (data.reachable) {
            resultSpan.textContent = `${data.timeMs} ms`;
            resultSpan.className = 'ping-result visible';
        } else {
            resultSpan.textContent = 'Keine Antwort';
            resultSpan.className = 'ping-result visible ping-fail';
        }
    } catch (e) {
        resultSpan.textContent = 'Fehler beim Pingen';
        resultSpan.className = 'ping-result visible ping-fail';
    } finally {
        if (dot) dot.classList.remove('pinging');
        if (btn) { btn.disabled = false; btn.classList.remove('pinging'); }
    }
}

// --- API LOGIK: STATUS (Uptime Kuma) ---

let statusPollTimer = null;

async function initStatusView() {
    // Falls schon ein Timer aus einem vorherigen Besuch dieser Ansicht läuft, sauber stoppen
    if (statusPollTimer) clearInterval(statusPollTimer);

    await fetchStatus();

    // Alle 30s aktualisieren - bricht sich selbst ab, sobald die Status-Ansicht
    // verlassen wurde (erkennbar daran, dass #status-content nicht mehr existiert)
    statusPollTimer = setInterval(() => {
        if (!document.getElementById('status-content')) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
            return;
        }
        fetchStatus();
    }, 30000);
}

async function fetchStatus() {
    const container = document.getElementById('status-content');
    if (!container) return;

    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        renderStatus(container, data);
    } catch (e) {
        renderStatus(container, { configured: true, available: false });
    }
}

const KUMA_STATUS_LABELS = {
    up: 'Online',
    down: 'Nicht erreichbar',
    pending: 'Ausstehend',
    maintenance: 'Wartung',
    unknown: 'Unbekannt'
};

// Merkt sich die zuletzt geladenen Monitore (nach ID), damit das Bearbeiten-Modal
// die vorhandenen Werte vorausfüllen kann, ohne extra beim Server nachzufragen
let currentMonitorsById = {};

function renderStatus(container, data) {
    const actionBar = document.getElementById('status-action-bar');

    if (!data.configured) {
        if (actionBar) actionBar.hidden = true;
        container.innerHTML = '<div class="status-hint">Status-Monitoring ist in dieser Umgebung nicht eingerichtet.</div>';
        return;
    }

    if (!data.available) {
        if (actionBar) actionBar.hidden = true;
        container.innerHTML = '<div class="status-hint">Status-Server momentan nicht erreichbar.</div>';
        return;
    }

    if (actionBar) actionBar.hidden = false;

    const monitors = data.monitors || [];
    currentMonitorsById = {};
    monitors.forEach(m => { currentMonitorsById[m.id] = m; });

    if (monitors.length === 0) {
        container.innerHTML = '<div class="status-hint">Noch keine Dienste angelegt. Klicke oben auf "+ Dienst hinzufügen".</div>';
        return;
    }

    const dotClass = (status) => status === 'up' ? 'online' : status === 'down' ? 'down' : '';

    // Verlaufs-Leiste wie im Kuma-Dashboard: ein Balken pro Heartbeat, fehlende am Anfang
    // werden als leere (graue) Balken aufgefüllt, damit die Leiste immer gleich breit ist
    const heartbeatBarHtml = (bar) => {
        const beats = bar || [];
        const padding = Math.max(0, 50 - beats.length);
        const bits = Array(padding).fill('').concat(beats);
        return bits.map(status => `<span class="status-heartbeat-bit ${status}"></span>`).join('');
    };

    const cards = monitors.map(m => `
        <div class="status-card">
            <div class="status-card-header">
                <span class="status-dot ${dotClass(m.status)}"></span>
                <div>
                    <div class="status-card-name">${escapeHtml(m.name)}</div>
                    <div class="status-card-label">${KUMA_STATUS_LABELS[m.status] || 'Unbekannt'}</div>
                </div>
            </div>
            <div class="status-heartbeat-bar">${heartbeatBarHtml(m.heartbeatBar)}</div>
            <div class="status-card-metrics">
                <span>Uptime (24h): <strong>${m.uptime24h !== null && m.uptime24h !== undefined ? m.uptime24h + '%' : '-'}</strong></span>
                <span>Antwortzeit: <strong>${m.responseTimeMs !== null && m.responseTimeMs !== undefined ? m.responseTimeMs + ' ms' : '-'}</strong></span>
            </div>
            <div class="status-card-actions">
                <button class="btn" onclick="openMonitorModal(${m.id})">Bearbeiten</button>
                <button class="btn btn-danger" onclick="deleteMonitor(${m.id}, '${jsStr(m.name)}')">Löschen</button>
            </div>
        </div>
    `).join('');

    container.innerHTML = `<div class="status-grid">${cards}</div>`;
}

// --- MONITOR-MODAL (Anlegen / Bearbeiten) ---

let editingMonitorId = null;

// Zeigt/versteckt das Port-Feld und passt das Label des Ziel-Felds an den gewählten Typ an
function updateMonitorFormFields() {
    const type = document.getElementById('monitor-type').value;
    document.getElementById('monitor-target-label').textContent = type === 'http' ? 'URL' : 'Host / IP-Adresse';
    document.getElementById('monitor-port-field').hidden = type !== 'port';
}

function openMonitorModal(monitorId) {
    const monitor = monitorId !== undefined ? currentMonitorsById[monitorId] : null;
    editingMonitorId = monitor ? monitor.id : null;

    document.getElementById('monitor-modal-title').textContent = monitor ? 'Dienst bearbeiten' : 'Dienst hinzufügen';
    document.getElementById('monitor-form-submit').textContent = monitor ? 'Speichern' : 'Anlegen';
    document.getElementById('monitor-name').value = monitor ? monitor.name : '';
    document.getElementById('monitor-type').value = monitor ? monitor.type : 'http';
    document.getElementById('monitor-type').disabled = !!monitor; // Typ kann beim Bearbeiten nicht geändert werden
    document.getElementById('monitor-target').value = monitor ? (monitor.target || '') : '';
    document.getElementById('monitor-port').value = monitor && monitor.port ? monitor.port : '';
    document.getElementById('monitor-interval').value = 60;
    updateMonitorFormFields();

    document.getElementById('monitor-modal-overlay').hidden = false;
    document.getElementById('monitor-name').focus();
}

function closeMonitorModal() {
    document.getElementById('monitor-modal-overlay').hidden = true;
    document.getElementById('monitor-type').disabled = false;
    editingMonitorId = null;
}

document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'monitor-form') return;
    e.preventDefault();

    const body = {
        type: document.getElementById('monitor-type').value,
        name: document.getElementById('monitor-name').value.trim(),
        target: document.getElementById('monitor-target').value.trim(),
        port: document.getElementById('monitor-port').value,
        interval: document.getElementById('monitor-interval').value
    };
    const idToEdit = editingMonitorId;
    closeMonitorModal();

    try {
        const res = await fetch(idToEdit ? `/api/status/monitors/${idToEdit}` : '/api/status/monitors', {
            method: idToEdit ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Speichern fehlgeschlagen.');
        fetchStatus();
    } catch (err) {
        alert('Fehler: ' + err.message);
    }
});

document.addEventListener('click', (e) => {
    if (e.target.id === 'monitor-modal-overlay') closeMonitorModal();
});

async function deleteMonitor(monitorId, name) {
    if (!confirm(`Dienst "${name}" wirklich aus Kuma löschen?`)) return;
    try {
        const res = await fetch(`/api/status/monitors/${monitorId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Löschen fehlgeschlagen.');
        fetchStatus();
    } catch (err) {
        alert('Fehler: ' + err.message);
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
            routesData.routes.filter(r => r.approved).forEach(r => routesList.push(r.route));
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
                select.innerHTML += `<option value="${jsStr(u.name)}" data-id="${jsStr(u.id)}">${escapeHtml(u.name)}</option>`;
            });
        }
    } catch (e) {
        console.error("Fehler beim Laden", e);
    }

    // Zeigt alle aktiven Keys direkt an - kein Benutzer-Filter nötig, um sie überhaupt zu sehen
    fetchKeys();
}

async function fetchKeys() {
    const grid = document.getElementById('keys-grid');
    if (!grid) return;
    grid.innerHTML = '<p>Lade Keys...</p>';

    try {
        const res = await fetch('/api/keys');
        const data = await res.json();

        if (!data.preAuthKeys || data.preAuthKeys.length === 0) {
            grid.innerHTML = '<p>Keine Keys auf dem Server gefunden.</p>';
            return;
        }

        const jetzt = new Date();
        const activeKeys = data.preAuthKeys.filter(k => new Date(k.expiration) > jetzt);

        if (activeKeys.length === 0) {
            grid.innerHTML = '<p>Keine aktiven Keys vorhanden.</p>';
            return;
        }

        grid.innerHTML = activeKeys.map(k => {
            const owner = k.user?.name || '-';
            return `
            <div class="node-card">
                <div class="node-card-header">
                    <div>
                        <div class="node-name">${escapeHtml(k.key)}</div>
                        <div class="node-owner">Für: ${escapeHtml(owner)}</div>
                    </div>
                </div>
                <div class="node-meta">
                    <div>Reusable: ${k.reusable ? 'Ja' : 'Nein'}</div>
                    <div>Läuft ab: ${new Date(k.expiration).toLocaleString()}</div>
                </div>
                <div class="node-card-footer">
                    <button class="btn btn-danger" onclick="expireKey('${jsStr(k.id)}', '${jsStr(k.key)}')">Ablaufen lassen</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        grid.innerHTML = '<p style="color:#b91c1c;">Fehler beim Laden!</p>';
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

// FIX: Headscale identifiziert den zu löschenden Key über seine ID, NICHT über den Key-Wert
// selbst - die Liste liefert den Key-Wert ohnehin nur maskiert zurück (z.B. "hskey-...-***"),
// ein Aufruf mit diesem maskierten Wert schlägt lautlos fehl (200 OK, aber ohne jede Wirkung).
async function expireKey(keyId, keyPrefix) {
    if (!confirm(`Möchtest du den Key ${keyPrefix.substring(0, 20)}... wirklich deaktivieren?`)) return;

    try {
        const res = await fetch('/api/keys/expire', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: keyId })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Server lehnte das Ablaufen ab.");

        fetchKeys();
    } catch (e) {
        alert("Fehler beim Deaktivieren: " + e.message);
    }
}

// --- API LOGIK: SUBNET ROUTES ---

async function fetchRoutes() {
    const grid = document.getElementById('routes-grid');
    if (!grid) return;

    try {
        const res = await fetch('/api/routes');
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Fehler beim Laden.');

        const routes = data.routes || [];
        if (routes.length === 0) {
            grid.innerHTML = '<div class="status-hint">Keine Subnet Routes angekündigt. Auf einem Gerät z.B. mit "tailscale up --advertise-routes=&lt;CIDR&gt;" eine Route bekannt machen.</div>';
            return;
        }

        grid.innerHTML = routes.map(r => {
            const dotClass = r.approved ? 'online' : 'pending';
            const statusLabel = r.approved ? 'Genehmigt' : 'Wartet auf Genehmigung';
            const actionBtn = r.approved
                ? `<button class="btn btn-danger" onclick="disableRoute('${jsStr(r.nodeId)}', '${jsStr(r.route)}')">Deaktivieren</button>`
                : `<button class="btn btn-primary" onclick="approveRoute('${jsStr(r.nodeId)}', '${jsStr(r.route)}')">Genehmigen</button>`;

            return `
            <div class="status-card">
                <div class="status-card-header">
                    <span class="status-dot ${dotClass}"></span>
                    <div>
                        <div class="status-card-name">${escapeHtml(r.route)}</div>
                        <div class="status-card-label">${escapeHtml(r.nodeName)}</div>
                    </div>
                </div>
                <div class="status-card-metrics">
                    <span>Angekündigt: <strong>${r.advertised ? 'Ja' : 'Nein'}</strong></span>
                    <span>Status: <strong>${statusLabel}</strong></span>
                </div>
                <div class="status-card-actions">${actionBtn}</div>
            </div>`;
        }).join('');
    } catch (e) {
        grid.innerHTML = `<div class="status-hint" style="color:#b91c1c;">Fehler beim Laden: ${escapeHtml(e.message)}</div>`;
    }
}

async function approveRoute(nodeId, route) {
    try {
        const res = await fetch('/api/routes/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, route })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Genehmigen fehlgeschlagen.');
        fetchRoutes();
    } catch (e) {
        alert('Fehler: ' + e.message);
    }
}

async function disableRoute(nodeId, route) {
    if (!confirm(`Route "${route}" wirklich deaktivieren?`)) return;
    try {
        const res = await fetch('/api/routes/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, route })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Deaktivieren fehlgeschlagen.');
        fetchRoutes();
    } catch (e) {
        alert('Fehler: ' + e.message);
    }
}

// --- API LOGIK: AUDIT LOG ---

// Zeigt die letzten Audit-Log-Einträge als kompakten Log-Feed auf der Startseite an -
// klassischer Monospace-"Log"-Look statt einer normalen Tabelle.
async function fetchDashboardAuditLog() {
    const container = document.getElementById('dashboard-audit-log');
    if (!container) return;

    try {
        const res = await fetch('/api/audit?limit=10&offset=0');
        const data = await res.json();

        if (!data.configured) {
            container.textContent = 'Audit-Log ist in dieser Umgebung nicht eingerichtet.';
            return;
        }
        if (!data.available) {
            container.textContent = 'Audit-Log-Datenbank momentan nicht erreichbar.';
            return;
        }

        const entries = data.entries || [];
        if (entries.length === 0) {
            container.textContent = 'Noch keine Einträge vorhanden.';
            return;
        }

        container.innerHTML = entries.map(e => {
            const time = new Date(e.timestamp).toLocaleString('de-DE');
            const target = e.target ? ` ${e.target}` : '';
            return `<div class="audit-log-line"><span class="audit-log-time">[${escapeHtml(time)}]</span> ${escapeHtml(e.actor)}  ${escapeHtml(e.action)}${escapeHtml(target)}</div>`;
        }).join('');
    } catch (e) {
        container.textContent = 'Fehler beim Laden.';
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
    if (e.key === 'Escape') { closeSshModal(); closeMonitorModal(); }
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
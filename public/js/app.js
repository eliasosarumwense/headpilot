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
                tbody.innerHTML += `<tr>
                    <td>${n.id}</td>
                    <td><strong>${n.givenName || n.name}</strong></td>
                    <td>${n.ipAddresses.join('<br>')}</td>
                    <td>${new Date(n.lastSeen).toLocaleString()}</td>
                </tr>`;
            });
        } else tbody.innerHTML = '<tr><td colspan="4">Keine Geräte gefunden.</td></tr>';
    } catch (e) { tbody.innerHTML = '<tr><td colspan="4" style="color:red;">Fehler beim Laden!</td></tr>'; }
}

// --- API LOGIK: USERS ---
async function fetchUsers() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();
        const tbody = document.getElementById('users-table-body');
        tbody.innerHTML = ''; 
        if (data.users && data.users.length > 0) {
            data.users.forEach(u => {
                tbody.innerHTML += `<tr>
                    <td>${u.id}</td>
                    <td><strong>${u.name}</strong></td>
                    <td>${new Date(u.createdAt).toLocaleString()}</td>
                    <td class="action-cell">
                        <button class="btn-warning" onclick="renameUser('${u.name}')">Umbenennen</button>
                        <button class="btn-danger" onclick="deleteUser('${u.name}')">Löschen</button>
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
        fetchUsers();
    } catch (e) { alert("Fehler beim Erstellen"); }
}

async function renameUser(oldName) {
    const newName = prompt(`Neuer Name für "${oldName}":`);
    if (!newName) return;
    try {
        await fetch(`/api/users/${oldName}/rename/${newName.trim()}`, { method: 'POST' });
        fetchUsers();
    } catch (e) { alert("Fehler beim Umbenennen"); }
}

async function deleteUser(name) {
    if (!confirm(`Benutzer "${name}" wirklich löschen?`)) return;
    try {
        await fetch(`/api/users/${name}`, { method: 'DELETE' });
        fetchUsers();
    } catch (e) { alert("Fehler beim Löschen"); }
}

async function fetchDashboardStats() {
    try {
        // Wir fragen beide Routen gleichzeitig ab, um Zeit zu sparen
        const [nodesRes, usersRes] = await Promise.all([
            fetch('/api/nodes'),
            fetch('/api/users')
        ]);
        
        const nodesData = await nodesRes.json();
        const usersData = await usersRes.json();

        // Zahlen in die Karten eintragen (oder 0, falls leer)
        const totalNodes = nodesData.nodes ? nodesData.nodes.length : 0;
        const totalUsers = usersData.users ? usersData.users.length : 0;

        document.getElementById('stat-nodes').innerText = totalNodes;
        document.getElementById('stat-users').innerText = totalUsers;

    } catch (e) {
        console.error("Fehler beim Laden der Statistiken", e);
        document.getElementById('stat-nodes').innerText = "ERR";
        document.getElementById('stat-users').innerText = "ERR";
    }
}

// --- API LOGIK: KEYS ---

// Wird aufgerufen, sobald die Keys-Seite öffnet
async function initKeysView() {
    try {
        // Holt alle Benutzer, um das Dropdown-Menü zu füllen
        const res = await fetch('/api/users');
        const data = await res.json();
        const select = document.getElementById('key-user-select');
        
        select.innerHTML = '<option value="">-- Benutzer wählen --</option>';
        if (data.users && data.users.length > 0) {
            data.users.forEach(u => {
                select.innerHTML += `<option value="${u.name}">${u.name}</option>`;
            });
        }
    } catch (e) {
        console.error("Fehler beim Laden der User für das Dropdown", e);
    }
}

// Holt die aktiven Keys für den im Dropdown gewählten User
async function fetchKeys() {
    const user = document.getElementById('key-user-select').value;
    const tbody = document.getElementById('keys-table-body');
    
    if (!user) {
        tbody.innerHTML = '<tr><td colspan="4">Bitte wähle oben einen Benutzer aus.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="4">Lade Keys...</td></tr>';

    try {
        const res = await fetch(`/api/keys?user=${user}`);
        const data = await res.json();
        tbody.innerHTML = '';
        
        if (data.preAuthKeys && data.preAuthKeys.length > 0) {
            // Filtern: Wir wollen nur Keys anzeigen, die noch nicht abgelaufen sind
            const activeKeys = data.preAuthKeys.filter(k => new Date(k.expiration) > new Date());
            
            if(activeKeys.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4">Keine aktiven Keys für diesen Benutzer.</td></tr>';
                return;
            }

            activeKeys.forEach(k => {
                tbody.innerHTML += `<tr>
                    <td><code>${k.key}</code></td>
                    <td>${k.reusable ? 'Ja' : 'Nein'}</td>
                    <td>${new Date(k.expiration).toLocaleString()}</td>
                    <td><button class="btn-danger" onclick="expireKey('${user}', '${k.key}')">Ablaufen lassen</button></td>
                </tr>`;
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="4">Keine Keys für diesen Benutzer.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:red;">Fehler beim Laden!</td></tr>';
    }
}

// Generiert einen neuen Key
async function createKey() {
    const user = document.getElementById('key-user-select').value;
    const reusable = document.getElementById('key-reusable').checked;
    
    if (!user) return alert("Bitte wähle zuerst einen Benutzer aus dem Dropdown aus!");

    // Setzt das Ablaufdatum standardmäßig auf +30 Tage ab heute
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);

    try {
        const res = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user: user,
                reusable: reusable,
                ephemeral: false,
                expiration: expirationDate.toISOString()
            })
        });
        
        if (!res.ok) throw new Error("Fehler beim Generieren des Keys.");
        
        const data = await res.json();
        
        // WICHTIG: Headscale zeigt den kompletten Key aus Sicherheitsgründen nur ein einziges Mal bei der Erstellung an!
        alert(`WICHTIG! Neuer Key generiert:\n\nKopiere ihn jetzt. Er wird danach nie wieder komplett angezeigt!\n\n${data.preAuthKey.key}`);
        
        fetchKeys(); // Tabelle neu laden
    } catch (e) {
        alert(e.message);
    }
}

// Macht einen Key sofort unbrauchbar
async function expireKey(user, key) {
    if (!confirm("Möchtest du diesen Key wirklich vorzeitig ablaufen lassen?")) return;
    
    try {
        await fetch('/api/keys/expire', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: user, key: key })
        });
        fetchKeys(); // Tabelle neu laden
    } catch (e) {
        alert("Fehler beim Ablaufen-lassen des Keys.");
    }
}
// Wenn das Skript geladen ist, starte mit der "nodes" Ansicht
window.onload = () => loadView('dashboard');
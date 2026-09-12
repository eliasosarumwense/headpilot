// sshVault.js
// Speichert SSH-Zugangsdaten pro Node verschlüsselt auf der Festplatte, damit man
// sich nicht bei jedem Docker-Scan erneut per SSH einloggen muss.
//
// Sicherheitsprinzip:
// - AES-256-GCM, pro gespeichertem Eintrag ein neuer zufälliger IV + Auth-Tag
// - Der Schlüssel wird per scrypt aus SSH_VAULT_SECRET (.env) + einem einmalig
//   zufällig generierten, pro Installation festen Salt abgeleitet (nie fest verdrahtet)
// - Ohne gesetztes SSH_VAULT_SECRET bleibt das Feature komplett deaktiviert -
//   es gibt bewusst KEINEN unsicheren Default-Schlüssel wie beim SESSION_SECRET-Fallback
// - Die Vault-Datei landet außerhalb von "public" und wird per .gitignore nie committed
// - Die Datei bekommt Unix-Rechte 0600 (nur der Prozess-Owner darf sie lesen)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_PATH = path.join(__dirname, 'data', 'ssh-vault.json');
const SECRET = process.env.SSH_VAULT_SECRET;

function isEnabled() {
    return !!SECRET;
}

function loadRaw() {
    if (!fs.existsSync(VAULT_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
    } catch (e) {
        console.error('SSH-Vault: Datei konnte nicht gelesen werden:', e.message);
        return null;
    }
}

function persist(raw) {
    fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true });
    fs.writeFileSync(VAULT_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });
}

// Legt die Vault-Datei mit einem frischen, zufälligen Salt an, falls sie noch nicht existiert
function ensureVaultFile() {
    const existing = loadRaw();
    if (existing && existing.salt) return existing;

    const fresh = { salt: crypto.randomBytes(16).toString('hex'), credentials: {} };
    persist(fresh);
    return fresh;
}

function deriveKey(saltHex) {
    // scrypt statt einem simplen Hash, damit ein schwaches SSH_VAULT_SECRET nicht
    // trivial per Brute-Force zu knacken wäre
    return crypto.scryptSync(SECRET, Buffer.from(saltHex, 'hex'), 32);
}

function encrypt(key, plainObj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        data: ciphertext.toString('base64')
    };
}

function decrypt(key, entry) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.authTag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}

// Speichert Benutzername + Passwort für eine Node verschlüsselt ab (überschreibt einen vorhandenen Eintrag)
function saveCredentials(nodeId, username, password) {
    if (!isEnabled()) throw new Error('SSH_VAULT_SECRET ist auf dem Server nicht konfiguriert.');

    const raw = ensureVaultFile();
    const key = deriveKey(raw.salt);

    raw.credentials[String(nodeId)] = {
        ...encrypt(key, { username, password }),
        // Nutzername unverschlüsselt nur zur Anzeige in der UI ("gespeichert für root") -
        // das Passwort selbst liegt ausschließlich in "data" (verschlüsselt)
        username,
        updatedAt: new Date().toISOString()
    };

    persist(raw);
}

// Liefert { username, password } entschlüsselt zurück, oder null wenn nichts gespeichert /
// das Feature nicht konfiguriert ist
function getCredentials(nodeId) {
    if (!isEnabled()) return null;

    const raw = loadRaw();
    const entry = raw?.credentials?.[String(nodeId)];
    if (!entry) return null;

    try {
        return decrypt(deriveKey(raw.salt), entry);
    } catch (e) {
        console.error(`SSH-Vault: Eintrag für Node ${nodeId} konnte nicht entschlüsselt werden:`, e.message);
        return null;
    }
}

// Nur Metadaten für die UI - liefert NIE das Passwort zurück
function getCredentialsInfo(nodeId) {
    const raw = loadRaw();
    const entry = raw?.credentials?.[String(nodeId)];
    if (!entry) return { saved: false };
    return { saved: true, username: entry.username, updatedAt: entry.updatedAt };
}

function deleteCredentials(nodeId) {
    const raw = loadRaw();
    if (!raw?.credentials?.[String(nodeId)]) return false;
    delete raw.credentials[String(nodeId)];
    persist(raw);
    return true;
}

module.exports = { isEnabled, saveCredentials, getCredentials, getCredentialsInfo, deleteCredentials };

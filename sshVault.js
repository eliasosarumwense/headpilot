// speichert ssh-zugangsdaten pro node verschlüsselt (aes-256-gcm, schlüssel per scrypt aus
// ssh_vault_secret + zufälligem salt). ohne secret komplett deaktiviert, kein default-fallback.

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

// legt die vault-datei mit einem frischen, zufälligen salt an, falls sie noch nicht existiert
function ensureVaultFile() {
    const existing = loadRaw();
    if (existing && existing.salt) return existing;

    const fresh = { salt: crypto.randomBytes(16).toString('hex'), credentials: {} };
    persist(fresh);
    return fresh;
}

function deriveKey(saltHex) {
    // scrypt statt einem simplen hash, damit ein schwaches ssh_vault_secret nicht
    // trivial per brute-force zu knacken wäre
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

// speichert benutzername + passwort für eine node verschlüsselt ab (überschreibt einen vorhandenen eintrag)
function saveCredentials(nodeId, username, password) {
    if (!isEnabled()) throw new Error('SSH_VAULT_SECRET ist auf dem Server nicht konfiguriert.');

    const raw = ensureVaultFile();
    const key = deriveKey(raw.salt);

    raw.credentials[String(nodeId)] = {
        ...encrypt(key, { username, password }),
        // nutzername unverschlüsselt nur zur anzeige in der ui ("gespeichert für root") -
        // das passwort selbst liegt ausschließlich in "data" (verschlüsselt)
        username,
        updatedAt: new Date().toISOString()
    };

    persist(raw);
}

// liefert { username, password } entschlüsselt zurück, oder null wenn nichts gespeichert /
// das feature nicht konfiguriert ist
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

// nur metadaten für die ui, liefert nie das passwort zurück
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

// audit.js
// Schreibt sicherheitsrelevante Aktionen (Löschen, Anlegen, Login, ...) in die Postgres-
// Tabelle "headpilot.audit_log". Läuft nach demselben Prinzip wie die Kuma-/SSH-Vault-
// Integration: Ist DATABASE_URL nicht gesetzt, bleibt das Feature einfach deaktiviert -
// blockiert oder crasht dabei nie die eigentliche Anwendung.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

if (pool) {
    // Ein Verbindungsfehler auf einem einzelnen Client im Pool darf nie den ganzen
    // Prozess crashen (Node killt den Prozess sonst standardmäßig bei einem
    // unbehandelten 'error'-Event auf dem Pool).
    pool.on('error', (err) => {
        console.error('Audit-Log: unerwarteter Datenbankfehler (Pool bleibt bestehen):', err.message);
    });
} else {
    console.warn('Audit-Log: DATABASE_URL ist nicht gesetzt - Audit-Logging bleibt deaktiviert.');
}

function isConfigured() {
    return !!pool;
}

// Schreibt einen Eintrag. Bewusst so gebaut, dass ein Fehler beim Loggen NIE die
// eigentliche Aktion (z.B. "Node löschen") verhindert - wird nur geloggt, nie geworfen.
async function logAudit({ actor, action, target, details, ip } = {}) {
    if (!pool) return;

    try {
        await pool.query(
            `INSERT INTO headpilot.audit_log (actor, action, target, details, ip)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                actor || 'unknown',
                action,
                target !== undefined && target !== null ? String(target) : null,
                details !== undefined ? JSON.stringify(details) : null,
                ip || null
            ]
        );
    } catch (err) {
        console.error(`Audit-Log: Eintrag konnte nicht gespeichert werden (action=${action}):`, err.message);
    }
}

// Liefert die letzten Einträge, neueste zuerst. Wirft bei einem echten DB-Fehler
// (im Unterschied zu logAudit) - die aufrufende Route unterscheidet damit "nicht
// konfiguriert" von "konfiguriert, aber gerade nicht erreichbar", genau wie bei Kuma.
async function getAuditLog({ limit = 50, offset = 0 } = {}) {
    if (!pool) return [];

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const result = await pool.query(
        `SELECT id, timestamp, actor, action, target, details, ip
         FROM headpilot.audit_log
         ORDER BY id DESC
         LIMIT $1 OFFSET $2`,
        [safeLimit, safeOffset]
    );

    return result.rows;
}

module.exports = { logAudit, getAuditLog, isConfigured };

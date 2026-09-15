# Headpilot

Ein eigenes Admin-Dashboard für [Headscale](https://headscale.net/), den selbst gehosteten Ersatz für den Tailscale-Coordination-Server. Headscale bringt von Haus aus kein Web-Interface mit, nur eine REST-API und die CLI. Headpilot setzt genau da an: Geräte verwalten, Benutzer anlegen, Subnet-Routes freigeben, Pre-Auth-Keys generieren und den Zustand des Tailnets auf einen Blick sehen, alles über eine normale Weboberfläche statt SSH und CLI-Befehle.

Login läuft über einen eigenen Keycloak-Server per OIDC. Headpilot verwaltet selbst keine Passwörter oder Benutzerkonten für den Zugriff aufs Dashboard.

## Geräte

Alle registrierten Nodes im Tailnet als Karten, mit Online-Status, IPv4/IPv6-Adressen, Besitzer und letztem Kontakt. Direkt aus der Karte heraus lässt sich ein Gerät umbenennen, seine Sitzung beenden, löschen oder per Ping anpingen.

![Geräte-Übersicht](docs/screenshots/nodes.png)

## Startseite

Zeigt auf einen Blick, wie viele Benutzer und Geräte es gibt, wie viele davon gerade online sind, offene Pre-Auth-Keys, bald ablaufende Sitzungen und genehmigte Subnet-Routes. Darunter ein interaktiver Graph des gesamten Tailnets sowie ein Log der letzten sicherheitsrelevanten Aktionen (Logins, Änderungen an Geräten, Benutzern und Routes).

![Startseite mit Netzwerk-Graph](docs/screenshots/dashboard.png)

## Benutzer

Headscale-Benutzer anlegen, umbenennen und löschen. Wer sich über Keycloak eingeloggt hat, bekommt automatisch Anzeigename und Anmeldeart angezeigt, dazu die Anzahl der Geräte, die diesem Benutzer aktuell zugeordnet sind.

![Benutzerverwaltung](docs/screenshots/users.png)

## Status

Bindet eine bestehende [Uptime Kuma](https://github.com/louislam/uptime-kuma)-Instanz direkt über deren Socket.IO-Schnittstelle ein, live und ohne öffentliche Status-Page. Monitore lassen sich direkt aus Headpilot heraus anlegen, bearbeiten und löschen, inklusive Verlaufsanzeige und Antwortzeiten. Eine Discord-Benachrichtigung bei Ausfällen kann mit einem Klick aktiviert werden.

![Status-Reiter](docs/screenshots/status.png)

## Pre-Auth Keys

Einladungs-Schlüssel für neue Geräte generieren, wiederverwendbar oder einmalig, mit Ablaufdatum. Fertig genutzte oder nicht mehr benötigte Keys lassen sich sofort ablaufen lassen.

![Pre-Auth Keys](docs/screenshots/keys.png)

## Weitere Reiter

Daneben gibt es noch einen Bereich für Subnet-Routes (angekündigte Routen genehmigen oder deaktivieren) und einen Docker-Reiter, der per SSH auf den einzelnen Geräten nachsieht, welche Container dort laufen, praktisch, um auf einen Blick zu sehen, ob z. B. Home Assistant oder ein Reverse Proxy noch läuft.

## Setup

```bash
npm install
cp .env.example .env
```

In der `.env` müssen mindestens `HEADSCALE_URL`, `HEADSCALE_API_KEY`, die Keycloak-Variablen (`KEYCLOAK_REALM_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `REDIRECT_URI`) und ein zufälliges `SESSION_SECRET` gesetzt sein. Uptime Kuma, die verschlüsselte SSH-Zugangsdaten-Speicherung und das Postgres-Audit-Log sind optional, fehlen die jeweiligen Variablen, schaltet sich das entsprechende Feature einfach sauber ab, ohne dass etwas crasht.

```bash
npm start
```

Läuft danach auf `http://localhost:3000`.

## Tech-Stack

Node.js mit Express im Backend, im Frontend bewusst kein Framework, sondern schlichtes JavaScript und serverseitig gerenderte HTML-Fragmente. Der Netzwerk-Graph läuft über [vis-network](https://visjs.github.io/vis-network/), die Kuma-Anbindung über die reguläre Socket.IO-Schnittstelle. SSH-Zugangsdaten werden, wenn gewünscht, AES-256-verschlüsselt auf dem Server abgelegt, nie im Klartext.

## Hinweis

Headpilot ist ein privates Projekt für mein eigenes Tailnet und auf meinen konkreten Anwendungsfall zugeschnitten. Es erhebt keinen Anspruch darauf, jede Headscale-Funktion abzudecken oder sich 1:1 auf jedes Setup übertragen zu lassen.

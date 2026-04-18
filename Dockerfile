FROM node:18-alpine

WORKDIR /app

# Installiere Abhängigkeiten
COPY package*.json ./
RUN npm install

# Kopiere den restlichen Code
COPY . .

# Exponiere den Port
EXPOSE 3000

# Starte den Server
CMD ["npm", "start"]

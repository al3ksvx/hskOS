# HotelOS by YSYR

PWA do zarządzania hotelem: pokoje (statusy na żywo), rezerwacje, zadania, czat, zespół i role, PL/UA.

## Uruchomienie lokalne
```
npm install
JWT_SECRET="długi-losowy-sekret" npm start      # http://localhost:3000
```
Windows (PowerShell): `$env:JWT_SECRET="sekret"; npm start`

## Baza danych
SQLite, plik `hotel.db` tworzony automatycznie (zmiana ścieżki: `DB_PATH=/dane/hotel.db`). Wykonuj kopie tego pliku.

## Pierwszy administrator
Otwórz aplikację – przy pustej bazie pokaże się formularz „Pierwsza konfiguracja” (nazwa hotelu, administrator, hasło min. 8 znaków). Potem: Pokoje → dodaj pokoje, Zespół → dodaj użytkowników.

## Wdrożenie online
Wymagany Node.js ≥ 18, HTTPS (konieczny dla PWA i instalacji na telefonie) oraz trwały dysk na `hotel.db`.
- Render / Railway / Fly.io: repo z tym folderem, Start: `npm start`, zmienne `JWT_SECRET`, `DB_PATH` (na dysku trwałym).
- VPS: `npm i -g pm2 && pm2 start server.js`, reverse proxy Caddy/Nginx z HTTPS i obsługą WebSocket (`/ws`).

## Instalacja na telefonie
Android/Chrome: menu → „Zainstaluj aplikację”. iOS/Safari: Udostępnij → „Dodaj do ekranu początkowego”.

## Nowy język
Skopiuj `public/i18n/pl.json` jako np. `de.json`, przetłumacz i dodaj opcję w funkcji `LS()` w `index.html`.

## Uwagi
Role: admin, manager, recepcja, pokojówki (ograniczone uprawnienia). Wiadomości czatu i nazwy własne nie są tłumaczone; komunikaty systemowe tak.

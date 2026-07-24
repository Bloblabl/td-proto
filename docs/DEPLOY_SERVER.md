# Деплой auth-сервера на VPS (Ubuntu/Debian)

Пошаговая инструкция для прод-хостинга `server/` на своём VPS. Даёт рабочий
HTTPS-эндпоинт **без покупки домена** — через `sslip.io` (публичный wildcard-DNS,
резолвит `<ip-с-дефисами>.sslip.io` в ваш IP; Let's Encrypt выдаёт на него серт).

Итог: фронт на GitHub Pages (`https://bloblabl.github.io/td-proto/`) ходит на
`https://<ip>.sslip.io/api/...`, прогресс игроков хранится в SQLite на VPS.

Всё, что ниже, выполняется **на VPS** под root (или через `sudo`), если не сказано иное.
Подставьте свой публичный IP вместо `203.0.113.5`.

---

## 0. Переменные (задать в начале сессии)

```bash
VPS_IP=203.0.113.5                      # ваш публичный IP
HOSTNAME=${VPS_IP//./-}.sslip.io        # -> 203-0-113-5.sslip.io
echo "$HOSTNAME"                         # проверьте вывод
```

Проверьте, что sslip.io резолвится в ваш IP:

```bash
getent hosts "$HOSTNAME"                 # должно показать ваш VPS_IP
```

## 1. Базовые пакеты и Node 22

`node:sqlite` требует Node **22+** (флаг `--experimental-sqlite`).

```bash
apt update && apt install -y git nginx ufw curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v                                  # должно быть v22.x
```

## 2. Firewall

Наружу только SSH + HTTP + HTTPS. Порт 3000 (Node) закрыт — доступен лишь nginx локально.

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'                   # 80 + 443
ufw --force enable
ufw status
```

## 3. Код и зависимости

Отдельный системный пользователь без прав root — сервис будет работать под ним.

```bash
useradd --system --create-home --shell /usr/sbin/nologin td
cd /opt
git clone https://github.com/Bloblabl/td-proto.git
chown -R td:td /opt/td-proto
cd /opt/td-proto
sudo -u td npm ci                        # ставит и tsx (нужен для запуска server/)
```

Каталог для БД (переживает `git pull` и редеплой — лежит вне репозитория):

```bash
mkdir -p /var/lib/td-proto
chown td:td /var/lib/td-proto
```

## 4. Секреты (server/.env)

```bash
cat > /opt/td-proto/server/.env <<EOF
PORT=3000
HOST=127.0.0.1
JWT_SECRET=$(openssl rand -hex 32)
ALLOWED_ORIGIN=https://bloblabl.github.io
TD_DB_PATH=/var/lib/td-proto/td.db
EOF
chown td:td /opt/td-proto/server/.env
chmod 600 /opt/td-proto/server/.env
```

> Образец полей — в `server/.env.example`. Файл `server/.env` в `.gitignore`,
> в репозиторий не попадёт.

## 5. systemd-сервис

```bash
cat > /etc/systemd/system/td-server.service <<'EOF'
[Unit]
Description=TD-Proto auth server
After=network.target

[Service]
Type=simple
User=td
WorkingDirectory=/opt/td-proto
EnvironmentFile=/opt/td-proto/server/.env
ExecStart=/usr/bin/npm run server
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now td-server
systemctl status td-server --no-pager    # active (running)
curl -s http://127.0.0.1:3000/api/health # {"ok":true}
```

## 6. nginx (reverse proxy)

```bash
cat > /etc/nginx/sites-available/td-server <<EOF
server {
    listen 80;
    server_name $HOSTNAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/td-server /etc/nginx/sites-enabled/td-server
nginx -t && systemctl reload nginx
curl -s "http://$HOSTNAME/api/health"     # {"ok":true}
```

## 7. HTTPS (Let's Encrypt)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d "$HOSTNAME" --non-interactive --agree-tos -m you@example.com --redirect
curl -s "https://$HOSTNAME/api/health"    # {"ok":true} по HTTPS
```

certbot настроит автопродление (таймер `certbot.timer`). Проверка: `systemctl list-timers | grep certbot`.

## 8. Связать фронт с бэкендом

На GitHub (репозиторий **Bloblabl/td-proto**) → **Settings → Secrets and
variables → Actions → Variables → New repository variable**:

- **Name:** `VITE_API_BASE`
- **Value:** `https://<ip-с-дефисами>.sslip.io` (напр. `https://203-0-113-5.sslip.io`, без хвостового слэша)

Затем передеплой фронта: **Actions → Deploy to GitHub Pages → Run workflow**
(или любой push в `master`). Билд вошьёт `VITE_API_BASE`, и на проде заработают
регистрация/вход/облачный прогресс.

> Без этой переменной сборка идёт с относительным `/api` — прод остаётся гостевым
> (регистрация/вход недоступны, прогресс локальный). Ничего не ломается.

## 9. Проверка end-to-end

1. Открыть `https://bloblabl.github.io/td-proto/` → меню → «Аккаунт».
2. Зарегистрироваться, сыграть забег, разлогиниться, снова войти — прогресс на месте.
3. DevTools → Network: запросы идут на `https://<ip>.sslip.io/api/...`, CORS без ошибок.

---

## Обновление сервера (редеплой кода)

```bash
cd /opt/td-proto
sudo -u td git pull
sudo -u td npm ci
systemctl restart td-server
```

БД (`/var/lib/td-proto/td.db`) не трогается — прогресс сохраняется.

## Диагностика

```bash
journalctl -u td-server -f               # логи сервера
systemctl status td-server --no-pager
nginx -t                                 # синтаксис конфига
tail -f /var/log/nginx/error.log
```

- **502 Bad Gateway** — Node-процесс не поднялся: `journalctl -u td-server`.
  Частая причина — старый Node (нужен 22+) или занятый порт 3000.
- **CORS-ошибка в браузере** — `ALLOWED_ORIGIN` в `server/.env` не совпадает с
  origin фронта (`https://bloblabl.github.io`, без пути и слэша). После правки
  `systemctl restart td-server`.
- **Mixed content / запросы на `/api` с github.io** — не задана `VITE_API_BASE`
  или фронт не передеплоен после её установки.
- **certbot не выдал серт** — проверьте `getent hosts $HOSTNAME` (IP верный?) и
  что порт 80 открыт (`ufw status`, `Nginx Full`).

## Резервная копия БД

```bash
sudo -u td cp /var/lib/td-proto/td.db /var/lib/td-proto/td.db.bak-$(date +%F)
```

## Ограничения

- URL завязан на IP VPS: сменится IP — сменится `sslip.io`-хостнейм и `VITE_API_BASE`.
  Для стабильного имени независимо от IP — бесплатный DuckDNS-сабдомен вместо sslip.io
  (шаги 6–8 те же, меняется только `$HOSTNAME`).
- `node:sqlite` помечен экспериментальным — для прототипа/плейтеста приемлемо.

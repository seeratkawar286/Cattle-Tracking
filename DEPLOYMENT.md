# sylCloud HCS048 Server — Deployment Guide

## Requirements
- Node.js ≥ 18.0.0
- MongoDB 6.x or 7.x (local or Atlas)
- Open ports: 3000 (REST/WS), 8080 (TCP)

## 1. Environment Setup
```bash
cp .env.example .env
# Edit .env — fill MONGO_URI and JWT_SECRET before starting
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Paste output as JWT_SECRET in .env
```

## 2. Install Dependencies
```bash
npm install --omit=dev
```

## 3. Start with PM2 (Recommended)
```bash
npm install -g pm2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup    # auto-start on server reboot
```

## 4. Start with Docker
```bash
docker build -t sylcloud-cattle .
docker run -d \
  --name sylcloud-cattle \
  -p 3000:3000 \
  -p 8080:8080 \
  --env-file .env \
  --restart unless-stopped \
  sylcloud-cattle
```

## 5. Start directly (development)
```bash
npm run dev
```

## Port Reference
| Port | Protocol | Purpose |
|------|----------|---------|
| 3000 | HTTP/WS  | REST API + WebSocket real-time stream |
| 8080 | TCP      | HCS048 ear tag data ingestion |

## Health Check
```
GET http://your-server:3000/health
```

## API Index
```
GET http://your-server:3000/api/v1
```

## WebSocket
```
ws://your-server:3000/ws
Events: LOCATION_UPDATE, ALARM
```

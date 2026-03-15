# CivicPulse API Server

Express.js backend for CivicPulse — handles WhatsApp webhook, AI classification, and report management.

## Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check + report count |
| GET | `/api/reports` | List reports (filterable) |
| GET | `/api/reports/stats` | Dashboard statistics |
| GET | `/api/reports/geojson` | GeoJSON for map |
| GET | `/api/reports/:id` | Single report |
| POST | `/api/reports` | Create report |
| PATCH | `/api/reports/:id` | Update status |
| POST | `/api/reports/:id/upvote` | Upvote report |
| POST | `/api/whatsapp/webhook` | Twilio WhatsApp webhook |

## Setup

```bash
npm install
cp .env.example .env  # Fill in your keys
npm start
```

## Deploy to Railway

1. Push to GitHub
2. Railway → New Project → Deploy from GitHub
3. Add environment variables
4. Railway provides URL like: civicpulse-api.up.railway.app

## AI Pipeline

Runs every 30 seconds, checks for unclassified reports:
1. Fetches photo from report
2. Sends to Claude Haiku 4.5 Vision → gets category, type, severity
3. If traffic violation → sends to PlateRecognizer → reads plate
4. Updates report with AI results

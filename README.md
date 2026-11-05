# MY VOICE AI Public V2

A multi-user Indonesian voice-cloning/TTS web app. Each account has its own ElevenLabs voice ID. The ElevenLabs API key stays on the server and is never sent to the browser.

## Features
- Email/password registration and login (bcrypt password hashing)
- PostgreSQL users, per-user voice IDs, and daily usage counters
- ElevenLabs Instant Voice Cloning (`POST /v1/voices/add`)
- Text-to-speech (`eleven_multilingual_v2`) with MP3 download
- Default limits: 1 clone/day and 10 generations/day per account
- Audio sample held in memory during upload; no local audio file storage
- Session cookies are HttpOnly, SameSite=Lax, Secure in production
- CSRF token checks, rate limits, upload size/type checks, Helmet security headers

## Requirements
- Node.js 20+
- PostgreSQL (Neon Free can be used for testing)
- ElevenLabs API key and an ElevenLabs plan that permits the desired voice-cloning feature

## Local run
1. Copy `.env.example` to `.env`.
2. Fill `DATABASE_URL`, `ELEVENLABS_API_KEY`, and a random `SESSION_SECRET` (32+ characters).
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

Do not commit `.env`. Do not put secrets in `public/`.

## Deploy to Render + Neon
1. Create a GitHub repository. Upload the contents of this folder (not the outer ZIP folder).
2. In Render, choose **New + → Web Service**, connect the repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`. Health check path: `/health`.
4. Add Environment Variables in Render:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = Neon pooled connection string (keep `sslmode=require`)
   - `ELEVENLABS_API_KEY` = your ElevenLabs API key
   - `SESSION_SECRET` = a unique random string of at least 32 characters
   - `DAILY_GENERATION_LIMIT` = `10`
   - `DAILY_CLONE_LIMIT` = `1`
   - `MAX_AUDIO_MB` = `20`
5. Deploy. Check `/health`, then register a test account and try a short audio sample.

### Neon notes
- Use the pooled connection string (host commonly contains `-pooler`) and keep the password private.
- Select a compute for the Neon branch before copying the connection string.
- Database and app do not need to share a region to function, though same-region placement reduces latency.
- This app creates `app_users`, `usage_daily`, and `user_sessions` tables automatically at startup.

## Important production notes
- The included `render.yaml` selects Render's `free` web-service plan and does not provision a Render database; it expects your existing Neon `DATABASE_URL`. Confirm current Render plan availability and limits in the dashboard before deployment. Free instances may sleep when idle and are intended for testing, not guaranteed always-on production.
- Neon Free has quotas and may suspend/scale to zero when idle; review its current limits and backup policy before public launch.
- The daily limits are basic abuse controls, not a complete billing system. A person can create multiple accounts. Add email verification, CAPTCHA, payment controls, admin moderation, and stronger abuse detection before broad public launch.
- This app does not store uploaded sample audio, but ElevenLabs processes it. Read ElevenLabs terms and privacy policy. Only upload your own voice or a voice for which you have explicit permission.
- Deleting an account or changing a voice is not exposed in this starter. Add an account deletion workflow and provider-side voice deletion before accepting public users at scale.
- Consider setting an application-specific privacy policy, terms of service, contact email, and clear notice that generated audio is AI-generated.
- Review current ElevenLabs API documentation and account permissions. API usage may incur charges under your ElevenLabs plan.

## API routes
- `GET /health`
- `GET /api/csrf`
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `POST /api/voice/clone` (multipart field `audio`, optional `name`)
- `POST /api/voice/generate` (JSON `{ "text": "..." }`)

## Troubleshooting
- `DATABASE_URL is required`: set the Neon connection string in Render Environment.
- `SESSION_SECRET must contain at least 32 characters`: generate a longer random value.
- `No computes`: activate a Neon compute for the branch before connecting.
- ElevenLabs 401/403: check API key, plan access, and voice-cloning permissions.
- ElevenLabs 429: account/API rate limit reached.

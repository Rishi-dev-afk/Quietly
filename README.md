# Quietly

A private, calm journaling app with AI-powered reflection, conversation, and deep self-analysis.

No social features. No streaks. No gamification. Just a place to write — and, over time, a clearer picture of what's moving through you.

---

## What it does

**Write** — A blank page each day. Pick a mood (Heavy → Open), write whatever's there, and save as a draft or close the entry when done. A rotating prompt appears if you're not sure where to start.

**Reflect** — After writing, ask for a reflection. The AI reads your entry and mirrors back what it notices — themes, emotions underneath the words, things you didn't quite say directly. No advice, no questions, no diagnosis. Just a quiet observation. Anonymous users get up to 5 free reflections per hour before being prompted to create an account.

**Talk it out** — A proper back-and-forth conversation with an AI companion. Not a chatbot, not a therapist — a thoughtful presence that listens carefully, asks one good question at a time, and matches your energy. Every conversation is saved and accessible by session so you can pick up where you left off.

**Past entries** — Browse everything you've written. Filter by mood (heavy days, open days) or saved entries. Expand any entry to read the full text and request a reflection on it.

**Patterns** — A visual thread of your last 30 days, a bar chart of what time of day you write (computed from your actual entries), and a word cloud of words that recur across your writing (stopwords removed, minimum 2 occurrences).

**Mental model** *(unlocks after 5 entries)* — An AI-generated brain diagram built from your journal entries and chat conversations combined. It extracts emotional and cognitive patterns — nodes typed as emotions, themes, behavioural patterns, coping mechanisms, relationships, and tensions — and draws them as a weighted, connected map. Hover any node to see what it represents. The last built snapshot is cached so reopening the view is instant; a "refresh available" flag appears after 5 new entries since the last build.

**Psychological profile** *(unlocks after 5 entries)* — A structured self-analysis using the Big Five personality dimensions (Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism) plus 5–8 observational lenses (affect regulation, rumination, self-criticism, interpersonal patterns, stress response, cognitive style, and more). Includes core tensions, genuine strengths, and an overall narrative. Never diagnostic — observational, specific to your writing, and honest about the limits of sparse data. Also cached and refreshable.

**Support** — Crisis resources (988, Samaritans, findahelpline.com) always one click away.

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 (App Router), plain CSS |
| Backend | FastAPI, SQLAlchemy, SQLite |
| Auth | JWT (7-day expiry), pbkdf2_sha256 passwords |
| AI | OpenRouter API (default: `anthropic/claude-haiku-4.5`) |
| Deployment | GitHub Codespaces / any Linux server |

---

## Getting started

### Prerequisites

- Python 3.11+
- Node.js 18+
- An [OpenRouter](https://openrouter.ai) API key

### 1. Clone the repo

```bash
git clone https://github.com/your-username/NeuroTwin.git
cd NeuroTwin
```

### 2. Set up the backend

```bash
cd backend
pip install -r requirements.txt
```

Create a `.env` file in `backend/`:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
SECRET_KEY=any-long-random-string-here
```

Optional settings:

```env
DATABASE_URL=sqlite:///./neurotwin.db
OPENROUTER_DEFAULT_MODEL=anthropic/claude-haiku-4.5
ACCESS_TOKEN_EXPIRE_MINUTES=10080
```

Start the backend:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Set up the frontend

```bash
cd ../frontend
npm install
npm run dev -- -H 0.0.0.0
```

App runs at `http://localhost:3000`.

---

## Running in GitHub Codespaces

1. Open the repo in a Codespace
2. Open two terminals — backend in one, frontend in the other (commands above)
3. Go to the **Ports** tab → find port **3000** → right-click → **Port Visibility → Public**
4. Click the 🌐 globe icon next to port 3000

---

## API reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Get JWT token |
| GET | `/api/auth/me` | ✅ | Current user profile |

### Journal

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/journal/entries` | ✅ | List all entries (newest first) |
| POST | `/api/journal/entries` | ✅ | Create entry |

### AI

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/ai/reflect` | Optional | One-shot reflection on an entry. Anonymous users are rate-limited (5/hour per IP). |
| POST | `/api/ai/chat` | ✅ | Send a chat message. Full conversation history in the request body; response includes `session_id`. |

### Chat history

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/chat/sessions` | ✅ | List all chat sessions (newest first, with preview) |
| GET | `/api/chat/sessions/{session_id}` | ✅ | Full message history for a session |

### Mental model

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ai/mental-model/status` | ✅ | Unlock status, entry count, whether a refresh is available |
| POST | `/api/ai/mental-model` | ✅ | Build/rebuild mental model from entries + chats |
| GET | `/api/ai/mental-model/latest` | ✅ | Return cached snapshot without calling the AI |

### Psychological profile

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ai/psych-profile/status` | ✅ | Unlock status, entry count, whether a refresh is available |
| POST | `/api/ai/psych-profile` | ✅ | Build/rebuild psychological profile from entries + chats |
| GET | `/api/ai/psych-profile/latest` | ✅ | Return cached snapshot without calling the AI |

---

## Feature gates

Both the mental model and psychological profile require **5 journal entries** before they unlock. This is intentional — the analysis is only useful with enough material to work from, and the error message tells the user how many more entries they need.

After the first build, a **"refresh available"** flag appears once 5 new entries have been written since the last build. Older snapshots stay visible in the meantime so the view is never blank.

These thresholds are configured in `main.py`:

```python
ANALYSIS_UNLOCK_ENTRY_COUNT = 5
ANALYSIS_REFRESH_EVERY_N_ENTRIES = 5
```

---

## Project structure

```
NeuroTwin/
├── backend/
│   ├── main.py              # FastAPI app — all routes, models, AI prompts
│   ├── requirements.txt
│   ├── neurotwin.db         # SQLite database (auto-created on first run)
│   └── tests/
│       └── test_api.py
└── frontend/
    ├── app/
    │   ├── page.js          # Entire React UI
    │   ├── layout.js        # Root Next.js layout
    │   └── globals.css      # Full design system
    ├── next.config.js
    ├── tailwind.config.js
    └── package.json
```

---

## Database models

| Table | Description |
|-------|-------------|
| `users` | Accounts — email, hashed password, display name |
| `journal_entries` | Entries with content, mood (1–5), status (draft/closed) |
| `chat_messages` | Individual chat turns, grouped by `session_id` (UUID) |
| `mental_model_snapshots` | Cached mental model builds with nodes/edges JSON |
| `psych_profile_snapshots` | Cached psychological profile builds |

All tables are created automatically on first run via `Base.metadata.create_all()`.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | Yes | — | Your OpenRouter key |
| `SECRET_KEY` | Yes (prod) | `dev-secret-key` | JWT signing secret — change this in production |
| `DATABASE_URL` | No | `sqlite:///./neurotwin.db` | SQLAlchemy database URL |
| `OPENROUTER_DEFAULT_MODEL` | No | `anthropic/claude-haiku-4.5` | Model for all AI features |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No | `10080` (7 days) | JWT token expiry |

---

## A note on what this isn't

Quietly is not a mental health product. The AI features — including the psychological profile — are observational tools for self-reflection, not clinical assessments. They don't diagnose, and they don't replace professional support. If you're in crisis, the Support section in the app has resources.

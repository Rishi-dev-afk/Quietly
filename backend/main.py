import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, create_engine, func
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("quietly")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./neurotwin.db")
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", str(60 * 24 * 7)))

if SECRET_KEY == "dev-secret-key":
    logger.warning(
        "SECRET_KEY is using the insecure default value. Set a long random SECRET_KEY "
        "in your environment before deploying to production."
    )

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_DEFAULT_MODEL = os.getenv("OPENROUTER_DEFAULT_MODEL", "anthropic/claude-haiku-4.5")

# CORS — comma-separated list of exact origins allowed to call this API, plus an optional regex
# for pattern-based origins (e.g. preview deployments). Both default to local dev origins only;
# set CORS_ALLOWED_ORIGINS / CORS_ALLOWED_ORIGIN_REGEX in production to your real frontend domain(s).
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if origin.strip()
]
CORS_ALLOWED_ORIGIN_REGEX = os.getenv("CORS_ALLOWED_ORIGIN_REGEX", r"https://.*\.app\.github\.dev")

REFLECTION_SYSTEM_PROMPT = """You are a calm, observing listener inside a private journaling app called Quietly.
Someone has just shared a journal entry with you. Your role is to help them reflect — not to diagnose, treat, \
coach, or give advice unless they clearly ask for practical suggestions.

How to respond:
- Read what they wrote carefully and reflect back what you notice — themes, shifts in feeling, things they \
might not have said directly — in your own words, gently and without judgment.
- Do not ask any questions. This is a one-way reflection, not the start of a conversation — end your response \
with an observation, not a question.
- Keep your tone warm, plain, and human. No clinical labels, no diagnoses, no therapy-speak, no forced positivity.
- Do not tell them what to do, fix their problem, or rush to reassure them that everything is fine.
- Keep your response brief — a few sentences to a short paragraph is plenty. This is a reflection, not an essay.
- Never claim to be a therapist, doctor, or any kind of medical professional, and don't pretend this replaces one.
- If the entry suggests they may be in crisis or at risk of harming themselves, gently and directly encourage them \
to reach out to a crisis line or a trusted person right now, in addition to anything else you say.
"""

CHAT_SYSTEM_PROMPT = """You are a thoughtful, warm companion inside a private journaling app called Quietly.
You are here to have a real conversation with someone about what's on their mind — their feelings, their day, \
their patterns, anything they want to explore together.

How to engage:
- Listen carefully to what they share and respond with genuine curiosity and warmth.
- Ask follow-up questions naturally — one at a time, only when a question would genuinely help them go deeper \
or feel heard. Never pepper them with multiple questions at once.
- Reflect back what you notice — emotions underneath the words, recurring themes, contradictions, small details \
that seem to carry weight — but do so gently, not as analysis.
- Match their energy: if they're processing something heavy, be still and present; if they're lighter and \
reflective, you can be a little warmer and more exploratory.
- Keep your replies concise and conversational — this is a dialogue, not a lecture. A few sentences is usually \
enough; longer only when they've shared a lot and you're holding it all together for them.
- Do not give unsolicited advice, fix problems, or rush toward solutions unless they clearly ask for that.
- No clinical language, no diagnoses, no therapy-speak. You're a thoughtful friend, not a professional.
- Never claim to be a therapist, doctor, or any kind of medical professional, and never suggest this replaces \
professional support — but you can gently encourage them to seek it if something sounds serious.
- If they seem to be in crisis or at risk of harming themselves, gently and directly encourage them to reach out \
to a crisis line or trusted person right now.
"""

PSYCH_PROFILE_SYSTEM_PROMPT = """You are a careful, non-judgmental psychological analyst reading someone's private journal entries and conversations.
Your task is to produce a structured psychological profile using the Big Five personality dimensions and several clinical-style observational lenses.
This is for personal self-reflection only — NOT a clinical diagnosis. Return ONLY a valid JSON object (no markdown, no explanation) with this structure:

{
  "big_five": {
    "openness":           { "score": 0-100, "label": "e.g. High", "summary": "1-2 sentences grounded in their writing" },
    "conscientiousness":  { "score": 0-100, "label": "e.g. Moderate", "summary": "..." },
    "extraversion":       { "score": 0-100, "label": "e.g. Low", "summary": "..." },
    "agreeableness":      { "score": 0-100, "label": "e.g. High", "summary": "..." },
    "neuroticism":        { "score": 0-100, "label": "e.g. Moderate-High", "summary": "..." }
  },
  "clinical_observations": [
    {
      "domain": "short domain name (e.g. Affect Regulation, Rumination, Self-Criticism, Interpersonal Patterns, Stress Response, Cognitive Style, Self-Concept, Avoidance Tendencies)",
      "finding": "1-2 sentences describing what you observe — specific, grounded in their words, non-diagnosing",
      "signal": "low | moderate | elevated | high"
    }
  ],
  "core_tensions": [
    "A brief phrase naming a central inner conflict visible in the writing (e.g. 'Wanting connection vs. fear of being seen')"
  ],
  "strengths": [
    "A brief phrase naming a genuine psychological strength visible in the writing"
  ],
  "overall_narrative": "3-4 sentences synthesising the psychological picture — honest, warm, specific to this person, not generic. Acknowledge what is unclear given limited data."
}

Guidelines:
- Big Five scores: be calibrated and specific — avoid clustering everything near 50. Use the full range honestly.
- clinical_observations: include 5-8 domains. Only include what is actually visible in the writing; don't fill in blanks with assumptions.
- signal levels: 'low' = minimal evidence, 'moderate' = present but manageable, 'elevated' = notable pattern, 'high' = frequent/intense pattern.
- core_tensions: 2-4 items max. Name real tensions you see, not textbook ones.
- strengths: 2-5 items. Be specific — 'ability to articulate ambivalence' is more useful than 'self-aware'.
- overall_narrative: write this as if to the person directly — honest but not clinical, warm but not sycophantic.
- If data is sparse, say so explicitly in the narrative and reduce confidence on scores.
- NEVER diagnose. NEVER name specific mental health conditions or disorders. Observe, describe, reflect.
"""

MENTAL_MODEL_SYSTEM_PROMPT = """You are an introspective analyst reading someone's private journal entries and conversations.
Your task is to build a JSON representation of their inner mental landscape — a map of the emotional and \
cognitive patterns that emerge across their writing and conversations.

Analyze the provided content and return ONLY a valid JSON object (no markdown, no explanation) with this structure:

{
  "nodes": [
    {
      "id": "unique_id",
      "label": "short label (2-4 words)",
      "type": "emotion | theme | pattern | coping | relationship | tension",
      "weight": 1-10,
      "description": "one sentence describing what this node represents in this person's inner world",
      "evidence": ["journal:142", "msg:55"]
    }
  ],
  "edges": [
    {
      "source": "node_id",
      "target": "node_id",
      "relationship": "fuels | conflicts_with | leads_to | soothes | masks | orbits",
      "strength": 1-5
    }
  ],
  "summary": "2-3 sentences capturing the overall shape of this person's mental landscape right now"
}

Guidelines:
- Extract 6-14 nodes. Each node should be something genuinely present in their writing, not generic.
- evidence: each piece of content above is tagged with an id like "journal:142" or "msg:55" (the text after the # symbol, e.g. "#journal:142" → cite it as "journal:142"). For every node, list the 1-4 ids that most directly informed it. Only cite ids that actually appear in the content provided — never invent one. If a node draws on the overall pattern rather than one specific moment, cite whichever 1-2 entries best illustrate it.
- Use their own vocabulary and imagery where possible — if they say 'the fog', use that, not 'depression'.
- Types: emotion (felt states), theme (recurring subject), pattern (behavioural tendency), coping (what they reach for), relationship (key people/dynamics), tension (unresolved conflicts or contradictions).
- Edges should reflect real relationships you observe between nodes, not assumed ones.
- weight reflects how frequently/intensely something appears (1=subtle trace, 10=central preoccupation).
- Be honest and specific — a useful mental model names the real shapes, not flattering ones.
- If there is very little content, return fewer nodes and be honest about the limited picture.
- The content includes both journal entries and chat conversations — weight patterns that appear across both more heavily.
"""


# ─── Database ──────────────────────────────────────────────────────────────────

# `check_same_thread` is a SQLite-only connect arg — passing it to Postgres (or any other
# driver) raises a TypeError at connection time, so it's only included for sqlite:// URLs.
# This lets DATABASE_URL switch between sqlite:///... (local dev) and postgresql://...
# (production, e.g. Neon/Render Postgres) with no other code changes required.
_engine_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_engine_connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    display_name = Column(String(255), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    content = Column(Text, nullable=False)
    mood = Column(Integer, default=3)
    status = Column(String(50), default="draft")
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    session_id = Column(String(36), index=True, nullable=False)
    role = Column(String(20), nullable=False)  # "user" or "assistant"
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class MentalModelSnapshot(Base):
    __tablename__ = "mental_model_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    nodes_json = Column(Text, nullable=False)
    edges_json = Column(Text, nullable=False)
    summary = Column(Text, nullable=False)
    entry_count_at_build = Column(Integer, default=0)
    model = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class PsychProfileSnapshot(Base):
    __tablename__ = "psych_profile_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    big_five_json = Column(Text, nullable=False)
    clinical_observations_json = Column(Text, nullable=False)
    core_tensions_json = Column(Text, nullable=False)
    strengths_json = Column(Text, nullable=False)
    overall_narrative = Column(Text, nullable=False)
    entry_count_at_build = Column(Integer, default=0)
    model = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


Base.metadata.create_all(bind=engine)

# ─── Auth ──────────────────────────────────────────────────────────────────────

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
security = HTTPBearer()
optional_security = HTTPBearer(auto_error=False)
app = FastAPI(title="Quietly API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_origin_regex=CORS_ALLOWED_ORIGIN_REGEX or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Pydantic Schemas ──────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    display_name: str = Field(min_length=1, max_length=255)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: int
    email: str
    display_name: str


class JournalEntryCreate(BaseModel):
    content: str
    mood: int = 3
    status: str = "draft"


class JournalEntryResponse(BaseModel):
    id: int
    content: str
    mood: int
    status: str
    created_at: datetime


class JournalEntryListResponse(BaseModel):
    entries: list[JournalEntryResponse]


class ReflectionRequest(BaseModel):
    content: str = Field(min_length=1)
    model: str | None = None


class ReflectionResponse(BaseModel):
    reflection: str
    model: str


class ChatMessage_(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage_]
    session_id: str | None = None
    model: str | None = None


class ChatResponse(BaseModel):
    reply: str
    model: str
    session_id: str


class ChatSessionSummary(BaseModel):
    session_id: str
    started_at: datetime
    message_count: int
    preview: str


class ChatSessionListResponse(BaseModel):
    sessions: list[ChatSessionSummary]


class ChatMessageResponse(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime


class ChatSessionMessagesResponse(BaseModel):
    session_id: str
    messages: list[ChatMessageResponse]


class MentalModelRequest(BaseModel):
    model: str | None = None


class MentalModelResponse(BaseModel):
    nodes: list[dict]
    edges: list[dict]
    summary: str
    model: str
    created_at: datetime | None = None
    entry_count_at_build: int | None = None


class MentalModelStatusResponse(BaseModel):
    has_snapshot: bool
    entries_total: int
    entries_required: int
    entries_remaining: int
    unlocked: bool
    update_available: bool
    last_built_at: datetime | None = None
    last_entry_count: int | None = None


# ─── Time-lapse (mental model history) ──────────────────────────────────────────

class MentalModelHistoryItem(BaseModel):
    id: int
    nodes: list[dict]
    edges: list[dict]
    summary: str
    model: str
    created_at: datetime
    entry_count_at_build: int | None = None


class MentalModelHistoryResponse(BaseModel):
    snapshots: list[MentalModelHistoryItem]


# ─── Evidence (node provenance) ─────────────────────────────────────────────────

class EvidenceRequest(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=20)


class EvidenceItem(BaseModel):
    id: str
    type: str  # "journal" | "msg"
    content: str
    created_at: datetime | None = None
    mood: int | None = None


class EvidenceResponse(BaseModel):
    items: list[EvidenceItem]


# ─── Node-scoped chat ────────────────────────────────────────────────────────────

class NodeChatMessage(BaseModel):
    role: str
    content: str


class NodeChatRequest(BaseModel):
    node_label: str = Field(min_length=1, max_length=200)
    node_type: str | None = None
    node_description: str | None = Field(default=None, max_length=1000)
    evidence_ids: list[str] = Field(default_factory=list, max_length=10)
    messages: list[NodeChatMessage]
    session_id: str | None = None
    model: str | None = None


class NodeChatResponse(BaseModel):
    reply: str
    model: str
    session_id: str


class PsychProfileRequest(BaseModel):
    model: str | None = None


class PsychProfileResponse(BaseModel):
    big_five: dict
    clinical_observations: list[dict]
    core_tensions: list[str]
    strengths: list[str]
    overall_narrative: str
    model: str
    created_at: datetime | None = None
    entry_count_at_build: int | None = None


class PsychProfileStatusResponse(BaseModel):
    has_snapshot: bool
    entries_total: int
    entries_required: int
    entries_remaining: int
    unlocked: bool
    update_available: bool
    last_built_at: datetime | None = None
    last_entry_count: int | None = None


# How many journal entries a user needs before the mental model / psych profile features unlock,
# and how many *new* entries since the last build before we flag that an update is worth running.
ANALYSIS_UNLOCK_ENTRY_COUNT = 5
ANALYSIS_REFRESH_EVERY_N_ENTRIES = 5


# ─── Helpers ───────────────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security), db: Session = Depends(get_db)) -> User:
    credentials_exception = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        email: str | None = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError as exc:
        raise credentials_exception from exc

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
    return user


def get_current_user_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
    db: Session = Depends(get_db),
) -> User | None:
    """Like get_current_user, but returns None instead of raising when no/invalid credentials are given.
    Used by routes that should work for both signed-in and anonymous visitors (e.g. the first reflection,
    before someone has created an account)."""
    if credentials is None:
        return None
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        email: str | None = payload.get("sub")
        if email is None:
            return None
    except JWTError:
        return None

    return db.query(User).filter(User.email == email).first()


# Simple in-memory rate limiter, keyed by (bucket, client IP). This is intentionally lightweight —
# it resets on restart and isn't shared across multiple server processes — but it's enough to slow
# down casual abuse without adding new infrastructure (e.g. Redis). For a multi-process production
# deployment, swap this for a shared store (Redis, etc.) keyed the same way.
_rate_limit_hits: dict[str, list[float]] = {}


def enforce_rate_limit(request: Request, bucket: str, limit: int, window_seconds: int, message: str) -> None:
    client_ip = request.client.host if request.client else "unknown"
    key = f"{bucket}:{client_ip}"
    now = datetime.now(timezone.utc).timestamp()
    cutoff = now - window_seconds

    hits = [t for t in _rate_limit_hits.get(key, []) if t > cutoff]
    if len(hits) >= limit:
        raise HTTPException(status_code=429, detail=message)
    hits.append(now)
    _rate_limit_hits[key] = hits


ANON_REFLECT_LIMIT = 5
ANON_REFLECT_WINDOW_SECONDS = 60 * 60  # 1 hour


def enforce_anon_rate_limit(request: Request) -> None:
    enforce_rate_limit(
        request,
        bucket="anon_reflect",
        limit=ANON_REFLECT_LIMIT,
        window_seconds=ANON_REFLECT_WINDOW_SECONDS,
        message="You've used up your free reflections for now. Create a free account to keep going.",
    )


# Login/register are brute-force/credential-stuffing targets, so they get their own (more generous,
# since real users mistype passwords) per-IP limit. Signed-in routes are unaffected.
AUTH_ATTEMPT_LIMIT = 20
AUTH_ATTEMPT_WINDOW_SECONDS = 60 * 10  # 10 minutes


def enforce_auth_rate_limit(request: Request) -> None:
    enforce_rate_limit(
        request,
        bucket="auth",
        limit=AUTH_ATTEMPT_LIMIT,
        window_seconds=AUTH_ATTEMPT_WINDOW_SECONDS,
        message="Too many attempts. Please wait a few minutes and try again.",
    )


async def call_openrouter(messages: list[dict], model: str, timeout: int = 60) -> tuple[str, str]:
    if not OPENROUTER_API_KEY:
        raise HTTPException(status_code=503, detail="AI features aren't configured yet. Set OPENROUTER_API_KEY on the server.")
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                OPENROUTER_BASE_URL,
                headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json"},
                json={"model": model, "messages": messages},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Could not reach OpenRouter. Please try again.") from exc

    if response.status_code == 401:
        raise HTTPException(status_code=502, detail="OpenRouter rejected the server's API key")
    if response.status_code == 402:
        raise HTTPException(status_code=502, detail="The server's OpenRouter account is out of credits")
    if response.status_code >= 400:
        logger.error("OpenRouter error %s: %s", response.status_code, response.text)
        raise HTTPException(status_code=502, detail="OpenRouter could not complete the request")

    data = response.json()
    try:
        message = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="OpenRouter returned an unexpected response") from exc

    if not message or not message.strip():
        raise HTTPException(status_code=502, detail="OpenRouter returned an empty response")

    return message.strip(), data.get("model", model)


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentUserOptional = Annotated[User | None, Depends(get_current_user_optional)]

# Matches the evidence tags emitted by the mental-model prompt, e.g. "journal:142" or "msg:55".
EVIDENCE_ID_RE = re.compile(r"^(journal|msg):(\d+)$")

# ─── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def read_root():
    return {"message": "Quietly API is running"}


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


# Auth

@app.post("/api/auth/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register_user(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    enforce_auth_rate_limit(request)
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(email=str(payload.email), display_name=payload.display_name, hashed_password=get_password_hash(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info("New user registered: %s", user.email)
    return UserResponse(id=user.id, email=user.email, display_name=user.display_name)


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    enforce_auth_rate_limit(request)
    user = db.query(User).filter(User.email == str(payload.email)).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_access_token({"sub": user.email})
    return TokenResponse(access_token=token)


@app.get("/api/auth/me", response_model=UserResponse)
def get_me(current_user: CurrentUser):
    return UserResponse(id=current_user.id, email=current_user.email, display_name=current_user.display_name)


# Journal

@app.get("/api/journal/entries", response_model=JournalEntryListResponse)
def list_entries(current_user: CurrentUser, db: Session = Depends(get_db)):
    entries = db.query(JournalEntry).filter(JournalEntry.user_id == current_user.id).order_by(JournalEntry.created_at.desc()).all()
    return JournalEntryListResponse(entries=[
        JournalEntryResponse(id=e.id, content=e.content, mood=e.mood, status=e.status, created_at=e.created_at)
        for e in entries
    ])


@app.post("/api/journal/entries", response_model=JournalEntryResponse, status_code=status.HTTP_201_CREATED)
def create_entry(payload: JournalEntryCreate, current_user: CurrentUser, db: Session = Depends(get_db)):
    entry = JournalEntry(user_id=current_user.id, content=payload.content, mood=payload.mood, status=payload.status)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return JournalEntryResponse(id=entry.id, content=entry.content, mood=entry.mood, status=entry.status, created_at=entry.created_at)


@app.delete("/api/journal/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(entry_id: int, current_user: CurrentUser, db: Session = Depends(get_db)):
    entry = (
        db.query(JournalEntry)
        .filter(JournalEntry.id == entry_id, JournalEntry.user_id == current_user.id)
        .first()
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    db.delete(entry)
    db.commit()
    return None


# AI — Reflect

@app.post("/api/ai/reflect", response_model=ReflectionResponse)
async def reflect_on_entry(payload: ReflectionRequest, request: Request, current_user: CurrentUserOptional):
    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="There's nothing written yet to reflect on")

    # Anyone can get a reflection — including before they've created an account — but anonymous
    # visitors are rate-limited per IP to prevent abuse of the server's AI credits. Signed-in users
    # are not subject to this limit.
    if current_user is None:
        enforce_anon_rate_limit(request)

    model = payload.model or OPENROUTER_DEFAULT_MODEL
    messages = [
        {"role": "system", "content": REFLECTION_SYSTEM_PROMPT},
        {"role": "user", "content": payload.content},
    ]
    reply, actual_model = await call_openrouter(messages, model)
    return ReflectionResponse(reflection=reply, model=actual_model)


# AI — Chat (with persistence)

@app.post("/api/ai/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, current_user: CurrentUser, db: Session = Depends(get_db)):
    if not payload.messages:
        raise HTTPException(status_code=400, detail="No messages provided")

    # Use provided session_id or generate a new one
    session_id = payload.session_id or str(uuid.uuid4())

    model = payload.model or OPENROUTER_DEFAULT_MODEL
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
    for msg in payload.messages:
        if msg.role not in ("user", "assistant"):
            raise HTTPException(status_code=400, detail=f"Invalid role: {msg.role}")
        messages.append({"role": msg.role, "content": msg.content})

    # Persist the latest user message (last in the list)
    latest_user_msg = next((m for m in reversed(payload.messages) if m.role == "user"), None)
    if latest_user_msg:
        db_user_msg = ChatMessage(
            user_id=current_user.id,
            session_id=session_id,
            role="user",
            content=latest_user_msg.content,
        )
        db.add(db_user_msg)
        db.commit()

    reply, actual_model = await call_openrouter(messages, model)

    # Persist assistant reply
    db_assistant_msg = ChatMessage(
        user_id=current_user.id,
        session_id=session_id,
        role="assistant",
        content=reply,
    )
    db.add(db_assistant_msg)
    db.commit()

    return ChatResponse(reply=reply, model=actual_model, session_id=session_id)


# Chat history — list sessions

@app.get("/api/chat/sessions", response_model=ChatSessionListResponse)
def list_chat_sessions(current_user: CurrentUser, db: Session = Depends(get_db)):
    # Get all messages for user, grouped by session
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == current_user.id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )

    sessions: dict[str, dict] = {}
    for msg in messages:
        if msg.session_id not in sessions:
            sessions[msg.session_id] = {
                "session_id": msg.session_id,
                "started_at": msg.created_at,
                "message_count": 0,
                "preview": "",
            }
        sessions[msg.session_id]["message_count"] += 1
        # Preview = first user message
        if not sessions[msg.session_id]["preview"] and msg.role == "user":
            sessions[msg.session_id]["preview"] = msg.content[:120] + ("…" if len(msg.content) > 120 else "")

    # Sort sessions by most recent first
    sorted_sessions = sorted(sessions.values(), key=lambda s: s["started_at"], reverse=True)
    return ChatSessionListResponse(sessions=[ChatSessionSummary(**s) for s in sorted_sessions])


# Chat history — get messages for a session

@app.get("/api/chat/sessions/{session_id}", response_model=ChatSessionMessagesResponse)
def get_chat_session(session_id: str, current_user: CurrentUser, db: Session = Depends(get_db)):
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == current_user.id, ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    if not messages:
        raise HTTPException(status_code=404, detail="Session not found")

    return ChatSessionMessagesResponse(
        session_id=session_id,
        messages=[
            ChatMessageResponse(id=m.id, role=m.role, content=m.content, created_at=m.created_at)
            for m in messages
        ],
    )


@app.delete("/api/chat/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chat_session(session_id: str, current_user: CurrentUser, db: Session = Depends(get_db)):
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == current_user.id, ChatMessage.session_id == session_id)
        .all()
    )
    if not messages:
        raise HTTPException(status_code=404, detail="Session not found")
    for message in messages:
        db.delete(message)
    db.commit()
    return None


# AI — Mental Model (journals + chats)

def build_content_digest(current_user: User, db: Session) -> tuple[str, int]:
    """Shared helper for the mental-model and psych-profile routes: pulls recent journal entries and
    chat messages for a user and renders them into a single readable digest string for the AI prompt.
    Returns (digest, total_entry_count) — total_entry_count is the user's full entry count (not just
    the 30 most recent included in the digest), used for unlock/refresh gating."""
    entries = (
        db.query(JournalEntry)
        .filter(JournalEntry.user_id == current_user.id)
        .order_by(JournalEntry.created_at.desc())
        .limit(30)
        .all()
    )
    total_entry_count = db.query(JournalEntry).filter(JournalEntry.user_id == current_user.id).count()

    chat_messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == current_user.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(100)
        .all()
    )

    if not entries and not chat_messages:
        raise HTTPException(status_code=400, detail="No journal entries or conversations yet — write a few entries or have a conversation first.")

    content_parts = []

    for entry in entries:
        date_str = entry.created_at.strftime("%b %d")
        mood_label = {1: "Heavy", 2: "Low", 3: "Steady", 4: "Lighter", 5: "Open"}.get(entry.mood, "Steady")
        truncated = entry.content[:600] + ("…" if len(entry.content) > 600 else "")
        # The "journal:<id>" tag is a stable evidence reference the AI can cite on a node — it's
        # parsed back out by the evidence endpoint, scoped to this same user, when someone clicks
        # a node to see what it was actually built from.
        content_parts.append(f"[Journal #journal:{entry.id}, {date_str}, mood: {mood_label}]\n{truncated}")

    if chat_messages:
        sessions: dict[str, list] = {}
        for msg in reversed(chat_messages):  # oldest first
            if msg.session_id not in sessions:
                sessions[msg.session_id] = []
            sessions[msg.session_id].append(msg)

        for session_id, msgs in list(sessions.items())[:10]:  # cap at 10 sessions
            date_str = msgs[0].created_at.strftime("%b %d")
            lines = [f"[Chat, {date_str}]"]
            for msg in msgs:
                prefix = "You" if msg.role == "user" else "Quietly"
                truncated = msg.content[:300] + ("…" if len(msg.content) > 300 else "")
                # Same idea as journal entries — "msg:<id>" lets a node cite the exact chat line
                # that informed it.
                lines.append(f"{prefix} (#msg:{msg.id}): {truncated}")
            content_parts.append("\n".join(lines))

    digest = "\n\n---\n\n".join(content_parts)
    return digest, total_entry_count


# Minimum number of messages in a chat session for it to count as a "meaningful" interaction
# toward the unlock gate (2 user + 2 assistant = one real exchange plus a follow-up).
QUALIFYING_CHAT_MIN_MESSAGES = 4


def get_content_count(current_user: User, db: Session) -> int:
    """Return the total number of meaningful content interactions for the current user.

    Counts:
    - Every journal entry (each is self-contained signal).
    - Every chat session that has at least QUALIFYING_CHAT_MIN_MESSAGES messages
      (filters out sessions that are just a greeting with no real depth).
    """
    journal_count = (
        db.query(JournalEntry)
        .filter(JournalEntry.user_id == current_user.id)
        .count()
    )

    # Count distinct session_ids that have enough messages to be meaningful.
    qualifying_sessions = (
        db.query(ChatMessage.session_id)
        .filter(ChatMessage.user_id == current_user.id)
        .group_by(ChatMessage.session_id)
        .having(func.count(ChatMessage.id) >= QUALIFYING_CHAT_MIN_MESSAGES)
        .count()
    )

    return journal_count + qualifying_sessions


def require_analysis_unlocked(total_content_count: int) -> None:
    if total_content_count < ANALYSIS_UNLOCK_ENTRY_COUNT:
        remaining = ANALYSIS_UNLOCK_ENTRY_COUNT - total_content_count
        raise HTTPException(
            status_code=403,
            detail=f"You need {remaining} more journal {'entry' if remaining == 1 else 'entries'} or "
                   f"{'conversation' if remaining == 1 else 'conversations'} to unlock this feature "
                   f"({ANALYSIS_UNLOCK_ENTRY_COUNT} total needed) — the more you've shared, the more accurate this is.",
        )


# AI — Mental Model (journals + chats)

@app.get("/api/ai/mental-model/status", response_model=MentalModelStatusResponse)
def mental_model_status(current_user: CurrentUser, db: Session = Depends(get_db)):
    total_content_count = get_content_count(current_user, db)
    latest = (
        db.query(MentalModelSnapshot)
        .filter(MentalModelSnapshot.user_id == current_user.id)
        .order_by(MentalModelSnapshot.created_at.desc())
        .first()
    )
    unlocked = total_content_count >= ANALYSIS_UNLOCK_ENTRY_COUNT
    update_available = False
    if latest is not None:
        new_content_since = total_content_count - (latest.entry_count_at_build or 0)
        update_available = new_content_since >= ANALYSIS_REFRESH_EVERY_N_ENTRIES
    return MentalModelStatusResponse(
        has_snapshot=latest is not None,
        entries_total=total_content_count,
        entries_required=ANALYSIS_UNLOCK_ENTRY_COUNT,
        entries_remaining=max(0, ANALYSIS_UNLOCK_ENTRY_COUNT - total_content_count),
        unlocked=unlocked,
        update_available=update_available,
        last_built_at=latest.created_at if latest else None,
        last_entry_count=latest.entry_count_at_build if latest else None,
    )


@app.post("/api/ai/mental-model", response_model=MentalModelResponse)
async def build_mental_model(payload: MentalModelRequest, current_user: CurrentUser, db: Session = Depends(get_db)):
    require_analysis_unlocked(get_content_count(current_user, db))
    digest, total_entry_count = build_content_digest(current_user, db)

    user_message = f"Here is my recent journal content and conversations:\n\n{digest}"

    model = payload.model or OPENROUTER_DEFAULT_MODEL
    messages = [
        {"role": "system", "content": MENTAL_MODEL_SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    reply, actual_model = await call_openrouter(messages, model, timeout=90)

    try:
        clean = re.sub(r"```(?:json)?|```", "", reply).strip()
        data = json.loads(clean)
        nodes = data.get("nodes", [])
        edges = data.get("edges", [])
        summary = data.get("summary", "")
        if not nodes:
            raise ValueError("No nodes returned")
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Could not parse mental model from AI response") from exc

    snapshot = MentalModelSnapshot(
        user_id=current_user.id,
        nodes_json=json.dumps(nodes),
        edges_json=json.dumps(edges),
        summary=summary,
        entry_count_at_build=total_entry_count,
        model=actual_model,
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)

    return MentalModelResponse(
        nodes=nodes,
        edges=edges,
        summary=summary,
        model=actual_model,
        created_at=snapshot.created_at,
        entry_count_at_build=snapshot.entry_count_at_build,
    )


@app.get("/api/ai/mental-model/latest", response_model=MentalModelResponse)
def get_latest_mental_model(current_user: CurrentUser, db: Session = Depends(get_db)):
    """Returns the most recently built snapshot without calling the AI again — used so reopening the
    Mental Model tab shows your last result instantly instead of forcing a rebuild."""
    latest = (
        db.query(MentalModelSnapshot)
        .filter(MentalModelSnapshot.user_id == current_user.id)
        .order_by(MentalModelSnapshot.created_at.desc())
        .first()
    )
    if latest is None:
        raise HTTPException(status_code=404, detail="No mental model has been built yet")
    return MentalModelResponse(
        nodes=json.loads(latest.nodes_json),
        edges=json.loads(latest.edges_json),
        summary=latest.summary,
        model=latest.model or OPENROUTER_DEFAULT_MODEL,
        created_at=latest.created_at,
        entry_count_at_build=latest.entry_count_at_build,
    )


@app.get("/api/ai/mental-model/history", response_model=MentalModelHistoryResponse)
def get_mental_model_history(current_user: CurrentUser, db: Session = Depends(get_db)):
    """Returns every mental model snapshot ever built for this user, oldest first. Powers the
    time-lapse view — scrubbing through past snapshots to watch the graph evolve — rather than
    only ever seeing the latest build."""
    snapshots = (
        db.query(MentalModelSnapshot)
        .filter(MentalModelSnapshot.user_id == current_user.id)
        .order_by(MentalModelSnapshot.created_at.asc())
        .all()
    )
    return MentalModelHistoryResponse(
        snapshots=[
            MentalModelHistoryItem(
                id=s.id,
                nodes=json.loads(s.nodes_json),
                edges=json.loads(s.edges_json),
                summary=s.summary,
                model=s.model or OPENROUTER_DEFAULT_MODEL,
                created_at=s.created_at,
                entry_count_at_build=s.entry_count_at_build,
            )
            for s in snapshots
        ]
    )


# AI — Psychological Profile

@app.get("/api/ai/psych-profile/status", response_model=PsychProfileStatusResponse)
def psych_profile_status(current_user: CurrentUser, db: Session = Depends(get_db)):
    total_content_count = get_content_count(current_user, db)
    latest = (
        db.query(PsychProfileSnapshot)
        .filter(PsychProfileSnapshot.user_id == current_user.id)
        .order_by(PsychProfileSnapshot.created_at.desc())
        .first()
    )
    unlocked = total_content_count >= ANALYSIS_UNLOCK_ENTRY_COUNT
    update_available = False
    if latest is not None:
        new_content_since = total_content_count - (latest.entry_count_at_build or 0)
        update_available = new_content_since >= ANALYSIS_REFRESH_EVERY_N_ENTRIES
    return PsychProfileStatusResponse(
        has_snapshot=latest is not None,
        entries_total=total_content_count,
        entries_required=ANALYSIS_UNLOCK_ENTRY_COUNT,
        entries_remaining=max(0, ANALYSIS_UNLOCK_ENTRY_COUNT - total_content_count),
        unlocked=unlocked,
        update_available=update_available,
        last_built_at=latest.created_at if latest else None,
        last_entry_count=latest.entry_count_at_build if latest else None,
    )


@app.post("/api/ai/psych-profile", response_model=PsychProfileResponse)
async def build_psych_profile(payload: PsychProfileRequest, current_user: CurrentUser, db: Session = Depends(get_db)):
    require_analysis_unlocked(get_content_count(current_user, db))
    digest, total_entry_count = build_content_digest(current_user, db)

    user_message = f"Here is my recent journal content and conversations:\n\n{digest}"

    model = payload.model or OPENROUTER_DEFAULT_MODEL
    messages = [
        {"role": "system", "content": PSYCH_PROFILE_SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    reply, actual_model = await call_openrouter(messages, model, timeout=90)

    try:
        clean = re.sub(r"```(?:json)?|```", "", reply).strip()
        data = json.loads(clean)
        big_five = data.get("big_five", {})
        clinical_observations = data.get("clinical_observations", [])
        core_tensions = data.get("core_tensions", [])
        strengths = data.get("strengths", [])
        overall_narrative = data.get("overall_narrative", "")
        if not big_five:
            raise ValueError("No Big Five data returned")
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Could not parse psychological profile from AI response") from exc

    snapshot = PsychProfileSnapshot(
        user_id=current_user.id,
        big_five_json=json.dumps(big_five),
        clinical_observations_json=json.dumps(clinical_observations),
        core_tensions_json=json.dumps(core_tensions),
        strengths_json=json.dumps(strengths),
        overall_narrative=overall_narrative,
        entry_count_at_build=total_entry_count,
        model=actual_model,
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)

    return PsychProfileResponse(
        big_five=big_five,
        clinical_observations=clinical_observations,
        core_tensions=core_tensions,
        strengths=strengths,
        overall_narrative=overall_narrative,
        model=actual_model,
        created_at=snapshot.created_at,
        entry_count_at_build=snapshot.entry_count_at_build,
    )


@app.get("/api/ai/psych-profile/latest", response_model=PsychProfileResponse)
def get_latest_psych_profile(current_user: CurrentUser, db: Session = Depends(get_db)):
    """Returns the most recently built snapshot without calling the AI again."""
    latest = (
        db.query(PsychProfileSnapshot)
        .filter(PsychProfileSnapshot.user_id == current_user.id)
        .order_by(PsychProfileSnapshot.created_at.desc())
        .first()
    )
    if latest is None:
        raise HTTPException(status_code=404, detail="No psychological profile has been built yet")
    return PsychProfileResponse(
        big_five=json.loads(latest.big_five_json),
        clinical_observations=json.loads(latest.clinical_observations_json),
        core_tensions=json.loads(latest.core_tensions_json),
        strengths=json.loads(latest.strengths_json),
        overall_narrative=latest.overall_narrative,
        model=latest.model or OPENROUTER_DEFAULT_MODEL,
        created_at=latest.created_at,
        entry_count_at_build=latest.entry_count_at_build,
    )


# AI — Evidence (node provenance)

@app.post("/api/ai/evidence", response_model=EvidenceResponse)
def get_evidence(payload: EvidenceRequest, current_user: CurrentUser, db: Session = Depends(get_db)):
    """Resolves the evidence tags a mental-model node cites (e.g. 'journal:142', 'msg:55') back to
    the actual journal entry or chat message text. Strictly scoped to the current user — an id that
    doesn't parse, or that belongs to someone else's content, is silently skipped rather than erroring,
    since a node's evidence list is best-effort AI output, not a guaranteed-valid reference."""
    items: list[EvidenceItem] = []
    for raw_id in payload.ids[:20]:
        match = EVIDENCE_ID_RE.match(raw_id.strip())
        if not match:
            continue
        kind, numeric_id = match.group(1), int(match.group(2))
        if kind == "journal":
            entry = (
                db.query(JournalEntry)
                .filter(JournalEntry.id == numeric_id, JournalEntry.user_id == current_user.id)
                .first()
            )
            if entry:
                items.append(
                    EvidenceItem(id=raw_id, type="journal", content=entry.content, created_at=entry.created_at, mood=entry.mood)
                )
        else:
            message = (
                db.query(ChatMessage)
                .filter(ChatMessage.id == numeric_id, ChatMessage.user_id == current_user.id)
                .first()
            )
            if message:
                items.append(EvidenceItem(id=raw_id, type="msg", content=message.content, created_at=message.created_at))
    return EvidenceResponse(items=items)


# AI — Node-scoped chat

@app.post("/api/ai/mental-model/node-chat", response_model=NodeChatResponse)
async def node_chat(payload: NodeChatRequest, current_user: CurrentUser, db: Session = Depends(get_db)):
    """A chat scoped to a single mental-model node — e.g. clicking the tension node 'wanting
    connection vs. fear of being seen' and talking it through directly, instead of starting a
    conversation from a blank page. Grounded with the actual journal/chat excerpts that produced
    the node, when evidence ids are provided, so the AI isn't reasoning from the label alone.
    Persists into the same chat_messages/session_id model as regular chat, so these conversations
    show up in chat history like any other."""
    if not payload.messages:
        raise HTTPException(status_code=400, detail="No messages provided")

    evidence_text = ""
    if payload.evidence_ids:
        evidence_items = get_evidence(EvidenceRequest(ids=payload.evidence_ids), current_user, db).items
        if evidence_items:
            evidence_lines = [f"- {item.content[:400]}" for item in evidence_items]
            evidence_text = "\n\nHere is what they actually wrote that this pattern is drawn from:\n" + "\n".join(evidence_lines)

    node_context = (
        f"\n\nFor this conversation, you are specifically helping the person go deeper on one pattern "
        f"from their mental model, titled \"{payload.node_label}\""
        + (f" ({payload.node_type})" if payload.node_type else "")
        + (f" — {payload.node_description}" if payload.node_description else "")
        + evidence_text
        + "\n\nStay focused on this specific pattern unless they clearly want to talk about something else."
    )

    session_id = payload.session_id or str(uuid.uuid4())
    model = payload.model or OPENROUTER_DEFAULT_MODEL
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT + node_context}]
    for msg in payload.messages:
        if msg.role not in ("user", "assistant"):
            raise HTTPException(status_code=400, detail=f"Invalid role: {msg.role}")
        messages.append({"role": msg.role, "content": msg.content})

    latest_user_msg = next((m for m in reversed(payload.messages) if m.role == "user"), None)
    if latest_user_msg:
        db.add(ChatMessage(user_id=current_user.id, session_id=session_id, role="user", content=latest_user_msg.content))
        db.commit()

    reply, actual_model = await call_openrouter(messages, model)

    db.add(ChatMessage(user_id=current_user.id, session_id=session_id, role="assistant", content=reply))
    db.commit()

    return NodeChatResponse(reply=reply, model=actual_model, session_id=session_id)

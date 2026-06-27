import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./neurotwin.db")
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", str(60 * 24 * 7)))

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_DEFAULT_MODEL = os.getenv("OPENROUTER_DEFAULT_MODEL", "anthropic/claude-haiku-4.5")

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
      "description": "one sentence describing what this node represents in this person's inner world"
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
- Use their own vocabulary and imagery where possible — if they say 'the fog', use that, not 'depression'.
- Types: emotion (felt states), theme (recurring subject), pattern (behavioural tendency), coping (what they reach for), relationship (key people/dynamics), tension (unresolved conflicts or contradictions).
- Edges should reflect real relationships you observe between nodes, not assumed ones.
- weight reflects how frequently/intensely something appears (1=subtle trace, 10=central preoccupation).
- Be honest and specific — a useful mental model names the real shapes, not flattering ones.
- If there is very little content, return fewer nodes and be honest about the limited picture.
- The content includes both journal entries and chat conversations — weight patterns that appear across both more heavily.
"""


# ─── Database ──────────────────────────────────────────────────────────────────

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
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


Base.metadata.create_all(bind=engine)

# ─── Auth ──────────────────────────────────────────────────────────────────────

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
security = HTTPBearer()
app = FastAPI(title="NeuroTwin API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "https://bookish-halibut-x59jw447wvjwhpqvq-3000.app.github.dev/"],
    allow_origin_regex=r"https://.*\.app\.github\.dev",
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
        print(f"OpenRouter error {response.status_code}: {response.text}")
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

# ─── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def read_root():
    return {"message": "NeuroTwin API is running"}


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


# Auth

@app.post("/api/auth/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register_user(payload: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(email=str(payload.email), display_name=payload.display_name, hashed_password=get_password_hash(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserResponse(id=user.id, email=user.email, display_name=user.display_name)


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
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


# AI — Reflect

@app.post("/api/ai/reflect", response_model=ReflectionResponse)
async def reflect_on_entry(payload: ReflectionRequest, current_user: CurrentUser):
    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="There's nothing written yet to reflect on")

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


# AI — Mental Model (journals + chats)

@app.post("/api/ai/mental-model", response_model=MentalModelResponse)
async def build_mental_model(payload: MentalModelRequest, current_user: CurrentUser, db: Session = Depends(get_db)):
    entries = (
        db.query(JournalEntry)
        .filter(JournalEntry.user_id == current_user.id)
        .order_by(JournalEntry.created_at.desc())
        .limit(30)
        .all()
    )

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

    # Journal entries
    for entry in entries:
        date_str = entry.created_at.strftime("%b %d")
        mood_label = {1: "Heavy", 2: "Low", 3: "Steady", 4: "Lighter", 5: "Open"}.get(entry.mood, "Steady")
        truncated = entry.content[:600] + ("…" if len(entry.content) > 600 else "")
        content_parts.append(f"[Journal, {date_str}, mood: {mood_label}]\n{truncated}")

    # Chat messages — group by session and build readable transcript
    if chat_messages:
        # Group by session
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
                lines.append(f"{prefix}: {truncated}")
            content_parts.append("\n".join(lines))

    digest = "\n\n---\n\n".join(content_parts)
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

    return MentalModelResponse(nodes=nodes, edges=edges, summary=summary, model=actual_model)
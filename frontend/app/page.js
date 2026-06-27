'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

const MOOD_COLORS = { 1: '#5B6B73', 2: '#7E8A8F', 3: '#A8927E', 4: '#B98B6C', 5: '#A8765E' };
const MOOD_LABELS = { 1: 'Heavy', 2: 'Low', 3: 'Steady', 4: 'Lighter', 5: 'Open' };
const PROMPTS = [
  'No pressure to make this make sense. Just say where you are right now.',
  'What took more energy than it should have today?',
  'Write down one thing you did not say out loud today.',
  'What would you tell a friend who described your day back to you?',
  "What's the smallest thing that helped, even a little?",
  'If today had a weather forecast, what would it be?',
];

const STOPWORDS = new Set([
  'i','me','my','myself','we','our','ours','ourselves','you','your','yours','yourself',
  'he','him','his','himself','she','her','hers','herself','it','its','itself','they',
  'them','their','theirs','themselves','what','which','who','whom','this','that','these',
  'those','am','is','are','was','were','be','been','being','have','has','had','having',
  'do','does','did','doing','a','an','the','and','but','if','or','because','as','until',
  'while','of','at','by','for','with','about','against','between','into','through',
  'during','before','after','above','below','to','from','up','down','in','out','on',
  'off','over','under','again','further','then','once','here','there','when','where',
  'why','how','all','both','each','few','more','most','other','some','such','no','nor',
  'not','only','own','same','so','than','too','very','s','t','can','will','just','don',
  'should','now','d','ll','m','o','re','ve','y','ain','aren','couldn','didn','doesn',
  'hadn','hasn','haven','isn','ma','mightn','mustn','needn','shan','shouldn','wasn',
  'weren','won','wouldn','i\'m','i\'ve','i\'ll','i\'d','it\'s','didn\'t','don\'t',
  'wasn\'t','weren\'t','haven\'t','hadn\'t','couldn\'t','wouldn\'t','shouldn\'t',
  'really','just','also','even','like','get','got','getting','going','went','think',
  'thought','know','knew','feel','felt','feeling','day','today','time','back',
  'still','want','wanted','need','needed','something','anything','everything','nothing',
  'one','two','three','much','many','way','make','made','take','took','come',
  'came','see','saw','go','say','said','look','looked','right','left','new','old',
  'good','bad','little','big','great','last','long','never','always','every','things',
  'thing','bit','lot','actually','maybe','pretty','quite','very','really','kind',
]);

function generateSessionId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function computeWordCloud(entries) {
  const freq = {};
  for (const entry of entries) {
    const words = entry.snippet
      .toLowerCase()
      .replace(/[^a-z\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !STOPWORDS.has(w.replace(/'/g, '')));
    for (const word of words) {
      freq[word] = (freq[word] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat('en-US', { ...options }).format(date);
}

function mapEntryToViewModel(entry) {
  const raw = entry.created_at;
  // Ensure UTC parsing: append Z if no timezone info present
  const normalized = /[Zz]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw + 'Z';
  const date = new Date(normalized);
  return {
    id: entry.id,
    date,
    mood: entry.mood,
    snippet: entry.content,
    words: entry.content.trim().split(/\s+/).filter(Boolean).length,
    hour: date.getHours(),
    saved: entry.status === 'closed',
  };
}

function mapChatSession(session) {
  const raw = session.started_at;
  const normalized = /[Zz]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw + 'Z';
  return {
    ...session,
    started_at: new Date(normalized),
  };
}

function mapChatMessage(msg) {
  const raw = msg.created_at;
  const normalized = /[Zz]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw + 'Z';
  return {
    ...msg,
    created_at: new Date(normalized),
  };
}

// ─── SVG Thread ────────────────────────────────────────────────────────────────

function ThreadSVG({ entries, height = 100, amp = 26, bg = '#FFFFFF' }) {
  const width = 900;
  const padX = 24;
  const baseline = height * 0.58;
  const step = entries.length > 1 ? (width - padX * 2) / (entries.length - 1) : 0;

  const points = entries.map((entry, index) => ({
    x: padX + step * index,
    y: baseline - (entry.mood - 3) * amp * 0.5,
    entry,
  }));

  if (!points.length) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" role="img" aria-label="Mood thread over time">
        <line x1={padX} y1={baseline} x2={width - padX} y2={baseline} stroke="#D8D2C4" strokeWidth="1" strokeDasharray="2 4" />
      </svg>
    );
  }

  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} `;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index];
    const p1 = points[index + 1];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    path += `Q ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)} `;
  }
  path += `T ${points[points.length - 1].x.toFixed(1)} ${points[points.length - 1].y.toFixed(1)}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" role="img" aria-label="Mood thread over time">
      <line x1={padX} y1={baseline} x2={width - padX} y2={baseline} stroke="#D8D2C4" strokeWidth="1" strokeDasharray="2 4" />
      <path d={path} fill="none" stroke="#C9A893" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
      {points.map((point, index) => {
        const isToday = index === points.length - 1;
        const color = MOOD_COLORS[point.entry.mood];
        return (
          <g key={`${point.entry.id}-${index}`} tabIndex="0">
            <title>{`${formatDate(point.entry.date, { month: 'short', day: 'numeric' })} — ${MOOD_LABELS[point.entry.mood]}`}</title>
            <circle cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} r={isToday ? 5.5 : 4} fill={color} stroke={bg} strokeWidth="2" />
            {isToday ? <circle cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} r="9" fill="none" stroke={color} strokeWidth="1" opacity="0.4" /> : null}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Reflection Card ────────────────────────────────────────────────────────────

function ReflectionCard({ state }) {
  if (!state) return null;
  const isError = state.status === 'error';
  const isLoading = state.status === 'loading';

  return (
    <div className={`reflect-card ${isError ? 'is-error' : ''}`} role="status" aria-live="polite">
      <svg className="reflect-card-icon" viewBox="0 0 20 20" fill="none">
        <path d="M10 2.5l1.4 4.1 4.1 1.4-4.1 1.4L10 13.5l-1.4-4.1-4.1-1.4 4.1-1.4L10 2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M16 13.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      </svg>
      <div className="reflect-card-body">
        <span className="reflect-card-label">{isError ? 'Could not reflect' : 'A reflection'}</span>
        <p className="reflect-card-text">
          {isLoading ? 'Reading what you wrote…' : state.text}
        </p>
      </div>
    </div>
  );
}

// ─── Mental Model Brain Diagram ─────────────────────────────────────────────────

const NODE_TYPE_COLORS = {
  emotion:      { fill: '#C9A893', stroke: '#A8765E', text: '#2B2A33' },
  theme:        { fill: '#8A9298', stroke: '#5B6B73', text: '#FFFFFF' },
  pattern:      { fill: '#EFEBE2', stroke: '#C7BFAC', text: '#2B2A33' },
  coping:       { fill: '#B8D4C8', stroke: '#7AA898', text: '#2B2A33' },
  relationship: { fill: '#C4B8D4', stroke: '#8A7AA8', text: '#2B2A33' },
  tension:      { fill: '#D4B8B8', stroke: '#A87A7A', text: '#2B2A33' },
};
const EDGE_COLORS = {
  fuels:         '#A8765E',
  conflicts_with:'#A87A7A',
  leads_to:      '#7AA898',
  soothes:       '#B8D4C8',
  masks:         '#8A7AA8',
  orbits:        '#C7BFAC',
};

function BrainDiagram({ nodes, edges }) {
  const svgRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [positions, setPositions] = useState({});

  useEffect(() => {
    if (!nodes.length) return;
    const cx = 460, cy = 280;
    const sorted = [...nodes].sort((a, b) => b.weight - a.weight);
    const pos = {};

    pos[sorted[0].id] = { x: cx, y: cy };

    const ring1 = sorted.slice(1, 5);
    const ring2 = sorted.slice(5);

    ring1.forEach((node, i) => {
      const angle = (i / ring1.length) * 2 * Math.PI - Math.PI / 2;
      const r = 140 + Math.random() * 30;
      pos[node.id] = {
        x: cx + r * Math.cos(angle) + (Math.random() - 0.5) * 20,
        y: cy + r * Math.sin(angle) + (Math.random() - 0.5) * 20,
      };
    });

    ring2.forEach((node, i) => {
      const angle = (i / Math.max(ring2.length, 1)) * 2 * Math.PI - Math.PI / 4;
      const r = 230 + Math.random() * 40;
      pos[node.id] = {
        x: cx + r * Math.cos(angle) + (Math.random() - 0.5) * 30,
        y: cy + r * Math.sin(angle) + (Math.random() - 0.5) * 30,
      };
    });

    setPositions(pos);
  }, [nodes]);

  if (!nodes.length || !Object.keys(positions).length) return null;

  const nodeRadius = (weight) => 18 + weight * 3.5;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <svg
        ref={svgRef}
        viewBox="0 0 920 560"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: '100%', display: 'block', overflow: 'visible' }}
        aria-label="Mental model brain diagram"
      >
        <ellipse cx="460" cy="280" rx="380" ry="240" fill="#F6F4F0" stroke="#D8D2C4" strokeWidth="1" strokeDasharray="3 5" opacity="0.6" />
        <ellipse cx="370" cy="200" rx="160" ry="120" fill="none" stroke="#EFEBE2" strokeWidth="1" opacity="0.5" />
        <ellipse cx="560" cy="350" rx="140" ry="110" fill="none" stroke="#EFEBE2" strokeWidth="1" opacity="0.5" />

        {edges.map((edge, i) => {
          const s = positions[edge.source];
          const t = positions[edge.target];
          if (!s || !t) return null;
          const color = EDGE_COLORS[edge.relationship] || '#D8D2C4';
          const strokeW = 0.8 + edge.strength * 0.4;
          const mx = (s.x + t.x) / 2 + (t.y - s.y) * 0.15;
          const my = (s.y + t.y) / 2 - (t.x - s.x) * 0.15;
          return (
            <g key={i}>
              <path
                d={`M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`}
                fill="none"
                stroke={color}
                strokeWidth={strokeW}
                strokeLinecap="round"
                opacity="0.55"
              />
            </g>
          );
        })}

        {nodes.map((node) => {
          const pos = positions[node.id];
          if (!pos) return null;
          const colors = NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.theme;
          const r = nodeRadius(node.weight);
          const isHovered = tooltip?.id === node.id;

          return (
            <g
              key={node.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setTooltip({ id: node.id, x: pos.x, y: pos.y, node })}
              onMouseLeave={() => setTooltip(null)}
            >
              {isHovered && <circle r={r + 8} fill={colors.fill} opacity="0.2" />}
              <circle r={r} fill={colors.fill} stroke={colors.stroke} strokeWidth="1.5" />
              <foreignObject x={-r} y={-r} width={r * 2} height={r * 2} style={{ overflow: 'visible' }}>
                <div
                  xmlns="http://www.w3.org/1999/xhtml"
                  style={{
                    width: r * 2,
                    height: r * 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    padding: '4px',
                    fontSize: Math.max(9, Math.min(12, r * 0.38)) + 'px',
                    fontFamily: 'Inter, sans-serif',
                    fontWeight: 600,
                    color: colors.text,
                    lineHeight: 1.2,
                    userSelect: 'none',
                    pointerEvents: 'none',
                  }}
                >
                  {node.label}
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>

      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: `${(tooltip.x / 920) * 100}%`,
            top: `${(tooltip.y / 560) * 100}%`,
            transform: 'translate(-50%, -120%)',
            background: '#2B2A33',
            color: '#F6F4F0',
            borderRadius: 10,
            padding: '10px 14px',
            maxWidth: 220,
            fontSize: 12.5,
            lineHeight: 1.5,
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 13 }}>{tooltip.node.label}</div>
          <div style={{ opacity: 0.7, fontSize: 11, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{tooltip.node.type} · weight {tooltip.node.weight}/10</div>
          <div>{tooltip.node.description}</div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 20, paddingTop: 16, borderTop: '1px solid #EFEBE2' }}>
        {Object.entries(NODE_TYPE_COLORS).map(([type, colors]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#5B6B73' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.fill, border: `1.5px solid ${colors.stroke}` }} />
            <span style={{ textTransform: 'capitalize' }}>{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [activeView, setActiveView] = useState('write');
  const [activeFilter, setActiveFilter] = useState('all');
  const [mood, setMood] = useState(3);
  const [promptIndex, setPromptIndex] = useState(0);
  const [editorValue, setEditorValue] = useState('');
  const [actionLabel, setActionLabel] = useState('');
  const [todayLabel, setTodayLabel] = useState('Today');
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [entries, setEntries] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [expandedEntryId, setExpandedEntryId] = useState(null);
  const [reflections, setReflections] = useState({});

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [chatSessions, setChatSessions] = useState([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [chatView, setChatView] = useState('current'); // 'current' | 'history'
  const [loadingSessionId, setLoadingSessionId] = useState(null);
  const chatBottomRef = useRef(null);

  // Mental model state
  const [mentalModel, setMentalModel] = useState(null);
  const [isMentalModelLoading, setIsMentalModelLoading] = useState(false);
  const [mentalModelError, setMentalModelError] = useState('');

  // Psych profile state
  const [psychProfile, setPsychProfile] = useState(null);
  const [isPsychLoading, setIsPsychLoading] = useState(false);
  const [psychError, setPsychError] = useState('');

  useEffect(() => {
    setTodayLabel(formatDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }));
  }, []);

  useEffect(() => {
    const storedToken = window.localStorage.getItem('neurotwin-token');
    const storedUser = window.localStorage.getItem('neurotwin-user');
    if (storedToken) {
      setToken(storedToken);
      if (storedUser) setUser(JSON.parse(storedUser));
    }
  }, []);

  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatLoading]);

  const showToast = (message, duration = 2200) => {
    setActionLabel(message);
    window.setTimeout(() => setActionLabel(''), duration);
  };

  const requestReflection = async (key, content) => {
    if (!content || !content.trim()) {
      showToast('Write something first');
      return;
    }
    setReflections((current) => ({ ...current, [key]: { status: 'loading' } }));
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/reflect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not get a reflection right now');
      setReflections((current) => ({ ...current, [key]: { status: 'done', text: data.reflection } }));
    } catch (error) {
      setReflections((current) => ({
        ...current,
        [key]: { status: 'error', text: error.message || 'Could not get a reflection right now' },
      }));
    }
  };

  const startNewChat = () => {
    setChatMessages([]);
    setCurrentSessionId(generateSessionId());
    setChatView('current');
  };

  const loadChatSessions = async () => {
    if (!token) return;
    setIsLoadingSessions(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/chat/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setChatSessions(data.sessions.map(mapChatSession));
    } catch {
      showToast('Unable to load chat history');
    } finally {
      setIsLoadingSessions(false);
    }
  };

  const loadChatSession = async (sessionId) => {
    if (!token) return;
    setLoadingSessionId(sessionId);
    try {
      const response = await fetch(`${API_BASE_URL}/api/chat/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const msgs = data.messages.map(mapChatMessage).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      setChatMessages(msgs);
      setCurrentSessionId(sessionId);
      setChatView('current');
    } catch {
      showToast('Unable to load conversation');
    } finally {
      setLoadingSessionId(null);
    }
  };

  const sendChatMessage = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading) return;
    if (!token) { showToast('Please sign in first'); return; }

    // Generate session ID on first message if not set
    const sessionId = currentSessionId || generateSessionId();
    if (!currentSessionId) setCurrentSessionId(sessionId);

    const newMessages = [...chatMessages, { role: 'user', content: text }];
    setChatMessages(newMessages);
    setChatInput('');
    setIsChatLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: newMessages, session_id: sessionId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not get a reply');
      // Use session_id from response in case backend generated one
      if (data.session_id && !currentSessionId) setCurrentSessionId(data.session_id);
      setChatMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (error) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: `Something went wrong: ${error.message}`, isError: true }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleChatKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

  // Load sessions when switching to history view
  useEffect(() => {
    if (chatView === 'history' && token) {
      loadChatSessions();
    }
  }, [chatView, token]);

  const loadMentalModel = async () => {
    if (!token) { showToast('Please sign in first'); return; }
    setIsMentalModelLoading(true);
    setMentalModelError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/mental-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not build mental model');
      setMentalModel(data);
    } catch (error) {
      setMentalModelError(error.message || 'Could not build mental model');
    } finally {
      setIsMentalModelLoading(false);
    }
  };

  const loadPsychProfile = async () => {
    if (!token) { showToast('Please sign in first'); return; }
    setIsPsychLoading(true);
    setPsychError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/psych-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not build psychological profile');
      setPsychProfile(data);
    } catch (error) {
      setPsychError(error.message || 'Could not build psychological profile');
    } finally {
      setIsPsychLoading(false);
    }
  };

  const clearAuth = () => {
    setToken('');
    setUser(null);
    setEntries([]);
    setChatMessages([]);
    setChatSessions([]);
    setCurrentSessionId(null);
    window.localStorage.removeItem('neurotwin-token');
    window.localStorage.removeItem('neurotwin-user');
  };

  useEffect(() => {
    if (!token) return;
    const loadEntries = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/api/journal/entries`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status === 401) { clearAuth(); showToast('Your session expired — please sign in again'); return; }
        if (!response.ok) throw new Error('Unable to load entries');
        const data = await response.json();
        setEntries(data.entries.map(mapEntryToViewModel));
      } catch {
        showToast('Unable to load entries');
      } finally {
        setIsLoading(false);
      }
    };
    loadEntries();
  }, [token]);

  const filteredEntries = useMemo(() => {
    let list = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (activeFilter === 'heavy') list = list.filter((e) => e.mood <= 2);
    if (activeFilter === 'open') list = list.filter((e) => e.mood >= 4);
    if (activeFilter === 'flagged') list = list.filter((e) => e.saved);
    return list;
  }, [activeFilter, entries]);

  const wordCount = useMemo(() => {
    const words = editorValue.trim().split(/\s+/).filter(Boolean);
    return `${words.length} word${words.length === 1 ? '' : 's'}`;
  }, [editorValue]);

  const timeBuckets = useMemo(() => {
    const buckets = { Morning: 0, Midday: 0, Evening: 0, Night: 0 };
    entries.forEach((entry) => {
      if (entry.hour >= 5 && entry.hour < 11) buckets.Morning += 1;
      else if (entry.hour >= 11 && entry.hour < 17) buckets.Midday += 1;
      else if (entry.hour >= 17 && entry.hour < 21) buckets.Evening += 1;
      else buckets.Night += 1;
    });
    const max = Math.max(...Object.values(buckets), 1);
    return Object.entries(buckets).map(([label, count]) => ({
      label,
      count,
      height: `${(count / max) * 100}%`,
    }));
  }, [entries]);

  const wordCloud = useMemo(() => computeWordCloud(entries), [entries]);

  const handlePrompt = () => {
    setPromptIndex((current) => (current + 1) % PROMPTS.length);
  };

  const submitEntry = async (entryStatus) => {
    if (!token) { showToast('Please sign in first'); return; }
    try {
      const response = await fetch(`${API_BASE_URL}/api/journal/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: editorValue, mood, status: entryStatus }),
      });
      if (response.status === 401) { clearAuth(); showToast('Your session expired — please sign in again'); return; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      setEntries((current) => [mapEntryToViewModel(data), ...current]);
      setEditorValue('');
      showToast(entryStatus === 'closed' ? "Today's entry closed" : 'Draft saved');
    } catch {
      showToast(entryStatus === 'closed' ? 'Unable to close entry' : 'Unable to save entry');
    }
  };

  const handleSave = () => submitEntry('draft');
  const handleClose = () => {
    if (!editorValue.trim()) { showToast('Write something first'); return; }
    submitEntry('closed');
  };

  const handleAuth = async (event) => {
    event.preventDefault();
    if (!email.trim() || !password.trim()) { setAuthMessage('Email and password are required'); return; }
    if (authMode === 'register' && password.length < 8) { setAuthMessage('Password must be at least 8 characters'); return; }

    setIsAuthSubmitting(true);
    setAuthMessage('');
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = authMode === 'login' ? { email, password } : { email, password, display_name: displayName.trim() || email.split('@')[0] };
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        const detail = Array.isArray(data.detail) ? data.detail.map((item) => item.msg).join(' ') : data.detail;
        throw new Error(detail || 'Authentication failed');
      }
      if (authMode === 'login') {
        const meResponse = await fetch(`${API_BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${data.access_token}` } });
        if (!meResponse.ok) throw new Error('Signed in, but could not load your profile');
        const profile = await meResponse.json();
        setToken(data.access_token);
        setUser(profile);
        window.localStorage.setItem('neurotwin-token', data.access_token);
        window.localStorage.setItem('neurotwin-user', JSON.stringify(profile));
        setPassword('');
        showToast(`Welcome back, ${profile.display_name}`);
      } else {
        setAuthMode('login');
        setPassword('');
        setAuthMessage('Account created. Please sign in.');
      }
    } catch (error) {
      setAuthMessage(error.message || 'Authentication failed');
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleLogout = () => { clearAuth(); showToast('Signed out'); };

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-top">
          <div className="brand">
            <svg className="brand-mark" viewBox="0 0 28 28" fill="none">
              <path d="M4 14C4 14 7 6 14 6C21 6 24 14 24 14C24 14 21 22 14 22C7 22 4 14 4 14Z" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="14" cy="14" r="2.6" fill="currentColor" />
            </svg>
            <span>Quietly</span>
          </div>
        </div>

        <nav className="rail-nav" aria-label="Primary">
          <button type="button" className={`rail-link ${activeView === 'write' ? 'is-active' : ''}`} onClick={() => setActiveView('write')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 17.5h14M4 13.5l1-3.6L13.6 1.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8 13l-4 .5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
            Write
          </button>
          <button type="button" className={`rail-link ${activeView === 'entries' ? 'is-active' : ''}`} onClick={() => setActiveView('entries')}>
            <svg viewBox="0 0 20 20" fill="none"><rect x="3.5" y="2.5" width="13" height="15" rx="1.4" stroke="currentColor" strokeWidth="1.3" /><path d="M6.5 6.5h7M6.5 9.5h7M6.5 12.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
            Past entries
          </button>
          <button type="button" className={`rail-link ${activeView === 'patterns' ? 'is-active' : ''}`} onClick={() => setActiveView('patterns')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 16V8M9 16V4M15 16v-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M3 16h14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            Patterns
          </button>
          <button type="button" className={`rail-link ${activeView === 'chat' ? 'is-active' : ''}`} onClick={() => setActiveView('chat')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M3.5 4.5h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 2.5V5.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
            Talk it out
          </button>
          <button type="button" className={`rail-link ${activeView === 'mentalmodel' ? 'is-active' : ''}`} onClick={() => setActiveView('mentalmodel')}>
            <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.2" /><circle cx="4" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="16" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="4" cy="15" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="16" cy="15" r="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 5.8L8.5 8.5M11.5 8.5L14.5 5.8M5.5 14.2L8.5 11.5M11.5 11.5L14.5 14.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
            Mental model
          </button>
          <button type="button" className={`rail-link ${activeView === 'psychprofile' ? 'is-active' : ''}`} onClick={() => setActiveView('psychprofile')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5C7 2.5 4.5 5 4.5 8c0 2.1 1.1 3.9 2.8 4.9V15h5.4v-2.1c1.7-1 2.8-2.8 2.8-4.9 0-3-2.5-5.5-5.5-5.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M7.5 17.5h5M8.5 15.5v2M11.5 15.5v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            Psych profile
          </button>
        </nav>

        <div className="rail-bottom">
          <button type="button" className={`rail-link rail-help ${activeView === 'support' ? 'is-active' : ''}`} onClick={() => setActiveView('support')}>
            <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.3" stroke="currentColor" strokeWidth="1.3" /><path d="M10 11.2v-.4c0-.7.4-1 .95-1.4.6-.4 1-.85 1-1.6 0-1-.85-1.8-1.95-1.8s-1.95.8-1.95 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="10" cy="13.7" r="0.15" fill="currentColor" stroke="currentColor" strokeWidth="0.9" /></svg>
            If you need support
          </button>
          <div className="rail-profile">
            <div className="avatar">{user ? user.display_name?.[0]?.toUpperCase() || 'U' : 'U'}</div>
            <div className="rail-profile-text">
              <span className="rail-profile-name">{user ? user.display_name : 'Guest'}</span>
              <span className="rail-profile-streak">{token ? 'Signed in' : 'Sign in to save'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Write ── */}
      <main className={`page ${activeView === 'write' ? '' : 'is-hidden'}`} id="view-write">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow" id="todayLabel">{todayLabel}</span>
            <h1 className="page-title">What's sitting with you today?</h1>
          </div>
          <div className="prompt-toggle">
            <button className="ghost-btn" id="newPromptBtn" onClick={handlePrompt}>
              <svg viewBox="0 0 16 16" fill="none"><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M12.6 3.4l-2.1 2.1M5.5 10.5l-2.1 2.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
              New prompt
            </button>
          </div>
        </header>

        <p className="prompt-line" id="promptLine">{PROMPTS[promptIndex]}</p>

        <section className="mood-row" aria-label="How you're feeling">
          <span className="mood-row-label">Feeling, roughly</span>
          <div className="mood-set" role="group" aria-label="Select a mood">
            {[1, 2, 3, 4, 5].map((value) => (
              <button key={value} type="button" className={`mood-dot ${mood === value ? 'is-selected' : ''}`} onClick={() => setMood(value)} style={{ '--mc': MOOD_COLORS[value] }}>
                <span className="mood-tooltip">{MOOD_LABELS[value]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="editor-wrap">
          {!token ? (
            <form className="auth-card" onSubmit={handleAuth}>
              <div className="auth-card-head">
                <h3>{authMode === 'login' ? 'Sign in to save entries' : 'Create an account'}</h3>
                <p className="auth-card-sub">{authMode === 'login' ? 'Your entries stay private to your account.' : 'Takes a few seconds — no email confirmation needed.'}</p>
              </div>
              {authMessage ? (
                <p className={`auth-message ${authMessage.startsWith('Account created') ? 'is-success' : 'is-error'}`} role="status">{authMessage}</p>
              ) : null}
              {authMode === 'register' ? (
                <label className="auth-field">
                  <span>Display name</span>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="What should we call you?" autoComplete="name" />
                </label>
              ) : null}
              <label className="auth-field">
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
              </label>
              <label className="auth-field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={authMode === 'register' ? 'At least 8 characters' : 'Your password'} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={authMode === 'register' ? 8 : undefined} required />
              </label>
              <div className="editor-actions auth-card-actions">
                <button className="ghost-btn" type="button" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthMessage(''); }} disabled={isAuthSubmitting}>
                  {authMode === 'login' ? 'Create account' : 'Back to sign in'}
                </button>
                <button className="solid-btn" type="submit" disabled={isAuthSubmitting}>
                  {isAuthSubmitting ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Register'}
                </button>
              </div>
            </form>
          ) : null}
          <textarea className="editor" id="editor" value={editorValue} onChange={(e) => setEditorValue(e.target.value)} placeholder="Start anywhere. A sentence, a list, a complaint, a single word — it all counts." aria-label="Journal entry" />
          <div className="editor-foot">
            <span className="word-count" id="wordCount">{wordCount}</span>
            <div className="editor-actions">
              <button className="ghost-btn" onClick={() => requestReflection('draft', editorValue)} disabled={reflections.draft?.status === 'loading'}>
                {reflections.draft?.status === 'loading' ? 'Reflecting…' : 'Reflect on this'}
              </button>
              <button className="ghost-btn" id="saveDraftBtn" onClick={handleSave}>Save as draft</button>
              <button className="solid-btn" id="closeEntryBtn" onClick={handleClose}>Close today's entry</button>
              {token ? <button className="ghost-btn" onClick={handleLogout}>Log out</button> : null}
            </div>
          </div>
        </section>

        <ReflectionCard state={reflections.draft} />

        {actionLabel ? <div className="toast" role="status" aria-live="polite">{actionLabel}</div> : null}

        <section className="thread-section" aria-label="Your last 14 entries">
          <div className="thread-head">
            <span className="thread-title">Your last 14 days, as a thread</span>
            <button className="text-link" onClick={() => setActiveView('patterns')}>See full pattern view →</button>
          </div>
          <div className="thread" id="threadSvgHolder"><ThreadSVG entries={entries.slice(-14)} height={100} amp={26} bg="#FFFFFF" /></div>
        </section>
      </main>

      {/* ── Past Entries ── */}
      <main className={`page ${activeView === 'entries' ? '' : 'is-hidden'}`} id="view-entries">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Archive</span>
            <h1 className="page-title">Past entries</h1>
          </div>
          <div className="entries-filter">
            <button type="button" className={`chip ${activeFilter === 'all' ? 'is-active' : ''}`} onClick={() => setActiveFilter('all')}>All</button>
            <button type="button" className={`chip ${activeFilter === 'heavy' ? 'is-active' : ''}`} onClick={() => setActiveFilter('heavy')}>Heavy days</button>
            <button type="button" className={`chip ${activeFilter === 'open' ? 'is-active' : ''}`} onClick={() => setActiveFilter('open')}>Open days</button>
            <button type="button" className={`chip ${activeFilter === 'flagged' ? 'is-active' : ''}`} onClick={() => setActiveFilter('flagged')}>Saved</button>
          </div>
        </header>

        <p className="entry-meta" style={{ marginTop: '20px' }}>Click any entry to read the full text and ask for a reflection.</p>

        <div className="entry-list" id="entryList">
          {isLoading ? <p className="entry-meta">Loading entries…</p> : null}
          {filteredEntries.map((entry) => {
            const dateStr = formatDate(entry.date, { month: 'short', day: 'numeric' });
            const weekday = formatDate(entry.date, { weekday: 'short' });
            const isExpanded = expandedEntryId === entry.id;
            const reflectionKey = `entry-${entry.id}`;
            return (
              <div key={entry.id}>
                <button type="button" className={`entry-row ${isExpanded ? 'is-expanded' : ''}`} onClick={() => setExpandedEntryId(isExpanded ? null : entry.id)} aria-expanded={isExpanded}>
                  <div className="entry-date"><strong>{dateStr}</strong>{weekday}</div>
                  <div className="entry-mood-mark" style={{ background: MOOD_COLORS[entry.mood] }} title={MOOD_LABELS[entry.mood]} />
                  <div className="entry-body">
                    <p className="entry-snippet">{entry.snippet}</p>
                    <span className="entry-meta">{entry.words} words · {MOOD_LABELS[entry.mood]}</span>
                  </div>
                  <div className="entry-save">{entry.saved ? 'Saved ✓' : ''}</div>
                </button>
                {isExpanded ? (
                  <div className="entry-expanded">
                    <p className="entry-expanded-text">{entry.snippet}</p>
                    <div className="entry-expanded-actions">
                      <button type="button" className="ghost-btn" onClick={() => requestReflection(reflectionKey, entry.snippet)} disabled={reflections[reflectionKey]?.status === 'loading'}>
                        {reflections[reflectionKey]?.status === 'loading' ? 'Reflecting…' : 'Reflect on this entry'}
                      </button>
                    </div>
                    <ReflectionCard state={reflections[reflectionKey]} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </main>

      {/* ── Patterns ── */}
      <main className={`page ${activeView === 'patterns' ? '' : 'is-hidden'}`} id="view-patterns">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Patterns</span>
            <h1 className="page-title">No grades here — just shapes worth noticing</h1>
          </div>
        </header>

        <p className="patterns-intro">This isn't a score. It's just what the last month looked like, in case a shape jumps out at you.</p>

        <div className="patterns-grid">
          <div className="pattern-card pattern-card-wide">
            <span className="pattern-card-label">30-day thread</span>
            <div className="thread thread-large"><ThreadSVG entries={entries} height={140} amp={32} bg="#FFFFFF" /></div>
          </div>

          <div className="pattern-card">
            <span className="pattern-card-label">Most common time you write</span>
            {entries.length === 0 ? (
              <p className="pattern-empty">No entries yet — your writing times will appear here.</p>
            ) : (
              <div className="time-bars" id="timeBars">
                {timeBuckets.map((bucket) => (
                  <div key={bucket.label} className="time-bar-col">
                    <span className="time-bar-count">{bucket.count > 0 ? bucket.count : ''}</span>
                    <div className="time-bar" style={{ height: bucket.height || '4px' }} />
                    <span className="time-bar-label">{bucket.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pattern-card">
            <span className="pattern-card-label">Words that show up often</span>
            {wordCloud.length === 0 ? (
              <p className="pattern-empty">Write a few more entries and your recurring words will surface here.</p>
            ) : (
              <div className="word-cloud" id="wordCloud">
                {wordCloud.map(([word, weight]) => {
                  const maxWeight = wordCloud[0]?.[1] || 1;
                  const size = 13 + (weight / maxWeight) * 16;
                  const opacity = 0.5 + (weight / maxWeight) * 0.5;
                  return <span key={word} style={{ fontSize: `${size.toFixed(0)}px`, opacity: opacity.toFixed(2) }}>{word}</span>;
                })}
              </div>
            )}
          </div>

          <div className="pattern-card pattern-card-wide pattern-note">
            <svg viewBox="0 0 20 20" fill="none" className="note-icon"><circle cx="10" cy="10" r="7.3" stroke="currentColor" strokeWidth="1.3" /><path d="M10 6.5v5M10 13.7v.15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <p>If "heavy" has shown up for more than a few days in a row, it might be worth talking to someone — a friend, or a professional. Patterns are just patterns; you don't have to interpret them alone.</p>
          </div>
        </div>
      </main>

      {/* ── Chat ── */}
      <main className={`page page-chat ${activeView === 'chat' ? '' : 'is-hidden'}`} id="view-chat">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Talk it out</span>
            <h1 className="page-title">Say what's on your mind</h1>
          </div>
          {token && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`ghost-btn ${chatView === 'history' ? 'is-active' : ''}`}
                onClick={() => setChatView(chatView === 'history' ? 'current' : 'history')}
              >
                {chatView === 'history' ? 'Back to chat' : 'Past conversations'}
              </button>
              {chatView === 'current' && chatMessages.length > 0 && (
                <button className="ghost-btn" onClick={startNewChat}>New conversation</button>
              )}
            </div>
          )}
        </header>

        {!token ? (
          <div className="chat-signin-prompt">
            <p>Sign in to start a conversation.</p>
          </div>
        ) : chatView === 'history' ? (
          /* ── Chat History View ── */
          <div className="chat-history">
            {isLoadingSessions ? (
              <p className="entry-meta">Loading conversations…</p>
            ) : chatSessions.length === 0 ? (
              <div className="chat-empty">
                <p>No past conversations yet.</p>
                <button className="ghost-btn" onClick={() => setChatView('current')}>Start one</button>
              </div>
            ) : (
              <div className="entry-list">
                {chatSessions.map((session) => (
                  <button
                    key={session.session_id}
                    type="button"
                    className="entry-row"
                    onClick={() => loadChatSession(session.session_id)}
                    disabled={loadingSessionId === session.session_id}
                  >
                    <div className="entry-date">
                      <strong>{formatDate(session.started_at, { month: 'short', day: 'numeric' })}</strong>
                      {formatDate(session.started_at, { weekday: 'short' })}
                    </div>
                    <div className="entry-body">
                      <p className="entry-snippet">{session.preview || 'No preview available'}</p>
                      <span className="entry-meta">{session.message_count} messages</span>
                    </div>
                    <div className="entry-save">
                      {loadingSessionId === session.session_id ? 'Loading…' : '→'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* ── Active Chat View ── */
          <div className="chat-wrap">
            <div className="chat-messages" aria-live="polite" aria-label="Conversation">
              {chatMessages.length === 0 && (
                <div className="chat-empty">
                  <svg viewBox="0 0 40 40" fill="none" className="chat-empty-icon">
                    <path d="M8 30l4-4H32a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2Z" stroke="#C9A893" strokeWidth="1.3" strokeLinejoin="round" />
                    <path d="M12 16h16M12 21h10" stroke="#C9A893" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                  <p>No agenda. No pressure. Start wherever feels natural.</p>
                  <div className="chat-starters">
                    {["Something's been on my mind…", "I don't know how to explain it, but…", "Today was a lot.", "I've been thinking about…"].map((starter) => (
                      <button key={starter} className="chat-starter-btn" onClick={() => { setChatInput(starter); }}>
                        {starter}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`chat-bubble chat-bubble-${msg.role} ${msg.isError ? 'is-error' : ''}`}>
                  {msg.content}
                </div>
              ))}
              {isChatLoading && (
                <div className="chat-bubble chat-bubble-assistant chat-bubble-typing">
                  <span /><span /><span />
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            <div className="chat-input-row">
              <textarea
                className="chat-input"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleChatKeyDown}
                placeholder="Type something… Enter to send, Shift+Enter for a new line"
                rows={1}
                aria-label="Chat message"
              />
              <button
                className="chat-send-btn"
                onClick={sendChatMessage}
                disabled={isChatLoading || !chatInput.trim()}
                aria-label="Send"
              >
                <svg viewBox="0 0 20 20" fill="none"><path d="M3 10L17 3l-4 7 4 7-14-7Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
              </button>
            </div>

            {chatMessages.length > 0 && (
              <div className="chat-actions-bar">
                <button className="ghost-btn" onClick={startNewChat}>New conversation</button>
                <button className="ghost-btn" onClick={() => { setChatMessages([]); setCurrentSessionId(null); }}>Clear</button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Mental Model ── */}
      <main className={`page ${activeView === 'mentalmodel' ? '' : 'is-hidden'}`} id="view-mentalmodel">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Mental model</span>
            <h1 className="page-title">A map of what's moving through you</h1>
          </div>
          {token && (
            <button className="solid-btn" onClick={loadMentalModel} disabled={isMentalModelLoading}>
              {isMentalModelLoading ? 'Building…' : mentalModel ? 'Rebuild map' : 'Build my map'}
            </button>
          )}
        </header>

        <p className="patterns-intro">
          Built from your journal entries and conversations, this diagram tries to show the emotional and cognitive patterns that run through your writing — not as a diagnosis, just as a shape worth seeing.
        </p>

        {!token && (
          <div className="mental-model-empty">
            <p>Sign in to build your mental model.</p>
          </div>
        )}

        {token && !mentalModel && !isMentalModelLoading && !mentalModelError && (
          <div className="mental-model-empty">
            <svg viewBox="0 0 64 64" fill="none" className="mental-model-empty-icon">
              <circle cx="32" cy="32" r="8" stroke="#C9A893" strokeWidth="1.5" />
              <circle cx="12" cy="16" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <circle cx="52" cy="16" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <circle cx="12" cy="48" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <circle cx="52" cy="48" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <path d="M17 19l11 10M36 25l11-9M17 45l11-10M36 39l11 9" stroke="#D8D2C4" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <p>Press "Build my map" to generate a diagram from your journal entries and conversations.</p>
            {entries.length < 3 && (
              <p className="mental-model-hint">Write at least a few entries first — the more you've written, the more accurate the map.</p>
            )}
          </div>
        )}

        {isMentalModelLoading && (
          <div className="mental-model-loading">
            <div className="mental-model-spinner" />
            <p>Reading your entries and conversations, drawing the map…</p>
          </div>
        )}

        {mentalModelError && (
          <div className="mental-model-error">
            <p>{mentalModelError}</p>
            <button className="ghost-btn" onClick={loadMentalModel}>Try again</button>
          </div>
        )}

        {mentalModel && !isMentalModelLoading && (
          <div className="mental-model-content">
            <div className="mental-model-summary">
              <svg viewBox="0 0 20 20" fill="none" className="reflect-card-icon" style={{ flexShrink: 0, marginTop: 2 }}>
                <path d="M10 2.5l1.4 4.1 4.1 1.4-4.1 1.4L10 13.5l-1.4-4.1-4.1-1.4 4.1-1.4L10 2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
              </svg>
              <p>{mentalModel.summary}</p>
            </div>

            <div className="mental-model-diagram">
              <BrainDiagram nodes={mentalModel.nodes} edges={mentalModel.edges} />
            </div>

            <div className="mental-model-nodes-list">
              <h3 className="mental-model-nodes-title">What's in the map</h3>
              <div className="mental-model-nodes-grid">
                {mentalModel.nodes.sort((a, b) => b.weight - a.weight).map((node) => {
                  const colors = NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.theme;
                  return (
                    <div key={node.id} className="mental-model-node-card">
                      <div className="mental-model-node-header">
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.fill, border: `1.5px solid ${colors.stroke}`, flexShrink: 0 }} />
                        <span className="mental-model-node-label">{node.label}</span>
                        <span className="mental-model-node-type">{node.type}</span>
                      </div>
                      <p className="mental-model-node-desc">{node.description}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Psychological Profile ── */}
      <main className={`page ${activeView === 'psychprofile' ? '' : 'is-hidden'}`} id="view-psychprofile">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Psychological profile</span>
            <h1 className="page-title">A mirror, not a verdict</h1>
          </div>
          {token && (
            <button className="solid-btn" onClick={loadPsychProfile} disabled={isPsychLoading}>
              {isPsychLoading ? 'Analysing…' : psychProfile ? 'Rebuild profile' : 'Build my profile'}
            </button>
          )}
        </header>

        <div className="psych-disclaimer" role="note">
          <svg viewBox="0 0 16 16" fill="none" style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1 }}>
            <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M8 5.2v4M8 10.8v.15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span>
            <strong>This is not a clinical diagnosis.</strong> This profile is generated from your personal writing using
            the Big Five personality framework and broad observational lenses. It reflects patterns in your words, not
            a professional psychological evaluation. Please do not use it to make medical, therapeutic, or major life
            decisions. If you have concerns about your mental health, speak with a qualified professional.
          </span>
        </div>

        {!token && (
          <div className="mental-model-empty">
            <p>Sign in to build your psychological profile.</p>
          </div>
        )}

        {token && !psychProfile && !isPsychLoading && !psychError && (
          <div className="mental-model-empty">
            <svg viewBox="0 0 64 64" fill="none" className="mental-model-empty-icon">
              <path d="M32 8C22 8 14 16 14 26c0 7 3.6 13.2 9.2 16.8V46h17.6v-3.2C46.4 39.2 50 33 50 26c0-10-8-18-18-18Z" stroke="#C9A893" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M24 54h16M27 46v8M37 46v8" stroke="#C9A893" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <p>Press "Build my profile" to generate a psychological profile from your journal entries and conversations.</p>
            {entries.length < 3 && (
              <p className="mental-model-hint">Write at least a few entries first — the more you've written, the more accurate the profile.</p>
            )}
          </div>
        )}

        {isPsychLoading && (
          <div className="mental-model-loading">
            <div className="mental-model-spinner" />
            <p>Reading your writing carefully — this takes a moment…</p>
          </div>
        )}

        {psychError && (
          <div className="mental-model-error">
            <p>{psychError}</p>
            <button className="ghost-btn" onClick={loadPsychProfile}>Try again</button>
          </div>
        )}

        {psychProfile && !isPsychLoading && (
          <div className="psych-content">

            {/* Overall narrative */}
            <div className="mental-model-summary">
              <svg viewBox="0 0 20 20" fill="none" className="reflect-card-icon" style={{ flexShrink: 0, marginTop: 2 }}>
                <path d="M10 2.5l1.4 4.1 4.1 1.4-4.1 1.4L10 13.5l-1.4-4.1-4.1-1.4 4.1-1.4L10 2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
              </svg>
              <p>{psychProfile.overall_narrative}</p>
            </div>

            {/* Big Five */}
            <section className="psych-section">
              <h2 className="psych-section-title">Big Five personality dimensions</h2>
              <p className="psych-section-sub">Scores are inferred from your writing — not a psychometric test. Treat them as rough compass bearings.</p>
              <div className="psych-big-five">
                {[
                  { key: 'openness', label: 'Openness', desc: 'Curiosity, imagination, breadth of experience' },
                  { key: 'conscientiousness', label: 'Conscientiousness', desc: 'Organisation, self-discipline, goal-directedness' },
                  { key: 'extraversion', label: 'Extraversion', desc: 'Sociability, assertiveness, energy from others' },
                  { key: 'agreeableness', label: 'Agreeableness', desc: 'Warmth, cooperation, trust in others' },
                  { key: 'neuroticism', label: 'Neuroticism', desc: 'Emotional reactivity, sensitivity to stress' },
                ].map(({ key, label, desc }) => {
                  const dim = psychProfile.big_five[key];
                  if (!dim) return null;
                  const score = dim.score ?? 50;
                  const barColor = key === 'neuroticism'
                    ? score > 65 ? '#D4B8B8' : score > 40 ? '#C9A893' : '#B8D4C8'
                    : score > 65 ? '#B8D4C8' : score > 40 ? '#C9A893' : '#D4B8B8';
                  return (
                    <div key={key} className="psych-trait-card">
                      <div className="psych-trait-head">
                        <div>
                          <span className="psych-trait-label">{label}</span>
                          <span className="psych-trait-desc">{desc}</span>
                        </div>
                        <span className="psych-trait-badge" style={{ background: barColor }}>{dim.label}</span>
                      </div>
                      <div className="psych-bar-track">
                        <div className="psych-bar-fill" style={{ width: `${score}%`, background: barColor }} />
                      </div>
                      <p className="psych-trait-summary">{dim.summary}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Clinical observations */}
            {psychProfile.clinical_observations?.length > 0 && (
              <section className="psych-section">
                <h2 className="psych-section-title">Observational findings</h2>
                <p className="psych-section-sub">Patterns noticed across your writing — not diagnoses.</p>
                <div className="psych-observations">
                  {psychProfile.clinical_observations.map((obs, i) => {
                    const signalColors = {
                      low:      { bg: '#F0F4F2', border: '#B8D4C8', dot: '#7AA898' },
                      moderate: { bg: '#F6F2EE', border: '#C9A893', dot: '#A8765E' },
                      elevated: { bg: '#F4F0F6', border: '#C4B8D4', dot: '#8A7AA8' },
                      high:     { bg: '#F4EEEE', border: '#D4B8B8', dot: '#A87A7A' },
                    };
                    const colors = signalColors[obs.signal] || signalColors.moderate;
                    return (
                      <div key={i} className="psych-obs-card" style={{ background: colors.bg, borderColor: colors.border }}>
                        <div className="psych-obs-head">
                          <span className="psych-obs-domain">{obs.domain}</span>
                          <span className="psych-obs-signal" style={{ color: colors.dot }}>
                            <span className="psych-obs-dot" style={{ background: colors.dot }} />
                            {obs.signal}
                          </span>
                        </div>
                        <p className="psych-obs-finding">{obs.finding}</p>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Tensions & Strengths */}
            <div className="psych-two-col">
              {psychProfile.core_tensions?.length > 0 && (
                <section className="psych-section psych-section-card">
                  <h2 className="psych-section-title">Core tensions</h2>
                  <p className="psych-section-sub">Unresolved conflicts visible in your writing.</p>
                  <ul className="psych-list psych-list-tension">
                    {psychProfile.core_tensions.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </section>
              )}
              {psychProfile.strengths?.length > 0 && (
                <section className="psych-section psych-section-card">
                  <h2 className="psych-section-title">Psychological strengths</h2>
                  <p className="psych-section-sub">Genuine capacities visible in your writing.</p>
                  <ul className="psych-list psych-list-strength">
                    {psychProfile.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

          </div>
        )}
      </main>

      {/* ── Support ── */}
      <main className={`page ${activeView === 'support' ? '' : 'is-hidden'}`} id="view-support">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Support</span>
            <h1 className="page-title">If you need more than a page right now</h1>
          </div>
        </header>
        <div className="support-grid">
          <div className="support-card">
            <h3>This app isn't built for crises</h3>
            <p>Quietly is a place to write. If you're in crisis or thinking about harming yourself, please reach out to people trained for that, right away.</p>
          </div>
          <div className="support-card support-card-contact">
            <h3>US — 988</h3>
            <p>Suicide & Crisis Lifeline. Call or text 988, anytime.</p>
          </div>
          <div className="support-card support-card-contact">
            <h3>UK — 116 123</h3>
            <p>Samaritans, free, anytime.</p>
          </div>
          <div className="support-card support-card-contact">
            <h3>International</h3>
            <p>findahelpline.com lists crisis lines by country.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
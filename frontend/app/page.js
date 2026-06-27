'use client';

import { useEffect, useMemo, useState } from 'react';

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

function createSeededRandom(seed) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);
}

function mapEntryToViewModel(entry) {
  const date = new Date(entry.created_at);
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
          <g key={`${point.entry.date}-${index}`} tabIndex="0">
            <title>{`${formatDate(point.entry.date, { month: 'short', day: 'numeric' })} — ${MOOD_LABELS[point.entry.mood]}`}</title>
            <circle cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} r={isToday ? 5.5 : 4} fill={color} stroke={bg} strokeWidth="2" />
            {isToday ? <circle cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} r="9" fill="none" stroke={color} strokeWidth="1" opacity="0.4" /> : null}
          </g>
        );
      })}
    </svg>
  );
}

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
  const [authMessage, setAuthMessage] = useState('');

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
    if (!token) return;
    const loadEntries = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/api/journal/entries`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Unable to load entries');
        const data = await response.json();
        setEntries(data.entries.map(mapEntryToViewModel));
      } catch (error) {
        setActionLabel('Unable to load entries');
      } finally {
        setIsLoading(false);
      }
    };

    loadEntries();
  }, [token]);

  const filteredEntries = useMemo(() => {
    let list = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (activeFilter === 'heavy') list = list.filter((entry) => entry.mood <= 2);
    if (activeFilter === 'open') list = list.filter((entry) => entry.mood >= 4);
    if (activeFilter === 'flagged') list = list.filter((entry) => entry.saved);
    return list;
  }, [activeFilter, entries]);

  const wordCount = useMemo(() => {
    const words = editorValue.trim().split(/\s+/).filter(Boolean);
    return `${words.length} word${words.length === 1 ? '' : 's'}`;
  }, [editorValue]);

  const timeBuckets = useMemo(() => {
    const buckets = { Morning: 0, Midday: 0, Evening: 0, Night: 0 };
    entries.forEach((entry) => {
      if (entry.hour < 11) buckets.Morning += 1;
      else if (entry.hour < 17) buckets.Midday += 1;
      else if (entry.hour < 21) buckets.Evening += 1;
      else buckets.Night += 1;
    });
    const max = Math.max(...Object.values(buckets), 1);
    return Object.entries(buckets).map(([label, count]) => ({ label, height: `${(count / max) * 100}%` }));
  }, [entries]);

  const wordCloud = [
    ['tired', 28],
    ['better', 22],
    ['anxious', 19],
    ['okay', 26],
    ['work', 24],
    ['sleep', 17],
    ['quiet', 14],
    ['family', 15],
    ['progress', 12],
    ['heavy', 13],
    ['grateful', 11],
    ['stuck', 10],
  ];

  const handlePrompt = () => {
    setPromptIndex((current) => (current + 1) % PROMPTS.length);
  };

  const handleSave = async () => {
    if (!token) {
      setActionLabel('Please sign in first');
      window.setTimeout(() => setActionLabel(''), 1600);
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/journal/entries`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: editorValue, mood, status: 'draft' }),
      });
      if (!response.ok) throw new Error('Unable to save entry');
      setActionLabel('Draft saved');
      window.setTimeout(() => setActionLabel(''), 1600);
      const data = await response.json();
      setEntries((current) => [mapEntryToViewModel(data), ...current]);
      setEditorValue('');
    } catch (error) {
      setActionLabel('Unable to save entry');
      window.setTimeout(() => setActionLabel(''), 1600);
    }
  };

  const handleClose = async () => {
    if (!editorValue.trim()) {
      setActionLabel('Write something first');
      window.setTimeout(() => setActionLabel(''), 1600);
      return;
    }

    if (!token) {
      setActionLabel('Please sign in first');
      window.setTimeout(() => setActionLabel(''), 1600);
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/journal/entries`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: editorValue, mood, status: 'closed' }),
      });
      if (!response.ok) throw new Error('Unable to close entry');
      setActionLabel("Today's entry closed");
      window.setTimeout(() => setActionLabel(''), 1600);
      const data = await response.json();
      setEntries((current) => [mapEntryToViewModel(data), ...current]);
      setEditorValue('');
    } catch (error) {
      setActionLabel('Unable to close entry');
      window.setTimeout(() => setActionLabel(''), 1600);
    }
  };

  const handleAuth = async (event) => {
    event.preventDefault();
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = authMode === 'login' ? { email, password } : { email, password, display_name: displayName || email.split('@')[0] };
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Authentication failed');
      if (authMode === 'login') {
        setToken(data.access_token);
        window.localStorage.setItem('neurotwin-token', data.access_token);
        const meResponse = await fetch(`${API_BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${data.access_token}` } });
        const profile = await meResponse.json();
        setUser(profile);
        window.localStorage.setItem('neurotwin-user', JSON.stringify(profile));
      } else {
        setAuthMode('login');
        setAuthMessage('Account created. Please sign in.');
      }
    } catch (error) {
      setAuthMessage(error.message || 'Authentication failed');
    }
  };

  const handleLogout = () => {
    setToken('');
    setUser(null);
    setEntries([]);
    window.localStorage.removeItem('neurotwin-token');
    window.localStorage.removeItem('neurotwin-user');
  };

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
              <h3>{authMode === 'login' ? 'Sign in to save entries' : 'Create an account'}</h3>
              {authMessage ? <p className="entry-meta">{authMessage}</p> : null}
              {authMode === 'register' ? <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Display name" /> : null}
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" />
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" />
              <div className="editor-actions">
                <button className="ghost-btn" type="button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{authMode === 'login' ? 'Create account' : 'Back to sign in'}</button>
                <button className="solid-btn" type="submit">{authMode === 'login' ? 'Sign in' : 'Register'}</button>
              </div>
            </form>
          ) : null}
          <textarea className="editor" id="editor" value={editorValue} onChange={(event) => setEditorValue(event.target.value)} placeholder="Start anywhere. A sentence, a list, a complaint, a single word — it all counts." aria-label="Journal entry" />
          <div className="editor-foot">
            <span className="word-count" id="wordCount">{wordCount}</span>
            <div className="editor-actions">
              <button className="ghost-btn" id="saveDraftBtn" onClick={handleSave}>Save as draft</button>
              <button className="solid-btn" id="closeEntryBtn" onClick={handleClose}>Close today's entry</button>
              {token ? <button className="ghost-btn" onClick={handleLogout}>Log out</button> : null}
            </div>
          </div>
        </section>

        <section className="thread-section" aria-label="Your last 14 entries">
          <div className="thread-head">
            <span className="thread-title">Your last 14 days, as a thread</span>
            <button className="text-link" onClick={() => setActiveView('patterns')}>See full pattern view →</button>
          </div>
          <div className="thread" id="threadSvgHolder"><ThreadSVG entries={entries.slice(-14)} height={100} amp={26} bg="#FFFFFF" /></div>
        </section>
      </main>

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

        <div className="entry-list" id="entryList">
          {isLoading ? <p className="entry-meta">Loading entries…</p> : null}
          {filteredEntries.map((entry) => {
            const dateStr = formatDate(entry.date, { month: 'short', day: 'numeric' });
            const weekday = formatDate(entry.date, { weekday: 'short' });
            return (
              <div key={`${entry.date}-${entry.snippet}`} className="entry-row">
                <div className="entry-date"><strong>{dateStr}</strong>{weekday}</div>
                <div className="entry-mood-mark" style={{ background: MOOD_COLORS[entry.mood] }} title={MOOD_LABELS[entry.mood]} />
                <div className="entry-body">
                  <p className="entry-snippet">{entry.snippet}</p>
                  <span className="entry-meta">{entry.words} words · {MOOD_LABELS[entry.mood]}</span>
                </div>
                <div className="entry-save">{entry.saved ? 'Saved ✓' : ''}</div>
              </div>
            );
          })}
        </div>
      </main>

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
            <div className="time-bars" id="timeBars">
              {timeBuckets.map((bucket) => (
                <div key={bucket.label} className="time-bar-col">
                  <div className="time-bar" style={{ height: bucket.height }} />
                  <span className="time-bar-label">{bucket.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="pattern-card">
            <span className="pattern-card-label">Words that show up often</span>
            <div className="word-cloud" id="wordCloud">
              {wordCloud.map(([word, weight]) => {
                const size = 13 + (weight / 28) * 16;
                const opacity = 0.55 + (weight / 28) * 0.45;
                return <span key={word} style={{ fontSize: `${size.toFixed(0)}px`, opacity: opacity.toFixed(2) }}>{word}</span>;
              })}
            </div>
          </div>
          <div className="pattern-card pattern-card-wide pattern-note">
            <svg viewBox="0 0 20 20" fill="none" className="note-icon"><circle cx="10" cy="10" r="7.3" stroke="currentColor" strokeWidth="1.3" /><path d="M10 6.5v5M10 13.7v.15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <p>If "heavy" has shown up for more than a few days in a row, it might be worth talking to someone — a friend, or a professional. Patterns are just patterns; you don't have to interpret them alone.</p>
          </div>
        </div>
      </main>

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

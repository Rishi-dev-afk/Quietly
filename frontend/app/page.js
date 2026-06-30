'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrainDiagram3D from './BrainDiagram3D';

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

// ─── "Since last time" diffing ──────────────────────────────────────────────────
// Both diff helpers are deliberately conservative: they only surface a change when it's large
// enough to be meaningful (avoids noisy "+1" chatter from normal AI output variance), and they
// never claim more precision than a small-sample LLM read genuinely supports.

function diffMentalModels(previous, current) {
  if (!previous || !current) return null;
  const prevByLabel = new Map(previous.nodes.map((n) => [n.label.toLowerCase(), n]));
  const currByLabel = new Map(current.nodes.map((n) => [n.label.toLowerCase(), n]));

  const newcomers = current.nodes.filter((n) => !prevByLabel.has(n.label.toLowerCase()));
  const faded = previous.nodes.filter((n) => !currByLabel.has(n.label.toLowerCase()));
  const shifted = [];
  for (const [label, currNode] of currByLabel) {
    const prevNode = prevByLabel.get(label);
    if (prevNode && Math.abs(currNode.weight - prevNode.weight) >= 2) {
      shifted.push({ label: currNode.label, from: prevNode.weight, to: currNode.weight });
    }
  }

  if (newcomers.length === 0 && faded.length === 0 && shifted.length === 0) return null;
  return { newcomers, faded, shifted };
}

function diffPsychProfiles(previous, current) {
  if (!previous || !current) return null;
  const dims = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
  const shifts = [];
  for (const dim of dims) {
    const prevScore = previous.big_five?.[dim]?.score;
    const currScore = current.big_five?.[dim]?.score;
    if (typeof prevScore === 'number' && typeof currScore === 'number' && Math.abs(currScore - prevScore) >= 8) {
      shifts.push({ dim, from: prevScore, to: currScore });
    }
  }
  if (shifts.length === 0) return null;
  return { shifts };
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
    session_type: session.session_type || null,
    node_label: session.node_label || null,
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
  emotion:      { glow: '#E0A98A', stroke: '#C98A63', text: '#F2E9DD' },
  theme:        { glow: '#9FB6C4', stroke: '#6E8B9C', text: '#EAF1F4' },
  pattern:      { glow: '#D8D0BC', stroke: '#AFA587', text: '#F2EEE2' },
  coping:       { glow: '#9AD6BC', stroke: '#5E9C82', text: '#E6F5EE' },
  relationship: { glow: '#C2AEDE', stroke: '#9078B8', text: '#F0EAF7' },
  tension:      { glow: '#E0A0A0', stroke: '#B86E6E', text: '#F7E9E9' },
};
const EDGE_COLORS = {
  fuels:         '#C98A63',
  conflicts_with:'#B86E6E',
  leads_to:      '#5E9C82',
  soothes:       '#7FB8A0',
  masks:         '#9078B8',
  orbits:        '#8A8A98',
};

const DIAGRAM_W = 920;
const DIAGRAM_H = 560;

function nodeRadius(weight) {
  return 17 + weight * 3.3;
}

// Deterministic pseudo-random from a string seed, so each node's organic
// shape stays stable across re-renders instead of jittering.
function seedRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return (h % 1000) / 1000;
  };
}

// Builds an irregular, organic blob path (like a neuron soma) instead of a
// perfect circle — smoothed through N perturbed points around the radius.
function blobPath(r, seed) {
  const rand = seedRandom(seed);
  const points = 9;
  const pts = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const wobble = 0.82 + rand() * 0.36;
    pts.push({ x: Math.cos(angle) * r * wobble, y: Math.sin(angle) * r * wobble });
  }
  let d = `M ${pts[0].x},${pts[0].y} `;
  for (let i = 0; i < points; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % points];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    d += `Q ${p0.x},${p0.y} ${mx},${my} `;
  }
  d += 'Z';
  return d;
}

// Lightweight force simulation — no dependencies. Settles connected nodes
// near each other and spaces everything else out, bound to the canvas.
function simulateLayout(nodes, edges) {
  const cx = DIAGRAM_W / 2, cy = DIAGRAM_H / 2;
  const ids = nodes.map((n) => n.id);
  const idx = {};
  ids.forEach((id, i) => (idx[id] = i));

  const sorted = [...nodes].sort((a, b) => b.weight - a.weight);
  const pos = nodes.map(() => ({ x: cx, y: cy }));
  sorted.forEach((node, i) => {
    const angle = i * 2.4;
    const r = i === 0 ? 0 : 60 + i * 26;
    pos[idx[node.id]] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  const vel = nodes.map(() => ({ x: 0, y: 0 }));
  const links = edges
    .map((e) => ({ a: idx[e.source], b: idx[e.target], strength: e.strength || 1 }))
    .filter((l) => l.a !== undefined && l.b !== undefined);

  const n = nodes.length;
  const radii = nodes.map((node) => nodeRadius(node.weight));

  for (let tick = 0; tick < 260; tick++) {
    const damping = 0.86;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const minDist = radii[i] + radii[j] + 26;
        const force = dist < minDist ? (minDist - dist) * 0.06 : 900 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        vel[i].x += fx; vel[i].y += fy;
        vel[j].x -= fx; vel[j].y -= fy;
      }
    }

    links.forEach(({ a, b, strength }) => {
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const targetLen = 120 - strength * 6;
      const force = (dist - targetLen) * 0.02 * (0.4 + strength * 0.15);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      vel[a].x += fx; vel[a].y += fy;
      vel[b].x -= fx; vel[b].y -= fy;
    });

    for (let i = 0; i < n; i++) {
      const pull = 0.012 + (1 - nodes[i].weight / 10) * 0.006;
      vel[i].x += (cx - pos[i].x) * pull;
      vel[i].y += (cy - pos[i].y) * pull;
    }

    for (let i = 0; i < n; i++) {
      vel[i].x *= damping;
      vel[i].y *= damping;
      pos[i].x += vel[i].x;
      pos[i].y += vel[i].y;
      const margin = radii[i] + 24;
      pos[i].x = Math.max(margin, Math.min(DIAGRAM_W - margin, pos[i].x));
      pos[i].y = Math.max(margin, Math.min(DIAGRAM_H - margin, pos[i].y));
    }
  }

  const result = {};
  nodes.forEach((node, i) => (result[node.id] = pos[i]));
  return result;
}

function wrapLabel(label, maxChars) {
  const words = label.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    if (lines.length === 1) break;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

function BrainDiagram({ nodes, edges, onNodeClick, selectedNodeId }) {
  const [tooltip, setTooltip] = useState(null);
  const [positions, setPositions] = useState({});
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!nodes.length) return;
    setDrawn(false);
    setPositions(simulateLayout(nodes, edges));
    const t = setTimeout(() => setDrawn(true), 40);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  if (!nodes.length || !Object.keys(positions).length) return null;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <style>{`
        @keyframes mm-draw-edge { to { stroke-dashoffset: 0; } }
        @keyframes mm-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes mm-pulse-ring { 0% { opacity: 0.5; r: var(--r0); } 100% { opacity: 0; r: var(--r1); } }
        @keyframes mm-flicker { 0%, 100% { opacity: 1; } 50% { opacity: 0.86; } }
        .mm-node-group { transition: filter 0.15s ease; }
        .mm-node-group:hover .mm-soma { filter: url(#mm-node-glow-hover); }
      `}</style>
      <svg
        viewBox={`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: '100%', display: 'block', overflow: 'visible', borderRadius: 18, background: '#0E0E14' }}
        aria-label="Mental model brain diagram"
      >
        <defs>
          <radialGradient id="mm-bg" cx="50%" cy="40%" r="75%">
            <stop offset="0%" stopColor="#1B1C26" />
            <stop offset="55%" stopColor="#121319" />
            <stop offset="100%" stopColor="#0A0A0F" />
          </radialGradient>
          <filter id="mm-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise" />
            <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.025 0" />
          </filter>
          <filter id="mm-node-glow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="mm-node-glow-hover" x="-140%" y="-140%" width="380%" height="380%">
            <feGaussianBlur stdDeviation="9" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="mm-edge-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="1.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect x="0" y="0" width={DIAGRAM_W} height={DIAGRAM_H} fill="url(#mm-bg)" rx="18" />
        <rect x="0" y="0" width={DIAGRAM_W} height={DIAGRAM_H} filter="url(#mm-grain)" rx="18" opacity="0.5" />

        {edges.map((edge, i) => {
          const s = positions[edge.source];
          const t = positions[edge.target];
          if (!s || !t) return null;
          const color = EDGE_COLORS[edge.relationship] || '#8A8A98';
          const strokeW = 0.6 + edge.strength * 0.28;
          const mx = (s.x + t.x) / 2 + (t.y - s.y) * 0.16;
          const my = (s.y + t.y) / 2 - (t.x - s.x) * 0.16;
          const len = Math.hypot(t.x - s.x, t.y - s.y) * 1.25 + 40;
          const pathId = `mm-edge-path-${i}`;
          return (
            <g key={i} filter="url(#mm-edge-glow)">
              <path
                id={pathId}
                d={`M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`}
                fill="none"
                stroke={color}
                strokeWidth={strokeW}
                strokeLinecap="round"
                opacity={drawn ? 0.4 : 0}
                strokeDasharray={drawn ? 'none' : len}
                strokeDashoffset={drawn ? 0 : len}
                style={{
                  transition: 'opacity 0.6s ease',
                  animation: drawn ? `mm-draw-edge 0.9s ease ${0.15 + i * 0.02}s forwards` : 'none',
                }}
              />
              {drawn && edge.strength >= 3 && (
                <circle r="1.6" fill={color} opacity="0.9">
                  <animateMotion dur={`${2.4 + (i % 5) * 0.5}s`} repeatCount="indefinite" rotate="auto">
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </circle>
              )}
            </g>
          );
        })}

        {nodes.map((node, ni) => {
          const pos = positions[node.id];
          if (!pos) return null;
          const colors = NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.theme;
          const r = nodeRadius(node.weight);
          const isHovered = tooltip?.id === node.id;
          const isSelected = selectedNodeId === node.id;
          const lines = wrapLabel(node.label, Math.max(7, Math.round(r * 0.42)));
          const fontSize = Math.max(8.5, Math.min(11.5, r * 0.34));
          const lineHeight = fontSize * 1.2;
          const path = blobPath(r, node.id);

          return (
            <g
              key={node.id}
              className="mm-node-group"
              transform={`translate(${pos.x}, ${pos.y})`}
              style={{
                cursor: onNodeClick ? 'pointer' : 'default',
                opacity: drawn ? 1 : 0,
                animation: drawn ? `mm-fade-in 0.5s ease ${0.05 + ni * 0.03}s backwards, mm-flicker ${3 + (ni % 4)}s ease-in-out ${ni * 0.4}s infinite` : 'none',
              }}
              onMouseEnter={() => setTooltip({ id: node.id, x: pos.x, y: pos.y, node })}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => onNodeClick && onNodeClick(node)}
              role={onNodeClick ? 'button' : undefined}
              tabIndex={onNodeClick ? 0 : undefined}
              onKeyDown={(e) => {
                if (onNodeClick && (e.key === 'Enter' || e.key === ' ')) onNodeClick(node);
              }}
            >
              {isSelected && (
                <circle
                  r={r + 10}
                  fill="none"
                  stroke={colors.stroke}
                  strokeWidth="1.5"
                  strokeDasharray="1.5 5"
                  style={{ animation: 'mm-pulse-ring 2.4s linear infinite', '--r0': `${r + 8}px`, '--r1': `${r + 18}px` }}
                  opacity="0.6"
                />
              )}

              <path className="mm-soma" d={path} fill={colors.glow} fillOpacity={isHovered || isSelected ? 0.34 : 0.22} stroke={colors.stroke} strokeWidth="1" filter="url(#mm-node-glow)" />
              <path d={path} fill="none" stroke={colors.stroke} strokeWidth="1" opacity="0.7" />

              <text
                textAnchor="middle"
                dominantBaseline="middle"
                fill={colors.text}
                fontSize={fontSize}
                fontWeight="500"
                fontFamily="Inter, sans-serif"
                style={{ userSelect: 'none', pointerEvents: 'none' }}
              >
                {lines.map((line, li) => (
                  <tspan key={li} x="0" y={(li - (lines.length - 1) / 2) * lineHeight}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>

      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: `${Math.min(86, Math.max(14, (tooltip.x / DIAGRAM_W) * 100))}%`,
            top: `${Math.min(88, Math.max(8, (tooltip.y / DIAGRAM_H) * 100))}%`,
            transform: 'translate(-50%, -122%)',
            background: 'rgba(18,19,25,0.96)',
            color: '#EAEAEF',
            borderRadius: 10,
            padding: '11px 15px',
            maxWidth: 230,
            fontSize: 12.5,
            lineHeight: 1.5,
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 13 }}>{tooltip.node.label}</div>
          <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {tooltip.node.type} · weight {tooltip.node.weight}/10
          </div>
          <div>{tooltip.node.description}</div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 20, paddingTop: 16, borderTop: '1px solid #EFEBE2' }}>
        {Object.entries(NODE_TYPE_COLORS).map(([type, colors]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#5B6B73' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.glow, border: `1.5px solid ${colors.stroke}` }} />
            <span style={{ textTransform: 'capitalize' }}>{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Auth Form (shared between the write-page save prompt and the account modal) ──────────────

function AuthForm({
  authMode,
  setAuthMode,
  email,
  setEmail,
  password,
  setPassword,
  displayName,
  setDisplayName,
  authMessage,
  setAuthMessage,
  isAuthSubmitting,
  onSubmit,
  heading,
  subheading,
  onCancel,
  cancelLabel = 'Cancel',
}) {
  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <div className="auth-card-head">
        <h3>{heading}</h3>
        <p className="auth-card-sub">{subheading}</p>
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
        <button className="ghost-btn" type="button" onClick={onCancel} disabled={isAuthSubmitting}>
          {cancelLabel}
        </button>
        <button className="solid-btn" type="submit" disabled={isAuthSubmitting}>
          {isAuthSubmitting ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Register'}
        </button>
      </div>
    </form>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [activeView, setActiveView] = useState('write');

  // Navigate to a view and close the mobile nav drawer, if open — used by every nav link so the
  // drawer doesn't linger open over the new view after a tap.
  const goToView = (view) => {
    setActiveView(view);
    setShowMobileNav(false);
  };
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
  const [showSavePrompt, setShowSavePrompt] = useState(false);

  // Account rail (bottom-left) — dropdown menu and the modal it opens for sign in/up
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const accountMenuRef = useRef(null);

  // Mobile nav drawer — the rail collapses into a top bar + slide-in menu below 760px
  const [showMobileNav, setShowMobileNav] = useState(false);

  // Deletion in-flight trackers, so the relevant row can show a "Deleting…" state and disable itself
  const [deletingEntryId, setDeletingEntryId] = useState(null);
  const [deletingSessionId, setDeletingSessionId] = useState(null);

  // "Click once to arm, click again to confirm" state for delete buttons — avoids a separate
  // confirmation modal per row while still preventing one-click accidental deletion.
  const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState(null);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState(null);

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
  const [previousMentalModel, setPreviousMentalModel] = useState(null);
  const [mentalModelStatus, setMentalModelStatus] = useState(null);
  const [isMentalModelLoading, setIsMentalModelLoading] = useState(false);
  const [mentalModelError, setMentalModelError] = useState('');

  // Time-lapse: full history of snapshots, and which one (if any) is being scrubbed to.
  // When viewedHistoryIndex is null, the diagram shows the latest build (mentalModel) as before.
  const [mentalModelHistory, setMentalModelHistory] = useState([]);
  const [viewedHistoryIndex, setViewedHistoryIndex] = useState(null);

  // Node provenance panel — which node is selected, and the evidence excerpts it resolved to.
  const [selectedNode, setSelectedNode] = useState(null);
  const [nodeEvidence, setNodeEvidence] = useState(null); // { status: 'loading' | 'done' | 'error', items: [] }

  // Node-scoped chat — a focused conversation seeded with a single node's context.
  const [nodeChatMessages, setNodeChatMessages] = useState([]);
  const [nodeChatInput, setNodeChatInput] = useState('');
  const [isNodeChatLoading, setIsNodeChatLoading] = useState(false);
  const [nodeChatSessionId, setNodeChatSessionId] = useState(null);

  // Psych profile state
  const [psychProfile, setPsychProfile] = useState(null);
  const [previousPsychProfile, setPreviousPsychProfile] = useState(null);
  const [psychProfileStatus, setPsychProfileStatus] = useState(null);
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

  // Close the account dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!showAccountMenu) return;
    const handleClickOutside = (event) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) {
        setShowAccountMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAccountMenu]);

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
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE_URL}/api/ai/reflect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not get a reflection right now');
      setReflections((current) => ({ ...current, [key]: { status: 'done', text: data.reflection } }));
      // First reflection while signed out is the moment to invite saving — the reward came first,
      // so the ask doesn't feel like a wall.
      if (key === 'draft' && !token) {
        setShowSavePrompt(true);
      }
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

  const deleteChatSession = async (sessionId) => {
    if (!token) return;
    setDeletingSessionId(sessionId);
    try {
      const response = await fetch(`${API_BASE_URL}/api/chat/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) { clearAuth(); showToast('Your session expired — please sign in again'); return; }
      if (!response.ok && response.status !== 404) throw new Error();
      setChatSessions((current) => current.filter((s) => s.session_id !== sessionId));
      // If the conversation currently open in the chat view is the one we just deleted,
      // clear it out so the user isn't left looking at a "live" view of a deleted session.
      if (currentSessionId === sessionId) {
        setChatMessages([]);
        setCurrentSessionId(null);
      }
      showToast('Conversation deleted');
    } catch {
      showToast('Unable to delete conversation');
    } finally {
      setDeletingSessionId(null);
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

  // Load status (and last snapshot, if any) when opening the Mental Model / Psych Profile tabs,
  // so returning users see their last result and an "update available" signal rather than a blank slate.
  useEffect(() => {
    if (activeView === 'mentalmodel' && token) {
      loadMentalModelStatus();
      loadMentalModelHistory();
    }
  }, [activeView, token]);

  useEffect(() => {
    if (activeView === 'psychprofile' && token) {
      loadPsychProfileStatus();
    }
  }, [activeView, token]);

  const loadMentalModelStatus = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/mental-model/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setMentalModelStatus(data);
      // If a snapshot already exists and we haven't loaded one into view yet, fetch it so
      // reopening the tab shows the last result instantly instead of an empty state.
      if (data.has_snapshot && !mentalModel) {
        const latestResponse = await fetch(`${API_BASE_URL}/api/ai/mental-model/latest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (latestResponse.ok) {
          const latestData = await latestResponse.json();
          setMentalModel(latestData);
        }
      }
    } catch {
      // Status is a soft enhancement, but the gate still needs *something* to render against —
      // fall back to the entry count we already have client-side rather than spinning forever.
      setMentalModelStatus((current) => current || {
        has_snapshot: false,
        entries_total: entries.length,
        entries_required: 5,
        entries_remaining: Math.max(0, 5 - entries.length),
        unlocked: entries.length >= 5,
        update_available: false,
        last_built_at: null,
        last_entry_count: null,
      });
    }
  };

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
      setPreviousMentalModel(mentalModel);
      setMentalModel(data);
      setViewedHistoryIndex(null);
      setSelectedNode(null);
      setNodeEvidence(null);
      loadMentalModelStatus();
      loadMentalModelHistory();
    } catch (error) {
      setMentalModelError(error.message || 'Could not build mental model');
    } finally {
      setIsMentalModelLoading(false);
    }
  };

  const loadMentalModelHistory = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/mental-model/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const data = await response.json();
      setMentalModelHistory(data.snapshots || []);
    } catch {
      // Time-lapse is a soft enhancement on top of the existing latest-snapshot view — if it
      // fails to load, the rest of the Mental Model tab still works fine.
    }
  };

  // Resolve the evidence ids a node cites into the actual journal/chat excerpts they came from.
  const loadNodeEvidence = async (node) => {
    if (!token || !node?.evidence?.length) {
      setNodeEvidence({ status: 'done', items: [] });
      return;
    }
    setNodeEvidence({ status: 'loading', items: [] });
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: node.evidence }),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setNodeEvidence({ status: 'done', items: data.items || [] });
    } catch {
      setNodeEvidence({ status: 'error', items: [] });
    }
  };

  const selectMentalModelNode = (node) => {
    setSelectedNode(node);
    setNodeChatMessages([]);
    setNodeChatInput('');
    setNodeChatSessionId(null);
    loadNodeEvidence(node);
  };

  const closeNodePanel = () => {
    setSelectedNode(null);
    setNodeEvidence(null);
    setNodeChatMessages([]);
    setNodeChatSessionId(null);
  };

  const sendNodeChatMessage = async () => {
    if (!token || !selectedNode || !nodeChatInput.trim()) return;
    const userMessage = { role: 'user', content: nodeChatInput.trim() };
    const nextMessages = [...nodeChatMessages, userMessage];
    setNodeChatMessages(nextMessages);
    setNodeChatInput('');
    setIsNodeChatLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/mental-model/node-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          node_label: selectedNode.label,
          node_type: selectedNode.type,
          node_description: selectedNode.description,
          evidence_ids: selectedNode.evidence || [],
          messages: nextMessages,
          session_id: nodeChatSessionId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not send that message');
      setNodeChatSessionId(data.session_id);
      setNodeChatMessages((current) => [...current, { role: 'assistant', content: data.reply }]);
    } catch (error) {
      setNodeChatMessages((current) => [...current, { role: 'assistant', content: error.message || "Couldn't get a reply just now — try again?", isError: true }]);
    } finally {
      setIsNodeChatLoading(false);
    }
  };

  const loadPsychProfileStatus = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/psych-profile/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setPsychProfileStatus(data);
      if (data.has_snapshot && !psychProfile) {
        const latestResponse = await fetch(`${API_BASE_URL}/api/ai/psych-profile/latest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (latestResponse.ok) {
          const latestData = await latestResponse.json();
          setPsychProfile(latestData);
        }
      }
    } catch {
      setPsychProfileStatus((current) => current || {
        has_snapshot: false,
        entries_total: entries.length,
        entries_required: 5,
        entries_remaining: Math.max(0, 5 - entries.length),
        unlocked: entries.length >= 5,
        update_available: false,
        last_built_at: null,
        last_entry_count: null,
      });
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
      setPreviousPsychProfile(psychProfile);
      setPsychProfile(data);
      loadPsychProfileStatus();
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
    setMentalModel(null);
    setPreviousMentalModel(null);
    setMentalModelStatus(null);
    setMentalModelHistory([]);
    setViewedHistoryIndex(null);
    setSelectedNode(null);
    setNodeEvidence(null);
    setNodeChatMessages([]);
    setNodeChatSessionId(null);
    setPsychProfile(null);
    setPreviousPsychProfile(null);
    setPsychProfileStatus(null);
    setShowAccountMenu(false);
    setShowAccountModal(false);
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
    if (!token) {
      // Don't dead-end here — this is exactly the moment to invite account creation,
      // with their writing already in hand rather than asking for it up front.
      setShowSavePrompt(true);
      showToast('Create a free account to save this');
      return;
    }
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
      setShowSavePrompt(false);
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

  const deleteEntry = async (entryId) => {
    if (!token) return;
    setDeletingEntryId(entryId);
    try {
      const response = await fetch(`${API_BASE_URL}/api/journal/entries/${entryId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) { clearAuth(); showToast('Your session expired — please sign in again'); return; }
      if (!response.ok && response.status !== 404) throw new Error();
      setEntries((current) => current.filter((e) => e.id !== entryId));
      if (expandedEntryId === entryId) setExpandedEntryId(null);
      showToast('Entry deleted');
    } catch {
      showToast('Unable to delete entry');
    } finally {
      setDeletingEntryId(null);
    }
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
        setShowSavePrompt(false);
        setShowAccountModal(false);

        // If they wrote something before signing in, save it now rather than asking them to
        // press "save" again — the whole point of writing-first is that nothing gets lost.
        if (editorValue.trim()) {
          try {
            const entryResponse = await fetch(`${API_BASE_URL}/api/journal/entries`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.access_token}` },
              body: JSON.stringify({ content: editorValue, mood, status: 'draft' }),
            });
            if (entryResponse.ok) {
              const entryData = await entryResponse.json();
              setEntries((current) => [mapEntryToViewModel(entryData), ...current]);
              setEditorValue('');
              showToast(`Welcome, ${profile.display_name} — your entry is saved`);
            } else {
              showToast(`Welcome back, ${profile.display_name}`);
            }
          } catch {
            showToast(`Welcome back, ${profile.display_name}`);
          }
        } else {
          showToast(`Welcome back, ${profile.display_name}`);
        }
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
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-nav-toggle"
          aria-label={showMobileNav ? 'Close menu' : 'Open menu'}
          aria-expanded={showMobileNav}
          onClick={() => setShowMobileNav((current) => !current)}
        >
          {showMobileNav ? (
            <svg viewBox="0 0 20 20" fill="none"><path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          )}
        </button>
        <div className="brand brand-mobile">
          <svg className="brand-mark" viewBox="0 0 28 28" fill="none">
            <path d="M4 14C4 14 7 6 14 6C21 6 24 14 24 14C24 14 21 22 14 22C7 22 4 14 4 14Z" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="14" cy="14" r="2.6" fill="currentColor" />
          </svg>
          <span>Quietly</span>
        </div>
        <button
          type="button"
          className="mobile-avatar-btn"
          aria-label="Account"
          onClick={() => { setShowMobileNav(false); setShowAccountMenu((current) => !current); }}
        >
          <div className="avatar avatar-sm">{user ? user.display_name?.[0]?.toUpperCase() || 'U' : 'U'}</div>
        </button>
      </header>

      {showMobileNav ? (
        <button type="button" className="mobile-nav-backdrop" aria-label="Close menu" onClick={() => setShowMobileNav(false)} />
      ) : null}

      <aside className={`rail ${showMobileNav ? 'is-open' : ''}`}>
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
          <button type="button" className={`rail-link ${activeView === 'write' ? 'is-active' : ''}`} onClick={() => goToView('write')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 17.5h14M4 13.5l1-3.6L13.6 1.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8 13l-4 .5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
            Write
          </button>
          <button type="button" className={`rail-link ${activeView === 'entries' ? 'is-active' : ''}`} onClick={() => goToView('entries')}>
            <svg viewBox="0 0 20 20" fill="none"><rect x="3.5" y="2.5" width="13" height="15" rx="1.4" stroke="currentColor" strokeWidth="1.3" /><path d="M6.5 6.5h7M6.5 9.5h7M6.5 12.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
            Past entries
          </button>
          <button type="button" className={`rail-link ${activeView === 'patterns' ? 'is-active' : ''}`} onClick={() => goToView('patterns')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 16V8M9 16V4M15 16v-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M3 16h14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            Patterns
          </button>
          <button type="button" className={`rail-link ${activeView === 'chat' ? 'is-active' : ''}`} onClick={() => goToView('chat')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M3.5 4.5h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 2.5V5.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
            Talk it out
          </button>
          <button type="button" className={`rail-link ${activeView === 'mentalmodel' ? 'is-active' : ''}`} onClick={() => goToView('mentalmodel')}>
            <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.2" /><circle cx="4" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="16" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="4" cy="15" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="16" cy="15" r="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 5.8L8.5 8.5M11.5 8.5L14.5 5.8M5.5 14.2L8.5 11.5M11.5 11.5L14.5 14.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
            Mental model
          </button>
          <button type="button" className={`rail-link ${activeView === 'psychprofile' ? 'is-active' : ''}`} onClick={() => goToView('psychprofile')}>
            <svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5C7 2.5 4.5 5 4.5 8c0 2.1 1.1 3.9 2.8 4.9V15h5.4v-2.1c1.7-1 2.8-2.8 2.8-4.9 0-3-2.5-5.5-5.5-5.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M7.5 17.5h5M8.5 15.5v2M11.5 15.5v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            Psych profile
          </button>
          <button type="button" className={`rail-link rail-help rail-help-in-nav ${activeView === 'support' ? 'is-active' : ''}`} onClick={() => goToView('support')}>
            <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.3" stroke="currentColor" strokeWidth="1.3" /><path d="M10 11.2v-.4c0-.7.4-1 .95-1.4.6-.4 1-.85 1-1.6 0-1-.85-1.8-1.95-1.8s-1.95.8-1.95 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="10" cy="13.7" r="0.15" fill="currentColor" stroke="currentColor" strokeWidth="0.9" /></svg>
            If you need support
          </button>
        </nav>

        <div className="rail-bottom">
          <div className="rail-profile-wrap">
            <button
              type="button"
              className="rail-profile"
              onClick={() => setShowAccountMenu((current) => !current)}
              aria-haspopup="menu"
              aria-expanded={showAccountMenu}
            >
              <div className="avatar">{user ? user.display_name?.[0]?.toUpperCase() || 'U' : 'U'}</div>
              <div className="rail-profile-text">
                <span className="rail-profile-name">{user ? user.display_name : 'Guest'}</span>
                <span className="rail-profile-streak">{token ? 'Signed in' : 'Sign in to save'}</span>
              </div>
            </button>
          </div>
        </div>
      </aside>

      {showAccountMenu ? (
        <div className="account-menu" role="menu" ref={accountMenuRef}>
          {token ? (
            <>
              <div className="account-menu-info">
                <span className="account-menu-name">{user?.display_name}</span>
                <span className="account-menu-email">{user?.email}</span>
              </div>
              <button
                type="button"
                className="account-menu-item account-menu-item-danger"
                role="menuitem"
                onClick={() => { setShowAccountMenu(false); handleLogout(); }}
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="account-menu-item"
                role="menuitem"
                onClick={() => { setAuthMode('login'); setAuthMessage(''); setShowAccountMenu(false); setShowAccountModal(true); }}
              >
                Sign in
              </button>
              <button
                type="button"
                className="account-menu-item"
                role="menuitem"
                onClick={() => { setAuthMode('register'); setAuthMessage(''); setShowAccountMenu(false); setShowAccountModal(true); }}
              >
                Create account
              </button>
            </>
          )}
        </div>
      ) : null}

      {showAccountModal ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Sign in or create an account" onClick={(e) => { if (e.target === e.currentTarget) setShowAccountModal(false); }}>
          <div className="modal-card">
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowAccountModal(false)}>
              <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
            <AuthForm
              authMode={authMode}
              setAuthMode={setAuthMode}
              email={email}
              setEmail={setEmail}
              password={password}
              setPassword={setPassword}
              displayName={displayName}
              setDisplayName={setDisplayName}
              authMessage={authMessage}
              setAuthMessage={setAuthMessage}
              isAuthSubmitting={isAuthSubmitting}
              onSubmit={handleAuth}
              heading={authMode === 'login' ? 'Sign in to Quietly' : 'Create your account'}
              subheading={authMode === 'login' ? 'Welcome back.' : 'Takes a few seconds — your entries stay private to your account.'}
              onCancel={() => setShowAccountModal(false)}
              cancelLabel="Cancel"
            />
          </div>
        </div>
      ) : null}

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
          {!token && !showSavePrompt ? (
            <div className="auth-card" style={{ paddingBottom: 10 }}>
              <div className="auth-card-head">
                <h3>Just write — there's nothing to fill in first</h3>
                <p className="auth-card-sub">
                  Ask for a reflection any time. When you want to keep what you write,{' '}
                  <button type="button" className="text-link" style={{ display: 'inline', padding: 0 }} onClick={() => setShowSavePrompt(true)}>
                    sign in or create an account
                  </button>.
                </p>
              </div>
            </div>
          ) : null}

          {!token && showSavePrompt ? (
            <AuthForm
              authMode={authMode}
              setAuthMode={setAuthMode}
              email={email}
              setEmail={setEmail}
              password={password}
              setPassword={setPassword}
              displayName={displayName}
              setDisplayName={setDisplayName}
              authMessage={authMessage}
              setAuthMessage={setAuthMessage}
              isAuthSubmitting={isAuthSubmitting}
              onSubmit={handleAuth}
              heading={authMode === 'login' ? 'Sign in to save this' : 'Create an account to save this'}
              subheading={authMode === 'login' ? 'Your entries stay private to your account.' : 'Takes a few seconds — what you wrote will be saved automatically.'}
              onCancel={() => setShowSavePrompt(false)}
              cancelLabel="Keep writing"
            />
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

        {!token && reflections.draft?.status === 'done' && showSavePrompt === false ? (
          <div className="anon-save-prompt" role="note">
            <p><strong>Want to keep this?</strong> Create a free account and this entry will be saved.</p>
            <div className="anon-save-prompt-actions">
              <button className="solid-btn" onClick={() => setShowSavePrompt(true)}>Save this entry</button>
            </div>
          </div>
        ) : null}

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
                <button type="button" className={`entry-row ${isExpanded ? 'is-expanded' : ''}`} onClick={() => { setExpandedEntryId(isExpanded ? null : entry.id); setConfirmDeleteEntryId(null); }} aria-expanded={isExpanded}>
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
                      <button
                        type="button"
                        className={`ghost-btn ghost-btn-danger ${confirmDeleteEntryId === entry.id ? 'is-armed' : ''}`}
                        disabled={deletingEntryId === entry.id}
                        onClick={() => {
                          if (confirmDeleteEntryId === entry.id) {
                            setConfirmDeleteEntryId(null);
                            deleteEntry(entry.id);
                          } else {
                            setConfirmDeleteEntryId(entry.id);
                          }
                        }}
                      >
                        {deletingEntryId === entry.id ? 'Deleting…' : confirmDeleteEntryId === entry.id ? 'Click to confirm' : 'Delete entry'}
                      </button>
                      {confirmDeleteEntryId === entry.id ? (
                        <button type="button" className="text-link" onClick={() => setConfirmDeleteEntryId(null)}>
                          Cancel
                        </button>
                      ) : null}
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
                  <div key={session.session_id} className="session-row-wrap">
                    <button
                      type="button"
                      className="entry-row session-row"
                      onClick={() => loadChatSession(session.session_id)}
                      disabled={loadingSessionId === session.session_id || deletingSessionId === session.session_id}
                    >
                      <div className="entry-date">
                        <strong>{formatDate(session.started_at, { month: 'short', day: 'numeric' })}</strong>
                        {formatDate(session.started_at, { weekday: 'short' })}
                      </div>
                      <div className="entry-body">
                        <p className="entry-snippet">{session.preview || 'No preview available'}</p>
                        <span className="entry-meta">
                          {session.session_type === 'node_chat' && session.node_label && (
                            <span className="session-node-badge">⬡ {session.node_label}</span>
                          )}
                          {session.message_count} messages
                        </span>
                      </div>
                      <div className="entry-save">
                        {loadingSessionId === session.session_id ? 'Loading…' : '→'}
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`session-delete-btn ${confirmDeleteSessionId === session.session_id ? 'is-armed' : ''}`}
                      disabled={deletingSessionId === session.session_id}
                      aria-label={confirmDeleteSessionId === session.session_id ? 'Click to confirm deletion' : 'Delete conversation'}
                      title={confirmDeleteSessionId === session.session_id ? 'Click to confirm deletion' : 'Delete conversation'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirmDeleteSessionId === session.session_id) {
                          setConfirmDeleteSessionId(null);
                          deleteChatSession(session.session_id);
                        } else {
                          setConfirmDeleteSessionId(session.session_id);
                        }
                      }}
                    >
                      {deletingSessionId === session.session_id ? (
                        '…'
                      ) : confirmDeleteSessionId === session.session_id ? (
                        'Confirm?'
                      ) : (
                        <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 5h9M6.5 5V3.6c0-.5.4-.9.9-.9h1.2c.5 0 .9.4.9.9V5M5 5l.5 7.4c0 .6.5 1.1 1.1 1.1h2.8c.6 0 1.1-.5 1.1-1.1L11 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      )}
                    </button>
                  </div>
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
          {token && mentalModelStatus?.unlocked && (
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

        {token && !mentalModelStatus && (
          <div className="mental-model-loading">
            <div className="mental-model-spinner" />
          </div>
        )}

        {token && mentalModelStatus && !mentalModelStatus.unlocked && (
          <div className="analysis-gate">
            <svg viewBox="0 0 64 64" fill="none" className="analysis-gate-icon">
              <circle cx="32" cy="32" r="8" stroke="#C9A893" strokeWidth="1.5" />
              <circle cx="12" cy="16" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <circle cx="52" cy="16" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <circle cx="12" cy="48" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <circle cx="52" cy="48" r="5" stroke="#C9A893" strokeWidth="1.2" />
              <path d="M17 19l11 10M36 25l11-9M17 45l11-10M36 39l11 9" stroke="#D8D2C4" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <p className="analysis-gate-title">
              Write {mentalModelStatus.entries_remaining} more {mentalModelStatus.entries_remaining === 1 ? 'journal entry or conversation' : 'journal entries or conversations'} to unlock your mental model.
            </p>
            <div className="analysis-gate-progress">
              <div className="analysis-gate-track">
                <div
                  className="analysis-gate-fill"
                  style={{ width: `${Math.min(100, (mentalModelStatus.entries_total / mentalModelStatus.entries_required) * 100)}%` }}
                />
              </div>
              <span className="analysis-gate-count">{mentalModelStatus.entries_total} of {mentalModelStatus.entries_required} entries or conversations</span>
            </div>
            <div className="analysis-gate-preview">
              <div className="analysis-gate-preview-blur">
                <div className="mental-model-node-card">
                  <div className="mental-model-node-header">
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#E7DCCB', border: '1.5px solid #C9A893', flexShrink: 0 }} />
                    <span className="mental-model-node-label">The quiet ache</span>
                    <span className="mental-model-node-type">tension</span>
                  </div>
                  <p className="mental-model-node-desc">Something you've circled around in a few entries without quite naming.</p>
                </div>
              </div>
              <div className="analysis-gate-preview-label">What it'll look like</div>
            </div>
          </div>
        )}

        {token && mentalModelStatus?.unlocked && !mentalModel && !isMentalModelLoading && !mentalModelError && (
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

        {activeView === 'mentalmodel' && mentalModel && !isMentalModelLoading && (() => {
          // When scrubbing the time-lapse slider, show that historical snapshot instead of the
          // latest build — but keep the "rebuild" banner and button tied to the real latest state.
          const displayedSnapshot = viewedHistoryIndex !== null ? mentalModelHistory[viewedHistoryIndex] : mentalModel;
          const diffPrevious = viewedHistoryIndex !== null
            ? mentalModelHistory[viewedHistoryIndex - 1] || null
            : previousMentalModel;
          const isViewingPast = viewedHistoryIndex !== null && viewedHistoryIndex !== mentalModelHistory.length - 1;

          return (
            <div className="mental-model-content">
              {mentalModelStatus?.update_available && !isViewingPast && (
                <div className="analysis-update-banner">
                  <p>You've written more since this was built — <strong>your map may have shifted.</strong></p>
                  <button className="ghost-btn" onClick={loadMentalModel} disabled={isMentalModelLoading}>Update now</button>
                </div>
              )}

              {mentalModelHistory.length > 1 && (
                <div className="mental-model-timelapse">
                  <div className="mental-model-timelapse-header">
                    <span className="mental-model-timelapse-title">Time-lapse</span>
                    <span className="mental-model-timelapse-date">
                      {formatDate(new Date(displayedSnapshot.created_at), { month: 'short', day: 'numeric', year: 'numeric' })}
                      {isViewingPast ? ' (past snapshot)' : ' (latest)'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={mentalModelHistory.length - 1}
                    value={viewedHistoryIndex !== null ? viewedHistoryIndex : mentalModelHistory.length - 1}
                    onChange={(e) => {
                      const idx = Number(e.target.value);
                      setViewedHistoryIndex(idx === mentalModelHistory.length - 1 ? null : idx);
                      setSelectedNode(null);
                      setNodeEvidence(null);
                    }}
                    className="mental-model-timelapse-slider"
                    aria-label="Scrub through past mental model snapshots"
                  />
                  <p className="mental-model-timelapse-hint">Drag to watch your map shift over {mentalModelHistory.length} builds.</p>
                </div>
              )}

              {(() => {
                const diff = diffMentalModels(diffPrevious, displayedSnapshot);
                if (!diff) return null;
                return (
                  <div className="analysis-diff">
                    <p className="analysis-diff-title">{isViewingPast ? 'Compared to the snapshot before' : 'Since last time'}</p>
                    <ul className="analysis-diff-list">
                      {diff.newcomers.map((n) => (
                        <li key={`new-${n.id}`}><span>{n.label}</span> showed up for the first time.</li>
                      ))}
                      {diff.shifted.map((s) => (
                        <li key={`shift-${s.label}`}>
                          <span>{s.label}</span> moved from {s.from} to {s.to}{' '}
                          <span className={s.to > s.from ? 'analysis-diff-up' : 'analysis-diff-down'}>
                            ({s.to > s.from ? '↑' : '↓'} {Math.abs(s.to - s.from)})
                          </span>
                        </li>
                      ))}
                      {diff.faded.map((n) => (
                        <li key={`faded-${n.id}`}><span>{n.label}</span> has faded from the picture.</li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

              <div className="mental-model-summary">
                <svg viewBox="0 0 20 20" fill="none" className="reflect-card-icon" style={{ flexShrink: 0, marginTop: 2 }}>
                  <path d="M10 2.5l1.4 4.1 4.1 1.4-4.1 1.4L10 13.5l-1.4-4.1-4.1-1.4 4.1-1.4L10 2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                </svg>
                <p>{displayedSnapshot.summary}</p>
              </div>

              <div className="mental-model-diagram">
                <BrainDiagram3D
                  nodes={displayedSnapshot.nodes}
                  edges={displayedSnapshot.edges}
                  onNodeClick={selectMentalModelNode}
                  selectedNodeId={selectedNode?.id}
                />
                <p className="mental-model-diagram-hint">Click a node to see what it's drawn from, or talk it through.</p>
              </div>

              {selectedNode && (
                <div className="mental-model-node-panel">
                  <div className="mental-model-node-panel-header">
                    <div>
                      <span className="mental-model-node-panel-label">{selectedNode.label}</span>
                      <span className="mental-model-node-type">{selectedNode.type}</span>
                    </div>
                    <button className="ghost-btn" onClick={closeNodePanel} aria-label="Close">Close</button>
                  </div>
                  <p className="mental-model-node-desc">{selectedNode.description}</p>

                  <div className="mental-model-evidence">
                    <h4 className="mental-model-evidence-title">What this is drawn from</h4>
                    {nodeEvidence?.status === 'loading' && <p className="mental-model-evidence-loading">Looking it up…</p>}
                    {nodeEvidence?.status === 'error' && <p className="mental-model-evidence-loading">Could not load the source entries.</p>}
                    {nodeEvidence?.status === 'done' && nodeEvidence.items.length === 0 && (
                      <p className="mental-model-evidence-loading">No specific entries were cited for this one — it reflects a broader pattern across your writing.</p>
                    )}
                    {nodeEvidence?.status === 'done' && nodeEvidence.items.length > 0 && (
                      <ul className="mental-model-evidence-list">
                        {nodeEvidence.items.map((item) => (
                          <li key={item.id} className="mental-model-evidence-item">
                            <span className="mental-model-evidence-meta">
                              {item.type === 'journal' ? 'Journal' : 'Chat'}
                              {item.created_at ? ` · ${formatDate(new Date(item.created_at), { month: 'short', day: 'numeric' })}` : ''}
                            </span>
                            <p>"{item.content}"</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="mental-model-node-chat">
                    <h4 className="mental-model-evidence-title">Talk about this</h4>
                    {nodeChatMessages.length > 0 && (
                      <div className="mental-model-node-chat-thread">
                        {nodeChatMessages.map((msg, i) => (
                          <div key={i} className={`mental-model-node-chat-msg ${msg.role} ${msg.isError ? 'is-error' : ''}`}>
                            {msg.content}
                          </div>
                        ))}
                        {isNodeChatLoading && <div className="mental-model-node-chat-msg assistant is-loading">Thinking…</div>}
                      </div>
                    )}
                    <form
                      className="mental-model-node-chat-form"
                      onSubmit={(e) => { e.preventDefault(); sendNodeChatMessage(); }}
                    >
                      <input
                        type="text"
                        value={nodeChatInput}
                        onChange={(e) => setNodeChatInput(e.target.value)}
                        placeholder={`Ask about "${selectedNode.label}"…`}
                        disabled={isNodeChatLoading}
                      />
                      <button type="submit" className="solid-btn" disabled={isNodeChatLoading || !nodeChatInput.trim()}>Send</button>
                    </form>
                  </div>
                </div>
              )}

              <div className="mental-model-nodes-list">
                <h3 className="mental-model-nodes-title">What's in the map</h3>
                <div className="mental-model-nodes-grid">
                  {[...displayedSnapshot.nodes].sort((a, b) => b.weight - a.weight).map((node) => {
                    const colors = NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.theme;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`mental-model-node-card ${selectedNode?.id === node.id ? 'is-selected' : ''}`}
                        onClick={() => selectMentalModelNode(node)}
                      >
                        <div className="mental-model-node-header">
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.fill, border: `1.5px solid ${colors.stroke}`, flexShrink: 0 }} />
                          <span className="mental-model-node-label">{node.label}</span>
                          <span className="mental-model-node-type">{node.type}</span>
                        </div>
                        <p className="mental-model-node-desc">{node.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {displayedSnapshot.created_at && (
                <span className="analysis-meta">
                  Built {formatDate(new Date(displayedSnapshot.created_at), { month: 'short', day: 'numeric' })} from {displayedSnapshot.entry_count_at_build} {displayedSnapshot.entry_count_at_build === 1 ? 'entry' : 'entries'}.
                </span>
              )}
            </div>
          );
        })()}
      </main>

      {/* ── Psychological Profile ── */}
      <main className={`page ${activeView === 'psychprofile' ? '' : 'is-hidden'}`} id="view-psychprofile">
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Psychological profile</span>
            <h1 className="page-title">A mirror, not a verdict</h1>
          </div>
          {token && psychProfileStatus?.unlocked && (
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

        {token && !psychProfileStatus && (
          <div className="mental-model-loading">
            <div className="mental-model-spinner" />
          </div>
        )}

        {token && psychProfileStatus && !psychProfileStatus.unlocked && (
          <div className="analysis-gate">
            <svg viewBox="0 0 64 64" fill="none" className="analysis-gate-icon">
              <path d="M32 8C22 8 14 16 14 26c0 7 3.6 13.2 9.2 16.8V46h17.6v-3.2C46.4 39.2 50 33 50 26c0-10-8-18-18-18Z" stroke="#C9A893" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M24 54h16M27 46v8M37 46v8" stroke="#C9A893" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <p className="analysis-gate-title">
              Write {psychProfileStatus.entries_remaining} more {psychProfileStatus.entries_remaining === 1 ? 'journal entry or conversation' : 'journal entries or conversations'} to unlock your psychological profile.
            </p>
            <div className="analysis-gate-progress">
              <div className="analysis-gate-track">
                <div
                  className="analysis-gate-fill"
                  style={{ width: `${Math.min(100, (psychProfileStatus.entries_total / psychProfileStatus.entries_required) * 100)}%` }}
                />
              </div>
              <span className="analysis-gate-count">{psychProfileStatus.entries_total} of {psychProfileStatus.entries_required} entries or conversations</span>
            </div>
            <div className="analysis-gate-preview">
              <div className="analysis-gate-preview-blur">
                <div className="psych-trait-card">
                  <div className="psych-trait-head">
                    <div>
                      <span className="psych-trait-label">Openness</span>
                      <span className="psych-trait-desc">Curiosity, imagination, breadth of experience</span>
                    </div>
                    <span className="psych-trait-badge" style={{ background: '#B8D4C8' }}>High</span>
                  </div>
                  <div className="psych-bar-track">
                    <div className="psych-bar-fill" style={{ width: '72%', background: '#B8D4C8' }} />
                  </div>
                </div>
              </div>
              <div className="analysis-gate-preview-label">What it'll look like</div>
            </div>
          </div>
        )}

        {token && psychProfileStatus?.unlocked && !psychProfile && !isPsychLoading && !psychError && (
          <div className="mental-model-empty">
            <svg viewBox="0 0 64 64" fill="none" className="mental-model-empty-icon">
              <path d="M32 8C22 8 14 16 14 26c0 7 3.6 13.2 9.2 16.8V46h17.6v-3.2C46.4 39.2 50 33 50 26c0-10-8-18-18-18Z" stroke="#C9A893" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M24 54h16M27 46v8M37 46v8" stroke="#C9A893" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <p>Press "Build my profile" to generate a psychological profile from your journal entries and conversations.</p>
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

            {psychProfileStatus?.update_available && (
              <div className="analysis-update-banner">
                <p>You've written more since this was built — <strong>your profile may have shifted.</strong></p>
                <button className="ghost-btn" onClick={loadPsychProfile} disabled={isPsychLoading}>Update now</button>
              </div>
            )}

            {(() => {
              const diff = diffPsychProfiles(previousPsychProfile, psychProfile);
              if (!diff) return null;
              const dimLabels = { openness: 'Openness', conscientiousness: 'Conscientiousness', extraversion: 'Extraversion', agreeableness: 'Agreeableness', neuroticism: 'Neuroticism' };
              return (
                <div className="analysis-diff">
                  <p className="analysis-diff-title">Since last time</p>
                  <ul className="analysis-diff-list">
                    {diff.shifts.map((s) => (
                      <li key={s.dim}>
                        <span>{dimLabels[s.dim]}</span> moved from {s.from} to {s.to}{' '}
                        <span className={s.to > s.from ? 'analysis-diff-up' : 'analysis-diff-down'}>
                          ({s.to > s.from ? '↑' : '↓'} {Math.abs(s.to - s.from)})
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

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

            {psychProfile.created_at && (
              <span className="analysis-meta">
                Built {formatDate(new Date(psychProfile.created_at), { month: 'short', day: 'numeric' })} from {psychProfile.entry_count_at_build} {psychProfile.entry_count_at_build === 1 ? 'entry' : 'entries'}.
              </span>
            )}

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

// ===================================================================
// Quietly — frontend behavior (mock data, no backend)
// ===================================================================

const MOOD_COLORS = {1:'#5B6B73', 2:'#7E8A8F', 3:'#A8927E', 4:'#B98B6C', 5:'#A8765E'};
const MOOD_LABELS = {1:'Heavy', 2:'Low', 3:'Steady', 4:'Lighter', 5:'Open'};

const PROMPTS = [
  "No pressure to make this make sense. Just say where you are right now.",
  "What took more energy than it should have today?",
  "Write down one thing you didn't say out loud today.",
  "What would you tell a friend who described your day back to you?",
  "What's the smallest thing that helped, even a little?",
  "If today had a weather forecast, what would it be?",
];

// ---- Mock data: last 30 days ----
function generateMockEntries(days){
  const entries = [];
  const today = new Date();
  const snippets = [
    "Didn't sleep well but the morning walk helped more than I expected.",
    "Felt okay until the 3pm meeting, then it all went sideways.",
    "Good day, actually. Called my sister and we just talked for an hour.",
    "Hard to put into words. Just heavy, all day, for no clear reason.",
    "Small win: finished the thing I'd been avoiding for a week.",
    "Tired in a way that sleep doesn't fix.",
    "Noticed I felt lighter after writing yesterday. Trying again today.",
    "Argument with my partner. Still sitting with it.",
    "Quiet day. Read on the porch. Nothing dramatic, which was nice.",
    "Anxious about tomorrow's appointment. Trying not to spiral.",
    "Realized I've been comparing myself to people online again.",
    "Good session with my therapist. Talked about the pattern with my dad.",
  ];
  for(let i=0; i<days; i++){
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    // skip some days to feel real (not every day journaled)
    if(Math.random() < 0.18 && i !== 0) continue;
    const mood = Math.max(1, Math.min(5, Math.round(2.8 + Math.sin(i/3.2)*1.3 + (Math.random()-0.5)*1.4)));
    entries.push({
      date: d,
      mood,
      snippet: snippets[Math.floor(Math.random()*snippets.length)],
      words: 40 + Math.floor(Math.random()*260),
      hour: [7,8,9,13,21,22,23][Math.floor(Math.random()*7)],
      saved: Math.random() < 0.15,
    });
  }
  return entries.reverse(); // oldest -> newest
}

const ALL_ENTRIES = generateMockEntries(30);

// ===================================================================
// Feeling thread SVG — the signature element.
// A hand-drawn-feeling horizontal line; each entry is a mark whose
// vertical offset + color encode mood. Built with a gentle organic
// wobble rather than a straight ruled line.
// ===================================================================
function buildThreadSVG(entries, opts={}){
  const w = opts.width || 900;
  const h = opts.height || 110;
  const padX = 24;
  const baseline = h * 0.58;
  const amp = opts.amp || 30; // how far marks travel from baseline based on mood

  const n = entries.length;
  const step = n > 1 ? (w - padX*2) / (n-1) : 0;

  // Build a gently wobbling path for the "thread" itself (mood-driven, smoothed)
  const points = entries.map((e,i) => {
    const x = padX + step*i;
    const y = baseline - (e.mood - 3) * amp * 0.5;
    return {x, y, e};
  });

  // smooth path using quadratic midpoints
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} `;
  for(let i=0; i<points.length-1; i++){
    const p0 = points[i], p1 = points[i+1];
    const mx = (p0.x + p1.x)/2, my = (p0.y + p1.y)/2;
    path += `Q ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)} `;
  }
  path += `T ${points[points.length-1].x.toFixed(1)} ${points[points.length-1].y.toFixed(1)}`;

  const marks = points.map((p,i) => {
    const color = MOOD_COLORS[p.e.mood];
    const label = MOOD_LABELS[p.e.mood];
    const dateStr = p.e.date.toLocaleDateString(undefined, {month:'short', day:'numeric'});
    const isToday = i === points.length - 1;
    return `
      <g class="thread-mark-group" tabindex="0">
        <title>${dateStr} — ${label}</title>
        <circle class="thread-mark" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isToday ? 5.5 : 4}"
          fill="${color}" stroke="${opts.bg || '#FFFFFF'}" stroke-width="2"/>
        ${isToday ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" fill="none" stroke="${color}" stroke-width="1" opacity="0.4"/>` : ''}
      </g>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" role="img" aria-label="Mood thread over time">
      <line x1="${padX}" y1="${baseline}" x2="${w-padX}" y2="${baseline}" stroke="#D8D2C4" stroke-width="1" stroke-dasharray="2 4"/>
      <path d="${path}" fill="none" stroke="#C9A893" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/>
      ${marks}
    </svg>
  `;
}

function renderThread(containerId, entries, opts){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = buildThreadSVG(entries, opts);
}

// ===================================================================
// View switching
// ===================================================================
const views = ['write','entries','patterns','support'];
function showView(name){
  views.forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('is-hidden', v !== name);
  });
  document.querySelectorAll('.rail-link').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
  window.scrollTo({top:0});
}

document.querySelectorAll('[data-view]').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ===================================================================
// Write view: today label, prompt rotation, mood selection, editor
// ===================================================================
document.getElementById('todayLabel').textContent =
  new Date().toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric'});

let promptIndex = 0;
document.getElementById('newPromptBtn').addEventListener('click', () => {
  promptIndex = (promptIndex + 1) % PROMPTS.length;
  const el = document.getElementById('promptLine');
  el.style.opacity = 0;
  setTimeout(() => {
    el.textContent = PROMPTS[promptIndex];
    el.style.opacity = 1;
  }, 150);
});
document.getElementById('promptLine').style.transition = 'opacity 0.15s ease';

document.querySelectorAll('.mood-dot').forEach(dot => {
  dot.addEventListener('click', () => {
    document.querySelectorAll('.mood-dot').forEach(d => d.classList.remove('is-selected'));
    dot.classList.add('is-selected');
  });
});

const editor = document.getElementById('editor');
const wordCount = document.getElementById('wordCount');
editor.addEventListener('input', () => {
  const words = editor.value.trim().split(/\s+/).filter(Boolean).length;
  wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
});

document.getElementById('saveDraftBtn').addEventListener('click', () => {
  flashButton('saveDraftBtn', 'Draft saved');
});
document.getElementById('closeEntryBtn').addEventListener('click', () => {
  if(!editor.value.trim()){
    flashButton('closeEntryBtn', 'Write something first');
    return;
  }
  flashButton('closeEntryBtn', "Today's entry closed");
});

function flashButton(id, message){
  const btn = document.getElementById(id);
  const original = btn.textContent;
  btn.textContent = message;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1600);
}

// ===================================================================
// Entries view
// ===================================================================
function renderEntryList(filter='all'){
  const list = document.getElementById('entryList');
  let entries = [...ALL_ENTRIES].reverse(); // newest first

  if(filter === 'heavy') entries = entries.filter(e => e.mood <= 2);
  if(filter === 'open') entries = entries.filter(e => e.mood >= 4);
  if(filter === 'flagged') entries = entries.filter(e => e.saved);

  if(entries.length === 0){
    list.innerHTML = `<p style="color:var(--slate); font-size:14px; padding:32px 8px;">Nothing here yet for this filter. That's not a problem to solve — just an empty shelf.</p>`;
    return;
  }

  list.innerHTML = entries.map(e => {
    const dateStr = e.date.toLocaleDateString(undefined, {month:'short', day:'numeric'});
    const weekday = e.date.toLocaleDateString(undefined, {weekday:'short'});
    return `
      <div class="entry-row">
        <div class="entry-date"><strong>${dateStr}</strong>${weekday}</div>
        <div class="entry-mood-mark" style="background:${MOOD_COLORS[e.mood]}" title="${MOOD_LABELS[e.mood]}"></div>
        <div class="entry-body">
          <p class="entry-snippet">${e.snippet}</p>
          <span class="entry-meta">${e.words} words · ${MOOD_LABELS[e.mood]}</span>
        </div>
        <div class="entry-save">${e.saved ? 'Saved ✓' : ''}</div>
      </div>
    `;
  }).join('');
}

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    renderEntryList(chip.dataset.filter);
  });
});

// ===================================================================
// Patterns view: time-of-day bars + word cloud (mock aggregation)
// ===================================================================
function renderTimeBars(){
  const buckets = {Morning:0, Midday:0, Evening:0, Night:0};
  ALL_ENTRIES.forEach(e => {
    if(e.hour < 11) buckets.Morning++;
    else if(e.hour < 17) buckets.Midday++;
    else if(e.hour < 21) buckets.Evening++;
    else buckets.Night++;
  });
  const max = Math.max(...Object.values(buckets), 1);
  const el = document.getElementById('timeBars');
  el.innerHTML = Object.entries(buckets).map(([label, count]) => `
    <div class="time-bar-col">
      <div class="time-bar" style="height:${(count/max*100).toFixed(0)}%"></div>
      <span class="time-bar-label">${label}</span>
    </div>
  `).join('');
}

function renderWordCloud(){
  const words = [
    ['tired', 28], ['better', 22], ['anxious', 19], ['okay', 26],
    ['work', 24], ['sleep', 17], ['quiet', 14], ['family', 15],
    ['progress', 12], ['heavy', 13], ['grateful', 11], ['stuck', 10],
  ];
  const max = Math.max(...words.map(w => w[1]));
  const el = document.getElementById('wordCloud');
  el.innerHTML = words.map(([w, n]) => {
    const size = 13 + (n/max) * 16;
    const opacity = 0.55 + (n/max) * 0.45;
    return `<span style="font-size:${size.toFixed(0)}px; opacity:${opacity.toFixed(2)}">${w}</span>`;
  }).join('');
}

// ===================================================================
// Init
// ===================================================================
renderThread('threadSvgHolder', ALL_ENTRIES.slice(-14), {height:100, amp:26});
renderThread('threadSvgHolderLarge', ALL_ENTRIES, {height:140, amp:32});
renderEntryList('all');
renderTimeBars();
renderWordCloud();

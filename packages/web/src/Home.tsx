import React, { useState, useEffect } from 'react';
import { typeLabel, TYPE_HINT, scopeName, cleanContent } from './format';

interface Memory {
  id: string;
  content: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'semantic';
  scope: string;
  state: string;
  importance: number;
  tags: string[];
  created_at: string;
}

interface DreamLog {
  id: string;
  scope: string;
  started_at: string;
  stats: Record<string, number>;
}

interface Stats {
  total: number;
  byState: Record<string, number>;
  byType: Record<string, number>;
  byScope: number;
  embeddings?: { provider: string; encoded: number };
}

interface HomeProps {
  stats: Stats;
  dreamLogs: DreamLog[];
  onOpenWorkspace: () => void;
  onSelectMemory: (id: string) => void;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const TYPE_DESC: Record<string, string> = {
  project: 'Architecture decisions, tech choices, constraints',
  user: 'Preferences, working style, communication patterns',
  feedback: 'Corrections, course-changes, things to avoid',
  reference: 'File paths, API endpoints, code pointers',
  episodic: 'What happened, when, in which session',
  semantic: 'Concepts, patterns, domain knowledge',
};

const CONCEPTS = [
  {
    icon: '◉',
    color: 'var(--accent)',
    label: 'Memories',
    desc: 'Each stored fact has a type, scope (global or project-specific), importance score, and a confidence that decays when it goes unrecalled — like a real memory fading without reinforcement.',
  },
  {
    icon: '◑',
    color: 'var(--color-episodic)',
    label: 'Dream (consolidation)',
    desc: 'Sleep-staged processing: NREM deduplicates near-identical memories, REM cross-links related ones, decay adjusts confidence, and reconciliation detects when a newer memory supersedes or contradicts an older one.',
  },
  {
    icon: '⬡',
    color: 'var(--color-reference)',
    label: 'The graph',
    desc: 'Memories aren\'t isolated — they connect via edges: relates-to, supersedes, contradicts, derived-from. Superseded facts fade in recall. Contradictions surface for review.',
  },
  {
    icon: '⌖',
    color: 'var(--color-user)',
    label: 'Search & recall',
    desc: 'Hybrid retrieval: BM25 keyword matching fused with transformer vector search (via Ollama) using reciprocal rank fusion. Finds memories by meaning, not just exact words.',
  },
  {
    icon: '◈',
    color: 'var(--color-feedback)',
    label: 'MCP tools',
    desc: 'AI assistants connect via Model Context Protocol. remember(), recall(), dream(), ask() — the full memory surface available from inside Claude, Cursor, or any MCP-compatible tool.',
  },
];

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  sources?: Memory[];
  /** Index pairs into sources that contradict each other (from the API). */
  conflicts?: [number, number][];
}

interface ModelStatus {
  report: { trained: boolean; n: number; accuracy?: number; baselineAccuracy?: number } | null;
  updatedAt: string | null;
  enabled: boolean;
}

interface MlStatus {
  models: Record<string, ModelStatus>;
  trainingData: { adjudicationsBySource: Record<string, number>; feedbackUsed: number; feedbackSkipped: number };
  llm: { consolidationModel: string; reconcileModel: string; lastDreamFallbacks: number };
}

interface EvalReport {
  queries: number;
  bm25: { recallAt5: number; mrr: number };
  hybrid: { recallAt5: number; mrr: number };
  reranked: { recallAt5: number; mrr: number };
}

interface ReversibleMutation {
  mutationId: string;
  phase: 'nrem-merge' | 'reconcile-supersede';
  createdAt: string;
  description: string;
  memoryIds: string[];
}

const MODEL_LABELS: Record<string, string> = {
  typeClassifier: 'Type suggest',
  prescreenNrem: 'Pre-screen · dedup',
  prescreenReconcile: 'Pre-screen · reconcile',
  reranker: 'Recall reranker',
};

function modelChip(m: ModelStatus): { text: string; color: string } {
  if (!m.enabled) return { text: 'off', color: 'var(--text-muted)' };
  if (m.report?.trained) return { text: `live · ${Math.round((m.report.accuracy ?? 0) * 100)}%`, color: 'var(--color-reference)' };
  return { text: 'learning', color: 'var(--accent)' };
}

const CHAT_STORAGE_KEY = 'mnemo-chat-thread';

function loadThread(): ChatTurn[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function Home({ stats, dreamLogs, onOpenWorkspace, onSelectMemory }: HomeProps) {
  const [recentMemories, setRecentMemories] = useState<Memory[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatThread, setChatThread] = useState<ChatTurn[]>(loadThread);
  const [mlStatus, setMlStatus] = useState<MlStatus | null>(null);
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null);
  const [evalRunning, setEvalRunning] = useState(false);
  const [reversible, setReversible] = useState<ReversibleMutation[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const chatEndRef = React.useRef<HTMLDivElement>(null);

  const loadAudit = () =>
    fetch('/api/dream-audit')
      .then(r => r.ok ? r.json() : [])
      .then(data => setReversible(Array.isArray(data) ? data : []))
      .catch(() => {});

  useEffect(() => {
    const load = () =>
      fetch('/api/memories?states=active,dormant&sort=recent&limit=15')
        .then(r => r.ok ? r.json() : [])
        .then(data => setRecentMemories(Array.isArray(data) ? data : []))
        .catch(() => {});
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetch('/api/ml-status')
      .then(r => r.ok ? r.json() : null)
      .then(setMlStatus)
      .catch(() => {});
    loadAudit();
  }, []);

  const undo = async (mutationId: string) => {
    if (undoing) return;
    setUndoing(mutationId);
    try {
      await fetch('/api/dream-audit/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutation_id: mutationId }),
      });
      await loadAudit();
    } catch { /* leave list as-is */ }
    setUndoing(null);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatThread]);

  // Survive a page refresh: the thread is the user's conversation state.
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatThread));
    } catch { /* storage full/blocked — thread just won't persist */ }
  }, [chatThread]);

  const runEval = async () => {
    if (evalRunning) return;
    setEvalRunning(true);
    try {
      const r = await fetch('/api/eval', { method: 'POST' });
      setEvalReport(await r.json());
    } catch { /* leave prior report */ }
    setEvalRunning(false);
  };

  const handleChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = chatInput.trim();
    if (!q || chatLoading) return;
    const userTurn: ChatTurn = { role: 'user', content: q };
    const nextThread = [...chatThread, userTurn];
    setChatThread(nextThread);
    setChatInput('');
    setChatLoading(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextThread.map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = await r.json();
      setChatThread(prev => [...prev, {
        role: 'assistant',
        content: data.message ?? 'No relevant memories found.',
        sources: data.sources ?? [],
        conflicts: data.conflicts ?? [],
      }]);
    } catch {
      setChatThread(prev => [...prev, { role: 'assistant', content: 'Something went wrong.', sources: [] }]);
    }
    setChatLoading(false);
  };

  const activeCount = stats.byState?.active ?? 0;
  const dormantCount = stats.byState?.dormant ?? 0;
  const embProvider = stats.embeddings?.provider;
  const embEncoded = stats.embeddings?.encoded ?? 0;
  const lastDream = dreamLogs[0];

  return (
    <div className="home-view">

      {/* ── HERO ── */}
      <div className="home-hero">
        <div className="home-hero-inner">
          <div className="home-eyebrow">memory infrastructure for AI agents</div>
          <h1 className="home-title">Your AI assistants<br />never forget.</h1>
          <p className="home-sub">
            mnemo gives AI tools a persistent, structured long-term memory. Every preference, decision, and
            piece of context gets stored, linked, and consolidated — across sessions, across projects,
            and across every tool that connects to it.
          </p>
          <div className="home-actions">
            <button className="primary home-cta" onClick={onOpenWorkspace}>Open Workspace →</button>
            <a href="/mnemo-scroll.html" target="_blank" rel="noopener" className="secondary home-cta">Architecture ↗</a>
            <a href="/astermind-scroll.html" target="_blank" rel="noopener" className="secondary home-cta">ML Docs ↗</a>
          </div>
        </div>
      </div>

      {/* ── CHAT ── */}
      <div className="home-ask">
        {chatThread.length > 0 && (
          <div className="home-chat-thread">
            {chatThread.map((turn, i) => (
              <div key={i} className={`home-chat-turn home-chat-turn--${turn.role}`}>
                {turn.role === 'user' ? (
                  <div className="home-chat-bubble home-chat-bubble--user">{turn.content}</div>
                ) : (
                  <>
                    <div className="home-chat-bubble home-chat-bubble--assistant">{turn.content}</div>
                    {turn.sources && turn.sources.length > 0 && (
                      <div className="home-ask-sources">
                        <div className="home-ask-sources-label">
                          {turn.sources.length} source{turn.sources.length !== 1 ? 's' : ''}
                        </div>
                        <div className="home-ask-source-list">
                          {turn.sources.map((m, si) => {
                            const conflicted = new Set((turn.conflicts ?? []).flat());
                            return (
                              <div
                                key={m.id}
                                className="home-ask-source-card"
                                onClick={() => { onSelectMemory(m.id); onOpenWorkspace(); }}
                                style={{ '--card-accent': `var(--color-${m.type})` } as React.CSSProperties}
                              >
                                <div className="home-ask-source-meta">
                                  <span className={`badge ${m.type}`} title={TYPE_HINT[m.type]}>{typeLabel(m.type)}</span>
                                  <span className="home-memory-scope">{scopeName(m.scope)}</span>
                                  {conflicted.has(si) && <span className="home-pill conflict">⚠ conflict</span>}
                                </div>
                                <div className="home-ask-source-text">{cleanContent(m.content).text}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {chatLoading && (
              <div className="home-chat-turn home-chat-turn--assistant">
                <div className="home-chat-bubble home-chat-bubble--assistant home-chat-bubble--thinking">
                  <span className="home-ask-spinner" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        )}

        <form className="home-ask-form" onSubmit={handleChat}>
          <input
            className="home-ask-input"
            type="text"
            placeholder={chatThread.length === 0 ? 'Ask anything about your stored memories…' : 'Follow up…'}
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            disabled={chatLoading}
            autoFocus={chatThread.length > 0}
          />
          <button className="home-ask-btn" type="submit" disabled={!chatInput.trim() || chatLoading}>
            {chatLoading ? <span className="home-ask-spinner" /> : chatThread.length === 0 ? 'Ask' : 'Send'}
          </button>
          {chatThread.length > 0 && (
            <button
              type="button"
              className="home-ask-clear"
              onClick={() => { setChatThread([]); setChatInput(''); }}
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* ── STATS ROW ── */}
      <div className="home-section">
        <div className="home-stats-row">
          <div className="home-stat-card">
            <div className="home-stat-num">{stats.total ?? 0}</div>
            <div className="home-stat-lbl">Total memories</div>
          </div>
          <div className="home-stat-card">
            <div className="home-stat-num" style={{ color: 'var(--color-reference)' }}>{activeCount}</div>
            <div className="home-stat-lbl">Active</div>
          </div>
          <div className="home-stat-card">
            <div className="home-stat-num" style={{ color: 'var(--text-muted)' }}>{dormantCount}</div>
            <div className="home-stat-lbl">Dormant</div>
          </div>
          <div className="home-stat-card">
            <div className="home-stat-num">{stats.byScope ?? 0}</div>
            <div className="home-stat-lbl">Project scopes</div>
          </div>
          <div className="home-stat-card">
            <div className="home-stat-chip" style={{ color: embProvider && embProvider !== 'none' ? 'var(--color-reference)' : 'var(--text-muted)' }}>
              {embProvider && embProvider !== 'none' ? embProvider : 'off'}
            </div>
            <div className="home-stat-lbl">
              {embProvider && embProvider !== 'none' ? `${embEncoded} encoded` : 'Embeddings off'}
            </div>
          </div>
          <div className="home-stat-card">
            <div className="home-stat-chip" style={{ color: lastDream ? 'var(--accent)' : 'var(--text-muted)' }}>
              {lastDream ? timeAgo(lastDream.started_at) : 'never'}
            </div>
            <div className="home-stat-lbl">Last consolidation</div>
          </div>
        </div>
      </div>

      {/* ── ON-DEVICE LEARNING ── */}
      {mlStatus && (
        <div className="home-section">
          <div className="home-col-head" style={{ marginBottom: '16px' }}>
            <h2>On-device learning</h2>
            <button className="home-link-btn" onClick={runEval} disabled={evalRunning}>
              {evalRunning ? 'Evaluating…' : 'Evaluate retrieval →'}
            </button>
          </div>
          <div className="home-stats-row">
            {Object.entries(mlStatus.models).map(([key, m]) => {
              const chip = modelChip(m);
              return (
                <div key={key} className="home-stat-card" title={m.report?.trained
                  ? `accuracy ${Math.round((m.report.accuracy ?? 0) * 100)}% vs ${Math.round((m.report.baselineAccuracy ?? 0) * 100)}% baseline · ${m.report.n} samples`
                  : m.report ? `${m.report.n} samples — hasn't beaten baseline yet` : 'no model yet — accumulating training data'}>
                  <div className="home-stat-chip" style={{ color: chip.color }}>{chip.text}</div>
                  <div className="home-stat-lbl">{MODEL_LABELS[key] ?? key}</div>
                </div>
              );
            })}
            <div className="home-stat-card">
              <div className="home-stat-num" style={{ fontSize: '20px' }}>
                {(mlStatus.trainingData.adjudicationsBySource['llm'] ?? 0)}
              </div>
              <div className="home-stat-lbl">Labeled verdicts</div>
            </div>
            <div className="home-stat-card">
              <div className="home-stat-num" style={{ fontSize: '20px' }}>
                {mlStatus.trainingData.feedbackUsed + mlStatus.trainingData.feedbackSkipped}
              </div>
              <div className="home-stat-lbl">Recall feedback rows</div>
            </div>
            <div className="home-stat-card" title={`consolidation: ${mlStatus.llm.consolidationModel}\nreconcile: ${mlStatus.llm.reconcileModel}\nfallbacks last dream: ${mlStatus.llm.lastDreamFallbacks}`}>
              <div className="home-stat-chip" style={{ color: mlStatus.llm.lastDreamFallbacks > 0 ? 'var(--color-feedback)' : 'var(--color-reference)' }}>
                {mlStatus.llm.reconcileModel.split('/').pop()}
              </div>
              <div className="home-stat-lbl">
                {mlStatus.llm.lastDreamFallbacks > 0 ? `⚠ ${mlStatus.llm.lastDreamFallbacks} fell back` : 'Consolidation LLM'}
              </div>
            </div>
          </div>
          {evalReport && (
            <div className="home-activity" style={{ marginTop: '12px' }}>
              {evalReport.queries === 0 ? (
                <div className="home-empty">No feedback ground truth yet — chat with your memories (answers that cite sources create it).</div>
              ) : (
                (['bm25', 'hybrid', 'reranked'] as const).map(v => (
                  <div key={v} className="home-activity-row">
                    <div className="home-activity-time">{v}</div>
                    <div className="home-activity-pills">
                      <span className="home-pill">recall@5 {(evalReport[v].recallAt5 * 100).toFixed(0)}%</span>
                      <span className="home-pill">MRR {evalReport[v].mrr.toFixed(2)}</span>
                      <span className="home-pill muted">{evalReport.queries} queries</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ── REVERSIBLE CHANGES ── */}
      {reversible.length > 0 && (
        <div className="home-section">
          <div className="home-col-head" style={{ marginBottom: '16px' }}>
            <h2>Reversible changes</h2>
            <span className="home-footer-muted" style={{ fontSize: '.8rem' }}>
              consolidation merges &amp; supersessions — undo restores the original memories
            </span>
          </div>
          <div className="home-activity">
            {reversible.map(m => (
              <div key={m.mutationId} className="home-activity-row">
                <div className="home-activity-pills" style={{ flex: 1 }}>
                  <span className={`home-pill ${m.phase === 'reconcile-supersede' ? 'conflict' : ''}`}>
                    {m.phase === 'nrem-merge' ? 'merge' : 'supersede'}
                  </span>
                  <span className="home-activity-time">{m.description}</span>
                  <span className="home-pill muted">{timeAgo(m.createdAt)}</span>
                </div>
                <button
                  className="home-ask-clear"
                  disabled={undoing === m.mutationId}
                  onClick={() => undo(m.mutationId)}
                >
                  {undoing === m.mutationId ? '…' : 'Undo'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── MAIN TWO-COL ── */}
      <div className="home-section home-main-grid">

        {/* LEFT: recent memories */}
        <div className="home-col-memories">
          <div className="home-col-head">
            <h2>Recent memories</h2>
            <button className="home-link-btn" onClick={onOpenWorkspace}>View all →</button>
          </div>
          {recentMemories.length === 0 ? (
            <div className="home-empty">
              No memories yet. AI agents store them automatically via MCP, or add one manually in the Workspace.
            </div>
          ) : (
            <div className="home-memory-grid">
              {recentMemories.map(m => (
                <div
                  key={m.id}
                  className="home-memory-card"
                  onClick={() => { onSelectMemory(m.id); onOpenWorkspace(); }}
                  style={{ '--card-accent': `var(--color-${m.type})` } as React.CSSProperties}
                >
                  <div className="home-memory-meta">
                    <span className={`badge ${m.type}`} title={TYPE_HINT[m.type]}>{typeLabel(m.type)}</span>
                    <span className="home-memory-scope">{scopeName(m.scope)}</span>
                    <span className="home-memory-age">{timeAgo(m.created_at)}</span>
                  </div>
                  {(() => { const c = cleanContent(m.content); return (
                    <>
                      <div className="home-memory-text home-memory-text--full">{c.text}</div>
                      {c.merged.length > 0 && (
                        <div className="home-memory-merged" title={c.merged.join('\n\n')}>
                          + {c.merged.length} merged note{c.merged.length !== 1 ? 's' : ''}
                        </div>
                      )}
                    </>
                  ); })()}
                  {m.tags?.length > 0 && (
                    <div className="home-memory-tags">
                      {m.tags.slice(0, 3).map(t => (
                        <span key={t} className="memory-item-tag">#{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: activity + concepts */}
        <div className="home-col-right">
          <div className="home-col-head">
            <h2>Recent consolidation</h2>
          </div>
          {dreamLogs.length === 0 ? (
            <div className="home-empty">No consolidation runs yet.</div>
          ) : (
            <div className="home-activity">
              {dreamLogs.slice(0, 4).map(log => {
                const s = log.stats;
                const decayed = (s.toDormant ?? 0) + (s.toArchived ?? 0) + (s.expired ?? 0);
                return (
                  <div key={log.id} className="home-activity-row">
                    <div className="home-activity-time">{timeAgo(log.started_at)}</div>
                    <div className="home-activity-pills">
                      {(s.merged ?? 0) > 0 && <span className="home-pill">merged {s.merged}</span>}
                      {(s.linked ?? 0) > 0 && <span className="home-pill">linked {s.linked}</span>}
                      {decayed > 0 && <span className="home-pill muted">decayed {decayed}</span>}
                      {(s.reactivated ?? 0) > 0 && <span className="home-pill">revived {s.reactivated}</span>}
                      {(s.supersessions ?? 0) > 0 && <span className="home-pill">superseded {s.supersessions}</span>}
                      {(s.contradictions ?? 0) > 0 && <span className="home-pill conflict">⚠ {s.contradictions} conflict{s.contradictions !== 1 ? 's' : ''}</span>}
                      {(s.merged ?? 0) === 0 && (s.linked ?? 0) === 0 && decayed === 0 && <span className="home-pill muted">no changes</span>}
                      <span className="home-pill muted">{s.duration_ms}ms</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="home-col-divider" />

          <div className="home-col-head">
            <h2>How it works</h2>
          </div>
          <div className="home-concepts">
            {CONCEPTS.map(c => (
              <div key={c.label} className="home-concept-row">
                <span className="home-concept-icon" style={{ color: c.color }}>{c.icon}</span>
                <div>
                  <div className="home-concept-label">{c.label}</div>
                  <div className="home-concept-desc">{c.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── TYPE BREAKDOWN ── */}
      <div className="home-section">
        <div className="home-col-head" style={{ marginBottom: '16px' }}>
          <h2>Memory types</h2>
          <button className="home-link-btn" onClick={onOpenWorkspace}>Browse in Workspace →</button>
        </div>
        <div className="home-type-grid">
          {(['project', 'user', 'feedback', 'reference', 'episodic', 'semantic'] as const).map(type => (
            <div
              key={type}
              className="home-type-card"
              onClick={onOpenWorkspace}
              style={{ '--type-c': `var(--color-${type})` } as React.CSSProperties}
            >
              <div className="home-type-count" style={{ color: `var(--color-${type})` }}>
                {stats.byType?.[type] ?? 0}
              </div>
              <span className={`badge ${type}`}>{type}</span>
              <div className="home-type-desc">{TYPE_DESC[type]}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── FOOTER ── */}
      <div className="home-footer">
        <span className="home-footer-brand">mnemo</span>
        <span className="home-footer-sep">·</span>
        <span className="home-footer-muted">long-term memory for AI agents</span>
        <div className="home-footer-links">
          <button className="home-link-btn" onClick={onOpenWorkspace}>Workspace →</button>
          <a href="/mnemo-scroll.html" target="_blank" rel="noopener" className="home-link-btn">Architecture ↗</a>
          <a href="/astermind-scroll.html" target="_blank" rel="noopener" className="home-link-btn">ML Docs ↗</a>
        </div>
      </div>

    </div>
  );
}

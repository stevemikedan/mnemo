import React, { useState, useEffect, useRef } from 'react';
import './App.css';

interface Memory {
  id: string;
  content: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'semantic';
  scope: string;
  state: 'active' | 'dormant' | 'archived' | 'expired';
  importance: number;
  confidence: number;
  access_count: number;
  created_at: string;
  tags: string[];
  source: string;
}

interface Edge {
  id: string;
  from_id: string;
  to_id: string;
  type: 'relates-to' | 'contradicts' | 'supersedes' | 'derived-from' | 'co-occurred';
  weight: number;
}

interface DreamLog {
  id: string;
  scope: string;
  phase: string;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, number>;
}

interface SimNode extends Memory {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export default function App() {
  const [nodes, setNodes] = useState<Memory[]>([]);        // filtered list (left panel)
  const [graphNodes, setGraphNodes] = useState<Memory[]>([]); // full graph (canvas + lookups)
  const [edges, setEdges] = useState<Edge[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);       // bumped after mutations to re-run the filtered fetch
  const [stats, setStats] = useState<any>({ total: 0, byState: {}, byType: {}, byScope: 0 });
  const [dreamLogs, setDreamLogs] = useState<DreamLog[]>([]);
  
  // UI states
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'view' | 'add'>('view');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterState, setFilterState] = useState<string>('active');
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [filterScope, setFilterScope] = useState<string>('all');
  const [isDreaming, setIsDreaming] = useState(false);
  const [dreamStatus, setDreamStatus] = useState('');

  // Collapsible panels — let the graph reclaim space
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);

  // Memory creation form state
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState<Memory['type']>('project');
  const [newScope, setNewScope] = useState('global');
  const [newTags, setNewTags] = useState('');
  const [newImportance, setNewImportance] = useState(0.5);

  // Selected memory edit state
  const [editingContent, setEditingContent] = useState('');
  const [editingType, setEditingType] = useState<Memory['type']>('project');
  const [editingScope, setEditingScope] = useState('');
  const [editingState, setEditingState] = useState<Memory['state']>('active');
  const [editingTags, setEditingTags] = useState<string[]>([]);
  const [editingImportance, setEditingImportance] = useState(0.5);
  const [newTagInput, setNewTagInput] = useState('');

  // Link creator state
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkRelation, setLinkRelation] = useState<Edge['type']>('relates-to');
  const [linkWeight, setLinkWeight] = useState(1.0);

  // Graph Simulation Refs
  const svgRef = useRef<SVGSVGElement>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  
  // Pan and Zoom
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1.0);
  const isPanningRef = useRef(false);
  const startPanRef = useRef({ x: 0, y: 0 });
  const draggedNodeRef = useRef<SimNode | null>(null);

  // Fetch initial data
  const fetchData = async () => {
    try {
      // 1. Get status stats
      const statsRes = await fetch('/api/status');
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }

      // 3. Get dream logs
      const logRes = await fetch('/api/dream-log');
      if (logRes.ok) {
        const logData = await logRes.json();
        setDreamLogs(logData || []);
      }

      // 4. Get available scopes
      const scopesRes = await fetch('/api/scopes');
      if (scopesRes.ok) {
        const scopesData = await scopesRes.json();
        setAvailableScopes(scopesData || []);
      }
    } catch (err) {
      console.error('Failed to fetch data from mnemo backend', err);
    }
  };

  // The graph (canvas + detail lookups) follows the selected scope so it shows
  // one project's context at a time instead of every project interlinked.
  const fetchGraph = async (scope: string) => {
    try {
      const qs = scope && scope !== 'all' ? `?scope=${encodeURIComponent(scope)}` : '';
      const graphRes = await fetch(`/api/graph${qs}`);
      if (graphRes.ok) {
        const graphData = await graphRes.json();
        setGraphNodes(graphData.nodes || []);
        setEdges(graphData.edges || []);
      }
    } catch (err) {
      console.error('Failed to fetch graph', err);
    }
  };

  // Refresh everything after a mutation: reload stats/logs AND re-run the
  // filtered list + scoped graph fetches (via refreshTick) so the panels keep
  // their active scope/filters instead of reverting.
  const refresh = () => {
    fetchData();
    setRefreshTick(t => t + 1);
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Refetch the graph whenever the scope changes or a mutation bumps refreshTick
  useEffect(() => {
    fetchGraph(filterScope);
  }, [filterScope, refreshTick]);

  // Sync simulation nodes whenever the full graph updates
  useEffect(() => {
    const currentMap = new Map(simNodesRef.current.map(n => [n.id, n]));

    // Width and height of initial spawn bounds
    const cx = 350;
    const cy = 250;

    simNodesRef.current = graphNodes.map(node => {
      const existing = currentMap.get(node.id);
      if (existing) {
        return {
          ...existing,
          ...node, // sync latest metadata
        };
      } else {
        // Random layout spawn circle
        const angle = Math.random() * Math.PI * 2;
        const radius = 50 + Math.random() * 150;
        return {
          ...node,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        };
      }
    });
    
    setSimNodes([...simNodesRef.current]);
  }, [graphNodes]);

  // Force-directed layout simulation math
  useEffect(() => {
    const tick = () => {
      const simNodes = simNodesRef.current;
      const nodeMap = new Map(simNodes.map(n => [n.id, n]));
      
      const width = 700;
      const height = 500;
      const cx = width / 2;
      const cy = height / 2;

      // Force settings
      const kRepulsion = -400;
      const kSpring = 0.05;
      const restingDist = 70;
      const kGravity = 0.008;
      const drag = 0.82;

      // 1. Initialize forces
      const fx = new Array(simNodes.length).fill(0);
      const fy = new Array(simNodes.length).fill(0);

      // 2. Repulsion (between all nodes)
      for (let i = 0; i < simNodes.length; i++) {
        const nodeA = simNodes[i];
        for (let j = i + 1; j < simNodes.length; j++) {
          const nodeB = simNodes[j];
          const dx = nodeB.x - nodeA.x;
          const dy = nodeB.y - nodeA.y;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
          
          if (d < 250) {
            const force = kRepulsion / (d * d);
            const fX = force * (dx / d);
            const fY = force * (dy / d);
            
            fx[i] += fX;
            fy[i] += fY;
            fx[j] -= fX;
            fy[j] -= fY;
          }
        }
      }

      // 3. Link force (attraction along edges)
      edges.forEach(edge => {
        const nodeA = nodeMap.get(edge.from_id);
        const nodeB = nodeMap.get(edge.to_id);
        if (!nodeA || !nodeB) return;

        const idxA = simNodes.indexOf(nodeA);
        const idxB = simNodes.indexOf(nodeB);

        const dx = nodeB.x - nodeA.x;
        const dy = nodeB.y - nodeA.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
        
        const displacement = d - restingDist;
        const force = displacement * kSpring * edge.weight;
        const fX = force * (dx / d);
        const fY = force * (dy / d);

        fx[idxA] += fX;
        fy[idxA] += fY;
        fx[idxB] -= fX;
        fy[idxB] -= fY;
      });

      // 4. Center attraction (gravity)
      for (let i = 0; i < simNodes.length; i++) {
        const node = simNodes[i];
        fx[i] += (cx - node.x) * kGravity;
        fy[i] += (cy - node.y) * kGravity;
      }

      // 5. Update positions
      for (let i = 0; i < simNodes.length; i++) {
        const node = simNodes[i];
        if (node === draggedNodeRef.current) continue; // Skip physical updates for dragged node

        node.vx = (node.vx + fx[i]) * drag;
        node.vy = (node.vy + fy[i]) * drag;
        node.x += node.vx;
        node.y += node.vy;
      }

      setSimNodes([...simNodes]);
      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [edges]);

  // Synchronize editing form state when selected memory changes.
  // Look up in graphNodes (the full set) so the detail panel still works when
  // the selected memory is filtered out of the left list.
  const selectedMemory = graphNodes.find(n => n.id === selectedId);
  useEffect(() => {
    if (selectedMemory) {
      setEditingContent(selectedMemory.content);
      setEditingType(selectedMemory.type);
      setEditingScope(selectedMemory.scope);
      setEditingState(selectedMemory.state);
      setEditingTags(selectedMemory.tags || []);
      setEditingImportance(selectedMemory.importance);
    }
  }, [selectedId, graphNodes]);

  // Handle Search & Filter query fetch
  useEffect(() => {
    const handleSearch = async () => {
      try {
        const params = new URLSearchParams();
        if (searchQuery) params.append('query', searchQuery);
        if (filterType !== 'all') params.append('types', filterType);
        if (filterState !== 'all') params.append('states', filterState);
        if (filterScope !== 'all') params.append('scope', filterScope);

        const res = await fetch(`/api/memories?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          if (searchQuery) {
            // For search, recall endpoint returns { memory, score, related }
            setNodes(data.map((item: any) => item.memory));
          } else {
            // Otherwise normal list
            setNodes(data);
          }
        }
      } catch (err) {
        console.error('Failed to search memories', err);
      }
    };

    const delayDebounce = setTimeout(() => {
      handleSearch();
    }, 200);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery, filterType, filterState, filterScope, refreshTick]);

  // Create a new memory
  const handleRemember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    try {
      const res = await fetch('/api/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: newContent,
          type: newType,
          scope: newScope,
          tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
          importance: newImportance,
        }),
      });

      if (res.ok) {
        setNewContent('');
        setNewTags('');
        setActiveTab('view');
        refresh();
      }
    } catch (err) {
      console.error('Failed to store memory', err);
    }
  };

  // Update selected memory
  const handleUpdate = async () => {
    if (!selectedId) return;

    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedId,
          content: editingContent,
          type: editingType,
          scope: editingScope,
          state: editingState,
          tags: editingTags,
          importance: editingImportance,
        }),
      });

      if (res.ok) {
        refresh();
      }
    } catch (err) {
      console.error('Failed to update memory', err);
    }
  };

  // Persist a partial edit to the selected memory using explicit values. This
  // avoids stale-closure saves — the previous pattern (setEditingX then a
  // setTimeout(handleUpdate)) read edit state before the change had committed,
  // persisting the prior value.
  const savePatch = async (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedId, ...patch }),
      });
      if (res.ok) refresh();
    } catch (err) {
      console.error('Failed to update memory', err);
    }
  };

  // Soft delete / Forget memory
  const handleForget = async () => {
    if (!selectedId) return;

    try {
      const res = await fetch('/api/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedId }),
      });

      if (res.ok) {
        refresh();
      }
    } catch (err) {
      console.error('Failed to forget memory', err);
    }
  };

  // Hard delete memory
  const handleDelete = async () => {
    if (!selectedId) return;

    if (!confirm('Are you sure you want to permanently delete this memory? This cannot be undone.')) {
      return;
    }

    try {
      const res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedId }),
      });

      if (res.ok) {
        setSelectedId(null);
        refresh();
      }
    } catch (err) {
      console.error('Failed to delete memory', err);
    }
  };

  // Add Link
  const handleAddLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !linkTargetId) return;

    try {
      const res = await fetch('/api/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_id: selectedId,
          to_id: linkTargetId,
          relation_type: linkRelation,
          weight: linkWeight,
        }),
      });

      if (res.ok) {
        setLinkTargetId('');
        refresh();
      }
    } catch (err) {
      console.error('Failed to add link', err);
    }
  };

  // Remove Link
  const handleRemoveLink = async (targetId: string) => {
    if (!selectedId) return;

    try {
      const res = await fetch('/api/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_id: selectedId,
          to_id: targetId,
        }),
      });

      if (res.ok) {
        refresh();
      }
    } catch (err) {
      console.error('Failed to remove link', err);
    }
  };

  // Trigger memory consolidation (Dreaming). Scope it to the selected project
  // so it only consolidates that workspace (+ global); 'all' dreams everything.
  const handleDream = async () => {
    setIsDreaming(true);
    const scopeLabel = filterScope === 'all' ? 'all memories'
      : filterScope === 'global' ? 'global memories'
      : (filterScope.startsWith('project:') ? filterScope.slice(8) : filterScope);
    setDreamStatus(`Consolidating ${scopeLabel} (NREM + REM phases)...`);

    try {
      const res = await fetch('/api/dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filterScope !== 'all' ? { scope: filterScope } : {}),
      });

      if (res.ok) {
        const stats = await res.json();
        setDreamStatus(`Dream finished: Merged ${stats.merged}, Linked ${stats.linked}, Promoted ${stats.promoted}`);
        refresh();
      } else {
        setDreamStatus('Memory consolidation failed.');
      }
    } catch (err) {
      console.error('Failed to run dream consolidation', err);
      setDreamStatus('Error connecting to backend for consolidation.');
    } finally {
      setTimeout(() => {
        setIsDreaming(false);
        setDreamStatus('');
      }, 5000);
    }
  };

  // Mouse Handlers for Force-Directed Graph interactions
  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    // If not clicking on a node, start canvas panning
    const target = e.target as SVGElement;
    if (target.tagName === 'svg' || target.id === 'grid-background') {
      isPanningRef.current = true;
      startPanRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    }
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isPanningRef.current) {
      setPan({
        x: e.clientX - startPanRef.current.x,
        y: e.clientY - startPanRef.current.y
      });
    } else if (draggedNodeRef.current && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      // Translate client coordinate back into simulation coordinate system
      draggedNodeRef.current.x = (clientX - pan.x) / zoom;
      draggedNodeRef.current.y = (clientY - pan.y) / zoom;
      
      // Stop velocity
      draggedNodeRef.current.vx = 0;
      draggedNodeRef.current.vy = 0;
    }
  };

  const handleSvgMouseUpOrLeave = () => {
    isPanningRef.current = false;
    draggedNodeRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const scale = e.deltaY < 0 ? 1.05 : 0.95;
    setZoom(prev => Math.min(Math.max(prev * scale, 0.2), 3.0));
  };

  const handleNodeMouseDown = (e: React.MouseEvent, node: SimNode) => {
    e.stopPropagation();
    draggedNodeRef.current = node;
    setSelectedId(node.id);
  };

  // Helpers for tag editor bubble list. Both compute the next tag array
  // explicitly and persist it via savePatch (previously Enter-to-add never
  // saved, and remove re-saved the deleted tag due to a stale closure).
  const handleRemoveTag = (index: number) => {
    const next = editingTags.filter((_, idx) => idx !== index);
    setEditingTags(next);
    savePatch({ tags: next });
  };

  const handleAddTag = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && newTagInput.trim()) {
      e.preventDefault();
      const tag = newTagInput.trim();
      if (!editingTags.includes(tag)) {
        const next = [...editingTags, tag];
        setEditingTags(next);
        savePatch({ tags: next });
      }
      setNewTagInput('');
    }
  };

  // Find connections for the selected memory
  const getSelectedConnections = () => {
    if (!selectedId) return [];
    return edges
      .filter(e => e.from_id === selectedId || e.to_id === selectedId)
      .map(edge => {
        const otherId = edge.from_id === selectedId ? edge.to_id : edge.from_id;
        const otherNode = graphNodes.find(n => n.id === otherId);
        return {
          edgeId: edge.id,
          targetId: otherId,
          type: edge.type,
          direction: edge.from_id === selectedId ? 'outgoing' : 'incoming',
          content: otherNode?.content || 'Unknown Memory',
          nodeType: otherNode?.type || 'project',
        };
      });
  };

  const selectedConnections = getSelectedConnections();
  const candidateTargetNodes = graphNodes.filter(n => n.id !== selectedId);

  return (
    <div className="dashboard">
      {/* HEADER SECTION */}
      <header className="header">
        <div className="brand">
          <svg className="brand-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path>
            <path d="M12 6v6l4 2"></path>
          </svg>
          <h1>mnemo</h1>
        </div>

        <div className="stats-bar">
          <div 
            className="stat-item pointer" 
            title="Click to show all memories"
            onClick={() => {
              setFilterType('all');
              setFilterScope('all');
              setFilterState('active');
              setSearchQuery('');
              setActiveTab('view');
            }}
          >
            Total: <strong>{stats.total || 0}</strong>
          </div>
          <div 
            className="stat-item pointer"
            title="Click to focus scope filter"
            onClick={() => {
              const select = document.getElementById('scope-filter-select');
              if (select) {
                select.focus();
                select.style.borderColor = 'var(--accent)';
                setTimeout(() => { select.style.borderColor = ''; }, 1000);
              }
            }}
          >
            Scopes: <strong>{stats.byScope || 0}</strong>
          </div>
          <div 
            className="stat-item pointer"
            title="Filter by Project Decisions"
            style={{ borderLeft: '3px solid var(--color-project)' }}
            onClick={() => {
              setFilterType('project');
              setActiveTab('view');
            }}
          >
            Projects: <strong>{stats.byType?.project || 0}</strong>
          </div>
          <div 
            className="stat-item pointer"
            title="Filter by Feedback & Corrections"
            style={{ borderLeft: '3px solid var(--color-feedback)' }}
            onClick={() => {
              setFilterType('feedback');
              setActiveTab('view');
            }}
          >
            Feedback: <strong>{stats.byType?.feedback || 0}</strong>
          </div>
          <div 
            className="stat-item pointer"
            title="Filter by User Preferences"
            style={{ borderLeft: '3px solid var(--color-user)' }}
            onClick={() => {
              setFilterType('user');
              setActiveTab('view');
            }}
          >
            User: <strong>{stats.byType?.user || 0}</strong>
          </div>
        </div>

        <div className="header-actions">
          {isDreaming && (
            <div className="dream-status-anim">
              <div className="spinner"></div>
              <span>Dreaming...</span>
            </div>
          )}
          <button className="secondary" onClick={refresh}>
            Refresh
          </button>
          <button className="primary" onClick={handleDream} disabled={isDreaming}>
            Consolidate (Dream)
          </button>
        </div>
      </header>

      {/* DASHBOARD SPLIT GRID */}
      <main
        className="workspace"
        style={{
          gridTemplateColumns: `${leftCollapsed ? '40px' : '360px'} 1fr ${rightCollapsed ? '40px' : '340px'}`,
          gridTemplateRows: `1fr ${consoleCollapsed ? '40px' : '240px'}`,
        }}
      >
        {/* LEFT PANEL: Memories filter and search list */}
        {leftCollapsed ? (
          <div className="panel rail" onClick={() => setLeftCollapsed(false)} title="Expand Memories">
            <button className="collapse-btn" aria-label="Expand Memories panel">›</button>
            <span className="rail-label">Memories</span>
          </div>
        ) : (
        <section className="panel">
          <div className="panel-header">
            <h2>Memories</h2>
            <div className="panel-header-actions">
              <span className="badge global" style={{ fontSize: '10px' }}>{nodes.length} visible</span>
              <button className="collapse-btn" aria-label="Collapse Memories panel" title="Collapse" onClick={() => setLeftCollapsed(true)}>‹</button>
            </div>
          </div>

          <div className="panel-content">
            <div className="tab-buttons">
              <button 
                className={`tab-btn ${activeTab === 'view' ? 'active' : ''}`}
                onClick={() => setActiveTab('view')}
              >
                Search & Filter
              </button>
              <button 
                className={`tab-btn ${activeTab === 'add' ? 'active' : ''}`}
                onClick={() => setActiveTab('add')}
              >
                + Remember
              </button>
            </div>

            {activeTab === 'view' ? (
              <>
                <div className="search-box">
                  <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                  <input
                    type="text"
                    placeholder="Search memories (BM25)..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label>Scope / Project Workspace</label>
                  <select 
                    id="scope-filter-select"
                    value={filterScope} 
                    onChange={(e) => setFilterScope(e.target.value)}
                    style={{ width: '100%', marginTop: '4px' }}
                  >
                    <option value="all">All Projects & Global</option>
                    <option value="global">Global Only</option>
                    {availableScopes
                      .filter(s => s !== 'global')
                      .map(s => (
                        <option key={s} value={s}>
                          {s.startsWith('project:') ? s.slice(8) : s}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="filters">
                  <div className="form-group">
                    <label>Type</label>
                    <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                      <option value="all">All Types</option>
                      <option value="user">User</option>
                      <option value="feedback">Feedback</option>
                      <option value="project">Project</option>
                      <option value="reference">Reference</option>
                      <option value="episodic">Episodic</option>
                      <option value="semantic">Semantic</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>State</label>
                    <select value={filterState} onChange={(e) => setFilterState(e.target.value)}>
                      <option value="all">All States</option>
                      <option value="active">Active</option>
                      <option value="dormant">Dormant</option>
                      <option value="archived">Archived</option>
                      <option value="expired">Expired</option>
                    </select>
                  </div>
                </div>

                {nodes.length === 0 ? (
                  <div className="empty-state">No memories found. Store one using the (+ Remember) tab.</div>
                ) : (
                  <div className="memory-list fade-in">
                    {nodes.map(node => (
                      <div
                        key={node.id}
                        className={`memory-item ${selectedId === node.id ? 'selected' : ''}`}
                        onClick={() => setSelectedId(node.id)}
                      >
                        <div
                          className="memory-item-border"
                          style={{ backgroundColor: `var(--color-${node.type})` }}
                        ></div>
                        <div className="memory-item-header">
                          <span className={`badge ${node.type}`}>{node.type}</span>
                          <span className="memory-item-id">{node.id.slice(0, 8)}</span>
                        </div>
                        <div className="memory-item-content">{node.content}</div>
                        <div className="memory-item-footer">
                          <span className="memory-item-scope">{node.scope === 'global' ? 'Global' : node.scope.split('/').pop()}</span>
                          <div className="memory-item-tags">
                            {node.tags && node.tags.slice(0, 2).map(tag => (
                              <span key={tag} className="memory-item-tag">#{tag}</span>
                            ))}
                            {node.tags && node.tags.length > 2 && (
                              <span className="memory-item-tag">+{node.tags.length - 2}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <form onSubmit={handleRemember} className="add-memory-form fade-in">
                <div className="form-group">
                  <label>Content</label>
                  <textarea
                    placeholder="Remember that this project uses pnpm workspace..."
                    value={newContent}
                    onChange={(e) => setNewContent(e.target.value)}
                    style={{ minHeight: '100px', resize: 'vertical' }}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Type</label>
                  <select value={newType} onChange={(e) => setNewType(e.target.value as any)}>
                    <option value="project">Project Decisions</option>
                    <option value="user">User Preferences</option>
                    <option value="feedback">Corrections / Feedback</option>
                    <option value="reference">Code Reference Pointers</option>
                    <option value="episodic">Episodic / Contextual</option>
                    <option value="semantic">Semantic Patterns</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Scope</label>
                  <select value={newScope} onChange={(e) => setNewScope(e.target.value)}>
                    <option value="global">Global (Everywhere)</option>
                    {availableScopes
                      .filter(s => s !== 'global')
                      .map(s => (
                        <option key={s} value={s}>
                          {s.startsWith('project:') ? s.slice(8) : s}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Tags (comma separated)</label>
                  <input
                    type="text"
                    placeholder="pnpm, workspace, config"
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Importance (0.0 to 1.0)</label>
                  <div className="slider-container">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={newImportance}
                      onChange={(e) => setNewImportance(parseFloat(e.target.value))}
                    />
                    <span className="slider-val">{newImportance.toFixed(2)}</span>
                  </div>
                </div>

                <button type="submit" className="primary" style={{ padding: '10px', marginTop: '8px' }}>
                  Store Memory
                </button>
              </form>
            )}
          </div>
        </section>
        )}

        {/* MIDDLE PANEL: Graph Visualization viewport */}
        <section className="graph-container">
          <div className="graph-overlay-status">
            <div>Nodes: <strong>{simNodes.length}</strong></div>
            <div>Edges: <strong>{edges.length}</strong></div>
            {dreamStatus && <div style={{ color: 'var(--color-user)' }}>{dreamStatus}</div>}
          </div>
          
          <div className="graph-controls">
            <button className="graph-btn" onClick={() => setZoom(prev => Math.min(prev * 1.2, 3.0))}>+</button>
            <button className="graph-btn" onClick={() => setZoom(prev => Math.max(prev / 1.2, 0.2))}>-</button>
            <button className="graph-btn" onClick={() => { setZoom(1.0); setPan({ x: 0, y: 0 }); }}>⟲</button>
          </div>

          <svg
            ref={svgRef}
            className="graph-viewport"
            onMouseDown={handleSvgMouseDown}
            onMouseMove={handleSvgMouseMove}
            onMouseUp={handleSvgMouseUpOrLeave}
            onMouseLeave={handleSvgMouseUpOrLeave}
            onWheel={handleWheel}
          >
            {/* SVG GRID BACKGROUND FOR BETTER SPATIAL CONTEXT */}
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--border)" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect id="grid-background" width="100%" height="100%" fill="url(#grid)" />

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* EDGES / LINKS RENDER */}
              {edges.map((edge) => {
                const nodeMap = new Map(simNodes.map(n => [n.id, n]));
                const sourceNode = nodeMap.get(edge.from_id);
                const targetNode = nodeMap.get(edge.to_id);
                if (!sourceNode || !targetNode) return null;

                const isSelected = selectedId === edge.from_id || selectedId === edge.to_id;
                
                return (
                  <g key={edge.id}>
                    <line
                      x1={sourceNode.x}
                      y1={sourceNode.y}
                      x2={targetNode.x}
                      y2={targetNode.y}
                      stroke={isSelected ? 'var(--accent)' : 'var(--border-focus)'}
                      strokeWidth={isSelected ? 1.8 : 1.0}
                      opacity={isSelected ? 0.9 : 0.4}
                      className={`graph-edge ${edge.type}`}
                    />
                  </g>
                );
              })}

              {/* NODES RENDER */}
              {simNodes.map((node) => {
                const isSelected = selectedId === node.id;
                const isSearchResult = searchQuery && node.content.toLowerCase().includes(searchQuery.toLowerCase());
                
                return (
                  <g
                    key={node.id}
                    className="node-group"
                    transform={`translate(${node.x}, ${node.y})`}
                    onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  >
                    {/* Ring glow for selected / search results */}
                    {(isSelected || isSearchResult) && (
                      <circle
                        r={16}
                        fill="none"
                        stroke={isSearchResult ? 'var(--color-user)' : 'var(--accent)'}
                        strokeWidth="1.5"
                        style={{
                          animation: 'pulseGlow 2s infinite',
                          '--glow-color': isSearchResult ? 'rgba(245, 158, 11, 0.4)' : 'rgba(99, 102, 241, 0.4)'
                        } as any}
                      />
                    )}
                    
                    {/* Node Core */}
                    <circle
                      r={10}
                      fill="var(--bg-card)"
                      stroke={`var(--color-${node.type})`}
                      strokeWidth={isSelected ? 3.0 : 1.8}
                      className="node-circle"
                    />
                    
                    {/* Tiny visual indicators on nodes */}
                    <circle r={2} fill={`var(--color-${node.type})`} opacity={0.6} />

                    {/* Node Label (Short content excerpt) */}
                    <text y={20} className="node-text">
                      {node.content.length > 20 ? `${node.content.slice(0, 18)}...` : node.content}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </section>

        {/* RIGHT PANEL: Details panel, linker and edit mode */}
        {rightCollapsed ? (
          <div className="panel rail" onClick={() => setRightCollapsed(false)} title="Expand Memory Context">
            <button className="collapse-btn" aria-label="Expand Memory Context panel">‹</button>
            <span className="rail-label">Memory Context</span>
          </div>
        ) : (
        <section className="panel">
          <div className="panel-header">
            <h2>Memory Context</h2>
            <button className="collapse-btn" aria-label="Collapse Memory Context panel" title="Collapse" onClick={() => setRightCollapsed(true)}>›</button>
          </div>

          <div className="panel-content">
            {selectedMemory ? (
              <div className="detail-view fade-in">
                {/* CONTENT EDIT */}
                <div className="detail-section">
                  <div className="detail-label">Memory ID</div>
                  <div className="detail-value" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                    {selectedMemory.id}
                  </div>
                </div>

                <div className="detail-section">
                  <label className="detail-label">Content</label>
                  <textarea
                    className="detail-content-textarea"
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    onBlur={handleUpdate}
                  />
                </div>

                <div className="filters" style={{ margin: 0 }}>
                  <div className="form-group">
                    <label>Type</label>
                    <select
                      value={editingType}
                      onChange={(e) => {
                        const value = e.target.value as Memory['type'];
                        setEditingType(value);
                        savePatch({ type: value });
                      }}
                    >
                      <option value="project">Project</option>
                      <option value="user">User</option>
                      <option value="feedback">Feedback</option>
                      <option value="reference">Reference</option>
                      <option value="episodic">Episodic</option>
                      <option value="semantic">Semantic</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>State</label>
                    <select
                      value={editingState}
                      onChange={(e) => {
                        const value = e.target.value as Memory['state'];
                        setEditingState(value);
                        savePatch({ state: value });
                      }}
                    >
                      <option value="active">Active</option>
                      <option value="dormant">Dormant</option>
                      <option value="archived">Archived</option>
                      <option value="expired">Expired</option>
                    </select>
                  </div>
                </div>

                {/* TAGS EDITOR */}
                <div className="detail-section">
                  <label className="detail-label">Tags (Enter to add)</label>
                  <div className="tag-editor">
                    {editingTags.map((tag, idx) => (
                      <span key={tag} className="tag-bubble">
                        #{tag}
                        <button onClick={() => handleRemoveTag(idx)}>×</button>
                      </span>
                    ))}
                    <input
                      type="text"
                      className="tag-input-inline"
                      placeholder="Add tag..."
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={handleAddTag}
                      onBlur={() => {
                        const tag = newTagInput.trim();
                        if (tag && !editingTags.includes(tag)) {
                          const nextTags = [...editingTags, tag];
                          setEditingTags(nextTags);
                          savePatch({ tags: nextTags });
                        }
                        setNewTagInput('');
                      }}
                    />
                  </div>
                </div>

                {/* IMPORTANCE */}
                <div className="detail-section">
                  <label className="detail-label">Importance</label>
                  <div className="slider-container">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={editingImportance}
                      onChange={(e) => setEditingImportance(parseFloat(e.target.value))}
                      onMouseUp={() => savePatch({ importance: editingImportance })}
                      onTouchEnd={() => savePatch({ importance: editingImportance })}
                    />
                    <span className="slider-val">{editingImportance.toFixed(2)}</span>
                  </div>
                </div>

                <div className="detail-section" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
                  <div>Source: <strong>{selectedMemory.source}</strong></div>
                  <div>Access count: <strong>{selectedMemory.access_count}</strong></div>
                </div>

                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '8px 0' }} />

                {/* RELATIONSHIPS / GRAPH CONNECTIONS */}
                <div className="detail-section">
                  <div className="detail-label">Graph Connections ({selectedConnections.length})</div>
                  {selectedConnections.length === 0 ? (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No relations yet. Use the tool below to link nodes.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {selectedConnections.map(conn => (
                        <div key={conn.edgeId} className="linked-item">
                          <div className="linked-item-info">
                            <span className="linked-item-rel">{conn.direction === 'outgoing' ? '→' : '←'} {conn.type}</span>
                            <span 
                              style={{ 
                                cursor: 'pointer', 
                                color: 'var(--text-normal)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '200px'
                              }}
                              onClick={() => setSelectedId(conn.targetId)}
                              title={conn.content}
                            >
                              {conn.content}
                            </span>
                          </div>
                          <button 
                            style={{ background: 'none', border: 'none', color: 'var(--color-feedback)', fontSize: '14px', padding: '0 4px' }}
                            onClick={() => handleRemoveLink(conn.targetId)}
                            title="Unlink memories"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* NODE LINKER FORM */}
                <form onSubmit={handleAddLink} className="link-creator">
                  <div className="link-creator-title">Link to other Memory</div>
                  <div className="link-creator-form">
                    <select 
                      value={linkTargetId} 
                      onChange={(e) => setLinkTargetId(e.target.value)}
                      required
                    >
                      <option value="">Select target memory...</option>
                      {candidateTargetNodes.map(node => (
                        <option key={node.id} value={node.id}>
                          [{node.type.slice(0, 3).toUpperCase()}] {node.content.slice(0, 30)}...
                        </option>
                      ))}
                    </select>

                    <select
                      value={linkRelation}
                      onChange={(e) => setLinkRelation(e.target.value as any)}
                    >
                      <option value="relates-to">Relates To</option>
                      <option value="contradicts">Contradicts</option>
                      <option value="supersedes">Supersedes</option>
                      <option value="derived-from">Derived From</option>
                      <option value="co-occurred">Co-occurred</option>
                    </select>

                    <div className="slider-container" style={{ margin: '2px 0' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Weight</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.1"
                        value={linkWeight}
                        onChange={(e) => setLinkWeight(parseFloat(e.target.value))}
                      />
                      <span className="slider-val">{linkWeight.toFixed(1)}</span>
                    </div>

                    <button type="submit" className="primary" style={{ padding: '6px', fontSize: '12px' }}>
                      Add Graph Relationship
                    </button>
                  </div>
                </form>

                {/* DELETE ACTIONS */}
                <div className="action-buttons">
                  <button className="secondary danger" onClick={handleForget} disabled={selectedMemory.state === 'expired'}>
                    Forget
                  </button>
                  <button className="danger" onClick={handleDelete}>
                    Permanently Delete
                  </button>
                </div>
              </div>
            ) : (
              <div className="no-selection">
                <svg className="no-selection-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <div style={{ fontWeight: '500', color: 'var(--text-bright)', marginBottom: '4px' }}>No memory selected</div>
                <div style={{ fontSize: '12px' }}>Click a node on the graph or search for a memory to view details, update, or link relationships.</div>
              </div>
            )}
          </div>
        </section>
        )}

        {/* BOTTOM PANEL: Dream Console Logs */}
        <footer className={`dream-console ${consoleCollapsed ? 'collapsed' : ''}`}>
          <div className="console-header">
            <div className="console-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                <line x1="7" y1="2" x2="7" y2="22"></line>
                <line x1="17" y1="2" x2="17" y2="22"></line>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <line x1="2" y1="7" x2="7" y2="7"></line>
                <line x1="2" y1="17" x2="7" y2="17"></line>
                <line x1="17" y1="17" x2="22" y2="17"></line>
                <line x1="17" y1="7" x2="22" y2="7"></line>
              </svg>
              Consolidation Logs
            </div>
            <div className="panel-header-actions">
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Latest runs</span>
              <button
                className="collapse-btn"
                aria-label={consoleCollapsed ? 'Expand consolidation logs' : 'Collapse consolidation logs'}
                title={consoleCollapsed ? 'Expand' : 'Collapse'}
                onClick={() => setConsoleCollapsed(c => !c)}
              >
                {consoleCollapsed ? '▲' : '▼'}
              </button>
            </div>
          </div>

          {!consoleCollapsed && (
          <div className="console-content">
            <div className="log-viewer">
              {dreamLogs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No memory consolidation runs logged yet. Press 'Consolidate (Dream)' to trigger.</div>
              ) : (
                dreamLogs.map(log => (
                  <div key={log.id} className="log-entry">
                    <div>
                      <span className="log-entry-time">[{new Date(log.started_at).toLocaleString()}]</span>{' '}
                      Phase: <strong>{log.phase}</strong> | Scope: <strong>{log.scope}</strong>
                    </div>
                    <div className="log-entry-stats">
                      Stats: processed={log.stats.total_processed || 0}, merged={log.stats.merged || 0}, linked={log.stats.linked || 0}, promoted={log.stats.promoted || 0}, duration={log.stats.duration_ms || 0}ms
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="dream-action-pane">
              <div className="dream-info">
                Memory consolidation runs <strong>NREM</strong> deduplication (merging similar memories) and <strong>REM</strong> association (linking related nodes) to keep memory retrieval fast and contextual.
              </div>
              <button 
                className="primary" 
                onClick={handleDream} 
                disabled={isDreaming}
                style={{ padding: '8px 12px', fontSize: '12px' }}
              >
                {isDreaming ? 'Consolidating...' : 'Consolidate Now'}
              </button>
            </div>
          </div>
          )}
        </footer>
      </main>
    </div>
  );
}

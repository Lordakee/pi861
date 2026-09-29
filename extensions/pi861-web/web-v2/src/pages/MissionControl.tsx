import React, { useState } from 'react'
import { Play, Pause, Square, Check, Plus, X, GitBranch, Activity } from 'lucide-react'

interface Task {
  id: string; title: string; status: 'queued'|'running'|'done'|'blocked';
  attempts: number; maxAttempts: number; workerId?: string; model?: string;
  dependsOn: string[]; writeScopes: string[];
}
interface Goal { objective: string; status: string; baseCommit: string }

const STATUS_COLS = ['queued','running','done','blocked'] as const
const STATUS_LABEL: Record<string,string> = { queued:'Queued', running:'Running', done:'Done', blocked:'Blocked' }

export default function MissionControl({ ws, snapshot }: { ws: WebSocket|null; snapshot:any }) {
  const [showAddTask, setShowAddTask] = useState(false)
  const goal: Goal | null = snapshot?.goal || null
  const tasks: Task[] = snapshot?.tasks || []
  const doneCount = tasks.filter(t => t.status === 'done').length
  const progress = tasks.length ? Math.round(doneCount/tasks.length*100) : 0

  const send = (msg: any) => ws?.send(JSON.stringify(msg))

  const goalAction = (action: string) => send({ type: 'goal.control', action })

  const TaskCard = ({ task }: { task: Task }) => (
    <div className="card p-3 space-y-2 group hover:border-accent transition-colors cursor-pointer">
      <div className="flex items-start justify-between">
        <span className="text-xs font-mono text-muted">{task.id}</span>
        <span className={`badge badge-${task.status}`}>{task.status}</span>
      </div>
      <p className="text-sm font-medium leading-snug">{task.title}</p>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        {task.workerId && <span>👤 {task.workerId}</span>}
        {task.model && <span className="badge badge-running">{task.model}</span>}
        <span>🔄 {task.attempts}/{task.maxAttempts}</span>
      </div>
      {task.dependsOn.length > 0 && (
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <GitBranch size={12}/>
          {task.dependsOn.map(d => <span key={d} className="text-accent">{d}</span>).reduce((a:[],b:any)=>[...a,' → ',b],[] as any)}
        </div>
      )}
    </div>
  )

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Goal Header */}
      {goal ? (
        <div className="card p-6 flex items-center gap-6">
          <div className="relative w-20 h-20 shrink-0">
            <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
              <circle cx="40" cy="40" r="34" fill="none" stroke="var(--color-border)" strokeWidth="6"/>
              <circle cx="40" cy="40" r="34" fill="none" stroke="var(--color-accent)" strokeWidth="6"
                strokeDasharray={`${2*Math.PI*34*progress/100} ${2*Math.PI*34}`}
                strokeLinecap="round" className="transition-all duration-500"/>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-xl font-bold">{progress}%</div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold truncate">{goal.objective}</h2>
              <span className={`badge badge-${goal.status === 'review' ? 'review' : goal.status}`}>{goal.status}</span>
            </div>
            <p className="text-sm text-muted mt-1">{doneCount}/{tasks.length} tasks completed</p>
          </div>
          <div className="flex gap-2">
            {goal.status === 'active' && <>
              <button className="btn" onClick={() => goalAction('pause')}><Pause size={14}/> Pause</button>
              <button className="btn btn-danger" onClick={() => goalAction('cancel')}><Square size={14}/> Abort</button>
            </>}
            {goal.status === 'paused' && <>
              <button className="btn btn-primary" onClick={() => goalAction('resume')}><Play size={14}/> Resume</button>
            </>}
            {goal.status === 'review' && <>
              <button className="btn btn-primary" onClick={() => goalAction('accept')}><Check size={14}/> Accept</button>
            </>}
          </div>
        </div>
      ) : (
        <div className="card p-6 text-center text-muted">
          <p>No active goal. Create one from Chat or Settings.</p>
        </div>
      )}

      {/* DAG Visualization (simplified flow diagram) */}
      {tasks.length > 0 && (
        <div className="card p-4">
          <h3 className="text-xs uppercase tracking-wider text-muted mb-4">Task Dependencies</h3>
          <div className="flex items-center gap-2 overflow-x-auto pb-2">
            {tasks.map((task, i) => (
              <React.Fragment key={task.id}>
                {i > 0 && <div className="w-6 h-px bg-border shrink-0"/>}
                <div className={`shrink-0 px-3 py-2 rounded-lg border-2 text-xs font-medium min-w-[100px] text-center
                  ${task.status === 'done' ? 'border-success text-success' :
                    task.status === 'running' ? 'border-accent text-accent animate-pulse' :
                    task.status === 'blocked' ? 'border-error text-error' :
                    'border-border text-muted'}`}>
                  {task.id}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Kanban Board */}
      <div className="grid grid-cols-4 gap-4">
        {STATUS_COLS.map(col => (
          <div key={col} className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">{STATUS_LABEL[col]}</span>
              <span className="text-xs text-muted tabular-nums">{tasks.filter(t => t.status === col).length}</span>
            </div>
            <div className="space-y-2 min-h-[100px]">
              {tasks.filter(t => t.status === col).map(task => <TaskCard key={task.id} task={task}/>)}
            </div>
          </div>
        ))}
      </div>

      {/* Add Task */}
      {showAddTask && <AddTaskSheet onClose={() => setShowAddTask(false)} ws={ws} tasks={tasks}/>}
      <button className="btn fixed bottom-6 right-6 shadow-lg" onClick={() => setShowAddTask(!showAddTask)}>
        <Plus size={16}/> Add Task
      </button>
    </div>
  )
}

function AddTaskSheet({ onClose, ws, tasks }: { onClose:()=>void; ws:WebSocket|null; tasks:Task[] }) {
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [depends, setDepends] = useState<string[]>([])
  const [scopes, setScopes] = useState('')
  const [model, setModel] = useState('main')

  const submit = () => {
    ws?.send(JSON.stringify({
      type: 'task.append',
      tasks: [{ title, instructions, dependsOn: depends, writeScopes: scopes ? scopes.split(',').map(s=>s.trim()) : [], modelId: model }]
    }))
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-96 h-full bg-panel border-l border-border p-6 space-y-4 overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Add Task</h3>
          <button className="btn" onClick={onClose}><X size={16}/></button>
        </div>
        <div><label className="text-xs text-muted">Title</label><input className="input mt-1" value={title} onChange={e=>setTitle(e.target.value)} placeholder="Task title..."/></div>
        <div><label className="text-xs text-muted">Instructions</label><textarea className="input mt-1 h-32 resize-none" value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="What should the agent do?"/></div>
        <div>
          <label className="text-xs text-muted">Depends On</label>
          <div className="flex flex-wrap gap-2 mt-1">
            {tasks.map(t => (
              <button key={t.id} onClick={() => setDepends(prev => prev.includes(t.id) ? prev.filter(d=>d!==t.id) : [...prev, t.id])}
                className={`badge ${depends.includes(t.id) ? 'badge-running' : 'badge-queued'} cursor-pointer`}>
                {t.id}
              </button>
            ))}
          </div>
        </div>
        <div><label className="text-xs text-muted">Write Scopes (comma-separated)</label><input className="input mt-1" value={scopes} onChange={e=>setScopes(e.target.value)} placeholder="shared/, backend/"/></div>
        <div><label className="text-xs text-muted">Model</label>
          <select className="input mt-1" value={model} onChange={e=>setModel(e.target.value)}>
            <option value="main">Main</option><option value="fast">Fast</option>
          </select>
        </div>
        <button className="btn btn-primary w-full" onClick={submit} disabled={!title || !instructions}>Add Task</button>
      </div>
    </div>
  )
}

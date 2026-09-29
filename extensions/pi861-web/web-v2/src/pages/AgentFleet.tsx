import React, { useState } from 'react'
import { Play, Pause, Square, MessageSquare, Settings, UserPlus, Zap } from 'lucide-react'

interface AgentInfo {
  id: string; role: string; capabilities: string[]; status: 'online'|'busy'|'paused'|'offline';
  currentTask?: string; primaryModel?: string; fallbackModels?: string[];
  tokensUsed?: number; cost?: number;
}

const STATUS_COLOR: Record<string,string> = { online:'green', busy:'blue', paused:'yellow', offline:'red' }
const AVATAR_COLORS = ['from-indigo-500 to-purple-600','from-blue-500 to-cyan-600','from-green-500 to-emerald-600','from-orange-500 to-red-600','from-pink-500 to-rose-600']

export default function AgentFleet({ ws, snapshot }: { ws: WebSocket|null; snapshot:any }) {
  const [selected, setSelected] = useState<AgentInfo|null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const agents: AgentInfo[] = snapshot?.agents || []

  const send = (msg: any) => ws?.send(JSON.stringify(msg))

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Agent Fleet</h2>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}><UserPlus size={16}/> Add Agent</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent, i) => (
          <div key={agent.id} className="card p-5 space-y-3 hover:border-accent transition-colors cursor-pointer" onClick={() => setSelected(agent)}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center text-lg font-bold text-white`}>
                {agent.id.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{agent.id}</p>
                <p className="text-xs text-muted">{agent.role}</p>
              </div>
              <div className={`status-dot ${STATUS_COLOR[agent.status] || 'red'}`}/>
            </div>
            {agent.currentTask && (
              <div className="text-xs text-muted truncate">⚡ {agent.currentTask}</div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              {agent.primaryModel && <span className="badge badge-running"><Zap size={10}/>{agent.primaryModel}</span>}
              {agent.fallbackModels?.map(m => <span key={m} className="badge badge-queued">↳{m}</span>)}
            </div>
            <div className="flex gap-1.5 pt-1">
              <button className="btn flex-1 text-xs" onClick={e => {e.stopPropagation(); send({type:'agent.control',agentId:agent.id,action:'pause'})}}><Pause size={12}/></button>
              <button className="btn flex-1 text-xs" onClick={e => {e.stopPropagation(); send({type:'agent.control',agentId:agent.id,action:'resume'})}}><Play size={12}/></button>
              <button className="btn btn-danger flex-1 text-xs" onClick={e => {e.stopPropagation(); send({type:'agent.control',agentId:agent.id,action:'abort'})}}><Square size={12}/></button>
              <button className="btn flex-1 text-xs" onClick={e => {e.stopPropagation(); setSelected(agent)}}><MessageSquare size={12}/></button>
              <button className="btn flex-1 text-xs" onClick={e => {e.stopPropagation(); setSelected(agent)}}><Settings size={12}/></button>
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <div className="card p-8 text-center text-muted col-span-full">No agents. Add one to get started.</div>
        )}
      </div>
      {selected && <AgentDetail agent={selected} onClose={()=>setSelected(null)} ws={ws}/>}
      {showAdd && <AddAgentWizard onClose={()=>setShowAdd(false)} ws={ws}/>}
    </div>
  )
}

function AgentDetail({ agent, onClose, ws }: { agent:AgentInfo; onClose:()=>void; ws:WebSocket|null }) {
  const [tab, setTab] = useState<'chat'|'model'|'history'>('chat')
  const [steerText, setSteerText] = useState('')
  const [primary, setPrimary] = useState(agent.primaryModel || 'main')
  const [fallbacks, setFallbacks] = useState<string[]>(agent.fallbackModels || [])
  const [failover, setFailover] = useState(true)

  const send = (msg: any) => ws?.send(JSON.stringify(msg))

  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-[480px] h-full bg-panel border-l border-border flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-lg font-bold text-white">
            {agent.id.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1"><p className="font-semibold">{agent.id}</p><p className="text-xs text-muted">{agent.role}</p></div>
          <div className={`status-dot ${STATUS_COLOR[agent.status]}`}/>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="flex border-b border-border">
          {(['chat','model','history'] as const).map(t => (
            <button key={t} className={`flex-1 py-2 text-xs font-medium capitalize ${tab===t?'text-accent border-b-2 border-accent':'text-muted'}`} onClick={()=>setTab(t)}>{t}</button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'chat' && (
            <div className="space-y-3">
              <div className="text-xs text-muted text-center">Agent conversation log will appear here</div>
              <div className="flex gap-2">
                <input className="input flex-1" placeholder="Steer this agent..." value={steerText} onChange={e=>setSteerText(e.target.value)}/>
                <button className="btn btn-primary" onClick={() => {send({type:'agent.steer',agentId:agent.id,text:steerText}); setSteerText('')}}>Send</button>
              </div>
            </div>
          )}
          {tab === 'model' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-muted">Primary Model</label>
                <select className="input mt-1" value={primary} onChange={e=>setPrimary(e.target.value)}>
                  <option value="main">glm-5.3-flash</option><option value="strong">glm-5.3</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted">Fallback Models</label>
                <div className="flex gap-2 mt-1">
                  {['glm-5.3','glm-5.3-highspeed'].map(m => (
                    <button key={m} onClick={()=>setFallbacks(prev=>prev.includes(m)?prev.filter(f=>f!==m):[...prev,m])}
                      className={`badge ${fallbacks.includes(m)?'badge-running':'badge-queued'} cursor-pointer`}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Auto Failover</span>
                <button onClick={()=>setFailover(!failover)} className={`w-10 h-6 rounded-full transition-colors ${failover?'bg-accent':'bg-border'}`}>
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${failover?'translate-x-5':'translate-x-1'}`}/>
                </button>
              </div>
              <button className="btn btn-primary w-full" onClick={()=>send({type:'model.assign',agentId:agent.id,primaryId:primary,fallbackIds:fallbacks,recovery:{failoverEnabled:failover}})}>Save Model Config</button>
            </div>
          )}
          {tab === 'history' && (
            <div className="text-xs text-muted text-center py-8">Completed tasks will appear here</div>
          )}
        </div>
      </div>
    </div>
  )
}

function AddAgentWizard({ onClose, ws }: { onClose:()=>void; ws:WebSocket|null }) {
  const [step, setStep] = useState(1)
  const [id, setId] = useState('')
  const [role, setRole] = useState('developer')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [model, setModel] = useState('main')

  const send = (msg: any) => ws?.send(JSON.stringify(msg))

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="card w-[440px] p-6 space-y-4" onClick={e=>e.stopPropagation()}>
        <h3 className="text-lg font-semibold">Add Agent</h3>
        {step === 1 && <>
          <div><label className="text-xs text-muted">Agent ID</label><input className="input mt-1" value={id} onChange={e=>setId(e.target.value)} placeholder="local-2"/></div>
          <div><label className="text-xs text-muted">Role</label>
            <select className="input mt-1" value={role} onChange={e=>setRole(e.target.value)}>
              <option>developer</option><option>reviewer</option><option>integrator</option>
            </select>
          </div>
          <button className="btn btn-primary w-full" onClick={()=>setStep(2)} disabled={!id}>Next</button>
        </>}
        {step === 2 && <>
          <div><label className="text-xs text-muted">Capabilities (click to toggle)</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {['node','kotlin','python','api-design','review','integration'].map(c => (
                <button key={c} onClick={()=>setCapabilities(prev=>prev.includes(c)?prev.filter(x=>x!==c):[...prev,c])}
                  className={`badge ${capabilities.includes(c)?'badge-running':'badge-queued'} cursor-pointer`}>{c}</button>
              ))}
            </div>
          </div>
          <div><label className="text-xs text-muted">Model</label>
            <select className="input mt-1" value={model} onChange={e=>setModel(e.target.value)}>
              <option value="main">glm-5.3-flash</option><option value="strong">glm-5.3</option>
            </select>
          </div>
          <div className="flex gap-2"><button className="btn flex-1" onClick={()=>setStep(1)}>Back</button>
          <button className="btn btn-primary flex-1" onClick={()=>{send({type:'team.join',agent:{id,role,capabilities,modelId:model}}); onClose()}}>Add Agent</button></div>
        </>}
      </div>
    </div>
  )
}

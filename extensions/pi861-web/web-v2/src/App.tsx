import React, { useState, useEffect, useRef, useCallback } from 'react'
import { MessageSquare, Target, Users, Brain, Settings as SettingsIcon, Wifi, WifiOff } from 'lucide-react'
import Chat from './pages/Chat'
import MissionControl from './pages/MissionControl'
import AgentFleet from './pages/AgentFleet'
import ModelHub from './pages/ModelHub'
import Settings from './pages/Settings'

type Page = 'chat'|'mission'|'agents'|'models'|'settings'
const NAV: {id:Page; label:string; icon:React.ReactNode}[] = [
  {id:'chat', label:'Chat', icon:<MessageSquare size={18}/>},
  {id:'mission', label:'Mission Control', icon:<Target size={18}/>},
  {id:'agents', label:'Agent Fleet', icon:<Users size={18}/>},
  {id:'models', label:'Models', icon:<Brain size={18}/>},
  {id:'settings', label:'Settings', icon:<SettingsIcon size={18}/>},
]

export default function App() {
  const [page, setPage] = useState<Page>('chat')
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState<any>(null)
  const [token, setToken] = useState(localStorage.getItem('pi861_token') || '')
  const [showAuth, setShowAuth] = useState(!token)
  const wsRef = useRef<WebSocket|null>(null)

  const connect = useCallback((tok: string) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${tok}`)
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({type:'subscribe'})) }
    ws.onclose = () => { setConnected(false); setTimeout(()=>connect(tok), 3000) }
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.type === 'project.snapshot') setSnapshot(data.snapshot)
    }
    wsRef.current = ws
  }, [])

  useEffect(() => { if (token) connect(token) }, [token, connect])

  if (showAuth) return <Auth onAuth={(t)=>{localStorage.setItem('pi861_token',t); setToken(t); setShowAuth(false)}}/>

  return (
    <div style={{display:'grid', gridTemplateRows:'48px 1fr', gridTemplateColumns:'220px 1fr', height:'100vh'}}>
      {/* Top Bar */}
      <div style={{gridColumn:'1/-1'}} className="flex items-center justify-between px-4 border-b border-border bg-panel">
        <span className="font-bold text-accent text-lg">⚡ pi861</span>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted text-xs">{snapshot?.goal?.objective?.slice(0,40) || 'No goal'}</span>
          {connected
            ? <span className="badge badge-done"><Wifi size={12}/> Connected</span>
            : <span className="badge badge-blocked"><WifiOff size={12}/> Reconnecting...</span>}
        </div>
      </div>

      {/* Sidebar */}
      <div className="border-r border-border bg-panel p-2 flex flex-col gap-1">
        {NAV.map(item => (
          <button key={item.id} onClick={()=>setPage(item.id)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all
              ${page===item.id ? 'bg-accent/10 text-accent font-semibold' : 'text-muted hover:bg-accent/5 hover:text-text'}`}>
            {item.icon}<span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="overflow-hidden">
        {page==='chat' && <Chat ws={wsRef.current} connected={connected}/>}
        {page==='mission' && <MissionControl ws={wsRef.current} snapshot={snapshot}/>}
        {page==='agents' && <AgentFleet ws={wsRef.current} snapshot={snapshot}/>}
        {page==='models' && <ModelHub snapshot={snapshot}/>}
        {page==='settings' && <Settings ws={wsRef.current} snapshot={snapshot}/>}
      </div>
    </div>
  )
}

function Auth({ onAuth }: { onAuth:(t:string)=>void }) {
  const [token, setToken] = useState('')
  return (
    <div className="flex items-center justify-center" style={{height:'100vh', background:'var(--color-bg)'}}>
      <div className="card p-8 w-96 space-y-4 text-center">
        <div className="text-4xl mb-2">⚡</div>
        <h2 className="text-xl font-bold">pi861 Console</h2>
        <p className="text-sm text-muted">Enter your access token</p>
        <input className="input" type="password" placeholder="Token..." value={token} onChange={e=>setToken(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&token)onAuth(token)}} autoFocus/>
        <button className="btn btn-primary w-full" onClick={()=>token&&onAuth(token)} disabled={!token}>Connect</button>
      </div>
    </div>
  )
}

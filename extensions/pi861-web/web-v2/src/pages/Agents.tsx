import React from 'react'
export default function Agents({ ws, snapshot }: { ws:WebSocket|null; snapshot:any }) {
  const agents = snapshot?.agents || []
  const colors = ['#818cf8','#34d399','#fbbf24','#f87171','#60a5fa']
  const send = (m:any)=>ws?.send(JSON.stringify(m))
  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <h2 style={{fontSize:18,fontWeight:600}}>Agent Fleet</h2>
        <button className="btn btn-primary" onClick={()=>send({type:'team.join',agent:{id:`local-${agents.length}`,role:'developer',capabilities:['node'],modelId:'main'}})}>+ Add Agent</button>
      </div>
      <div className="agents-grid">
        {agents.map((a:any,i:number)=>(
          <div key={a.id} className="card agent-card">
            <div className="agent-header">
              <div className="agent-avatar" style={{background:`linear-gradient(135deg,${colors[i%5]},${colors[(i+1)%5]})`}}>{a.id[0]?.toUpperCase()}</div>
              <div style={{flex:1,minWidth:0}}><div className="agent-name">{a.id}</div><div className="agent-role">{a.role}</div></div>
              <div className={`status-dot ${a.status==='busy'?'blue':a.status==='online'?'green':'yellow'}`}/>
            </div>
            {a.currentTask&&<div style={{fontSize:12,color:'var(--muted)'}}>⚡ {a.currentTask}</div>}
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {a.primaryModel&&<span className="badge badge-running">{a.primaryModel}</span>}
              {a.fallbackModels?.map((m:string)=><span key={m} className="badge badge-queued">↳{m}</span>)}
            </div>
            <div className="agent-actions">
              <button className="btn" onClick={()=>send({type:'agent.control',agentId:a.id,action:'pause'})}>⏸</button>
              <button className="btn" onClick={()=>send({type:'agent.control',agentId:a.id,action:'resume'})}>▶</button>
              <button className="btn btn-danger" onClick={()=>send({type:'agent.control',agentId:a.id,action:'abort'})}>■</button>
            </div>
          </div>
        ))}
        {agents.length===0&&<div className="card" style={{padding:40,textAlign:'center',color:'var(--muted)',gridColumn:'1/-1'}}>No agents yet</div>}
      </div>
    </div>
  )
}

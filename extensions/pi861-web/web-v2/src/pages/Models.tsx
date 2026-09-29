import React from 'react'
export default function Models({ snapshot }: { snapshot:any }) {
  const usage = snapshot?.usage||{}; const budget = snapshot?.budget||{}
  const pct = budget.limit?Math.round(budget.used/budget.limit*100):0
  return (
    <div className="page">
      <div className="stats-grid">
        <div className="card" style={{padding:20}}><div style={{fontSize:11,color:'var(--muted)',textTransform:'uppercase',marginBottom:8}}>Requests</div><div style={{fontSize:24,fontWeight:700}}>{usage.totalRequests||0}</div></div>
        <div className="card" style={{padding:20}}><div style={{fontSize:11,color:'var(--muted)',textTransform:'uppercase',marginBottom:8}}>Cost</div><div style={{fontSize:24,fontWeight:700}}>${(usage.cost||0).toFixed(4)}</div></div>
        <div className="card" style={{padding:20}}><div style={{fontSize:11,color:'var(--muted)',textTransform:'uppercase',marginBottom:8}}>Budget</div><div style={{fontSize:24,fontWeight:700}}>{budget.used}/{budget.limit}</div><div className="progress-track" style={{marginTop:8}}><div className="progress-fill" style={{width:`${pct}%`}}/></div></div>
      </div>
      <div className="card" style={{padding:20}}>
        <div style={{fontSize:11,color:'var(--muted)',textTransform:'uppercase',marginBottom:12}}>Agent Model Assignment</div>
        <table className="data-table"><thead><tr><th>Agent</th><th>Primary</th><th>Fallback</th><th>Status</th></tr></thead>
        <tbody>{(snapshot?.agents||[]).map((a:any)=>(
          <tr key={a.id}><td style={{fontWeight:600}}>{a.id}</td><td><span className="badge badge-running">{a.primaryModel||'default'}</span></td><td><span className="badge badge-queued">{a.fallbackModels?.join(' → ')||'none'}</span></td><td><div className={`status-dot ${a.status==='busy'?'blue':a.status==='online'?'green':'yellow'}`}/></td></tr>
        ))}</tbody></table>
      </div>
    </div>
  )
}

import React from 'react'
export default function Mission({ ws, snapshot }: { ws:WebSocket|null; snapshot:any }) {
  const goal = snapshot?.goal; const tasks = snapshot?.tasks || []
  const done = tasks.filter((t:any)=>t.status==='done').length
  const pct = tasks.length ? Math.round(done/tasks.length*100) : 0
  const cols = ['queued','running','done','blocked']
  const labels: Record<string,string> = {queued:'Queued',running:'Running',done:'Done',blocked:'Blocked'}
  const send = (m:any)=>ws?.send(JSON.stringify(m))
  return (
    <div className="page">
      {goal && (
        <div className="card goal-header">
          <svg viewBox="0 0 80 80" className="goal-ring" style={{transform:'rotate(-90deg)'}}>
            <circle cx="40" cy="40" r="34" fill="none" stroke="var(--border)" strokeWidth="6"/>
            <circle cx="40" cy="40" r="34" fill="none" stroke="var(--accent)" strokeWidth="6"
              strokeDasharray={`${2*Math.PI*34*pct/100} ${2*Math.PI*34}`} strokeLinecap="round"/>
          </svg>
          <div className="goal-ring-text">{pct}%</div>
          <div className="goal-info">
            <div className="goal-title">{goal.objective}</div>
            <div className="goal-sub">{done}/{tasks.length} tasks · <span className={`badge badge-${goal.status}`}>{goal.status}</span></div>
          </div>
          <div style={{display:'flex',gap:8}}>
            {goal.status==='active'&&<><button className="btn" onClick={()=>send({type:'goal.control',action:'pause'})}>⏸ Pause</button><button className="btn btn-danger" onClick={()=>send({type:'goal.control',action:'cancel'})}>■ Abort</button></>}
            {goal.status==='paused'&&<button className="btn btn-primary" onClick={()=>send({type:'goal.control',action:'resume'})}>▶ Resume</button>}
            {goal.status==='review'&&<button className="btn btn-primary" onClick={()=>send({type:'goal.control',action:'accept'})}>✓ Accept</button>}
          </div>
        </div>
      )}
      <div className="kanban">
        {cols.map(col=>(
          <div key={col}>
            <div className="kanban-col-header"><span>{labels[col]}</span><span>{tasks.filter((t:any)=>t.status===col).length}</span></div>
            <div style={{display:'flex',flexDirection:'column',gap:8,minHeight:80}}>
              {tasks.filter((t:any)=>t.status===col).map((t:any)=>(
                <div key={t.id} className="card task-card">
                  <div className="task-card-header"><span className="task-card-id">{t.id}</span><span className={`badge badge-${t.status}`}>{t.status}</span></div>
                  <div className="task-card-title">{t.title}</div>
                  <div className="task-card-meta">{t.workerId&&<span>👤 {t.workerId}</span>}<span>🔄 {t.attempts}/{t.maxAttempts}</span></div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

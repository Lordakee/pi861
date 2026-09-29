import React,{useState} from 'react'
export default function Settings({ ws, snapshot }: { ws:WebSocket|null; snapshot:any }) {
  const p = snapshot?.project||{}
  const [conc,setConc]=useState(p.maxConcurrent||2); const [rev,setRev]=useState(p.reviewSlots||1); const [saved,setSaved]=useState(false)
  return (
    <div className="page" style={{maxWidth:600}}>
      <h2 style={{fontSize:18,fontWeight:600}}>Settings</h2>
      <div className="card" style={{padding:24,display:'flex',flexDirection:'column',gap:20}}>
        <div><div style={{display:'flex',justifyContent:'space-between',marginBottom:8,fontSize:14}}><span>Max Concurrent Workers</span><span style={{color:'var(--accent)',fontWeight:600}}>{conc}</span></div>
        <input type="range" min="1" max="8" value={conc} onChange={e=>setConc(+e.target.value)} style={{width:'100%',accentColor:'#818cf8'}}/></div>
        <div><div style={{display:'flex',justifyContent:'space-between',marginBottom:8,fontSize:14}}><span>Review Slots</span><span style={{color:'var(--accent)',fontWeight:600}}>{rev}</span></div>
        <input type="range" min="0" max="4" value={rev} onChange={e=>setRev(+e.target.value)} style={{width:'100%',accentColor:'#818cf8'}}/></div>
        <button className="btn btn-primary" onClick={()=>{ws?.send(JSON.stringify({type:'settings.update',settings:{maxConcurrent:conc,reviewSlots:rev}}));setSaved(true);setTimeout(()=>setSaved(false),2000)}}>{saved?'✓ Saved!':'Save Settings'}</button>
      </div>
      <div className="card" style={{padding:24}}>
        <div style={{fontSize:11,color:'var(--muted)',textTransform:'uppercase',marginBottom:8}}>Storage</div>
        <input className="input" value={p.stateDirectory||'—'} readOnly/>
      </div>
    </div>
  )
}

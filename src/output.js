const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function markdownReport(report) {
  return `# ${report.mission}\n\nOutcome: **${report.outcome}**\n\n${report.reason}\n\n` +
    `- Inferred location: [${report.inferredLocation}]\n- Location confidence: ${(100 * report.locationConfidence).toFixed(1)}%\n` +
    `- Status: ${report.inferredStatus} (${(100 * report.statusConfidence).toFixed(1)}%)\n- Actions: ${report.actions}\n` +
    `- Battery remaining: ${report.resources.batteryRemaining}/${report.resources.batteryCapacity}\n` +
    `- Time used: ${report.resources.timeUsed}/${report.resources.timeBudget}\n\n` +
    `## Recommended next step\n\n${report.recommendedNextStep}\n\n` +
    `Confidence is the model's posterior probability, not an independently calibrated success rate. Only direct contact confirms EVE's location and status.\n\n` +
    `## Evidence\n\n` + report.evidence.map(e => `- ${e.type} at t=${e.timestamp}: \`${JSON.stringify(e)}\``).join('\n') + '\n';
}

export function replayHtml(run) {
  // Escape '<' so config names cannot terminate the data script element.
  const data = JSON.stringify(run).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(run.mission.name)} · Signal room</title>
<style>
:root{color-scheme:dark;--bg:#101817;--panel:#192321;--line:#34413b;--text:#edf2e8;--muted:#9cae9f;--lime:#c4ed86;--orange:#f6ac73}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:36px 40px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:22px}.brand{font-size:12px;letter-spacing:3px;color:var(--lime)}.tag{font:11px monospace;border:1px solid var(--line);padding:9px 12px;border-radius:20px;color:var(--muted)}h1{font-size:clamp(28px,4vw,48px);font-weight:500;margin:30px 0 10px;letter-spacing:-2px}.subtitle{color:var(--muted);margin-bottom:30px}.layout{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:22px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}.panelhead{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid var(--line)}.label{font:11px monospace;letter-spacing:1.7px;color:var(--muted)}#map{display:block;width:100%;max-height:530px;padding:24px}#map text{font-family:monospace;pointer-events:none}.legend{display:flex;gap:22px;flex-wrap:wrap;padding:0 24px 22px;color:var(--muted);font:11px monospace}.legend b{color:var(--lime)}.controls{padding:20px 24px;border-top:1px solid var(--line);display:flex;gap:16px;align-items:center}button{cursor:pointer;border:1px solid var(--line);background:var(--lime);color:#192321;border-radius:8px;padding:10px 16px;font-weight:700}button.secondary{background:transparent;color:var(--text)}button:disabled{opacity:.35;cursor:default}input{flex:1;min-width:40px;accent-color:var(--lime)}.sidebar{display:flex;flex-direction:column;gap:18px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}.stat{background:var(--panel);padding:24px}.number{font-size:30px;margin:10px 0 0;font-variant-numeric:tabular-nums}.unit{color:var(--muted);font-size:13px}.bar{height:4px;background:#34413b;margin-top:15px;border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--lime)}.body{padding:22px}.body h2{font-size:21px;font-weight:500;margin:5px 0 12px}.body p{line-height:1.7;color:var(--muted);margin:6px 0}#action{color:var(--orange);font:12px monospace;letter-spacing:1px}.event{margin-top:18px;border-left:2px solid var(--lime);padding-left:13px}.foot{display:flex;justify-content:space-between;gap:20px;margin-top:25px;color:var(--muted);font:11px monospace;line-height:1.7}#step{font:12px monospace;color:var(--lime)}@media(max-width:850px){main{padding:22px 16px}.layout{grid-template-columns:1fr}h1{letter-spacing:-1px}.controls{gap:10px;padding:16px}.tag{display:none}.foot{flex-direction:column}.number{font-size:26px}}
</style></head><body><main>
<header><div class="brand">WALL-E / SIGNAL ROOM</div><div class="tag">AUTONOMOUS SEARCH · MISSION REPLAY</div></header>
<h1>${escapeHtml(run.mission.name)}</h1><p class="subtitle">One small robot. A fading signal. A way back home.</p>
<div class="layout"><section class="panel"><div class="panelhead"><span class="label">SECTOR MAP / POSTERIOR BELIEF</span><span id="step"></span></div>
<svg id="map" role="img" aria-label="Mission map with robot path, observed clues and location probabilities"></svg>
<div class="legend"><span><b>●</b> WALL-E</span><span><b>⌂</b> CHARGER</span><span style="color:var(--orange)">◆ FOUND CLUE</span><span>BRIGHTER = MORE LIKELY</span></div>
<div class="controls"><button id="play">Play</button><button id="back" class="secondary" aria-label="Previous action">←</button><input id="timeline" aria-label="Mission step" type="range" min="0" value="0"><button id="next" class="secondary" aria-label="Next action">→</button></div></section>
<aside class="sidebar"><section class="panel"><div class="stats">
<div class="stat"><div class="label">BATTERY</div><div class="number" id="battery"></div><div class="bar"><i id="batterybar"></i></div></div>
<div class="stat"><div class="label">ELAPSED</div><div class="number" id="elapsed"></div><div class="bar"><i id="timebar"></i></div></div>
<div class="stat"><div class="label">CONFIDENCE</div><div class="number" id="confidence"></div></div>
<div class="stat"><div class="label">EVE STATUS</div><div class="number" id="status" style="font-size:22px"></div></div></div></section>
<section class="panel"><div class="panelhead"><span class="label">DECISION LOG</span><span id="action"></span></div><div class="body"><h2 id="decisionTitle"></h2><p id="reason"></p><div class="event"><span class="label">OBSERVATION</span><p id="observation"></p></div></div></section>
<section class="panel"><div class="body"><span class="label">MISSION OUTLOOK</span><h2 id="outcome"></h2><p id="recommendation"></p></div></section></aside></div>
<div class="foot"><span>Only observed clues are shown. The target stays hidden until contact.</span><span>SEED ${run.mission.seed} / GRID ${run.mission.map.width} × ${run.mission.map.height} / NO NETWORK REQUIRED</span></div>
</main><script id="run-data" type="application/json">${data}</script><script>
const run=JSON.parse(document.getElementById('run-data').textContent), $=id=>document.getElementById(id);
let index=0,timer=null;
const slider=$('timeline'); slider.max=run.trace.length;
const map=run.mission.map, size=40;
$('map').setAttribute('viewBox','0 0 '+map.width*size+' '+map.height*size);
function pause(){clearInterval(timer);timer=null;$('play').textContent='Play'}
function render(){
 slider.value=index;$('step').textContent=String(index).padStart(2,'0')+' / '+run.trace.length;
 const frame=run.trace[index-1],state=frame?frame.result:{position:run.mission.start,battery:run.mission.resources.battery,elapsed:0},belief=frame?frame.belief:null;
 const probs=frame?frame.probabilities:{},max=Math.max(0.001,...Object.values(probs));
 let svg='';
 for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++){
  const wall=map.obstacles.some(p=>p[0]===x&&p[1]===y),p=probs[x+','+y]||0;
  const fill=wall?'#3a4640':p?'rgba(196,237,134,'+(0.06+0.65*p/max)+')':'#202d28';
  svg+='<rect x="'+(x*size+2)+'" y="'+(y*size+2)+'" width="36" height="36" rx="5" fill="'+fill+'"/>';
  if(wall)svg+='<path d="M'+(x*size+12)+' '+(y*size+12)+' l16 16 m0 -16 l-16 16" stroke="#58635b"/>';
 }
 const path=[run.mission.start,...run.trace.slice(0,index).filter(f=>f.action.type==='move').map(f=>f.result.position)];
 svg+='<polyline points="'+path.map(p=>(p[0]*size+20)+','+(p[1]*size+20)).join(' ')+'" fill="none" stroke="#c4ed86" stroke-width="2" stroke-opacity=".65" stroke-dasharray="4 4"/>';
 for(const p of run.mission.chargers)svg+='<text x="'+(p[0]*size+20)+'" y="'+(p[1]*size+26)+'" text-anchor="middle" fill="#c4ed86" font-size="25">⌂</text>';
 const clues=run.trace.slice(0,index).flatMap(f=>f.result.observation.clues);
 for(const c of clues)svg+='<text x="'+(c.position[0]*size+20)+'" y="'+(c.position[1]*size+25)+'" text-anchor="middle" fill="#f6ac73" font-size="20">◆</text>';
 const pos=state.position;
 svg+='<circle cx="'+(pos[0]*size+20)+'" cy="'+(pos[1]*size+20)+'" r="13" fill="#c4ed86" stroke="#101817" stroke-width="3"/><text x="'+(pos[0]*size+20)+'" y="'+(pos[1]*size+24)+'" text-anchor="middle" fill="#101817" font-size="11" font-weight="bold">'+(state.found?'E':'W')+'</text>';
 $('map').innerHTML=svg;
 $('battery').textContent=state.battery.toFixed(0)+' / '+run.mission.resources.battery;
 $('elapsed').textContent=state.elapsed+' / '+run.mission.resources.time;
 $('batterybar').style.width=(state.battery/run.mission.resources.battery*100)+'%';
 $('timebar').style.width=(state.elapsed/run.mission.resources.time*100)+'%';
 $('confidence').textContent=belief?(belief.confidence*100).toFixed(1)+'%':'—';
 $('status').textContent=belief?belief.status:'unknown';
 $('action').textContent=frame?frame.action.type.toUpperCase():'READY';
 $('decisionTitle').textContent=frame?({move:'Following the evidence',scan:'Listening for EVE',recharge:'A moment to recharge'}[frame.action.type]):'Waiting for the first reading';
 $('reason').textContent=frame?frame.action.reason:'The initial signal is available. Start the replay to watch WALL-E choose its next move.';
 const o=frame?frame.result.observation:null;
 $('observation').textContent=!o?'No actions taken yet.':o.contact?'Direct contact. EVE is '+o.contact.status+'.':o.signal?'Signal range '+o.signal.range.toFixed(2)+'; bearing '+(o.signal.bearing*180/Math.PI).toFixed(1)+'°. '+o.clues.length+' new clue(s).':frame.action.type==='recharge'?'Battery restored to full capacity.':'No direct contact at ['+pos+'].';
 const done=index===run.trace.length;
 $('outcome').textContent=done?(run.report.outcome==='found'?'EVE found.':'Search inconclusive.'):'Search in progress';
 $('recommendation').textContent=done?run.report.reason+' '+run.report.recommendedNextStep:'Plans adapt after each observation. Battery and time reserves keep a route home available.';
 $('back').disabled=index===0;$('next').disabled=done;
}
slider.oninput=()=>{pause();index=Number(slider.value);render()};
$('back').onclick=()=>{pause();index=Math.max(0,index-1);render()};
$('next').onclick=()=>{pause();index=Math.min(run.trace.length,index+1);render()};
$('play').onclick=()=>{if(timer){pause();return}if(index===run.trace.length)index=0;$('play').textContent='Pause';timer=setInterval(()=>{index=Math.min(run.trace.length,index+1);render();if(index===run.trace.length)pause()},450)};
document.addEventListener('keydown',event=>{if(event.target.tagName==='INPUT')return;if(event.key==='ArrowRight')$('next').click();if(event.key==='ArrowLeft')$('back').click()});render();
</script></body></html>`;
}

/** Styles of the Calibrate wizard (injected; index.html stays untouched). */
export const CALIB_CSS = `
#calibPanel { position:absolute; top:12px; right:12px; bottom:12px; width:min(1180px, calc(100vw - 380px)); min-width:760px;
  background:rgba(13,17,26,0.96); border:1px solid #2a3140; border-radius:10px; display:none; flex-direction:column; z-index:20;
  font-size:13px; color:#d7dde6; }
#calibPanel.open { display:flex; }
#calibPanel header { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid #232a38; }
#calibPanel header h1 { font-size:15px; margin:0 8px 0 0; }
#calibPanel .steps { display:flex; gap:4px; flex:1; flex-wrap:wrap; }
#calibPanel .steps button { padding:4px 9px; font-size:12px; }
#calibPanel .steps button.active { background:#2c57a8; border-color:#3a6bcf; }
#calibPanel .steps button.done::after { content:" \\2713"; color:#6fd08c; }
#calibPanel .body { display:flex; gap:12px; padding:12px 14px; flex:1; min-height:0; }
#calibPanel .view { flex:1.35; min-width:0; display:flex; flex-direction:column; gap:8px; }
#calibPanel .side { flex:1; min-width:330px; overflow-y:auto; padding-right:4px; }
#calibPanel .cam { position:relative; width:100%; background:#000; border:1px solid #2a3140; border-radius:6px; overflow:hidden; }
#calibPanel .cam img, #calibPanel .cam canvas { position:absolute; inset:0; width:100%; height:100%; }
#calibPanel .cam canvas { cursor:crosshair; }
#calibPanel .topdown { display:flex; gap:8px; }
#calibPanel .topdown img { width:220px; height:220px; border:1px solid #2a3140; border-radius:6px; background:#000; object-fit:contain; }
#calibPanel h2 { font-size:13px; margin:0 0 6px; color:#9fb0c7; }
#calibPanel h3 { font-size:12px; margin:12px 0 4px; color:#7f8ea3; text-transform:uppercase; letter-spacing:.4px; }
#calibPanel p { margin:4px 0; line-height:1.4; }
#calibPanel .guide { background:#151c2a; border-left:3px solid #3a6bcf; padding:6px 8px; border-radius:4px; margin:6px 0; }
#calibPanel .warn { color:#f2b84b; }
#calibPanel .bad { color:#ff6b6b; }
#calibPanel .good { color:#6fd08c; }
#calibPanel .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-variant-numeric:tabular-nums; }
#calibPanel .kv span:nth-child(odd) { color:#8fa0b6; }
#calibPanel .row { display:flex; align-items:center; gap:8px; margin:5px 0; flex-wrap:wrap; }
#calibPanel .row label { min-width:96px; color:#9fb0c7; }
#calibPanel input[type=number], #calibPanel select, #calibPanel textarea { background:#0f1420; color:#d7dde6; border:1px solid #2a3140; border-radius:4px; padding:3px 5px; }
#calibPanel input[type=number] { width:78px; }
#calibPanel textarea { width:100%; min-height:48px; }
#calibPanel .bar { height:8px; background:#1e2636; border-radius:4px; overflow:hidden; flex:1; min-width:80px; }
#calibPanel .bar > div { height:100%; background:#3a6bcf; }
#calibPanel .mini { border-collapse:collapse; margin:6px 0; }
#calibPanel .mini td { width:30px; height:30px; text-align:center; font-size:10px; border:1px solid #232a38; position:relative; padding:0; }
#calibPanel .mini td.lab { border:none; color:#6f7d91; width:14px; }
#calibPanel .mini td .pc { display:inline-block; width:18px; height:18px; border-radius:50%; line-height:18px; font-size:9px; }
#calibPanel .mini td.err { outline:2px solid #ff6b6b; outline-offset:-2px; }
#calibPanel .mini td.flag { outline:2px solid #f2b84b; outline-offset:-2px; }
#calibPanel .jog { display:grid; grid-template-columns:repeat(3, 54px); gap:4px; }
#calibPanel .msg { min-height:18px; margin-top:8px; }
#calibPanel .versions { max-height:150px; overflow-y:auto; }
#calibPanel .versions div { display:flex; gap:8px; align-items:center; padding:2px 0; }
#calibGate { margin:6px 0; padding:6px 8px; border-radius:4px; font-size:12px; display:none; }
#calibGate.blocked { display:block; background:#3a1d1d; color:#ffb3b3; border:1px solid #8a3b2c; }
#calibGate.ok { display:block; background:#173022; color:#a9e6bd; border:1px solid #2e6b46; }
`;

// Treasure Wars cloud watcher — one launch loops every 5 min for ~75 min.
// An hourly trigger relaunches it; concurrency cancels the old loop so there's
// always exactly one running. READ-ONLY: never bids.
const TOKEN = process.env.TW_TOKEN;
const TOPIC = process.env.NTFY_TOPIC;
const SNAP  = "https://api.treasurewars.live/api/v1/tournaments/active/snapshot";
const ALERT_MIN = 30, STRIKE_MIN = 15;
const LOOP_MIN = 75, EVERY_MS = 5*60*1000;

const CHEST = { brown:{blind:5}, blue:{blind:21}, red:{blind:13}, green:{blind:37}, purple:{blind:57}, royal:{blind:143} };
const JCAP  = { red:45, purple:107 };
const SPRIO = { purple:3, red:2, green:1, blue:0, brown:0, royal:0 };
const nc  = c => { c=String(c||"").toLowerCase().replace(/[^a-z]/g,""); return c.includes("royal")?"royal":c; };
const fmt = s => s<3600 ? `${Math.round(s/60)}m` : `${Math.floor(s/3600)}h${Math.round(s%3600/60)}m`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function ntfy(title, body){
  if(!TOPIC) return;
  try { await fetch(`https://ntfy.sh/${TOPIC}`, { method:"POST", body, headers:{ Title:title, Priority:"high", Tags:"moneybag" } }); }
  catch(e){ console.error("ntfy", e.message); }
}

async function runOnce(){
  let d;
  try {
    const r = await fetch(SNAP, { headers:{ Authorization:"Bearer "+TOKEN } });
    if(r.status===401){ await ntfy("Treasure Wars - token expired","Log in and update the TW_TOKEN secret."); return; }
    if(!r.ok){ console.error("http", r.status); return; }
    d = (await r.json()).data;
  } catch(e){ console.error("fetch", e.message); return; }

  const now = Date.now()/1000;
  const t = d.tournament || {}, rules = t.rules || {};
  const fee = rules.firstBidFee ?? 1;
  const dayEnd = t.startsAt ? Date.parse(t.startsAt)/1000 + (d.currentDayNumber||1)*(t.competitiveDayHours||24)*3600 : null;
  const earlySell = (rules.earlySellHours||12)*3600;
  const gold = d.teamWallet?.goldBalance;
  const closeSecs = ch => { let s=Infinity; if(dayEnd&&dayEnd>now)s=Math.min(s,dayEnd-now); if(ch.leadingBid>0&&ch.lastBidAt){const e=ch.lastBidAt+earlySell;if(e>now)s=Math.min(s,e-now);} return s===Infinity?null:s; };

  const hits=[], byColor={}; let outbid=0; const scouted=[];
  (d.chests||[]).forEach((ch,i) => {
    const spec = CHEST[nc(ch.color)]; if(!spec) return;
    const bid = ch.leadingBid||0;
    if(ch.status==="open" && bid>0){ const s=byColor[nc(ch.color)]||(byColor[nc(ch.color)]={withBids:0,overCap:0}); s.withBids++; if(bid>=spec.blind) s.overCap++; }
    if(ch.myTeamConfirmedBidAmount>0 && bid>ch.myTeamConfirmedBidAmount) outbid++;
    if(ch.teamHasScouted && ch.revealedGold!=null) scouted.push({color:nc(ch.color), g:ch.revealedGold});
    if(ch.status!=="open") return;
    let cap;
    if(ch.teamHasScouted && ch.revealedGold!=null){ if(ch.revealedGold===0) return; cap = ch.revealedGold-2-fee; }
    else { cap = spec.blind; if(ch.teamsScoutedCount>0 && bid>=spec.blind) return; }
    if(cap-bid<=0) return;
    const secs = closeSecs(ch); if(secs==null || secs>ALERT_MIN*60) return;
    hits.push({ i, color:ch.color, bid, cap, secs });
  });
  hits.sort((a,b)=> a.secs-b.secs || (b.cap-b.bid)-(a.cap-a.bid));
  const scoutLeft = (d.scoutContext?.scoutLimit||0) - (d.scoutContext?.scoutsUsedToday||0);
  if(hits.length){
    const lines = hits.slice(0,6).map(h=>`#${h.i+1} ${h.color}: bid up to ${h.cap} (now ${h.bid}, closes ${fmt(h.secs)})`);
    let body = lines.join("\n"); if(gold!=null) body+=`\nGold: ${gold}`; if(scoutLeft>0) body+=`\nScout still unused today`;
    await ntfy(`Treasure Wars - ${hits.length} chest(s) closing`, body); console.log("alerted", hits.length);
  } else console.log("nothing closing soon", new Date().toISOString());

  const flags=[];
  for(const [c,s] of Object.entries(byColor)) if(s.withBids>=4 && s.overCap>=3 && s.overCap/s.withBids>=0.4) flags.push(`${c}: ${s.overCap}/${s.withBids} leading bids at/above your cap (field hot)`);
  if(outbid>=2) flags.push(`${outbid} of your confirmed bids are being outbid`);
  const byc={}; scouted.forEach(x=>{(byc[x.color]||(byc[x.color]=[])).push(x.g);});
  const EXP={ brown:10, blue:30, red:25, green:50, purple:76, royal:150 };
  for(const [c,arr] of Object.entries(byc)) if(arr.length>=3){ const avg=arr.reduce((a,b)=>a+b,0)/arr.length; if(EXP[c]&&Math.abs(avg-EXP[c])/EXP[c]>0.35) flags.push(`${c} scouts averaging ${avg.toFixed(0)}g vs assumed ${EXP[c]}g (odds may be off)`); }
  if(flags.length){ await ntfy("Treasure Wars - STRATEGY CHECK", flags.join("\n")+"\nPing Claude to retune."); console.log("strategy check", flags); }

  if(dayEnd){
    const toBell = dayEnd - now;
    if(toBell>0 && toBell<=STRIKE_MIN*60 && scoutLeft>0){
      const cands=(d.chests||[]).map((ch,i)=>({ch,i})).filter(({ch})=>ch.status==="open" && !ch.teamHasScouted && SPRIO[nc(ch.color)]>0);
      cands.sort((a,b)=> SPRIO[nc(b.ch.color)]-SPRIO[nc(a.ch.color)] || (a.ch.teamsScoutedCount||0)-(b.ch.teamsScoutedCount||0) || (a.ch.leadingBid||0)-(b.ch.leadingBid||0));
      if(cands.length){ const tt=cands[0], j=JCAP[nc(tt.ch.color)];
        await ntfy("Treasure Wars - STRIKE WINDOW", `Bell in ${Math.round(toBell/60)}m. Scout #${tt.i+1} ${tt.ch.color} and bid now${j?` (up to ${j} if jackpot)`:""}. Reveal late so no one can counter.`);
        console.log("strike window", tt.i+1);
      }
    }
  }
}

(async () => {
  if(!TOKEN){ console.error("no TW_TOKEN"); process.exit(1); }
  const endAt = Date.now() + LOOP_MIN*60*1000;
  while(Date.now() < endAt){ try { await runOnce(); } catch(e){ console.error("loop", e.message); } await sleep(EVERY_MS); }
  console.log("loop done");
})();

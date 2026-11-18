// Treasure Wars cloud watcher — runs on GitHub Actions every 5 min.
// Polls the live snapshot and pushes a phone alert (ntfy) when a worthwhile
// chest is closing soon. READ-ONLY: it never places or confirms a bid.
const TOKEN = process.env.TW_TOKEN;
const TOPIC = process.env.NTFY_TOPIC || "treasurewars-krith-9f3k2";
const SNAP  = "https://api.treasurewars.live/api/v1/tournaments/active/snapshot";
const ALERT_MIN = 30; // alert when a good, under-cap chest closes within this many minutes

const CHEST = { brown:{blind:5}, blue:{blind:21}, red:{blind:13}, green:{blind:37}, purple:{blind:57}, royal:{blind:143} };
const nc  = c => { c=String(c||"").toLowerCase().replace(/[^a-z]/g,""); return c.includes("royal")?"royal":c; };
const fmt = s => s<3600 ? `${Math.round(s/60)}m` : `${Math.floor(s/3600)}h${Math.round(s%3600/60)}m`;

async function ntfy(title, body){
  try { await fetch(`https://ntfy.sh/${TOPIC}`, { method:"POST", body, headers:{ Title:title, Priority:"high", Tags:"moneybag" } }); }
  catch(e){ console.error("ntfy", e.message); }
}

(async () => {
  if(!TOKEN){ console.error("no TW_TOKEN env"); process.exit(1); }
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

  const closeSecs = ch => {
    let s = Infinity;
    if(dayEnd && dayEnd>now) s = Math.min(s, dayEnd-now);
    if(ch.leadingBid>0 && ch.lastBidAt){ const e=ch.lastBidAt+earlySell; if(e>now) s=Math.min(s,e-now); }
    return s===Infinity ? null : s;
  };

  const hits = [];
  const byColor = {};
  let outbid = 0;
  const scouted = [];

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
    const secs = closeSecs(ch);
    if(secs==null || secs > ALERT_MIN*60) return;
    hits.push({ i, color:ch.color, bid, cap, secs });
  });
  hits.sort((a,b)=> a.secs-b.secs || (b.cap-b.bid)-(a.cap-a.bid));

  if(hits.length){
    const lines = hits.slice(0,6).map(h=>`#${h.i} ${h.color}: bid up to ${h.cap} (now ${h.bid}, closes ${fmt(h.secs)})`);
    await ntfy(`Treasure Wars - ${hits.length} chest(s) closing`, lines.join("\n") + (gold!=null?`\nGold: ${gold}`:""));
    console.log("alerted", hits.length);
  } else console.log("nothing closing soon");

  const flags = [];
  for(const [c,s] of Object.entries(byColor)){
    if(s.withBids>=4 && s.overCap>=3 && s.overCap/s.withBids>=0.4) flags.push(`${c}: ${s.overCap}/${s.withBids} leading bids at/above your cap (field hot)`);
  }
  if(outbid>=2) flags.push(`${outbid} of your confirmed bids are being outbid`);
  const byc = {}; scouted.forEach(x=>{(byc[x.color]||(byc[x.color]=[])).push(x.g);});
  const EXP = { brown:10, blue:30, red:25, green:50, purple:76, royal:150 };
  for(const [c,arr] of Object.entries(byc)){
    if(arr.length>=3){ const avg=arr.reduce((a,b)=>a+b,0)/arr.length; if(EXP[c] && Math.abs(avg-EXP[c])/EXP[c]>0.35) flags.push(`${c} scouts averaging ${avg.toFixed(0)}g vs assumed ${EXP[c]}g (odds may be off)`); }
  }
  if(flags.length){
    await ntfy("Treasure Wars - STRATEGY CHECK", flags.join("\n") + "\nPing Claude to retune.");
    console.log("strategy check:", flags);
  }
})();

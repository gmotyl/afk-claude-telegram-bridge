#!/usr/bin/env node
#!/usr/bin/env node
"use strict";var a={slots:{1:void 0,2:void 0,3:void 0,4:void 0}};var d=(e,t,r)=>e?r.getTime()-e.lastHeartbeat.getTime()<t:!1;var l=(e,t,r)=>{let o={};return Object.entries(e.slots).forEach(([s,n])=>{let i=parseInt(s,10);o[i]=d(n,t,r)?n:void 0}),{slots:o}};var S=async()=>{try{let e=a;console.log("Bridge Daemon started"),console.log("Initial slots:",Object.keys(e.slots).length);let t=5*60*1e3;e=l(e,t,new Date),console.log("Daemon ready"),await new Promise(()=>{})}catch(e){console.error("Daemon error:",e),process.exit(1)}};S();

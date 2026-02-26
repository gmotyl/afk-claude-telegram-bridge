#!/usr/bin/env node
#!/usr/bin/env node
"use strict";var o={slots:{1:void 0,2:void 0,3:void 0,4:void 0}};var n=(e,t)=>`S${e} - ${t}`;var r=async()=>{try{let e=o;console.log("AFK Hook initialized"),console.log("Session slots available:",Object.keys(e.slots).length);let t=n(1,"claude-code");console.log("Primary topic:",t)}catch(e){console.error("Hook error:",e),process.exit(1)}};r();

// Wait for a Discord window on the DevTools port and report what Vencord loaded.
// Usage: node livecheck.mjs <port> [timeoutSeconds]
const port = process.argv[2] || "9223";
const deadline = Date.now() + Number(process.argv[3] || 120) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function page() {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const target = list.find(t => t.type === "page" && /discord\.com/.test(t.url));
      if (target) return target;
    } catch {}
    await sleep(2000);
  }
  throw new Error("no Discord window appeared");
}

const target = await page();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const evaluate = expression => new Promise(resolve => {
  const my = ++id;
  const onMessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id === my) { ws.removeEventListener("message", onMessage); resolve(msg.result?.result?.value); }
  };
  ws.addEventListener("message", onMessage);
  ws.send(JSON.stringify({ id: my, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
});

const probe = `(() => {
  const V = globalThis.Vencord;
  if (!V?.Plugins?.plugins) return null;
  const custom = ["PerfMonitor", "PlatformSpoofer", "PooWangUploader", "PrivacyPruner", "QuestCompleter", "SteamRichPresence"];
  return JSON.stringify({
    url: location.href.split("?")[0],
    vencord: true,
    customPlugins: custom.filter(n => V.Plugins.plugins[n]),
    openAsar: typeof globalThis.openasar !== "undefined" || document.documentElement.innerHTML.includes("OpenAsar"),
  });
})()`;
while (Date.now() < deadline) {
  const value = await evaluate(probe);
  if (value) {
    console.log("LIVE", value);
    process.exit(0);
  }
  await sleep(2000);
}
console.log("Vencord did not load in time");
process.exit(1);

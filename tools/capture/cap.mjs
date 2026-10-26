// 헤드리스 Chrome을 CDP로 움직여 캡처한다. 사용: node cap.mjs plan.json
// plan: [{tab, op:"open", url, w, h, mobile}, {tab, op:"eval", js}, {op:"sleep", ms}, {tab, op:"shot", file}, {tab, op:"click", x, y}]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9333;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--hide-scrollbars", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(p, method = "GET") {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method });
      return await r.json();
    } catch (e) {
      await sleep(200);
    }
  }
  throw new Error("chrome not reachable");
}

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) {
        const { res, rej } = this.pending.get(d.id);
        this.pending.delete(d.id);
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
      } else if (d.method === "Runtime.exceptionThrown") this.logs.push("EXC " + JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
      else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") this.logs.push("ERR " + d.params.args.map((a) => a.value || a.description).join(" "));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

const tabs = {};
const vars = {};
try {
  await json("/json/version");
  for (const step of plan) {
    if (step.op === "sleep") {
      await sleep(step.ms);
      continue;
    }
    if (step.op === "open") {
      const t = await json(`/json/new?about:blank`, "PUT");
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const tab = (tabs[step.tab] = new Tab(ws));
      await tab.send("Runtime.enable");
      await tab.send("Page.enable");
      await tab.send("Emulation.setDeviceMetricsOverride", { width: step.w, height: step.h, deviceScaleFactor: step.mobile ? 2 : 1, mobile: Boolean(step.mobile) });
      if (step.mobile) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      if (step.pre) await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: step.pre });
      await tab.send("Page.navigate", { url: step.url });
      await sleep(500);
      for (let i = 0; i < 100; i++) {
        const r = await tab.send("Runtime.evaluate", { expression: "document.readyState==='complete'&&!!window.FlagApp", returnByValue: true });
        if (r.result.value) break;
        await sleep(200);
      }
      await sleep(step.wait || 500);
      continue;
    }
    const tab = tabs[step.tab];
    if (step.op === "eval") {
      const js = step.js.replace(/\$\{(\w+)\}/g, (_, k) => vars[k]);
      const r = await tab.send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) console.log(`[${step.tab}] eval error:`, r.exceptionDetails.exception?.description);
      else {
        if (step.save) vars[step.save] = r.result.value;
        if (step.print) console.log(`[${step.tab}]`, JSON.stringify(r.result.value));
      }
    } else if (step.op === "click" || step.op === "tapjs") {
      await tab.send("Page.bringToFront");
      let { x, y } = step;
      if (step.op === "tapjs") {
        const r = await tab.send("Runtime.evaluate", { expression: step.js, returnByValue: true });
        if (r.exceptionDetails || !r.result.value) {
          console.log(`[${step.tab}] tapjs error`, r.exceptionDetails?.exception?.description);
          continue;
        }
        [x, y] = r.result.value;
      }
      if (step.touch) {
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    } else if (step.op === "shot") {
      await tab.send("Page.bringToFront");
      await tab.send("Runtime.evaluate", { expression: "document.activeElement && document.activeElement.blur && 0" });
      const r = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: Boolean(step.full) });
      fs.writeFileSync(step.file, Buffer.from(r.data, "base64"));
      console.log("saved", step.file);
    }
  }
  for (const [k, t] of Object.entries(tabs)) if (t.logs.length) console.log(`[${k}] logs:\n  ` + t.logs.join("\n  "));
} finally {
  proc.kill();
}

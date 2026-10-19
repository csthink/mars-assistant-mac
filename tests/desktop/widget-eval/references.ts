/**
 * Hand-written reference widgets, one per standard requirement. They are the positive control
 * of the evaluation: each must compile and satisfy every rule of its requirement, which shows
 * the rules are satisfiable as written. They are not model output.
 */
import type { WidgetPackage } from "../../../src/shared/widget";

const css = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;padding:16px;background:Canvas;color:CanvasText}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;cursor:pointer}
input{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid #8886;background:transparent;color:inherit}
label{display:inline-flex;gap:6px;align-items:center;margin:4px 8px 4px 0}
ul{padding-left:18px}`;

function widget(
  name: string,
  html: string,
  js: string,
  capabilities: WidgetPackage["capabilities"] = [],
  config: WidgetPackage["config"] = [],
  extraCss = "",
): WidgetPackage {
  return {
    schemaVersion: 1,
    name,
    view: { html, css: css + extraCss, js },
    config,
    draftFields: [],
    capabilities,
    resources: [],
  };
}

export const references: Record<string, WidgetPackage> = {
  "timer-pomodoro-zh": widget(
    "番茄钟",
    `<main><p id="time" style="font-size:40px;margin:8px 0">25:00</p><div><button id="start">开始</button><button id="pause">暂停</button><button id="reset">重置</button></div></main>`,
    `const total = 25 * 60;
let left = total;
let timer = null;
const time = document.querySelector("#time");
const pad = (n) => String(n).padStart(2, "0");
const show = () => { time.textContent = pad(Math.floor(left / 60)) + ":" + pad(left % 60); };
const halt = () => { clearInterval(timer); timer = null; };
document.querySelector("#start").addEventListener("click", () => {
  if (timer) return;
  timer = setInterval(() => { left = Math.max(0, left - 1); show(); if (!left) halt(); }, 1000);
});
document.querySelector("#pause").addEventListener("click", halt);
document.querySelector("#reset").addEventListener("click", () => { halt(); left = total; show(); });
show();`,
  ),
  "countdown-days-en": widget(
    "Countdown",
    `<label>Event name <input id="name" type="text"></label><label>Target date <input id="date" type="date"></label><p id="event"></p><p id="out">Pick a date</p>`,
    `const name = document.querySelector("#name");
const date = document.querySelector("#date");
const update = () => {
  document.querySelector("#event").textContent = name.value;
  if (!date.value) return;
  const days = Math.ceil((Date.parse(date.value + "T00:00:00") - Date.now()) / 86400000);
  document.querySelector("#out").textContent = days >= 0 ? days + " days left" : "Date has passed";
};
name.addEventListener("input", update);
date.addEventListener("input", update);
date.addEventListener("change", update);`,
  ),
  "todo-basic-zh": widget(
    "待办清单",
    `<p id="left">未完成：0</p><label>新待办 <input id="text"></label><button id="add">添加</button><ul id="list"></ul>`,
    `let items = [];
let revision = 0;
const list = document.querySelector("#list");
function render() {
  list.replaceChildren(...items.map((item, index) => {
    const li = document.createElement("li");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.done;
    box.setAttribute("aria-label", "完成 " + item.text);
    box.addEventListener("change", () => { item.done = box.checked; save(); });
    const text = document.createElement("span");
    text.textContent = item.text;
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", () => { items.splice(index, 1); save(); });
    li.append(box, text, remove);
    return li;
  }));
  document.querySelector("#left").textContent = "未完成：" + items.filter((i) => !i.done).length;
}
async function save() {
  render();
  const reply = await window.widget.writeData(revision, { items });
  if (reply.ok) revision = reply.revision;
}
document.querySelector("#add").addEventListener("click", () => {
  const input = document.querySelector("#text");
  const text = input.value.trim();
  if (!text) return;
  items.push({ text, done: false });
  input.value = "";
  save();
});
const loaded = await window.widget.readData();
if (loaded.ok) {
  revision = loaded.revision;
  if (Array.isArray(loaded.value?.items)) items = loaded.value.items;
}
render();`,
    ["data.read", "data.write"],
  ),
  "kanban-board-en": widget(
    "Task board",
    `<label>New task <input id="task"></label><button id="add">Add</button><div class="cols"><section><h3></h3><ul></ul></section><section><h3></h3><ul></ul></section><section><h3></h3><ul></ul></section></div>`,
    `const names = ["To do", "Doing", "Done"];
let tasks = [];
let revision = 0;
const sections = [...document.querySelectorAll("section")];
function render() {
  sections.forEach((section, col) => {
    const mine = tasks.filter((t) => t.col === col);
    section.querySelector("h3").textContent = names[col] + " (" + mine.length + ")";
    section.querySelector("ul").replaceChildren(...mine.map((task) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = task.text;
      li.append(text);
      if (col < 2) {
        const move = document.createElement("button");
        move.textContent = "Move";
        move.addEventListener("click", () => { task.col++; save(); });
        li.append(move);
      }
      return li;
    }));
  });
}
async function save() {
  render();
  const reply = await window.widget.writeData(revision, { tasks });
  if (reply.ok) revision = reply.revision;
}
document.querySelector("#add").addEventListener("click", () => {
  const input = document.querySelector("#task");
  if (!input.value.trim()) return;
  tasks.push({ text: input.value.trim(), col: 0 });
  input.value = "";
  save();
});
const loaded = await window.widget.readData();
if (loaded.ok) {
  revision = loaded.revision;
  if (Array.isArray(loaded.value?.tasks)) tasks = loaded.value.tasks;
}
render();`,
    ["data.read", "data.write"],
    [],
    `.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}`,
  ),
  "chart-bar-zh": widget(
    "本周支出",
    `<h2>本周支出</h2><svg id="chart" viewBox="0 0 320 200" width="100%" role="img" aria-label="本周支出柱状图"></svg>`,
    `const ns = "http://www.w3.org/2000/svg";
const days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const values = [120, 80, 150, 60, 200, 90, 130];
const svg = document.querySelector("#chart");
const max = Math.max(...values);
const node = (tag, attrs, text) => {
  const el = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  svg.append(el);
};
values.forEach((value, i) => {
  const height = (value / max) * 140;
  const x = 12 + i * 44;
  node("rect", { x, y: 170 - height, width: 28, height, rx: 4, fill: "#4a7bd0" });
  node("text", { x: x + 14, y: 164 - height, "text-anchor": "middle", "font-size": 11, fill: "currentColor" }, String(value));
  node("text", { x: x + 14, y: 190, "text-anchor": "middle", "font-size": 11, fill: "currentColor" }, days[i]);
});`,
  ),
  "chart-line-en": widget(
    "Weekly steps",
    `<h2>Weekly steps</h2><svg id="chart" viewBox="0 0 320 180" width="100%" role="img" aria-label="Weekly steps chart"></svg><button id="avg">Show average</button><p id="average"></p>`,
    `const ns = "http://www.w3.org/2000/svg";
const steps = [6400, 8200, 7100, 9050, 5600, 10200, 7800];
const svg = document.querySelector("#chart");
const max = 12000;
const y = (v) => 160 - (v / max) * 140;
const line = document.createElementNS(ns, "polyline");
line.setAttribute("points", steps.map((v, i) => (20 + i * 46) + "," + y(v)).join(" "));
line.setAttribute("fill", "none");
line.setAttribute("stroke", "#4a7bd0");
line.setAttribute("stroke-width", "2");
svg.append(line);
document.querySelector("#avg").addEventListener("click", () => {
  const mean = Math.round(steps.reduce((a, b) => a + b, 0) / steps.length);
  if (!svg.querySelector("line")) {
    const avg = document.createElementNS(ns, "line");
    avg.setAttribute("x1", "20");
    avg.setAttribute("x2", "300");
    avg.setAttribute("y1", String(y(mean)));
    avg.setAttribute("y2", String(y(mean)));
    avg.setAttribute("stroke", "#d0844a");
    avg.setAttribute("stroke-dasharray", "4 3");
    svg.append(avg);
  }
  document.querySelector("#average").textContent = "Average: " + mean.toLocaleString("en-US");
});`,
  ),
  "form-contact-zh": widget(
    "联系人登记",
    `<div><label>姓名 <input id="name"></label><label>邮箱 <input id="email" type="email"></label><label>电话 <input id="phone" type="tel"></label><button id="submit" type="button">提交</button></div><p id="error" role="alert"></p><ul id="list"></ul>`,
    `const value = (id) => document.querySelector(id).value.trim();
document.querySelector("#submit").addEventListener("click", () => {
  const error = document.querySelector("#error");
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value("#email"))) {
    error.textContent = "邮箱格式不正确";
    return;
  }
  error.textContent = "";
  const li = document.createElement("li");
  li.textContent = value("#name") + "（" + value("#phone") + "）";
  document.querySelector("#list").append(li);
});`,
  ),
  "form-bmi-en": widget(
    "BMI calculator",
    `<label>Height (cm) <input id="height" type="number"></label><label>Weight (kg) <input id="weight" type="number"></label><button id="calc">Calculate</button><p id="out"></p>`,
    `document.querySelector("#calc").addEventListener("click", () => {
  const h = Number(document.querySelector("#height").value) / 100;
  const w = Number(document.querySelector("#weight").value);
  const out = document.querySelector("#out");
  if (!(h > 0 && w > 0)) { out.textContent = "Enter height and weight"; return; }
  const bmi = w / (h * h);
  const category = bmi < 18.5 ? "Underweight" : bmi < 25 ? "Normal" : bmi < 30 ? "Overweight" : "Obese";
  out.textContent = "BMI " + bmi.toFixed(1) + " (" + category + ")";
});`,
  ),
  "ledger-zh": widget(
    "记账",
    `<label>金额 <input id="amount" type="number" step="0.01"></label><label>用途 <input id="purpose"></label><button id="add">记一笔</button><ul id="list"></ul><p id="total">合计：0.00</p>`,
    `let entries = [];
let revision = 0;
function render() {
  document.querySelector("#list").replaceChildren(...entries.map((e) => {
    const li = document.createElement("li");
    li.textContent = e.purpose + " " + e.amount.toFixed(2);
    return li;
  }));
  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  document.querySelector("#total").textContent = "合计：" + total.toFixed(2);
}
document.querySelector("#add").addEventListener("click", async () => {
  const amount = Number(document.querySelector("#amount").value);
  const purpose = document.querySelector("#purpose").value.trim();
  if (!Number.isFinite(amount) || !purpose) return;
  entries.push({ amount, purpose });
  render();
  const reply = await window.widget.writeData(revision, { entries });
  if (reply.ok) revision = reply.revision;
});
const loaded = await window.widget.readData();
if (loaded.ok) {
  revision = loaded.revision;
  if (Array.isArray(loaded.value?.entries)) entries = loaded.value.entries;
}
render();`,
    ["data.read", "data.write"],
  ),
  "habit-grid-en": widget(
    "Habit tracker",
    `<table><thead><tr><th>Habit</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th><th></th></tr></thead><tbody id="rows"></tbody></table>`,
    `const habits = ["Read", "Exercise", "Sleep early"];
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
let cells = habits.map(() => days.map(() => false));
let revision = 0;
const streak = (row) => { let n = 0; for (let i = row.length - 1; i >= 0 && row[i]; i--) n++; return n; };
function render() {
  document.querySelector("#rows").replaceChildren(...habits.map((habit, h) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = habit;
    tr.append(th);
    days.forEach((day, d) => {
      const td = document.createElement("td");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = cells[h][d];
      box.setAttribute("aria-label", habit + " " + day);
      box.addEventListener("change", async () => {
        cells[h][d] = box.checked;
        render();
        const reply = await window.widget.writeData(revision, { cells });
        if (reply.ok) revision = reply.revision;
      });
      td.append(box);
      tr.append(td);
    });
    const s = document.createElement("td");
    s.textContent = "Streak: " + streak(cells[h]);
    tr.append(s);
    return tr;
  }));
}
const loaded = await window.widget.readData();
if (loaded.ok) {
  revision = loaded.revision;
  if (Array.isArray(loaded.value?.cells)) cells = loaded.value.cells;
}
render();`,
    ["data.read", "data.write"],
  ),
  "world-clock-zh": widget(
    "世界时钟",
    `<ul id="clocks"></ul>`,
    `const zones = [["北京", "Asia/Shanghai"], ["伦敦", "Europe/London"], ["纽约", "America/New_York"]];
const list = document.querySelector("#clocks");
const rows = zones.map(([city, zone]) => {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = city;
  const time = document.createElement("strong");
  time.style.marginLeft = "8px";
  li.append(name, time);
  list.append(li);
  return { time, format: new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }) };
});
const tick = () => { const now = new Date(); for (const r of rows) r.time.textContent = r.format.format(now); };
tick();
setInterval(tick, 1000);`,
  ),
  "dice-roller-en": widget(
    "Dice roller",
    `<button id="roll">Roll</button><p id="dice"></p><p id="total"></p>`,
    `document.querySelector("#roll").addEventListener("click", () => {
  const a = 1 + Math.floor(Math.random() * 6);
  const b = 1 + Math.floor(Math.random() * 6);
  document.querySelector("#dice").textContent = "Die 1: " + a + ", Die 2: " + b;
  document.querySelector("#total").textContent = "Total: " + (a + b);
});`,
  ),
  "counter-config-zh": widget(
    "计数器",
    `<p id="count">计数：0</p><button id="inc">增加</button><button id="dec">减少</button><button id="reset">清零</button>`,
    `let count = 0;
let step = 1;
let revision = 0;
const show = () => { document.querySelector("#count").textContent = "计数：" + count; };
const save = async () => {
  show();
  const reply = await window.widget.writeData(revision, { count });
  if (reply.ok) revision = reply.revision;
};
document.querySelector("#inc").addEventListener("click", () => { count += step; save(); });
document.querySelector("#dec").addEventListener("click", () => { count -= step; save(); });
document.querySelector("#reset").addEventListener("click", () => { count = 0; save(); });
const config = await window.widget.readConfig();
if (config.ok && Number.isFinite(config.value?.step)) step = config.value.step;
const loaded = await window.widget.readData();
if (loaded.ok) {
  revision = loaded.revision;
  if (Number.isFinite(loaded.value?.count)) count = loaded.value.count;
}
show();`,
    ["config.read", "data.read", "data.write"],
    [{ id: "step", label: "步长", type: "number", default: 1 }],
  ),
};

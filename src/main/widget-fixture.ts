/** Explicit acceptance fixture, never presented as model-generated content. */
export const widgetFixture = JSON.stringify({
  schemaVersion: 1,
  name: "本地便笺测试候选",
  view: {
    html: '<main><h1 id="title"></h1><label for="note">随手记</label><textarea id="note" placeholder="写下一件想记住的事"></textarea><p id="saved" role="status">正在读取已保存内容…</p><div class="counter"><button id="increment">记录一次</button><span id="count">已记录 0 次</span></div></main>',
    css: ':root{color-scheme:light dark;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:light-dark(#28352c,#e5ebe4);background:light-dark(#f5f8f3,#202a23)}*{box-sizing:border-box}body{margin:0}main{padding:24px;max-width:720px;margin:auto}h1{font-size:22px;margin:0 0 24px;font-weight:650}label{display:block;margin-bottom:10px;font-weight:600}textarea{font:inherit;width:100%;min-height:120px;resize:vertical;padding:12px;border:1px solid light-dark(#bac9bb,#607364);border-radius:8px;background:light-dark(#fff,#172019);color:inherit}textarea:focus{outline:2px solid #638a6d;outline-offset:2px}button{font:inherit;color:inherit;padding:8px 12px;border:1px solid #819d86;border-radius:7px;background:transparent;cursor:pointer}button:focus-visible{outline:2px solid #638a6d;outline-offset:2px}p{min-height:20px;color:light-dark(#536858,#b5c8b9);font-size:12px}.counter[hidden]{display:none}.counter{display:flex;align-items:center;gap:14px;margin-top:22px}',
    js: `const note = document.querySelector('#note'), saved = document.querySelector('#saved');
let revision = 0, dataRevision = 0, count = 0, pending = false, failed = false, wanted = '', confirmed = '';
async function read() {
  const [draft, data, config] = await Promise.all([widget.readDraft(), widget.readData(), widget.readConfig()]);
  if (!draft.ok || !data.ok || !config.ok) { saved.textContent = '读取失败，请关闭后重新打开。'; return; }
  const field = draft.value.note; revision = field?.revision || 0; confirmed = field?.text || ''; wanted = confirmed; note.value = confirmed;
  dataRevision = data.revision; count = Number(data.value.count || 0); document.querySelector('#count').textContent = '已记录 ' + count + ' 次';
  document.querySelector('#title').textContent = config.value.title;
  note.style.fontSize = Math.max(12, Math.min(24, config.value.font_size)) + 'px';
  document.querySelector('.counter').hidden = !config.value.show_count;
  failed = field?.unconfirmed === true; saved.textContent = failed ? '已恢复未确认输入，请在预览上方核对并重读。' : '已读取上次确认的内容';
}
async function flush() {
  if (pending || failed) return; pending = true;
  while (wanted !== confirmed && !failed) {
    const text = wanted; saved.textContent = '正在保存…';
    const reply = await widget.writeDraft(revision, 'note', text);
    if (!reply.ok) { failed = true; saved.textContent = reply.message + ' 当前输入未确认保存。'; break; }
    revision = reply.revision; confirmed = text;
  }
  pending = false; if (!failed) saved.textContent = '草稿已确认保存';
}
note.addEventListener('input', () => { wanted = note.value; saved.textContent = '输入尚未确认'; void flush(); });
document.querySelector('#increment').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  const reply = await widget.writeData(dataRevision, { count: count + 1 });
  if (reply.ok) { dataRevision = reply.revision; count = reply.value.count; document.querySelector('#count').textContent = '已记录 ' + count + ' 次'; }
  else { saved.textContent = reply.message; }
  button.disabled = false;
});
void read();`,
  },
  config: [
    { id: "font_size", label: "文字大小", type: "number", default: 14 },
    { id: "show_count", label: "显示记录次数", type: "boolean", default: true },
    { id: "title", label: "便笺标题", type: "text", default: "今天想记住的事" },
  ],
  draftFields: ["note"],
  capabilities: ["data.read", "data.write", "draft.write", "config.read"],
  resources: [],
});

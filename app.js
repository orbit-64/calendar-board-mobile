const $ = (id) => document.getElementById(id);
const configKey = 'calendar-board-config-v1';
const sessionKey = 'calendar-board-session-v1';
const cacheKey = 'calendar-board-cache-v1';
const defaultConfig = {
  url: 'https://wnxfmendphwaiujllpag.supabase.co',
  key: 'sb_publishable_lnUN_5q2iYUR8C5MXODnXw_XlpgW-4R',
};
const state = {
  config: JSON.parse(localStorage.getItem(configKey) || 'null') || defaultConfig,
  session: JSON.parse(localStorage.getItem(sessionKey) || 'null'),
  items: [],
  offline: false,
  view: new Date(),
  selected: localDate(new Date()),
  editing: null,
};

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function parseDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function showStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function setPanel(name) {
  $('setupPanel').hidden = name !== 'setup';
  $('authPanel').hidden = name !== 'auth';
  $('calendarApp').hidden = name !== 'app';
}
function saveSession(data) {
  state.session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  localStorage.setItem(sessionKey, JSON.stringify(state.session));
}
async function rawRequest(path, { method = 'GET', body, token } = {}) {
  const headers = { apikey: state.config.key, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${state.config.url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('网络连接失败，请检查网络后重试。');
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.msg || data?.message || data?.error_description || `请求失败（${response.status}）`);
  return data;
}
async function refreshSession() {
  if (!state.session?.refresh_token) throw new Error('登录已过期，请重新登录。');
  const data = await rawRequest('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: state.session.refresh_token },
  });
  saveSession(data);
}
async function api(path, options = {}) {
  if (!state.session) throw new Error('请先登录。');
  if (Date.now() / 1000 > state.session.expires_at - 60) await refreshSession();
  try {
    return await rawRequest(path, { ...options, token: state.session.access_token });
  } catch (error) {
    if (/401|JWT|token/i.test(error.message)) {
      await refreshSession();
      return rawRequest(path, { ...options, token: state.session.access_token });
    }
    throw error;
  }
}
async function fetchItems() {
  const all = [];
  let offset = 0;
  while (true) {
    const rows = await api(`/rest/v1/calendar_items?select=id,payload&order=id.asc&limit=1000&offset=${offset}`);
    all.push(...rows);
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return all.map((row) => ({ ...row.payload, id: row.id })).filter((item) => item.id && item.date);
}
async function maintainRemote(items) {
  const today = localDate(new Date());
  let changed = false;
  for (const item of items) {
    if (item.date >= today) continue;
    if (item.type === '待办' && !item.done) {
      const updated = { ...item, date: today };
      await api(`/rest/v1/calendar_items?id=eq.${encodeURIComponent(item.id)}`, {
        method: 'PATCH', body: { payload: updated },
      });
      changed = true;
    } else if (item.type === '日程') {
      await api(`/rest/v1/calendar_items?id=eq.${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      changed = true;
    }
  }
  return changed;
}
async function loadItems() {
  try {
    let items = await fetchItems();
    if (await maintainRemote(items)) items = await fetchItems();
    state.items = items;
    state.offline = false;
    localStorage.setItem(cacheKey, JSON.stringify(items));
    showStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (error) {
    state.items = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    state.offline = true;
    showStatus(`${error.message} 正显示上次保存的内容；离线时不能编辑。`, true);
  }
  render();
}
function itemPlace(item) { return item.place || item.room || ''; }
function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function renderCalendar() {
  const y = state.view.getFullYear();
  const m = state.view.getMonth();
  $('monthTitle').textContent = `${y}年${m + 1}月`;
  const first = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const count = Math.ceil((first + days) / 7) * 7;
  const grid = $('monthGrid');
  grid.replaceChildren();
  const today = localDate(new Date());
  for (let i = 0; i < count; i++) {
    const date = new Date(y, m, i - first + 1);
    const iso = localDate(date);
    const button = make('button', '', '');
    button.type = 'button';
    button.setAttribute('aria-label', `${iso}，查看当天事项`);
    if (date.getMonth() !== m) button.classList.add('outside');
    if (iso === today) button.classList.add('today');
    if (iso === state.selected) button.classList.add('selected');
    button.append(make('span', 'number', String(date.getDate())));
    const dots = make('span', 'dots');
    const dayItems = state.items.filter((item) => item.date === iso);
    for (const type of ['课程', '待办', '日程']) {
      if (dayItems.some((item) => item.type === type)) {
        dots.append(make('span', `dot ${{ 课程: 'course', 待办: 'todo', 日程: 'schedule' }[type]}`));
      }
    }
    button.append(dots);
    button.addEventListener('click', () => {
      state.selected = iso;
      state.view = new Date(date.getFullYear(), date.getMonth(), 1);
      render();
    });
    grid.append(button);
  }
}
function renderDay() {
  const date = parseDate(state.selected);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  $('dayTitle').textContent = `${date.getMonth() + 1}月${date.getDate()}日 · ${weekdays[date.getDay()]}`;
  const container = $('dayItems');
  container.replaceChildren();
  for (const type of ['课程', '待办', '日程']) {
    const group = make('section', 'group');
    group.append(make('h3', '', type));
    const items = state.items.filter((item) => item.date === state.selected && item.type === type)
      .sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title, 'zh-CN'));
    if (!items.length) group.append(make('p', 'empty', `这天没有${type}`));
    for (const item of items) {
      const row = make('div', 'item');
      const main = make('div', 'item-main');
      main.append(make('div', 'item-title', item.title));
      const meta = [item.time, itemPlace(item) ? `场地：${itemPlace(item)}` : ''].filter(Boolean).join(' · ');
      if (meta) main.append(make('div', 'item-meta', meta));
      row.append(main);
      const actions = make('div', 'item-actions');
      const edit = make('button', '', '编辑');
      edit.type = 'button';
      edit.addEventListener('click', () => openEntry(item));
      const remove = make('button', '', type === '待办' ? '完成' : '删除');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteEntry(item));
      actions.append(edit, remove);
      row.append(actions);
      group.append(row);
    }
    container.append(group);
  }
}
function render() {
  renderCalendar();
  renderDay();
  $('addButton').disabled = state.offline;
}
function openEntry(item = null) {
  if (state.offline) { showStatus('离线时只能查看，联网后再编辑。', true); return; }
  state.editing = item;
  $('entryDialogTitle').textContent = item ? '编辑事项' : '新增事项';
  $('entryType').value = item?.type || '日程';
  $('entryDate').value = item?.date || state.selected;
  $('entryTitle').value = item?.title || '';
  $('entryStart').value = item?.startTime || (item?.time || '').split('-')[0] || '';
  $('entryEnd').value = item?.endTime || (item?.time || '').split('-')[1] || '';
  $('entryPlace').value = itemPlace(item || {});
  $('entryDialog').showModal();
}
async function saveEntry(event) {
  event.preventDefault();
  const start = $('entryStart').value;
  const end = $('entryEnd').value;
  if (end && (!start || end <= start)) { showStatus('结束时间需要晚于开始时间。', true); return; }
  const id = state.editing?.id || crypto.randomUUID().replaceAll('-', '');
  const item = {
    ...(state.editing || {}), id,
    date: $('entryDate').value,
    type: $('entryType').value,
    title: $('entryTitle').value.trim(),
    startTime: start, endTime: end,
    time: end ? `${start}-${end}` : start,
    place: $('entryPlace').value.trim(),
    done: state.editing?.done || false,
  };
  if (!item.title) { showStatus('请填写内容。', true); return; }
  if ('room' in item) item.room = item.place;
  if ('display' in item) item.display = item.title;
  try {
    if (state.editing) {
      await api(`/rest/v1/calendar_items?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: { payload: item },
      });
    } else {
      await api('/rest/v1/calendar_items', { method: 'POST', body: { id, payload: item } });
    }
    $('entryDialog').close();
    state.selected = item.date;
    state.view = parseDate(item.date);
    await loadItems();
  } catch (error) { showStatus(error.message, true); }
}
async function deleteEntry(item) {
  if (state.offline) { showStatus('离线时不能删除。', true); return; }
  if (!confirm(item.type === '待办' ? `完成并删除「${item.title}」？` : `删除「${item.title}」？`)) return;
  try {
    await api(`/rest/v1/calendar_items?id=eq.${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    await loadItems();
  } catch (error) { showStatus(error.message, true); }
}

$('setupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = $('projectUrl').value.trim().replace(/\/+$/, '');
  const key = $('publishableKey').value.trim();
  if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url) || !key.startsWith('sb_publishable_')) {
    showStatus('请填写 Supabase 项目 URL 和 sb_publishable_ 开头的密钥。', true);
    return;
  }
  state.config = { url, key };
  localStorage.setItem(configKey, JSON.stringify(state.config));
  state.session = null;
  localStorage.removeItem(sessionKey);
  setPanel('auth');
  showStatus('连接信息已保存。请登录日历账号。');
});
$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await rawRequest('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: $('email').value.trim(), password: $('password').value },
    });
    saveSession(data);
    $('password').value = '';
    setPanel('app');
    await loadItems();
  } catch (error) { showStatus(error.message, true); }
});
$('signupButton').addEventListener('click', async () => {
  if (!$('authForm').reportValidity() || $('password').value.length < 6) {
    showStatus('请先填写有效邮箱和至少 6 位密码。', true);
    return;
  }
  try {
    await rawRequest('/auth/v1/signup', {
      method: 'POST', body: { email: $('email').value.trim(), password: $('password').value },
    });
    showStatus('注册请求已提交。请查收验证邮件，验证后再登录。');
  } catch (error) { showStatus(error.message, true); }
});
$('settingsButton').addEventListener('click', () => {
  if (!confirm('退出当前登录并重新填写连接信息？')) return;
  state.session = null;
  localStorage.removeItem(sessionKey);
  setPanel('setup');
  showStatus('已退出登录。');
});
$('prevMonth').addEventListener('click', () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1); render(); });
$('nextMonth').addEventListener('click', () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1); render(); });
$('todayButton').addEventListener('click', () => { state.view = new Date(); state.selected = localDate(new Date()); render(); });
$('addButton').addEventListener('click', () => openEntry());
$('cancelEntry').addEventListener('click', () => $('entryDialog').close());
$('entryForm').addEventListener('submit', saveEntry);

if (new URLSearchParams(location.search).has('demo')) {
  const today = localDate(new Date());
  state.items = [
    { id: '11111111111111111111111111111111', date: today, type: '课程', title: '微积分Ⅰ', time: '10:20-11:55', place: '品学楼B308' },
    { id: '22222222222222222222222222222222', date: today, type: '待办', title: '完成数学作业', time: '' },
    { id: '33333333333333333333333333333333', date: today, type: '日程', title: '社团活动', time: '19:00-20:00', place: '学生活动中心' },
  ];
  state.offline = true;
  setPanel('app');
  render();
  showStatus('界面预览 · 演示数据');
} else if (state.config) {
  $('projectUrl').value = state.config.url;
  $('publishableKey').value = state.config.key;
  if (state.session) { setPanel('app'); loadItems(); }
  else setPanel('auth');
} else setPanel('setup');
setInterval(() => { if (state.config && state.session && !document.hidden) loadItems(); }, 5 * 60 * 1000);

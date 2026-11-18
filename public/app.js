(() => {
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "interviewai_history_v1";
 
  // history = every interview (saved in this browser). current = the interview being taken now.
  const state = { history: [], current: null, viewingId: null, mode: "setup", timerId: null };
 
  /* ================= helpers ================= */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (tag, cls, html) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmtDate = (ts) =>
    new Date(ts).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const niceError = (m) =>
    /session not found/i.test(m) ? "This interview session was lost (the server was restarted). Please start a new interview." : m;
 
  function loadHistory() {
    try {
      const r = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.history)); } catch (e) { /* ignore */ }
  }
 
  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }
 
  /* ================= chat rows ================= */
  function aiRow(text, chip) {
    const row = el("div", "row ai");
    row.append(el("div", "avatar", "🤖"));
    row.append(el("div", "bubble ai",
      `<div class="who">Interviewer${chip ? `<span class="chip">${esc(chip)}</span>` : ""}</div>${esc(text)}`));
    return row;
  }
  function userRow(text, name) {
    const row = el("div", "row user");
    row.append(el("div", "bubble user", `<div class="who">You</div>${esc(text)}`));
    row.append(el("div", "avatar user", esc((name || "Y").trim().charAt(0).toUpperCase() || "Y")));
    return row;
  }
  function evalRow(ev) {
    const sc = Number(ev.score) || 0;
    const cls = sc >= 7 ? "good" : sc >= 4 ? "mid" : "bad";
    const li = (a) => (a && a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    const row = el("div", "row ai");
    row.append(el("div", "avatar spacer"));
    row.append(el("div", `eval ${cls}`,
      `<div class="score">Score: ${sc}/10</div>
       <div>${esc(ev.feedback)}</div>
       ${ev.strengths && ev.strengths.length ? `<div style="margin-top:6px"><b>Strengths</b>${li(ev.strengths)}</div>` : ""}
       ${ev.gaps && ev.gaps.length ? `<div style="margin-top:6px"><b>Gaps</b>${li(ev.gaps)}</div>` : ""}
       ${ev.hint ? `<div class="hint">💡 ${esc(ev.hint)}</div>` : ""}`));
    return row;
  }
  function typingRow(text) {
    const row = el("div", "row ai");
    row.append(el("div", "avatar", "🤖"));
    row.append(el("div", "bubble ai", `<span class="typing">${esc(text)}</span>`));
    return row;
  }
  const noteRow = (text, err) => el("div", "note" + (err ? " err" : ""), esc(text));
 
  function reportCard(rec) {
    const r = rec.report;
    const list = (a) => `<ul>${(a || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    const wrap = el("div", "card report");
    wrap.innerHTML = `
      <h2>Interview report</h2>
      <div class="big">${esc(Math.round(Number(r.overall_score) || 0))}<span>/100</span></div>
      <span class="rec">${esc(r.recommendation)}</span>
      <p>${esc(r.summary)}</p>
      <div class="grid2">
        <div><h3>💪 Strengths</h3>${list(r.strengths)}</div>
        <div><h3>🎯 Areas to improve</h3>${list(r.areas_to_improve)}</div>
      </div>
      <h3>Topic breakdown</h3>
      ${(r.topic_scores || []).map((t) =>
        `<div class="bar-row"><span class="label">${esc(t.topic)}</span><div class="bar"><div style="width:${Math.min(100, (Number(t.score) || 0) * 10)}%"></div></div><span>${esc(t.score)}/10</span></div>`).join("")}
      <h3>📚 Study plan</h3>${list(r.study_plan)}
      <p class="muted">Average per-question score: ${esc(rec.averageScore)}/10</p>`;
    const b = el("button", "primary", "＋ Start a new interview");
    b.type = "button";
    b.onclick = () => newInterview();
    wrap.append(b);
    return wrap;
  }
 
  /* ================= drawing the screen ================= */
  function renderChat(rec, live) {
    const chat = $("chat");
    chat.innerHTML = "";
    if (rec.greeting) chat.append(aiRow(rec.greeting));
    rec.items.forEach((it) => {
      chat.append(aiRow(it.question, [it.topic, it.difficulty].filter(Boolean).join(" · ")));
      if (it.answer != null) chat.append(userRow(it.answer, rec.name));
      if (it.evaluation) chat.append(evalRow(it.evaluation));
    });
    if (live && rec.pending) chat.append(typingRow(rec.pending));
    if (live && rec.error) chat.append(noteRow(rec.error, true));
    if (rec.report) chat.append(reportCard(rec));
    else if (!live && !rec.finished) chat.append(noteRow("This interview was not finished."));
    const s = $("scroll");
    s.scrollTop = s.scrollHeight;
  }
 
  function updateTop(rec, live) {
    const answered = rec.items.filter((i) => i.evaluation).length;
    $("titleMain").textContent = `${rec.role} · ${rec.level}`;
    $("titleSub").textContent = `${rec.name} · ${fmtDate(rec.startedAt)}`;
    $("progressBadge").textContent = rec.finished
      ? "Completed"
      : live ? `Question ${Math.min(rec.items.length, rec.total)} of ${rec.total}` : `${answered} of ${rec.total} answered`;
    $("progressBadge").classList.remove("hidden");
    $("progress").classList.remove("hidden");
    $("progressBar").style.width = `${Math.min(100, (answered / rec.total) * 100)}%`;
    $("timer").classList.toggle("hidden", !(live && !rec.finished));
    $("endBtn").classList.toggle("hidden", !(live && !rec.finished && !rec.pending));
  }
 
  function updateComposer(rec, live) {
    const last = rec.items[rec.items.length - 1];
    const show = live && !rec.finished && !rec.pending && last && last.answer == null;
    $("composer").classList.toggle("hidden", !show);
    if (show) $("answer").focus();
  }
 
  function setMode(mode) {
    state.mode = mode;
    $("setup").classList.toggle("hidden", mode !== "setup");
    $("chat").classList.toggle("hidden", mode === "setup");
  }
 
  function renderSidebar() {
    const box = $("historyList");
    box.innerHTML = "";
    if (!state.history.length) {
      box.append(el("div", "empty", "No interviews yet.<br>Your past interviews will appear here."));
      return;
    }
    state.history.forEach((rec) => {
      const answered = rec.items.filter((i) => i.evaluation).length;
      const status = rec.finished
        ? `Avg ${rec.averageScore != null ? rec.averageScore : "-"}/10`
        : rec === state.current ? "In progress" : "Not finished";
      const item = el("div", "h-item" + (rec.id === state.viewingId ? " active" : ""));
      item.innerHTML = `
        <div class="h-main">
          <div class="h-title">${esc(rec.role)}</div>
          <div class="h-sub">${esc(rec.level)} · ${esc(fmtDate(rec.startedAt))}</div>
          <div class="h-sub">${answered}/${rec.total} answered · ${esc(status)}</div>
        </div>
        <button class="h-del" type="button" title="Delete">✕</button>`;
      item.onclick = () => openRecord(rec.id);
      item.querySelector(".h-del").onclick = (e) => { e.stopPropagation(); deleteRecord(rec.id); };
      box.append(item);
    });
  }
 
  /* ================= views ================= */
  function showSetup() {
    setMode("setup");
    state.viewingId = null;
    $("titleMain").textContent = "New interview";
    $("titleSub").textContent = "";
    ["progressBadge", "progress", "timer", "endBtn", "composer"].forEach((id) => $(id).classList.add("hidden"));
    renderSidebar();
  }
 
  function showLive() {
    const rec = state.current;
    if (!rec) return showSetup();
    setMode("live");
    state.viewingId = rec.id;
    refreshLive();
  }
 
  // redraw the live interview (only if it is the one on screen)
  function refreshLive() {
    const rec = state.current;
    if (!rec || state.mode !== "live" || state.viewingId !== rec.id) return renderSidebar();
    renderChat(rec, true);
    updateTop(rec, true);
    updateComposer(rec, true);
    renderSidebar();
  }
 
  function showReview(rec) {
    setMode("review");
    state.viewingId = rec.id;
    renderChat(rec, false);
    updateTop(rec, false);
    $("composer").classList.add("hidden");
    renderSidebar();
  }
 
  function openRecord(id) {
    const rec = state.history.find((r) => r.id === id);
    if (!rec) return;
    closeSidebar();
    if (rec === state.current) showLive();
    else showReview(rec);
  }
 
  function newInterview() {
    if (state.current && !state.current.finished) {
      if (!confirm("An interview is in progress. It will stay in your history, but you won't be able to continue it. Start a new one?")) return;
    }
    state.current = null;
    stopTimer();
    closeSidebar();
    showSetup();
  }
 
  function deleteRecord(id) {
    if (!confirm("Delete this interview from your history?")) return;
    const rec = state.history.find((r) => r.id === id);
    if (rec === state.current) { state.current = null; stopTimer(); }
    state.history = state.history.filter((r) => r.id !== id);
    saveHistory();
    if (state.viewingId === id) showSetup(); else renderSidebar();
  }
 
  /* ================= timer ================= */
  function tick() {
    const rec = state.current;
    if (!rec || rec.finished) return;
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function startTimer() { stopTimer(); state.timerId = setInterval(tick, 1000); tick(); }
  function stopTimer() { if (state.timerId) clearInterval(state.timerId); state.timerId = null; }
 
  /* ================= interview flow ================= */
  $("setupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Preparing your interview...";
    try {
      const data = await api("/api/interview/start", {
        name: $("name").value.trim(),
        role: $("role").value.trim(),
        level: $("level").value,
        numQuestions: $("numQuestions").value,
        focus: $("focus").value.trim(),
      });
      const rec = {
        id: uid(),
        sessionId: data.sessionId,
        name: $("name").value.trim() || "You",
        role: $("role").value.trim(),
        level: $("level").value,
        total: data.total,
        startedAt: Date.now(),
        greeting: data.greeting,
        items: [{ question: data.question, topic: data.topic, difficulty: data.difficulty }],
        finished: false,
        pending: null,
        error: null,
      };
      state.history.unshift(rec);
      state.current = rec;
      saveHistory();
      startTimer();
      showLive();
    } catch (err) {
      alert("Could not start: " + niceError(err.message));
    }
    btn.disabled = false;
    btn.textContent = "Start interview";
  });
 
  async function submitAnswer() {
    const rec = state.current;
    if (!rec || rec.pending || rec.finished) return;
    const text = $("answer").value.trim();
    if (!text) return;
    const item = rec.items[rec.items.length - 1];
    if (item.answer != null) return;
 
    item.answer = text;
    rec.error = null;
    rec.pending = "Evaluating your answer...";
    $("answer").value = "";
    $("answer").style.height = "auto";
    saveHistory();
    refreshLive();
 
    try {
      const data = await api("/api/interview/answer", { sessionId: rec.sessionId, answer: text });
      item.evaluation = data.evaluation;
      if (data.done) {
        rec.pending = "Generating your final report...";
        saveHistory();
        refreshLive();
        await finishInterview(rec);
        return;
      }
      rec.items.push({ question: data.question, topic: data.topic, difficulty: data.difficulty });
      rec.pending = null;
    } catch (err) {
      item.answer = null; // let the user try again
      rec.pending = null;
      rec.error = "Error: " + niceError(err.message) + " - please press Send again.";
      $("answer").value = text;
    }
    saveHistory();
    refreshLive();
  }
 
  async function finishInterview(rec) {
    try {
      const data = await api("/api/interview/report", { sessionId: rec.sessionId });
      rec.report = data.report;
      rec.averageScore = data.averageScore;
      rec.finished = true;
      stopTimer();
    } catch (err) {
      rec.error = "Could not generate the report: " + niceError(err.message) + " - press \"End & get report\" to try again.";
    }
    rec.pending = null;
    saveHistory();
    refreshLive();
  }
 
  async function endEarly() {
    const rec = state.current;
    if (!rec || rec.pending || rec.finished) return;
    const answered = rec.items.filter((i) => i.evaluation).length;
    if (!answered) {
      if (confirm("You haven't answered anything yet. Discard this interview?")) deleteRecordSilently(rec);
      return;
    }
    if (!confirm("End the interview now and see your report?")) return;
    rec.error = null;
    rec.pending = "Generating your final report...";
    refreshLive();
    await finishInterview(rec);
  }
 
  function deleteRecordSilently(rec) {
    state.current = null;
    stopTimer();
    state.history = state.history.filter((r) => r.id !== rec.id);
    saveHistory();
    showSetup();
  }
 
  /* ================= buttons & keyboard ================= */
  $("sendBtn").addEventListener("click", submitAnswer);
  $("answer").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
  });
  $("answer").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  });
  $("endBtn").addEventListener("click", endEarly);
  $("newBtn").addEventListener("click", newInterview);
  $("clearBtn").addEventListener("click", () => {
    if (!state.history.length) return;
    if (!confirm("Delete ALL interviews from your history?")) return;
    state.history = [];
    state.current = null;
    stopTimer();
    saveHistory();
    showSetup();
  });
 
  // phone: open/close the history panel
  function closeSidebar() { $("sidebar").classList.remove("open"); $("backdrop").classList.add("hidden"); }
  $("menuBtn").addEventListener("click", () => { $("sidebar").classList.add("open"); $("backdrop").classList.remove("hidden"); });
  $("backdrop").addEventListener("click", closeSidebar);
 
  /* ================= voice dictation (where the browser supports it) ================= */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("micBtn").classList.add("hidden");
  } else {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    let listening = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const box = $("answer");
          box.value += (box.value ? " " : "") + e.results[i][0].transcript.trim();
        }
      }
    };
    rec.onend = () => { listening = false; $("micBtn").textContent = "🎤"; };
    $("micBtn").addEventListener("click", () => {
      if (listening) { rec.stop(); return; }
      rec.start(); listening = true; $("micBtn").textContent = "⏹";
    });
  }
 
  /* ================= start ================= */
  state.history = loadHistory();
  showSetup();
})();
 
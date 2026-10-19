(() => {
  "use strict";

  const STORAGE_KEY = "lexiloop-progress-v1";
  const STATE_SCHEMA_VERSION = 1;
  const REVIEW_INTERVALS = [0, 1, 2, 4, 7, 15, 30];
  const VIEW_TITLES = {
    dashboard: "把词汇变成真正可调用的语言",
    learn: "先看见词的来路，再记住它的去处",
    recall: "用主动回忆，把短时印象变成长时记忆",
    practice: "在高难语境中调用今天的词汇",
    notebook: "集中攻克真正薄弱的词",
    plan: "每天四课，25 天完成一轮"
  };
  const THEME_FALLBACK = ["科技伦理", "生态农业", "公共健康", "城市治理", "文化心理", "经济韧性", "教育公平", "空间探索"];

  let vocabulary = null;
  let lessonsById = new Map();
  let termIndex = new Map();
  let state = loadState();
  let activeLessonFilter = "all";
  let recallDirection = "en-zh";
  let recallQueue = [];
  let recallIndex = 0;
  let clozeRound = 0;
  let activeBookFilter = "all";
  let toastTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const normalize = (value = "") => String(value).toLowerCase().trim().replace(/[’]/g, "'").replace(/[^a-z0-9'\-\s]/g, "").replace(/\s+/g, " ");

  function blankState() {
    return { schemaVersion: STATE_SCHEMA_VERSION, selectedDay: 1, memory: {}, notebook: {}, scores: {}, completedDays: [] };
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    const isRecord = item => item && typeof item === "object" && !Array.isArray(item);
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      selectedDay: Math.min(25, Math.max(1, Number(source.selectedDay) || 1)),
      memory: isRecord(source.memory) ? source.memory : {},
      notebook: isRecord(source.notebook) ? source.notebook : {},
      scores: isRecord(source.scores) ? source.scores : {},
      completedDays: Array.isArray(source.completedDays)
        ? [...new Set(source.completedDays.map(Number).filter(day => day >= 1 && day <= 25))]
        : []
    };
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return normalizeState(saved);
    } catch {
      return blankState();
    }
  }

  function saveState() {
    state.schemaVersion = STATE_SCHEMA_VERSION;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  async function exportProgress() {
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `lexiloop-progress-${stamp}.json`;
    const payload = JSON.stringify({
      app: "LexiLoop",
      schemaVersion: STATE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      state
    }, null, 2);
    const file = typeof File === "function" ? new File([payload], fileName, { type: "application/json" }) : null;

    if (file && navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ title: "词脉学习进度", text: "词脉 LexiLoop 本机学习进度备份", files: [file] });
        showToast("进度备份已交给系统分享");
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }

    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("进度备份已导出");
  }

  async function importProgress(file) {
    try {
      if (!file || file.size > 5 * 1024 * 1024) throw new Error("请选择小于 5 MB 的 JSON 备份文件");
      const parsed = JSON.parse(await file.text());
      const candidate = parsed?.state ?? parsed;
      if (!candidate || typeof candidate !== "object" || !["memory", "notebook", "scores", "completedDays"].some(key => key in candidate)) {
        throw new Error("这不是有效的词脉进度备份");
      }
      if (!window.confirm("导入会覆盖当前设备上的学习进度，确定继续吗？")) return;
      state = normalizeState(candidate);
      saveState();
      renderAll();
      showToast("学习进度已导入");
    } catch (error) {
      showToast(error?.message || "导入失败，请检查备份文件");
    }
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2100);
  }

  function lessonIdsForDay(day = state.selectedDay) {
    const high = 104 - day * 4;
    return [high, high - 1, high - 2, high - 3].filter(id => id >= 1 && id <= 100);
  }

  function lessonsForDay(day = state.selectedDay) {
    return lessonIdsForDay(day).map(id => lessonsById.get(id)).filter(Boolean);
  }

  function entriesForDay(day = state.selectedDay) {
    const seen = new Set();
    return lessonsForDay(day).flatMap(lesson => lesson.entries.map(entry => ({ ...entry, lessonId: lesson.id }))).filter(entry => {
      const key = normalize(entry.term);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function compactDetail(detail = "") {
    return detail.replace(/\s*\d{3,6}\s*$/, "").trim();
  }

  function lessonTitle(lesson) {
    const match = lesson.fileName.match(/[：:]([^.]*)/);
    if (match) return match[1].replace(/课堂笔记/g, "").trim();
    const root = lesson.roots?.[0] || "词根、派生与考试搭配";
    return root.replace(/^词根/, "词根 ").slice(0, 28);
  }

  function entryInfo(term, preferredLesson) {
    const normalized = normalize(term);
    const candidates = termIndex.get(normalized) || [];
    return candidates.find(item => item.lessonId === preferredLesson) || candidates[0] || null;
  }

  function setView(name) {
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === name));
    $$('[data-view-panel]').forEach(panel => panel.classList.toggle("active", panel.dataset.viewPanel === name));
    $("#viewTitle").textContent = VIEW_TITLES[name];
    $(".sidebar").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "recall") prepareRecall();
    if (name === "notebook") renderNotebook();
    if (name === "practice") renderResults();
  }

  function renderDayHeader() {
    const ids = lessonIdsForDay();
    const range = ids.length ? `词汇课 ${ids[0]}—${ids[ids.length - 1]}` : "";
    $("#todayLabel").textContent = `DAY ${String(state.selectedDay).padStart(2, "0")} · ${range}`;
    $("#dayChip").textContent = `${String(state.selectedDay).padStart(2, "0")} / 25`;
  }

  function renderDashboard() {
    const lessons = lessonsForDay();
    const entries = entriesForDay();
    const learned = entries.filter(entry => state.memory[normalize(entry.term)]?.stage > 0).length;
    const weak = entries.filter(entry => (state.memory[normalize(entry.term)]?.forgot || 0) > 0).length;
    const due = buildRecallQueue().filter(entry => (state.memory[normalize(entry.term)]?.nextDue ?? state.selectedDay) <= state.selectedDay).length;
    const percent = entries.length ? Math.round(learned / entries.length * 100) : 0;
    $("#progressPercent").textContent = `${percent}%`;
    $("#progressRing").style.setProperty("--progress", `${percent * 3.6}deg`);
    $("#learnedCount").textContent = learned;
    $("#dueCount").textContent = due;
    $("#weakCount").textContent = weak;
    $("#todayLessons").innerHTML = lessons.map((lesson, index) => {
      const lessonLearned = lesson.entries.filter(entry => state.memory[normalize(entry.term)]?.stage > 0).length;
      const lessonPercent = lesson.entries.length ? lessonLearned / lesson.entries.length * 100 : 0;
      return `<article class="lesson-card" data-lesson-jump="${lesson.id}">
        <div class="lesson-card-top"><span class="lesson-no">${String(index + 1).padStart(2, "0")}</span><span class="lesson-count">${lesson.entries.length} 词条</span></div>
        <h3>Lesson ${lesson.id}</h3><p>${esc(lessonTitle(lesson))}</p>
        <div class="lesson-progress"><i style="width:${lessonPercent}%"></i></div>
      </article>`;
    }).join("");

    $("#reviewTimeline").innerHTML = ["学习", "第一遍", "第二遍", "+1 天", "+2 天", "+4 天"].map((label, index) => {
      const status = index === 0 && learned ? "done" : index === 1 ? "active" : "";
      const sub = index < 3 ? "今天" : ["明天", "后天", "滚动"][index - 3] || "滚动";
      return `<div class="timeline-item ${status}"><i></i><strong>${label}</strong><small>${sub}</small></div>`;
    }).join("");
  }

  function renderLessonFilter() {
    const ids = lessonIdsForDay();
    $("#lessonFilter").innerHTML = ["all", ...ids].map(id => `<button class="${String(activeLessonFilter) === String(id) ? "active" : ""}" data-lesson-filter="${id}">${id === "all" ? "全部" : `L${id}`}</button>`).join("");
  }

  function renderLearning() {
    renderLessonFilter();
    const lessons = activeLessonFilter === "all" ? lessonsForDay() : [lessonsById.get(Number(activeLessonFilter))].filter(Boolean);
    const roots = lessons.flatMap(lesson => (lesson.roots || []).map(root => ({ root, lessonId: lesson.id }))).slice(0, 12);
    $("#rootBanner").innerHTML = roots.length ? roots.map(item => `<div class="root-item"><small>LESSON ${item.lessonId}</small><p>${esc(item.root)}</p></div>`).join("") : `<div class="root-item"><small>ROOT MAP</small><p>本课将词源、派生、搭配与例句串联为一个可回忆网络。</p></div>`;
    renderWordList();
  }

  function renderWordList() {
    const query = normalize($("#wordSearch")?.value || "");
    const lessons = activeLessonFilter === "all" ? lessonsForDay() : [lessonsById.get(Number(activeLessonFilter))].filter(Boolean);
    const entries = lessons.flatMap(lesson => lesson.entries.map(entry => ({ ...entry, lessonId: lesson.id }))).filter(entry => {
      const haystack = normalize(`${entry.term} ${entry.detail} ${(entry.notes || []).join(" ")}`);
      return !query || haystack.includes(query);
    });
    $("#wordCount").textContent = entries.length;
    $("#wordList").innerHTML = entries.map(entry => {
      const key = normalize(entry.term);
      const favorite = state.notebook[key]?.favorite;
      const detail = compactDetail(entry.detail);
      const notes = (entry.notes || []).slice(0, 7);
      return `<article class="word-card" data-word-card="${esc(key)}" data-lesson="${entry.lessonId}">
        <div class="word-card-head"><div><h3>${markQuery(entry.term, query)}</h3><p class="definition">${markQuery(detail, query)}</p></div>
          <button class="favorite-star ${favorite ? "active" : ""}" data-favorite="${esc(key)}" data-lesson="${entry.lessonId}" aria-label="收藏 ${esc(entry.term)}">${favorite ? "★" : "☆"}</button>
        </div>
        <div class="word-card-extra">${notes.map(note => `<p>${esc(note)}</p>`).join("")}<span class="origin-chip">Lesson ${entry.lessonId}</span></div>
      </article>`;
    }).join("") || `<div class="notebook-empty"><span>⌕</span><h3>没有匹配词条</h3><p>试试英文词形、中文义项或搭配关键词。</p></div>`;
  }

  function markQuery(text, query) {
    const safe = esc(text);
    if (!query || /[^a-z0-9'\- ]/.test(query)) return safe;
    return safe.replace(new RegExp(`(${escapeRegExp(query)})`, "ig"), "<mark>$1</mark>");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function toggleFavorite(term, lessonId, force) {
    const key = normalize(term);
    const current = state.notebook[key] || { term: term, lessonId, favorite: false, wrong: false, wrongCount: 0, addedDay: state.selectedDay };
    current.favorite = typeof force === "boolean" ? force : !current.favorite;
    if (!current.favorite && !current.wrong && !current.wrongCount) delete state.notebook[key];
    else state.notebook[key] = current;
    saveState();
    renderWordList();
    renderNotebook();
    showToast(current.favorite ? `已收藏 ${current.term}` : `已取消收藏 ${current.term}`);
  }

  function addWrong(term, lessonId) {
    const key = normalize(term);
    const info = entryInfo(term, lessonId);
    const current = state.notebook[key] || { term: info?.term || term, lessonId: info?.lessonId || lessonId, favorite: false, wrong: false, wrongCount: 0, addedDay: state.selectedDay };
    current.wrong = true;
    current.wrongCount = (current.wrongCount || 0) + 1;
    state.notebook[key] = current;
  }

  function openWord(term, lessonId) {
    const info = entryInfo(term, Number(lessonId));
    if (!info) return;
    const key = normalize(info.term);
    $("#dialogLesson").textContent = `LESSON ${info.lessonId}`;
    $("#dialogTerm").textContent = info.term;
    const detail = compactDetail(info.detail);
    const noteGroups = (info.notes || []).slice(0, 10);
    $("#dialogDetail").innerHTML = `<div class="dialog-section"><strong>完整释义</strong><p>${esc(detail)}</p></div>${noteGroups.map(note => `<div class="dialog-section"><p>${esc(note)}</p></div>`).join("")}`;
    const favorite = state.notebook[key]?.favorite;
    $("#dialogFavorite").textContent = favorite ? "★ 已收藏 · 点击取消" : "☆ 收藏到生词本";
    $("#dialogFavorite").dataset.term = info.term;
    $("#dialogFavorite").dataset.lesson = info.lessonId;
    $("#dialogSpeak").dataset.term = info.term;
    $("#wordDialog").showModal();
  }

  function speakWord(term) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance !== "function") {
      showToast("当前设备暂不支持系统朗读");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(term);
    utterance.lang = "en-GB";
    utterance.rate = 0.82;
    window.speechSynthesis.speak(utterance);
  }

  function buildRecallQueue() {
    const today = entriesForDay();
    const duePrior = [];
    Object.entries(state.memory).forEach(([term, memory]) => {
      if (memory.complete || memory.nextDue > state.selectedDay) return;
      const info = entryInfo(term);
      if (info && !today.some(entry => normalize(entry.term) === term)) duePrior.push(info);
    });
    const weak = Object.values(state.notebook).filter(item => (item.wrongCount || 0) > 0).map(item => entryInfo(item.term, item.lessonId)).filter(Boolean);
    const combined = [...weak, ...duePrior, ...today];
    const seen = new Set();
    return combined.filter(entry => {
      const key = normalize(entry.term);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (state.memory[normalize(b.term)]?.forgot || 0) - (state.memory[normalize(a.term)]?.forgot || 0));
  }

  function prepareRecall() {
    recallQueue = buildRecallQueue();
    recallIndex = Math.min(recallIndex, Math.max(0, recallQueue.length - 1));
    renderRecallCard();
  }

  function renderRecallCard() {
    const entry = recallQueue[recallIndex];
    if (!entry) {
      $("#flashPrompt").innerHTML = `<div><div class="flash-word">All clear.</div><p>今天没有待复习词汇。</p></div>`;
      $("#revealButton").hidden = true;
      $("#recallActions").hidden = true;
      return;
    }
    const key = normalize(entry.term);
    const memory = state.memory[key] || { stage: 0, forgot: 0 };
    $("#queuePosition").textContent = `${recallIndex + 1} / ${recallQueue.length}`;
    $("#memoryStageLabel").textContent = memory.stage ? `第 ${Math.min(memory.stage + 1, REVIEW_INTERVALS.length)} 节点` : "首次学习";
    $("#memoryDots").innerHTML = REVIEW_INTERVALS.map((_, index) => `<span class="${index <= memory.stage ? "active" : ""}"></span>`).join("");
    $("#flashLesson").textContent = `LESSON ${entry.lessonId}`;
    $("#flashFavorite").textContent = state.notebook[key]?.favorite ? "★" : "☆";
    $("#flashFavorite").dataset.term = entry.term;
    $("#flashFavorite").dataset.lesson = entry.lessonId;
    $("#flashPrompt").innerHTML = recallDirection === "en-zh" ? `<div class="flash-word">${esc(entry.term)}</div>` : `<div class="flash-meaning">${esc(stripPhonetics(compactDetail(entry.detail)))}</div>`;
    $("#revealPanel").hidden = true;
    $("#recallActions").hidden = true;
    $("#revealButton").hidden = false;
    $("#revealButton").textContent = "显示答案";
    $("#revealPanel").innerHTML = `<h4>${esc(entry.term)}</h4><p>${esc(compactDetail(entry.detail))}</p>${(entry.notes || []).slice(0, 4).map(note => `<p>${esc(note)}</p>`).join("")}`;
    renderMemoryStats();
  }

  function stripPhonetics(value) {
    return value.replace(/^\[[^\]]+\]\s*/, "");
  }

  function recordMemory(remembered) {
    const entry = recallQueue[recallIndex];
    if (!entry) return;
    const key = normalize(entry.term);
    const memory = state.memory[key] || { stage: 0, forgot: 0, seen: 0 };
    memory.seen = (memory.seen || 0) + 1;
    memory.lastDay = state.selectedDay;
    if (remembered) {
      memory.stage = Math.min(REVIEW_INTERVALS.length, (memory.stage || 0) + 1);
      memory.complete = memory.stage >= REVIEW_INTERVALS.length;
      memory.nextDue = memory.complete ? 999 : state.selectedDay + REVIEW_INTERVALS[memory.stage];
    } else {
      memory.forgot = (memory.forgot || 0) + 1;
      memory.stage = Math.max(0, (memory.stage || 0) - 1);
      memory.complete = false;
      memory.nextDue = state.selectedDay;
      addWrong(entry.term, entry.lessonId);
    }
    state.memory[key] = memory;
    saveState();
    recallIndex = (recallIndex + 1) % recallQueue.length;
    renderRecallCard();
    renderDashboard();
    showToast(remembered ? `已记录：${entry.term} 进入下一节点` : `${entry.term} 已加入强化队列`);
  }

  function renderMemoryStats() {
    const values = Object.values(state.memory);
    const mastered = values.filter(item => item.complete).length;
    const strengthening = values.filter(item => !item.complete && item.stage > 0).length;
    const forgotten = values.reduce((sum, item) => sum + (item.forgot || 0), 0);
    $("#memoryStats").innerHTML = `<div class="memory-stat"><span>完成完整曲线</span><strong>${mastered}</strong></div><div class="memory-stat"><span>曲线进行中</span><strong>${strengthening}</strong></div><div class="memory-stat"><span>累计遗忘标记</span><strong>${forgotten}</strong></div>`;
  }

  function highlightPassage(text, lesson) {
    const terms = lesson.entries.map(entry => entry.term).sort((a, b) => b.length - a.length);
    const termMap = new Map(terms.map(term => [normalize(term), term]));
    const alternatives = terms.map(term => escapeRegExp(term)).join("|");
    if (!alternatives) return esc(text);
    const pattern = new RegExp(`\\b(${alternatives})(s|ed|ing)?\\b`, "ig");
    return esc(text).replace(pattern, (match, base) => {
      const term = termMap.get(normalize(base)) || base;
      return `<span class="vocab" data-term="${esc(term)}" data-lesson="${lesson.id}">${match}</span>`;
    });
  }

  function fallbackExercise(lesson, index) {
    const theme = THEME_FALLBACK[(state.selectedDay * 4 + index) % THEME_FALLBACK.length];
    const groups = [];
    const entries = lesson.entries;
    for (let i = 0; i < entries.length; i += 12) groups.push(entries.slice(i, i + 12));
    return {
      theme,
      level: "CET-6+ · Full-coverage lexical reading",
      title: `${theme}: A Lexical Inquiry into Lesson ${lesson.id}`,
      paragraphs: groups.map((group, groupIndex) => `The ${groupIndex === 0 ? "initial" : "subsequent"} inquiry asks how ${group.map(entry => entry.term).join(", ")} can operate within one analytical frame. Rather than treating these items as an isolated list, the report compares their meanings, morphological relations and rhetorical force. Readers should infer each term from context, then return to the lesson notes to examine its precise collocations and register.`),
      questions: [
        { q: "What learning method does the passage recommend?", options: ["Memorising spelling without context.", "Connecting meaning, morphology and rhetorical use.", "Ignoring differences in register.", "Studying only the most frequent item."], answer: 1, weak: lesson.entries.slice(0, 3).map(entry => entry.term) },
        { q: "Why are the lesson notes mentioned?", options: ["They replace all contextual inference.", "They provide exact collocations and usage constraints.", "They contain no morphological information.", "They are intended only for teachers."], answer: 1, weak: lesson.entries.slice(3, 6).map(entry => entry.term) }
      ]
    };
  }

  function renderReading() {
    const lessons = lessonsForDay();
    const exercises = lessons.map((lesson, index) => window.LEXI_EXERCISES[lesson.id] || fallbackExercise(lesson, index));
    $("#coverageCount").textContent = entriesForDay().length;
    $("#readingPanel").innerHTML = exercises.map((exercise, index) => {
      const lesson = lessons[index];
      const phrases = (lesson.entries || []).flatMap(entry => (entry.notes || []).filter(note => /^(搭配|例句|释义)/.test(note))).slice(0, 80);
      return `<article class="reading-card" data-reading="${index}">
        <div class="reading-meta"><span>PASSAGE ${String.fromCharCode(65 + index)} · ${esc(exercise.theme)}</span><span>${esc(exercise.level)}</span></div>
        <h3>${esc(exercise.title)}</h3>
        <div class="reading-body">${exercise.paragraphs.map(paragraph => `<p>${highlightPassage(paragraph, lesson)}</p>`).join("")}</div>
        <details class="phrase-capsule"><summary>本篇同时复现原文档搭配与例句 · ${phrases.length} 条</summary><div class="phrase-list">${phrases.map(phrase => `<span>${esc(phrase)}</span>`).join("")}</div></details>
        <div class="questions">${exercise.questions.map((question, questionIndex) => `<div class="question-block" data-question="${questionIndex}"><p>${questionIndex + 1}. ${esc(question.q)}</p><div class="option-grid">${question.options.map((option, optionIndex) => `<button class="option-button" data-option="${optionIndex}">${String.fromCharCode(65 + optionIndex)}. ${esc(option)}</button>`).join("")}</div></div>`).join("")}</div>
        <div class="submit-row"><span class="score-note" data-reading-score>未提交</span><button class="primary-button" data-submit-reading="${index}">提交本篇</button></div>
      </article>`;
    }).join("");
  }

  function renderCloze() {
    const entries = entriesForDay();
    const pageSize = 16;
    const maxRound = Math.max(1, Math.ceil(entries.length / pageSize));
    clozeRound = Math.min(clozeRound, maxRound - 1);
    const selected = entries.slice(clozeRound * pageSize, clozeRound * pageSize + pageSize);
    const bank = shuffle([...selected]);
    $("#clozePanel").innerHTML = `<article class="cloze-card">
      <div class="cloze-intro"><div><p class="eyebrow">FULL COVERAGE · ROUND ${clozeRound + 1}/${maxRound}</p><h3>定义辨析型选词填空</h3></div><div class="round-controls"><button data-cloze-nav="-1" aria-label="上一组">←</button><button data-cloze-nav="1" aria-label="下一组">→</button></div></div>
      <p class="score-note">全量 ${entries.length} 词条分 ${maxRound} 组滚动测试；答错词自动进入生词本并提高后续复现权重。</p>
      <div class="word-bank">${bank.map(entry => `<button class="bank-word" data-bank-word="${esc(entry.term)}">${esc(entry.term)}</button>`).join("")}</div>
      <div class="cloze-grid">${selected.map((entry, index) => `<label class="cloze-item"><span>${index + 1}</span><p>${clozePrompt(entry)} <input class="cloze-input" data-cloze-answer="${esc(entry.term)}" data-lesson="${entry.lessonId}" aria-label="第 ${index + 1} 空" /></p></label>`).join("")}</div>
      <div class="submit-row"><span class="score-note" id="clozeScore">未提交</span><button class="primary-button" id="submitCloze">提交本组</button></div>
    </article>`;
  }

  function clozePrompt(entry) {
    const definition = stripPhonetics(compactDetail(entry.detail)).replace(/^([a-zA-Z.&-]+\s*)+/, "");
    const patterns = [
      `The committee needed the exact term <input-placeholder> to convey “${esc(definition)}” without weakening the argument.`,
      `In this context, only <input-placeholder> captures the writer’s intended sense of “${esc(definition)}”.`,
      `A careful editor would choose <input-placeholder>, meaning “${esc(definition)}”, rather than a looser synonym.`
    ];
    return patterns[(entry.term.length + entry.lessonId) % patterns.length].replace("<input-placeholder>", "");
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = (i * 7 + state.selectedDay * 3 + clozeRound) % (i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function renderTranslations() {
    const prompts = state.selectedDay === 1 ? window.LEXI_EXERCISES.translations : lessonsForDay().map((lesson, index) => {
      const keywords = lesson.entries.slice(0, 14).map(entry => entry.term);
      return {
        lesson: lesson.id,
        title: `${THEME_FALLBACK[(state.selectedDay + index) % THEME_FALLBACK.length]}综合翻译`,
        source: `本题要求你综合运用第 ${lesson.id} 课的词根、核心词义与固定搭配，讨论一个复杂社会议题。翻译时不要逐词替换，而要先建立清晰的逻辑关系，再准确调用下列目标词汇。`,
        keywords,
        reference: `This task asks you to integrate the roots, core meanings and collocations from Lesson ${lesson.id} in a discussion of a complex social issue. Rather than translating word for word, establish a coherent line of reasoning and then deploy the target vocabulary accurately.`
      };
    });
    $("#translationPanel").innerHTML = prompts.map((prompt, index) => `<article class="translation-card" data-translation="${index}">
      <div class="reading-meta"><span>TRANSLATION ${String.fromCharCode(65 + index)} · LESSON ${prompt.lesson}</span><span>建议 12 分钟</span></div>
      <h3>${esc(prompt.title)}</h3>
      <div class="translation-grid"><div><p class="eyebrow">中文原文</p><div class="translation-source">${esc(prompt.source)}</div><div class="phrase-list">${prompt.keywords.map(word => `<span>${esc(word)}</span>`).join("")}</div></div><div><p class="eyebrow">YOUR TRANSLATION</p><textarea data-translation-input placeholder="在这里完成英文翻译……"></textarea></div></div>
      <div class="translation-feedback" data-translation-feedback hidden></div>
      <div class="submit-row"><span class="score-note">按目标词、内容完整度与表达连贯度估分</span><button class="primary-button" data-score-translation="${index}">评分并查看参考</button></div>
    </article>`).join("");
  }

  function renderResults() {
    const scores = state.scores[state.selectedDay] || {};
    const reading = scores.reading?.percent || 0;
    const cloze = scores.cloze?.percent || 0;
    const translation = scores.translation?.percent || 0;
    const active = [reading, cloze, translation].filter(score => score > 0);
    const overall = active.length ? Math.round(active.reduce((a, b) => a + b, 0) / active.length) : 0;
    $("#resultsPanel").innerHTML = `<article class="result-card"><div class="result-hero"><div class="score-disc">${overall}</div><div><p class="eyebrow">DAILY REPORT</p><h3>${overall ? "今天的语言调用画像" : "完成任一训练后生成报告"}</h3><div class="result-breakdown">${[["阅读", reading], ["选词", cloze], ["翻译", translation]].map(([label, score]) => `<div class="breakdown-row"><span>${label}</span><div class="breakdown-bar"><i style="width:${score}%"></i></div><strong>${score}</strong></div>`).join("")}</div></div></div><div class="result-advice"><h4>${overall >= 85 ? "表现稳定，可以进入下一轮间隔复习。" : overall ? "优先复习生词本，再重做低分模块。" : "系统会把答错词和遗漏目标词自动放进生词本。"}</h4><p>阅读评分基于选择题；选词填空按词形精确匹配；翻译采用目标词覆盖估分，并给出参考译文。翻译分数用于反馈训练，不等同于人工阅卷。</p></div></article>`;
  }

  function renderNotebook() {
    const items = Object.values(state.notebook).filter(item => {
      if (activeBookFilter === "wrong") return item.wrong;
      if (activeBookFilter === "favorite") return item.favorite;
      if (activeBookFilter === "hard") return (item.wrongCount || 0) >= 2;
      return true;
    }).sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0));
    $("#notebookCount").textContent = Object.keys(state.notebook).length;
    $("#notebookEmpty").hidden = items.length > 0;
    $("#notebookGrid").innerHTML = items.map(item => {
      const info = entryInfo(item.term, item.lessonId);
      const memory = state.memory[normalize(item.term)] || { stage: 0 };
      return `<article class="notebook-card"><h3>${esc(info?.term || item.term)}</h3><div class="book-tags">${item.wrong ? `<span class="book-tag">答错 × ${item.wrongCount || 1}</span>` : ""}${item.favorite ? `<span class="book-tag favorite">主动收藏</span>` : ""}</div><p>${esc(compactDetail(info?.detail || "等待补充释义"))}</p><p>${esc((info?.notes || []).find(note => /^(搭配|例句)/.test(note)) || "回到学习模块查看完整词根、搭配与例句。")}</p><footer><span>Lesson ${info?.lessonId || item.lessonId} · 记忆节点 ${memory.stage || 0}/7</span><button data-remove-book="${esc(normalize(item.term))}">移除</button></footer></article>`;
    }).join("");
  }

  function renderPlan() {
    $("#planGrid").innerHTML = Array.from({ length: 25 }, (_, index) => {
      const day = index + 1;
      const ids = lessonIdsForDay(day);
      const entries = ids.reduce((sum, id) => sum + (lessonsById.get(id)?.entries.length || 0), 0);
      const status = state.completedDays.includes(day) ? "done" : day === state.selectedDay ? "active" : "";
      return `<article class="plan-card ${status}" data-day="${day}"><small>DAY ${String(day).padStart(2, "0")}</small><strong>${ids[0]}—${ids[ids.length - 1]}</strong><span>${entries} 词条 · ${THEME_FALLBACK[index % THEME_FALLBACK.length]}</span></article>`;
    }).join("");
    $("#dayPickerGrid").innerHTML = Array.from({ length: 25 }, (_, index) => `<button class="${state.selectedDay === index + 1 ? "active" : ""}" data-day="${index + 1}">Day ${String(index + 1).padStart(2, "0")}</button>`).join("");
  }

  function selectDay(day) {
    state.selectedDay = Math.min(25, Math.max(1, Number(day) || 1));
    activeLessonFilter = "all";
    clozeRound = 0;
    recallIndex = 0;
    saveState();
    renderAll();
    if ($("#dayDialog").open) $("#dayDialog").close();
    showToast(`已切换到 Day ${String(state.selectedDay).padStart(2, "0")}`);
  }

  function scoreReading(card, exerciseIndex) {
    const lesson = lessonsForDay()[exerciseIndex];
    const exercise = window.LEXI_EXERCISES[lesson.id] || fallbackExercise(lesson, exerciseIndex);
    let correct = 0;
    exercise.questions.forEach((question, questionIndex) => {
      const block = card.querySelector(`[data-question="${questionIndex}"]`);
      const selected = block.querySelector(".option-button.selected");
      block.querySelectorAll(".option-button").forEach(button => {
        const option = Number(button.dataset.option);
        button.classList.toggle("correct", option === question.answer);
        button.classList.toggle("wrong", button === selected && option !== question.answer);
      });
      if (selected && Number(selected.dataset.option) === question.answer) correct++;
      else (question.weak || []).forEach(term => addWrong(term, lesson.id));
    });
    const percent = Math.round(correct / exercise.questions.length * 100);
    card.querySelector("[data-reading-score]").textContent = `${correct}/${exercise.questions.length} · ${percent} 分`;
    const dayScores = state.scores[state.selectedDay] ||= {};
    const previous = dayScores.reading?.items || [];
    previous[exerciseIndex] = percent;
    dayScores.reading = { items: previous, percent: Math.round(previous.filter(Number.isFinite).reduce((a, b) => a + b, 0) / previous.filter(Number.isFinite).length) };
    saveState();
    renderNotebook();
    renderResults();
  }

  function scoreCloze() {
    const inputs = $$(".cloze-input", $("#clozePanel"));
    let correct = 0;
    inputs.forEach(input => {
      const isCorrect = normalize(input.value) === normalize(input.dataset.clozeAnswer);
      input.classList.toggle("correct", isCorrect);
      input.classList.toggle("wrong", !isCorrect);
      if (isCorrect) correct++;
      else {
        addWrong(input.dataset.clozeAnswer, Number(input.dataset.lesson));
        if (!input.value.trim()) input.placeholder = input.dataset.clozeAnswer;
      }
    });
    const percent = inputs.length ? Math.round(correct / inputs.length * 100) : 0;
    $("#clozeScore").textContent = `${correct}/${inputs.length} · ${percent} 分`;
    const dayScores = state.scores[state.selectedDay] ||= {};
    const rounds = dayScores.cloze?.rounds || {};
    rounds[clozeRound] = percent;
    const values = Object.values(rounds);
    dayScores.cloze = { rounds, percent: Math.round(values.reduce((a, b) => a + b, 0) / values.length) };
    saveState();
    renderNotebook();
    renderResults();
    showToast(percent >= 80 ? "本组选词完成得很稳" : "错词已加入强化队列");
  }

  function scoreTranslation(card, promptIndex) {
    const prompts = state.selectedDay === 1 ? window.LEXI_EXERCISES.translations : lessonsForDay().map((lesson, index) => ({
      lesson: lesson.id,
      keywords: lesson.entries.slice(0, 14).map(entry => entry.term),
      reference: `This task asks you to integrate the roots, core meanings and collocations from Lesson ${lesson.id} in a discussion of a complex social issue. Rather than translating word for word, establish a coherent line of reasoning and then deploy the target vocabulary accurately.`
    }));
    const prompt = prompts[promptIndex];
    const value = card.querySelector("textarea").value.toLowerCase();
    const hits = prompt.keywords.filter(keyword => value.includes(keyword.toLowerCase().replace(/\s+/g, " ")));
    const missing = prompt.keywords.filter(keyword => !hits.includes(keyword));
    const keywordScore = Math.round(hits.length / prompt.keywords.length * 80);
    const fluencyBonus = value.split(/\s+/).filter(Boolean).length >= 45 ? 20 : value.split(/\s+/).filter(Boolean).length >= 25 ? 12 : 5;
    const percent = Math.min(100, keywordScore + fluencyBonus);
    missing.forEach(term => addWrong(term, prompt.lesson));
    const feedback = card.querySelector("[data-translation-feedback]");
    feedback.hidden = false;
    feedback.innerHTML = `<strong>估分 ${percent}/100</strong><br>目标词命中 ${hits.length}/${prompt.keywords.length}${missing.length ? `；建议重点复习：${missing.map(esc).join("、")}` : "；目标词全部命中。"}<br><br><strong>参考译文</strong><br>${esc(prompt.reference)}`;
    const dayScores = state.scores[state.selectedDay] ||= {};
    const items = dayScores.translation?.items || [];
    items[promptIndex] = percent;
    dayScores.translation = { items, percent: Math.round(items.filter(Number.isFinite).reduce((a, b) => a + b, 0) / items.filter(Number.isFinite).length) };
    saveState();
    renderNotebook();
    renderResults();
  }

  function renderAll() {
    renderDayHeader();
    renderDashboard();
    renderLearning();
    renderReading();
    renderCloze();
    renderTranslations();
    renderResults();
    renderNotebook();
    renderPlan();
    prepareRecall();
  }

  function bindEvents() {
    let suppressNextVocabClick = false;
    let suppressResetTimer = null;
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-view]");
      if (nav) return setView(nav.dataset.view);
      const go = event.target.closest("[data-go]");
      if (go) return setView(go.dataset.go);
      const lessonJump = event.target.closest("[data-lesson-jump]");
      if (lessonJump) {
        activeLessonFilter = Number(lessonJump.dataset.lessonJump);
        renderLearning();
        return setView("learn");
      }
      const lessonFilter = event.target.closest("[data-lesson-filter]");
      if (lessonFilter) {
        activeLessonFilter = lessonFilter.dataset.lessonFilter;
        return renderLearning();
      }
      const favorite = event.target.closest("[data-favorite]");
      if (favorite) {
        event.stopPropagation();
        return toggleFavorite(favorite.dataset.favorite, Number(favorite.dataset.lesson));
      }
      const card = event.target.closest("[data-word-card]");
      if (card) return card.classList.toggle("open");
      const direction = event.target.closest("[data-direction]");
      if (direction) {
        recallDirection = direction.dataset.direction;
        $$("[data-direction]").forEach(button => button.classList.toggle("active", button === direction));
        return renderRecallCard();
      }
      const practiceTab = event.target.closest("[data-practice]");
      if (practiceTab) {
        $$("[data-practice]").forEach(button => button.classList.toggle("active", button === practiceTab));
        $$('[data-practice-panel]').forEach(panel => panel.classList.toggle("active", panel.dataset.practicePanel === practiceTab.dataset.practice));
        return;
      }
      const option = event.target.closest(".option-button");
      if (option) {
        $$(".option-button", option.closest(".option-grid")).forEach(button => button.classList.remove("selected"));
        option.classList.add("selected");
        return;
      }
      const submitReading = event.target.closest("[data-submit-reading]");
      if (submitReading) return scoreReading(submitReading.closest(".reading-card"), Number(submitReading.dataset.submitReading));
      const clozeNav = event.target.closest("[data-cloze-nav]");
      if (clozeNav) {
        const max = Math.ceil(entriesForDay().length / 16);
        clozeRound = (clozeRound + Number(clozeNav.dataset.clozeNav) + max) % max;
        return renderCloze();
      }
      const bankWord = event.target.closest("[data-bank-word]");
      if (bankWord) {
        const empty = $$(".cloze-input", $("#clozePanel")).find(input => !input.value.trim());
        if (empty) { empty.value = bankWord.dataset.bankWord; bankWord.classList.add("used"); empty.focus(); }
        return;
      }
      if (event.target.id === "submitCloze") return scoreCloze();
      const translation = event.target.closest("[data-score-translation]");
      if (translation) return scoreTranslation(translation.closest(".translation-card"), Number(translation.dataset.scoreTranslation));
      const bookFilter = event.target.closest("[data-book-filter]");
      if (bookFilter) {
        activeBookFilter = bookFilter.dataset.bookFilter;
        $$("[data-book-filter]").forEach(button => button.classList.toggle("active", button === bookFilter));
        return renderNotebook();
      }
      const removeBook = event.target.closest("[data-remove-book]");
      if (removeBook) {
        delete state.notebook[removeBook.dataset.removeBook];
        saveState();
        return renderNotebook();
      }
      const dayCard = event.target.closest("[data-day]");
      if (dayCard) return selectDay(dayCard.dataset.day);
      const vocab = event.target.closest(".vocab");
      if (vocab) {
        if (suppressNextVocabClick) {
          suppressNextVocabClick = false;
          return;
        }
        return openWord(vocab.dataset.term, vocab.dataset.lesson);
      }
    });

    $("#wordSearch").addEventListener("input", renderWordList);
    $("#revealButton").addEventListener("click", () => {
      $("#revealPanel").hidden = false;
      $("#recallActions").hidden = false;
      $("#revealButton").hidden = true;
    });
    $("#forgotButton").addEventListener("click", () => recordMemory(false));
    $("#rememberButton").addEventListener("click", () => recordMemory(true));
    $("#flashFavorite").addEventListener("click", event => toggleFavorite(event.currentTarget.dataset.term, Number(event.currentTarget.dataset.lesson)));
    $("#dialogSpeak").addEventListener("click", event => speakWord(event.currentTarget.dataset.term));
    $("#dialogFavorite").addEventListener("click", event => {
      toggleFavorite(event.currentTarget.dataset.term, Number(event.currentTarget.dataset.lesson));
      $("#wordDialog").close();
    });
    $("#dialogClose").addEventListener("click", () => $("#wordDialog").close());
    $("#dayDialogClose").addEventListener("click", () => $("#dayDialog").close());
    $("#dayPickerButton").addEventListener("click", () => $("#dayDialog").showModal());
    $("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
    $("#exportProgress").addEventListener("click", exportProgress);
    $("#importProgressButton").addEventListener("click", () => $("#importProgressFile").click());
    $("#importProgressFile").addEventListener("change", async event => {
      await importProgress(event.currentTarget.files?.[0]);
      event.currentTarget.value = "";
    });
    $("#resetProgress").addEventListener("click", () => {
      if (!window.confirm("确定清空当前浏览器中的学习、记忆和生词本进度吗？")) return;
      localStorage.removeItem(STORAGE_KEY);
      state = loadState();
      renderAll();
      showToast("本机学习进度已重置");
    });

    document.addEventListener("keydown", event => {
      if (event.target.matches("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = $(`.nav-item:nth-child(${Number(event.key)})`);
      if (target && Number(event.key) >= 1 && Number(event.key) <= 6) setView(target.dataset.view);
    });

    let holdTimer = null;
    let holdTarget = null;
    let holdStart = null;
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      holdTarget = null;
      holdStart = null;
    };
    document.addEventListener("pointerdown", event => {
      const vocab = event.target.closest(".vocab");
      if (!vocab) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      holdTarget = vocab;
      holdStart = { x: event.clientX, y: event.clientY };
      holdTimer = setTimeout(() => {
        suppressNextVocabClick = true;
        clearTimeout(suppressResetTimer);
        suppressResetTimer = setTimeout(() => { suppressNextVocabClick = false; }, 1200);
        toggleFavorite(vocab.dataset.term, Number(vocab.dataset.lesson), true);
        cancelHold();
      }, 550);
    });
    document.addEventListener("pointermove", event => {
      if (!holdTimer || !holdTarget || !holdStart) return;
      if (Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y) > 12) cancelHold();
    });
    ["pointerup", "pointercancel"].forEach(type => document.addEventListener(type, cancelHold));
    document.addEventListener("contextmenu", event => {
      const vocab = event.target.closest(".vocab");
      if (!vocab) return;
      event.preventDefault();
      if (suppressNextVocabClick) return;
      openWord(vocab.dataset.term, vocab.dataset.lesson);
    });
  }

  async function init() {
    try {
      vocabulary = await fetch("./vocabulary.json").then(response => {
        if (!response.ok) throw new Error(`Vocabulary request failed: ${response.status}`);
        return response.json();
      });
      lessonsById = new Map(vocabulary.lessons.map(lesson => [Number(lesson.id), lesson]));
      vocabulary.lessons.forEach(lesson => lesson.entries.forEach(entry => {
        const key = normalize(entry.term);
        const list = termIndex.get(key) || [];
        list.push({ ...entry, lessonId: Number(lesson.id) });
        termIndex.set(key, list);
      }));
      bindEvents();
      renderAll();
    } catch (error) {
      console.error(error);
      document.body.innerHTML = `<main style="max-width:720px;margin:80px auto;padding:30px;font-family:system-ui"><h1>词汇数据加载失败</h1><p>请通过本地服务器或已发布的网站打开本应用。</p><pre>${esc(error.message)}</pre></main>`;
    }
  }

  init();
})();

// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）に置き換えてください
const GAS_API_URL = "https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec";

const els = {
  form: document.getElementById("postForm"),
  name: document.getElementById("name"),
  message: document.getElementById("message"),
  submitBtn: document.getElementById("submitBtn"),
  submitSpinner: document.getElementById("submitSpinner"),
  submitLabel: document.getElementById("submitLabel"),
  list: document.getElementById("list"),
  loading: document.getElementById("loading"),
  emptyState: document.getElementById("emptyState"),
  reloadBtn: document.getElementById("reloadBtn"),
  errorBanner: document.getElementById("errorBanner"),
  errorMessage: document.getElementById("errorMessage"),
  errorClose: document.getElementById("errorClose"),
};

function showError(message) {
  els.errorMessage.textContent = message;
  els.errorBanner.classList.add("is-visible");
}

function hideError() {
  els.errorBanner.classList.remove("is-visible");
}

function setSubmitting(isSubmitting) {
  els.submitBtn.disabled = isSubmitting;
  els.submitSpinner.style.display = isSubmitting ? "inline-block" : "none";
  els.submitLabel.textContent = isSubmitting ? "送信中..." : "送信する";
}

function setLoadingList(isLoading) {
  els.loading.style.display = isLoading ? "flex" : "none";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderList(items) {
  els.list.innerHTML = "";
  els.emptyState.style.display = items.length === 0 ? "block" : "none";

  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "list__item";
    li.innerHTML = `
      <div class="list__item-name">${escapeHtml(item.name)}</div>
      <p class="list__item-message">${escapeHtml(item.message)}</p>
      <div class="list__item-time">${escapeHtml(item.createdAt || "")}</div>
    `;
    els.list.appendChild(li);
  });
}

// GAS API へのGETリクエスト（一覧取得）
async function fetchList() {
  hideError();
  setLoadingList(true);
  try {
    const url = new URL(GAS_API_URL);
    url.searchParams.set("action", "list");

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`サーバーエラー（HTTP ${res.status}）`);
    }

    const json = await res.json();
    if (json.status !== "success") {
      throw new Error(json.message || "データの取得に失敗しました");
    }

    renderList(json.data || []);
  } catch (err) {
    showError(`一覧の取得に失敗しました: ${err.message}`);
  } finally {
    setLoadingList(false);
  }
}

// GAS API へのPOSTリクエスト（新規投稿）
// Content-Type は "text/plain" にすることでプリフライト(OPTIONS)を回避しています。
// GAS 側では e.postData.contents を JSON.parse して読み取ります。
async function submitPost(name, message) {
  hideError();
  setSubmitting(true);
  try {
    const res = await fetch(GAS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "add", name, message }),
    });

    if (!res.ok) {
      throw new Error(`サーバーエラー（HTTP ${res.status}）`);
    }

    const json = await res.json();
    if (json.status !== "success") {
      throw new Error(json.message || "投稿に失敗しました");
    }

    els.form.reset();
    await fetchList();
  } catch (err) {
    showError(`投稿に失敗しました: ${err.message}`);
  } finally {
    setSubmitting(false);
  }
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.name.value.trim();
  const message = els.message.value.trim();
  if (!name || !message) {
    showError("お名前とメッセージを入力してください。");
    return;
  }
  submitPost(name, message);
});

els.reloadBtn.addEventListener("click", fetchList);
els.errorClose.addEventListener("click", hideError);

fetchList();

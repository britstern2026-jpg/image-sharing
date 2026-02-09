// ✅ Updated backend URL (Render)
const BACKEND_URL = "https://image-sharing-api-1mk9.onrender.com";

const pwInput = document.getElementById("pw");
const enterBtn = document.getElementById("enterBtn");
const statusEl = document.getElementById("status");

const btnText = enterBtn.querySelector(".btnText");
const spinner = enterBtn.querySelector(".spinner");

const OWNER_PASSWORD = "1234";

function setStatus(msg, type = "") {
  statusEl.textContent = msg || "";
  statusEl.classList.remove("ok", "err");
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "err") statusEl.classList.add("err");
}

function setLoading(isLoading) {
  enterBtn.disabled = isLoading;
  spinner.style.display = isLoading ? "inline-block" : "none";
  btnText.textContent = isLoading ? "בודק..." : "כניסה";
}

async function tryLogin() {
  const pw = (pwInput.value || "").trim();
  if (!pw) {
    setStatus("❌ יש להזין סיסמה", "err");
    return;
  }

  if (pw !== OWNER_PASSWORD) {
    setStatus("❌ סיסמה לא נכונה", "err");
    return;
  }

  try {
    // 🔒 You intentionally skip server verification here (event tradeoff)

    // ✅ Save for gallery usage
    localStorage.setItem("gallery_admin_pw", pw);
    localStorage.setItem("gallery_admin_mode", "1");

    setStatus("✅ הצלחה! מעביר לגלריה...", "ok");

    // Redirect to gallery in owner mode
    setTimeout(() => {
      window.location.href = "gallery.html?owner=1";
    }, 600);

  } catch (err) {
    setStatus(`❌ ${err.message}`, "err");
  } finally {
    setLoading(false);
  }
}

// Click button
enterBtn.addEventListener("click", tryLogin);

// Enter key submit
pwInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryLogin();
});

const BACKEND_URL = "https://image-sharing-api-1mk9.onrender.com";

const nameInput = document.getElementById("nameInput");
const photoInput = document.getElementById("photoInput");
const fileNameEl = document.getElementById("fileName");
const preview = document.getElementById("preview");
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("status");
const publicCheckbox = document.getElementById("publicCheckbox");

const btnText = uploadBtn.querySelector(".btnText");
const spinner = uploadBtn.querySelector(".spinner");

let selectedFile = null;
let uploading = false;

// ✅ simple gate: require landing password first
if (localStorage.getItem("landing_ok") !== "1") {
  window.location.href = "landing.html";
}

// ✅ Android only: hint camera availability without breaking iPhone gallery selection
(() => {
  const ua = navigator.userAgent || "";
  const isAndroid = /Android/i.test(ua);
  if (isAndroid) {
    // adds "Take photo" option on many Android devices
    photoInput.setAttribute("capture", "environment");
  } else {
    // ensure iPhone can still choose from photo library
    photoInput.removeAttribute("capture");
  }
})();

function setStatus(msg, type = "") {
  statusEl.textContent = msg || "";
  statusEl.classList.remove("ok", "err");
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "err") statusEl.classList.add("err");
}

function setUploading(isUploading) {
  uploading = isUploading;
  uploadBtn.disabled = isUploading || !selectedFile;
  spinner.style.display = isUploading ? "inline-block" : "none";
  btnText.textContent = isUploading ? "מעלה..." : "העלאה";
}

function updateUIFromFile() {
  if (!selectedFile) {
    fileNameEl.textContent = "לא נבחרה תמונה";
    preview.style.display = "none";
    uploadBtn.disabled = true;
    return;
  }

  fileNameEl.textContent = selectedFile.name || "נבחרה תמונה";
  preview.src = URL.createObjectURL(selectedFile);
  preview.style.display = "block";
  uploadBtn.disabled = false;
  setStatus("");
}

/**
 * iPhone Chrome reliability trick:
 * Sometimes the file appears slightly after the change event.
 */
function readFileFromInput() {
  selectedFile = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
  updateUIFromFile();
}

function isHeicLike(file) {
  const name = (file?.name || "").toLowerCase();
  const type = (file?.type || "").toLowerCase();
  return (
    type.includes("image/heic") ||
    type.includes("image/heif") ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  );
}

async function compressImageToJpegBlob(file) {
  // HEIC/HEIF usually can't be decoded in browsers; fail fast with a helpful message.
  if (isHeicLike(file)) {
    throw new Error(
      "נבחר קובץ HEIC/HEIF (נפוץ באייפון/מק). הדפדפן לא מצליח לעבד אותו. " +
      "בבקשה המירו ל-JPG (למשל Share/Export כ-JPEG) או צלמו מחדש בתוך הדפדפן."
    );
  }

  // Use createImageBitmap if possible (more reliable in some browsers)
  let bitmap = null;
  if ("createImageBitmap" in window) {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }
  }

  if (!bitmap) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    bitmap = img;
  }

  const maxSize = 1600; // px
  let width = bitmap.width;
  let height = bitmap.height;

  if (width > height && width > maxSize) {
    height = Math.round(height * (maxSize / width));
    width = maxSize;
  } else if (height > maxSize) {
    width = Math.round(width * (maxSize / height));
    height = maxSize;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);

  // free bitmap if it's an ImageBitmap
  if (bitmap && bitmap.close) {
    try { bitmap.close(); } catch {}
  }

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/jpeg",
      0.75
    );
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ✅ Upload with real progress (better UX on slow networks)
 * ✅ Robust error parsing for non-JSON responses (common on cold start / gateway)
 * ✅ Retry once on 502/503/504
 */
function uploadWithProgress(formData) {
  const doOnce = () =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BACKEND_URL}/upload`, true);
      xhr.setRequestHeader("Accept", "application/json");

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.max(1, Math.min(99, Math.round((e.loaded / e.total) * 100)));
        setStatus(`אנא המתן...`);
        btnText.textContent = `מעלה... ${pct}%`;
      };

      xhr.onload = () => {
        const status = xhr.status;
        const raw = xhr.responseText || "";
        const contentType = (xhr.getResponseHeader("content-type") || "").toLowerCase();

        const looksJson =
          contentType.includes("application/json") || raw.trim().startsWith("{");

        if (!looksJson) {
          const snippet = raw.trim().replace(/\s+/g, " ").slice(0, 200);
          const msg = snippet
            ? `שגיאת שרת (${status}). ${snippet}`
            : `שגיאת שרת (${status}). תגובה לא-JSON`;
          const err = new Error(msg);
          err.status = status;
          return reject(err);
        }

        let data = null;
        try {
          data = JSON.parse(raw || "{}");
        } catch (_) {
          const err = new Error(`שגיאת שרת (${status}). JSON לא תקין`);
          err.status = status;
          return reject(err);
        }

        if (status >= 200 && status < 300 && data && data.ok) {
          return resolve(data);
        }

        const msg = (data && data.error) ? data.error : "העלאה נכשלה";
        const err = new Error(msg);
        err.status = status;
        return reject(err);
      };

      xhr.onerror = () => {
        const err = new Error("שגיאת רשת. נסו שוב.");
        err.status = 0;
        reject(err);
      };
      xhr.ontimeout = () => {
        const err = new Error("תם הזמן להעלאה. נסו שוב.");
        err.status = 0;
        reject(err);
      };

      xhr.timeout = 240000; // 4 minutes
      xhr.send(formData);
    });

  return (async () => {
    try {
      return await doOnce();
    } catch (e) {
      if (e && (e.status === 502 || e.status === 503 || e.status === 504)) {
        setStatus("השרת מתעורר... מנסה שוב");
        await sleep(2000);
        return await doOnce();
      }
      throw e;
    }
  })();
}

photoInput.addEventListener("change", () => {
  readFileFromInput();
  setTimeout(readFileFromInput, 80);
  setTimeout(readFileFromInput, 200);
});

photoInput.addEventListener("input", () => {
  readFileFromInput();
  setTimeout(readFileFromInput, 80);
  setTimeout(readFileFromInput, 200);
});

uploadBtn.addEventListener("click", async () => {
  if (uploading) return;

  if (!selectedFile) {
    setStatus("❌ לא נבחרה תמונה. נסו לבחור שוב.", "err");
    return;
  }

  const rawName = (nameInput.value || "").trim();
  const safeName = rawName.length ? rawName : "ללא שם";

  const formData = new FormData();

  try {
    setStatus("מכין תמונה...");

    // Try compress. If compression fails for non-HEIC reasons, fallback to original file.
    try {
      const blob = await compressImageToJpegBlob(selectedFile);
      if (!blob) throw new Error("compress returned empty blob");
      formData.append("photo", blob, "photo.jpg");
    } catch (e) {
      if (isHeicLike(selectedFile)) throw e;
      console.warn("Compression failed, uploading original file:", e);
      formData.append("photo", selectedFile, selectedFile.name || "photo");
    }

    formData.append("name", safeName);
    formData.append("visibility", publicCheckbox.checked ? "public" : "private");

    setUploading(true);
    setStatus("מעלה...");

    await uploadWithProgress(formData);

    setStatus("✅ הועלה בהצלחה", "ok");

    selectedFile = null;
    photoInput.value = "";
    nameInput.value = "";
    publicCheckbox.checked = true;
    updateUIFromFile();

    btnText.textContent = "העלאה";
    setTimeout(() => setStatus(""), 3500);
  } catch (err) {
    setStatus(`❌ שגיאה: ${err.message}`, "err");
    btnText.textContent = "העלאה";
  } finally {
    setUploading(false);
  }
});

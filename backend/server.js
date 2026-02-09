import express from "express";
import multer from "multer";
import cors from "cors";
import sharp from "sharp";
import fs from "fs";

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

const app = express();

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (FRONTEND_ORIGINS.length === 0) return cb(null, true);
      return FRONTEND_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    allowedHeaders: ["Content-Type", "x-gallery-password"],
    methods: ["GET", "POST", "OPTIONS"]
  })
);

// ✅ Ensure uploads/ exists (important on Render)
const UPLOAD_DIR = "uploads";
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (e) {
  console.error("Failed to create uploads directory:", e);
}

const upload = multer({ dest: UPLOAD_DIR });

// ==========================
// ✅ Cloudflare R2 Config (S3-compatible)
// ==========================
const R2_BUCKET = process.env.R2_BUCKET || "image-sharing-bucket";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";

const SIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.SIGNED_URL_EXPIRES_SECONDS || 7 * 24 * 60 * 60
);

const R2_ENDPOINT = R2_ACCOUNT_ID
  ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : "";

const hasR2Config =
  Boolean(R2_BUCKET) &&
  Boolean(R2_ACCOUNT_ID) &&
  Boolean(R2_ACCESS_KEY_ID) &&
  Boolean(R2_SECRET_ACCESS_KEY);

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials:
    R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
      ? { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
      : undefined
});

function safeTrim(v, fallback) {
  const s = (v || "").toString().trim();
  return s ? s : fallback;
}

/**
 * ✅ IMPORTANT FIX:
 * R2/S3 metadata becomes HTTP headers (x-amz-meta-*) and MUST be ASCII.
 * So we must ensure keys/metadata values we store are ASCII-safe.
 */
function sanitizeForKey(name) {
  const s = safeTrim(name, "anon").toLowerCase();

  // Keep only ASCII a-z 0-9 _ -
  // Convert spaces to underscore, drop everything else.
  const ascii = s
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);

  return ascii || "anon";
}

async function signGet(key) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_EXPIRES_SECONDS });
}

async function headMetadata(key) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return head?.Metadata || {};
}

function assertR2Configured(res) {
  if (!hasR2Config) {
    res.status(500).json({
      error:
        "R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET env vars."
    });
    return false;
  }
  return true;
}

// ==========================
// ✅ Health check
// ==========================
app.get("/", (req, res) => {
  res.send("✅ Backend is running. Use POST /upload to upload photos.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ==========================
// ✅ Upload endpoint (ORIGINAL + THUMB)
// ==========================
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    if (!assertR2Configured(res)) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // NOTE: name can be Hebrew — that's fine for UX — but we DO NOT put it in R2 metadata headers.
    const rawName = safeTrim(req.body.name, "anon");
    const nameForKey = sanitizeForKey(rawName);

    const visibility = safeTrim(req.body.visibility, "private"); // keep your default
    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // ✅ Keys are ASCII-safe now
    const originalName = `${nameForKey}_${timestamp}.${ext}`;
    const thumbName = `thumbs/${nameForKey}_${timestamp}.jpg`;

    const thumbPath = `${req.file.path}_thumb.jpg`;

    await sharp(req.file.path)
      .rotate()
      .withMetadata({ orientation: 1 })
      .resize({ width: 600 })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);

    // ✅ Upload original to R2
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: originalName,
        Body: fs.createReadStream(req.file.path),
        ContentType: req.file.mimetype,
        Metadata: {
          visibility,      // ASCII
          thumb: thumbName // ASCII (fixed)
        }
      })
    );

    // ✅ Upload thumbnail to R2
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: thumbName,
        Body: fs.createReadStream(thumbPath),
        ContentType: "image/jpeg",
        Metadata: {
          visibility, // ASCII
          isthumb: "true"
        }
      })
    );

    fs.unlink(req.file.path, () => {});
    fs.unlink(thumbPath, () => {});

    res.json({
      ok: true,
      bucket: R2_BUCKET,
      objectName: originalName,
      thumbObject: thumbName,
      visibility
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ==========================
// ✅ Photos endpoint (returns thumb + full)
// ==========================
app.get("/photos", async (req, res) => {
  try {
    if (!assertR2Configured(res)) return;

    const requestPassword = safeTrim(req.header("x-gallery-password"), "");
    const isAdmin = requestPassword === ADMIN_PASSWORD;

    const allKeys = [];
    let ContinuationToken = undefined;

    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          ContinuationToken
        })
      );

      (out.Contents || []).forEach((o) => {
        if (o?.Key) allKeys.push({ key: o.Key, lastModified: o.LastModified });
      });

      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    allKeys.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta;
    });

    const originals = allKeys.filter((o) => !o.key.startsWith("thumbs/"));

    const visibleOriginals = [];
    for (const o of originals) {
      const meta = await headMetadata(o.key);
      const vis = safeTrim(meta.visibility, "private");
      if (isAdmin || vis === "public") visibleOriginals.push({ ...o, meta });
    }

    const photos = await Promise.all(
      visibleOriginals.map(async ({ key, lastModified, meta }) => {
        const thumbPath = meta.thumb;

        const signedUrl = await signGet(key);

        let signedThumbUrl = signedUrl;
        if (thumbPath) {
          signedThumbUrl = await signGet(thumbPath);
        }

        let contentType = null;
        let size = null;
        let updated = lastModified || null;
        try {
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })
          );
          contentType = head.ContentType || null;
          size = head.ContentLength != null ? String(head.ContentLength) : null;
          updated = head.LastModified || updated;
        } catch {
          // ignore
        }

        return {
          name: key,
          signedUrl,
          signedThumbUrl,
          visibility: safeTrim(meta.visibility, "private"),
          updated,
          size,
          contentType
        };
      })
    );

    res.json({ ok: true, admin: isAdmin, photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch photos" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

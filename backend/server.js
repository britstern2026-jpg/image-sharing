import express from "express";
import multer from "multer";
import cors from "cors";
import sharp from "sharp";
import fs from "fs";
import crypto from "crypto";

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand
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

// ✅ Ensure uploads/ exists (Render filesystem is ephemeral, but writable)
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

async function signGet(key) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_EXPIRES_SECONDS });
}

function makeId() {
  // ASCII-safe id: time + random
  return `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

async function streamToString(body) {
  // AWS SDK v3 GetObject Body is a stream
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
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
// ✅ Upload endpoint (ORIGINAL + THUMB + META JSON)
// ==========================
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    if (!assertR2Configured(res)) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const uploaderNameHebrew = safeTrim(req.body.name, "ללא שם"); // ✅ keep Hebrew
    const visibility = safeTrim(req.body.visibility, "private") === "public" ? "public" : "private";

    const id = makeId();
    const originalKey = `photos/${id}.jpg`;
    const thumbKey = `thumbs/${id}.jpg`;
    const metaKey = `meta/${id}.json`;

    const thumbPath = `${req.file.path}_thumb.jpg`;

    // ✅ IMPORTANT FIX: bake rotation into thumbnail
    await sharp(req.file.path)
      .rotate()
      .withMetadata({ orientation: 1 })
      .resize({ width: 600 })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);

    // Upload original
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: originalKey,
        Body: fs.createReadStream(req.file.path),
        ContentType: req.file.mimetype || "image/jpeg",
        // ✅ Metadata must be ASCII; keep it minimal
        Metadata: {
          visibility,
          meta: metaKey
        }
      })
    );

    // Upload thumb
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: thumbKey,
        Body: fs.createReadStream(thumbPath),
        ContentType: "image/jpeg",
        Metadata: {
          visibility,
          isthumb: "true",
          meta: metaKey
        }
      })
    );

    // Upload JSON meta (Hebrew-safe because it's file content, not headers)
    const metaObj = {
      id,
      uploader: uploaderNameHebrew,
      visibility,
      originalKey,
      thumbKey,
      createdAt: new Date().toISOString()
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: metaKey,
        Body: JSON.stringify(metaObj),
        ContentType: "application/json; charset=utf-8"
      })
    );

    // cleanup temp files
    fs.unlink(req.file.path, () => {});
    fs.unlink(thumbPath, () => {});

    res.json({
      ok: true,
      id,
      bucket: R2_BUCKET,
      objectName: originalKey,
      thumbObject: thumbKey,
      visibility
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ==========================
// ✅ Photos endpoint (reads META JSON so Hebrew names work)
// ==========================
app.get("/photos", async (req, res) => {
  try {
    if (!assertR2Configured(res)) return;

    const requestPassword = safeTrim(req.header("x-gallery-password"), "");
    const isAdmin = requestPassword === ADMIN_PASSWORD;

    // 1) list meta files (source of truth)
    const metaKeys = [];
    let ContinuationToken = undefined;

    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: "meta/",
          ContinuationToken
        })
      );

      (out.Contents || []).forEach((o) => {
        if (o?.Key) metaKeys.push({ key: o.Key, lastModified: o.LastModified });
      });

      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    // newest first
    metaKeys.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta;
    });

    const photos = [];
    for (const mk of metaKeys) {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: mk.key }));
        const jsonStr = await streamToString(obj.Body);
        const meta = JSON.parse(jsonStr);

        const vis = safeTrim(meta.visibility, "private");
        if (!isAdmin && vis !== "public") continue;

        const signedUrl = await signGet(meta.originalKey);
        const signedThumbUrl = await signGet(meta.thumbKey);

        // optional: head for size/contentType/updated
        let size = null;
        let contentType = null;
        let updated = mk.lastModified || null;
        try {
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: R2_BUCKET, Key: meta.originalKey })
          );
          size = head.ContentLength != null ? String(head.ContentLength) : null;
          contentType = head.ContentType || null;
          updated = head.LastModified || updated;
        } catch {
          // ignore
        }

        photos.push({
          id: meta.id,
          name: meta.originalKey, // keep for compatibility
          uploader: meta.uploader, // ✅ Hebrew name
          signedUrl,
          signedThumbUrl,
          visibility: vis,
          updated,
          size,
          contentType
        });
      } catch (e) {
        console.warn("Failed parsing meta:", mk.key, e?.message || e);
      }
    }

    res.json({ ok: true, admin: isAdmin, photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch photos" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

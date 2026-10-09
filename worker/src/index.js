const MAX_TEXT_LENGTH = 10000;
const UPLOAD_TOKEN_TTL_SECONDS = 60 * 60;
const MAX_TOTAL_MEDIA_BYTES = 40 * 1024 * 1024;

const MEDIA_TYPES = {
  "image/jpeg": { category: "image", extension: "jpg", maxBytes: 5 * 1024 * 1024 },
  "image/png": { category: "image", extension: "png", maxBytes: 5 * 1024 * 1024 },
  "image/webp": { category: "image", extension: "webp", maxBytes: 5 * 1024 * 1024 },
  "image/gif": { category: "image", extension: "gif", maxBytes: 5 * 1024 * 1024 },
  "audio/mpeg": { category: "audio", extension: "mp3", maxBytes: 15 * 1024 * 1024 },
  "audio/mp4": { category: "audio", extension: "m4a", maxBytes: 15 * 1024 * 1024 },
  "audio/aac": { category: "audio", extension: "aac", maxBytes: 15 * 1024 * 1024 },
  "audio/wav": { category: "audio", extension: "wav", maxBytes: 15 * 1024 * 1024 },
  "audio/webm": { category: "audio", extension: "webm", maxBytes: 15 * 1024 * 1024 },
  "video/mp4": { category: "video", extension: "mp4", maxBytes: 30 * 1024 * 1024 },
  "video/webm": { category: "video", extension: "webm", maxBytes: 30 * 1024 * 1024 }
};

const CATEGORY_LIMITS = {
  image: 6,
  audio: 1,
  video: 1
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method === "POST" && url.pathname === "/letter") {
      return createLetter(request, env);
    }

    const mediaUploadMatch = url.pathname.match(
      /^\/letter\/([a-f0-9]{32})\/media$/
    );

    if (request.method === "POST" && mediaUploadMatch) {
      return uploadMedia(request, env, mediaUploadMatch[1]);
    }

    const mediaReadMatch = url.pathname.match(
      /^\/letter\/([a-f0-9]{32})\/media\/(image|audio|video)\/([a-f0-9-]+\.[a-z0-9]+)$/
    );

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      mediaReadMatch
    ) {
      return readMedia(request, env, {
        letterId: mediaReadMatch[1],
        category: mediaReadMatch[2],
        objectName: mediaReadMatch[3]
      });
    }

    const letterMatch = url.pathname.match(/^\/letter\/([a-f0-9]{32})$/);

    if (request.method === "GET" && letterMatch) {
      return readLetter(env, letterMatch[1]);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ status: "ok" }, 200);
    }

    return jsonResponse({ error: "接口不存在" }, 404);
  }
};

async function createLetter(request, env) {
  try {
    const data = await request.json();

    if (!data.text || typeof data.text !== "string") {
      return jsonResponse({ error: "内容不能为空" }, 400);
    }

    if (data.text.length > MAX_TEXT_LENGTH) {
      return jsonResponse({ error: "内容过长" }, 400);
    }

    const id = crypto.randomUUID().replace(/-/g, "");
    const letter = {
      text: data.text,
      createdAt: Date.now()
    };

    if (data.wantsMedia !== true) {
      await env.LETTERS.put(id, JSON.stringify(letter));
      return jsonResponse({ success: true, id }, 200);
    }

    if (!env.MEDIA) {
      return jsonResponse({ error: "媒体存储尚未配置" }, 503);
    }

    const uploadToken = createUploadToken();
    const uploadExpiresAt = Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000;

    await Promise.all([
      env.LETTERS.put(id, JSON.stringify(letter)),
      env.MEDIA.put(uploadAuthorizationKey(id), "", {
        customMetadata: {
          uploadToken,
          uploadExpiresAt: String(uploadExpiresAt)
        }
      })
    ]);

    return jsonResponse(
      {
        success: true,
        id,
        uploadToken,
        uploadExpiresIn: UPLOAD_TOKEN_TTL_SECONDS
      },
      200
    );
  } catch {
    return jsonResponse({ error: "请求格式错误" }, 400);
  }
}

async function uploadMedia(request, env, letterId) {
  if (!env.MEDIA) {
    return jsonResponse({ error: "媒体存储尚未配置" }, 503);
  }

  const suppliedToken = request.headers.get("X-Upload-Token") || "";
  const [letter, uploadAuthorization] = await Promise.all([
    env.LETTERS.get(letterId),
    env.MEDIA.head(uploadAuthorizationKey(letterId))
  ]);

  if (!letter) {
    return jsonResponse({ error: "信件不存在" }, 404);
  }

  const expectedToken =
    uploadAuthorization?.customMetadata?.uploadToken || "";
  const uploadExpiresAt = Number(
    uploadAuthorization?.customMetadata?.uploadExpiresAt || 0
  );

  if (
    !expectedToken ||
    uploadExpiresAt <= Date.now() ||
    !safeTokenEquals(suppliedToken, expectedToken)
  ) {
    return jsonResponse({ error: "上传授权无效或已过期" }, 403);
  }

  const contentType = normalizeContentType(
    request.headers.get("Content-Type")
  );
  const mediaType = MEDIA_TYPES[contentType];

  if (!mediaType) {
    return jsonResponse({ error: "不支持的文件类型" }, 415);
  }

  const declaredLength = Number(request.headers.get("Content-Length"));

  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return jsonResponse({ error: "无法确定文件大小" }, 411);
  }

  if (declaredLength > mediaType.maxBytes) {
    return jsonResponse(
      { error: `${mediaType.category}文件过大` },
      413
    );
  }

  const existing = await env.MEDIA.list({
    prefix: mediaPrefix(letterId),
    include: ["httpMetadata", "customMetadata"]
  });

  const categoryCount = existing.objects.filter(
    (object) => object.customMetadata?.category === mediaType.category
  ).length;

  if (categoryCount >= CATEGORY_LIMITS[mediaType.category]) {
    return jsonResponse({ error: "该类型附件数量已达上限" }, 409);
  }

  const existingBytes = existing.objects.reduce(
    (total, object) => total + object.size,
    0
  );

  if (existingBytes + declaredLength > MAX_TOTAL_MEDIA_BYTES) {
    return jsonResponse({ error: "单封信附件总大小超过40 MB" }, 413);
  }

  const body = await request.arrayBuffer();

  if (body.byteLength !== declaredLength) {
    return jsonResponse({ error: "文件传输不完整" }, 400);
  }

  if (!matchesMagicBytes(body, contentType)) {
    return jsonResponse({ error: "文件内容与声明类型不一致" }, 415);
  }

  const objectName = `${crypto.randomUUID()}.${mediaType.extension}`;
  const key = `${mediaPrefix(letterId)}${mediaType.category}/${objectName}`;
  const originalName = sanitizeOriginalName(
    decodeFileName(
      request.headers.get("X-File-Name") || "attachment"
    )
  );

  await env.MEDIA.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: "private, max-age=3600"
    },
    customMetadata: {
      letterId,
      category: mediaType.category,
      originalName,
      uploadedAt: String(Date.now())
    }
  });

  return jsonResponse(
    {
      success: true,
      attachment: attachmentFromObject(
        {
          key,
          size: body.byteLength,
          httpMetadata: { contentType },
          customMetadata: {
            category: mediaType.category,
            originalName
          }
        },
        letterId
      )
    },
    201
  );
}

async function readLetter(env, letterId) {
  const storedLetter = await env.LETTERS.get(letterId);

  if (!storedLetter) {
    return jsonResponse({ error: "信件不存在" }, 404);
  }

  let letter;

  try {
    letter = JSON.parse(storedLetter);
  } catch {
    return jsonResponse({ error: "信件数据损坏" }, 500);
  }

  if (!env.MEDIA) {
    return jsonResponse(letter, 200);
  }

  const media = await env.MEDIA.list({
    prefix: mediaPrefix(letterId),
    include: ["httpMetadata", "customMetadata"]
  });

  const attachments = media.objects
    .map((object) => attachmentFromObject(object, letterId))
    .sort((left, right) => left.uploadedAt - right.uploadedAt);

  if (attachments.length === 0) {
    return jsonResponse(letter, 200);
  }

  return jsonResponse(
    {
      ...letter,
      attachments
    },
    200
  );
}

async function readMedia(request, env, mediaPath) {
  if (!env.MEDIA) {
    return jsonResponse({ error: "媒体存储尚未配置" }, 503);
  }

  const key = `${mediaPrefix(mediaPath.letterId)}${mediaPath.category}/${mediaPath.objectName}`;

  if (request.method === "HEAD") {
    const object = await env.MEDIA.head(key);

    if (!object) {
      return jsonResponse({ error: "附件不存在" }, 404);
    }

    const headers = mediaResponseHeaders(object);
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const object = await env.MEDIA.get(key, {
    onlyIf: request.headers,
    range: request.headers
  });

  if (!object) {
    return jsonResponse({ error: "附件不存在" }, 404);
  }

  const headers = mediaResponseHeaders(object);

  if (!("body" in object)) {
    return new Response(null, { status: 412, headers });
  }

  let status = 200;

  if (object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
    headers.set("Content-Length", String(object.range.length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { status, headers });
}

function attachmentFromObject(object, letterId) {
  const keyParts = object.key.split("/");
  const category = object.customMetadata?.category || keyParts.at(-2);
  const objectName = keyParts.at(-1);

  return {
    type: category,
    name: object.customMetadata?.originalName || objectName,
    mime: object.httpMetadata?.contentType || "application/octet-stream",
    size: object.size,
    uploadedAt: Number(object.customMetadata?.uploadedAt || 0),
    url: `/letter/${letterId}/media/${category}/${objectName}`
  };
}

function mediaResponseHeaders(object) {
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; media-src 'self'; img-src 'self'");
  return headers;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Upload-Token,X-File-Name,Range",
    "Access-Control-Expose-Headers": "Accept-Ranges,Content-Length,Content-Range,ETag",
    "Content-Type": "application/json;charset=UTF-8"
  };
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

function createUploadToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeTokenEquals(left, right) {
  if (left.length !== right.length || left.length === 0) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}

function uploadAuthorizationKey(letterId) {
  return `upload-authorizations/${letterId}`;
}

function mediaPrefix(letterId) {
  return `letters/${letterId}/`;
}

function normalizeContentType(value) {
  return (value || "").split(";", 1)[0].trim().toLowerCase();
}

function sanitizeOriginalName(value) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .slice(0, 80) || "attachment";
}

function decodeFileName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchesMagicBytes(buffer, contentType) {
  const bytes = new Uint8Array(buffer);
  const ascii = (start, length) =>
    String.fromCharCode(...bytes.slice(start, start + length));

  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (contentType === "image/png") {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 && ascii(1, 3) === "PNG" &&
      bytes[4] === 0x0d && bytes[5] === 0x0a &&
      bytes[6] === 0x1a && bytes[7] === 0x0a;
  }

  if (contentType === "image/webp") {
    return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  }

  if (contentType === "image/gif") {
    return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  }

  if (contentType === "audio/mpeg") {
    return bytes.length >= 3 &&
      (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  }

  if (contentType === "audio/aac") {
    return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  }

  if (contentType === "audio/wav") {
    return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
  }

  if (contentType === "audio/webm" || contentType === "video/webm") {
    return bytes.length >= 4 &&
      bytes[0] === 0x1a && bytes[1] === 0x45 &&
      bytes[2] === 0xdf && bytes[3] === 0xa3;
  }

  if (contentType === "audio/mp4" || contentType === "video/mp4") {
    return bytes.length >= 12 && ascii(4, 4) === "ftyp";
  }

  return false;
}

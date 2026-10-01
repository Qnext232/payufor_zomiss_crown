const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// --------------------------------------------------
// ENVIRONMENT
// --------------------------------------------------

const isProduction = process.env.NODE_ENV === "production";

// Behind a reverse proxy / hosting platform set TRUST_PROXY=1 so req.ip is the
// real visitor (needed for the payment throttle below).
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp);
}

// Where the separately hosted front-end lives. PayU sends the customer back to
// THIS API, and the API then redirects the browser to the front-end.
//   FRONTEND_URL=https://your-site.com            -> https://your-site.com/registration.html
//   FRONTEND_URL=https://your-site.com/apply.html -> used as is
// It must be the SAME origin the visitor filled the form on, otherwise the
// saved form data (localStorage) is not found after payment.
const FRONTEND_URL = (process.env.FRONTEND_URL || "").trim();

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch (error) {
    return null;
  }
}

function frontendUrl(params = {}) {
  const url = new URL(FRONTEND_URL);

  if (!/\.html?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/registration.html";
  }

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

// Browsers allowed to call this API (CORS).
const allowedOrigins = new Set(
  [
    originOf(FRONTEND_URL),
    ...String(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => originOf(item.trim()))
  ].filter(Boolean)
);

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = server-to-server / curl / PayU's own form post.
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      if (!isProduction && LOCAL_ORIGIN.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600
  })
);

// Registration payload contains base64 photos -> default 100kb limit would reject it.
app.use(express.json({ limit: "30mb" }));
// PayU posts its response back as a normal form.
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// --------------------------------------------------
// DATA STORAGE
// --------------------------------------------------

// Point DATA_DIR at a persistent disk/volume when your host has an ephemeral filesystem.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ORDERS_FILE = path.join(DATA_DIR, "payu-orders.json");
const REGISTRATIONS_FILE = path.join(
  DATA_DIR,
  "registrations.json"
);

function readJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error("Error reading data file:", error.message);
    throw new Error("Unable to read server data.");
  }
}

function writeJson(filePath, data) {
  // Write to a temp file first so a crash can never leave half-written JSON.
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempFile, filePath);
}

// --------------------------------------------------
// PAYU CONFIGURATION
// Amount is intentionally NOT configured here.
// --------------------------------------------------

const PAYU_CONFIG = {
  key: process.env.PAYU_MERCHANT_KEY,
  salt: process.env.PAYU_MERCHANT_SALT,
  mode: (process.env.PAYU_MODE || "test").toLowerCase(),

  productInfo:
    process.env.PAYU_PRODUCT_INFO ||
    "ZomissCrownRegistration",

  urls: {
    live: "https://secure.payu.in/_payment",
    test: "https://test.payu.in/_payment"
  }
};

function validateConfig() {
  if (!PAYU_CONFIG.key || !PAYU_CONFIG.salt) {
    throw new Error(
      "PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT are required."
    );
  }

  if (!["test", "live"].includes(PAYU_CONFIG.mode)) {
    throw new Error("PAYU_MODE must be test or live.");
  }

  if (!FRONTEND_URL || !originOf(FRONTEND_URL)) {
    throw new Error(
      "FRONTEND_URL is required (full URL of your hosted front-end, " +
      "e.g. https://your-site.com)."
    );
  }

  if (isProduction && !process.env.PUBLIC_BASE_URL) {
    throw new Error(
      "PUBLIC_BASE_URL (public URL of THIS API) is required in production."
    );
  }
}

validateConfig();

const PAYU_ACTION_URL =
  PAYU_CONFIG.mode === "live"
    ? PAYU_CONFIG.urls.live
    : PAYU_CONFIG.urls.test;

// Public URL of THIS API (where PayU posts the payment result).
// Example: https://api.your-domain.com   (no trailing slash needed)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL
  ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")
  : null;

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  if (isProduction) {
    throw new Error(
      "PUBLIC_BASE_URL must be configured in production."
    );
  }

  return `${req.protocol}://${req.get("host")}`;
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function createTransactionId() {
  return (
    "ZCI" +
    Date.now() +
    crypto.randomBytes(8).toString("hex").toUpperCase()
  );
}

function isValidAmount(value) {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return false;
  }

  const amountString = String(value);

  // Positive amount, maximum two decimal places.
  if (!/^\d+(?:\.\d{1,2})?$/.test(amountString)) {
    return false;
  }

  const amount = Number(amountString);

  return (
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 10000000
  );
}

function formatAmount(value) {
  return Number(value).toFixed(2);
}

function cleanText(value) {
  return String(value || "").trim();
}

function createHash(value) {
  return crypto
    .createHash("sha512")
    .update(value, "utf8")
    .digest("hex");
}

function safeEqualHex(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !/^[a-f0-9]{128}$/i.test(a) ||
    !/^[a-f0-9]{128}$/i.test(b)
  ) {
    return false;
  }

  const first = Buffer.from(a, "hex");
  const second = Buffer.from(b, "hex");

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function findOrder(txnid) {
  const orders = readJson(ORDERS_FILE, []);
  return orders.find((order) => order.txnid === txnid);
}

function updateOrder(txnid, updates) {
  const orders = readJson(ORDERS_FILE, []);
  const index = orders.findIndex(
    (order) => order.txnid === txnid
  );

  if (index === -1) {
    return null;
  }

  orders[index] = {
    ...orders[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  writeJson(ORDERS_FILE, orders);

  return orders[index];
}

// --------------------------------------------------
// 1. GET PAYU CONFIG
// Does not expose salt or amount.
// --------------------------------------------------

app.get("/api/payu/config", (req, res) => {
  res.json({
    success: true,
    key: PAYU_CONFIG.key,
    mode: PAYU_CONFIG.mode,
    productInfo: PAYU_CONFIG.productInfo,
    actionUrl: PAYU_ACTION_URL
  });
});

// --------------------------------------------------
// Small in-memory throttle so repeated clicks / reloads can never
// hammer PayU (PayU answers 429 "Too many requests" when that happens).
// --------------------------------------------------

const lastOrderAt = new Map();
const ORDER_COOLDOWN_MS = 10 * 1000;

setInterval(() => {
  const cutoff = Date.now() - ORDER_COOLDOWN_MS;
  for (const [id, time] of lastOrderAt) {
    if (time < cutoff) lastOrderAt.delete(id);
  }
}, 60 * 1000).unref();

function orderThrottle(req, res, next) {
  const id = `${req.ip}|${String((req.body && req.body.email) || "").toLowerCase()}`;
  const now = Date.now();
  const last = lastOrderAt.get(id) || 0;

  if (now - last < ORDER_COOLDOWN_MS) {
    const wait = Math.ceil((ORDER_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({
      success: false,
      message: `Please wait ${wait} seconds before trying the payment again.`
    });
  }

  lastOrderAt.set(id, now);
  next();
}

// --------------------------------------------------
// 2. CREATE PAYU ORDER
// Amount comes ONLY from req.body.amount.
// --------------------------------------------------

app.post("/api/payu/create-order", orderThrottle, (req, res) => {
  try {
    const {
      fullName,
      email,
      mobile,
      amount: requestedAmount
    } = req.body;

    if (!fullName || !email || !mobile) {
      return res.status(400).json({
        success: false,
        message:
          "Full name, email, and mobile are required."
      });
    }

    if (!isValidAmount(requestedAmount)) {
      return res.status(400).json({
        success: false,
        message:
          "A valid amount is required in the request body."
      });
    }

    const cleanName = cleanText(fullName);
    const cleanEmail = cleanText(email).toLowerCase();
    const cleanPhone = cleanText(mobile).replace(/\D/g, "");

    if (
      cleanName.length < 2 ||
      cleanName.length > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid full name."
      });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address."
      });
    }

    if (!/^\d{10,15}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid mobile number."
      });
    }

    const key = PAYU_CONFIG.key.trim();
    const salt = PAYU_CONFIG.salt.trim();

    const txnid = createTransactionId();
    const amount = formatAmount(requestedAmount);

    const productinfo = PAYU_CONFIG.productInfo
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .trim()
      .slice(0, 100);

    const firstname =
      cleanName
        .split(/\s+/)[0]
        .replace(/[^a-zA-Z0-9]/g, "") ||
      "Candidate";

    const baseUrl = getBaseUrl(req);

    const surl = `${baseUrl}/api/payu/response`;
    const furl = `${baseUrl}/api/payu/response`;

    // PayU request hash:
    // key|txnid|amount|productinfo|firstname|email|
    // udf1|udf2|udf3|udf4|udf5|udf6|udf7|udf8|udf9|udf10|salt
    //
    // All ten UDF fields are empty.

    const hashString =
      `${key}|${txnid}|${amount}|${productinfo}|` +
      `${firstname}|${cleanEmail}|||||||||||${salt}`;

    const hash = createHash(hashString);

    // Save the original transaction on the server.
    const orders = readJson(ORDERS_FILE, []);

    orders.push({
      txnid,
      amount,
      productinfo,
      firstname,
      email: cleanEmail,
      phone: cleanPhone,
      status: "PENDING",
      createdAt: new Date().toISOString()
    });

    writeJson(ORDERS_FILE, orders);

    // Never log the salt or complete hash string.
    console.log("[PayU Order Created]", {
      txnid,
      amount,
      mode: PAYU_CONFIG.mode
    });

    return res.json({
      success: true,
      actionUrl: PAYU_ACTION_URL,

      params: {
        key,
        txnid,
        amount,
        productinfo,
        firstname,
        email: cleanEmail,
        phone: cleanPhone,
        surl,
        furl,
        hash,
        service_provider: "payu_paisa",

        udf1: "",
        udf2: "",
        udf3: "",
        udf4: "",
        udf5: "",
        udf6: "",
        udf7: "",
        udf8: "",
        udf9: "",
        udf10: ""
      }
    });
  } catch (error) {
    console.error("Create order error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create PayU order."
    });
  }
});

// --------------------------------------------------
// 3. PAYU PAYMENT RESPONSE
// Verify reverse hash and match the saved order.
// --------------------------------------------------

app.post("/api/payu/response", (req, res) => {
  try {
    const {
      status,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      mihpayid,
      hash,
      key,
      udf1 = "",
      udf2 = "",
      udf3 = "",
      udf4 = "",
      udf5 = "",
      udf6 = "",
      udf7 = "",
      udf8 = "",
      udf9 = "",
      udf10 = "",
      error_Message
    } = req.body;

    const order = findOrder(txnid);

    if (!order) {
      return res.redirect(
        frontendUrl({
          status: "failure",
          msg: "Invalid transaction."
        })
      );
    }

    const salt = PAYU_CONFIG.salt.trim();

    // PayU reverse hash:
    // salt|status|udf10|udf9|...|udf1|email|
    // firstname|productinfo|amount|txnid|key
    //
    // Use the callback values for hash verification.

    const reverseParts = [
      salt,
      status || "",
      udf10,
      udf9,
      udf8,
      udf7,
      udf6,
      udf5,
      udf4,
      udf3,
      udf2,
      udf1,
      email || "",
      firstname || "",
      productinfo || "",
      amount || "",
      txnid || "",
      key || ""
    ];

    // When PayU adds extra charges the reverse hash is prefixed with them.
    if (req.body.additionalCharges) {
      reverseParts.unshift(req.body.additionalCharges);
    }

    const reverseHashString = reverseParts.join("|");

    const expectedReverseHash =
      createHash(reverseHashString);

    const isHashValid = safeEqualHex(
      hash,
      expectedReverseHash
    );

    // Match callback against the original server-side order.
    const isOrderMatch =
      key === PAYU_CONFIG.key &&
      txnid === order.txnid &&
      Number(amount) === Number(order.amount) &&
      productinfo === order.productinfo &&
      String(email).toLowerCase() === order.email;

    if (!isHashValid || !isOrderMatch) {
      console.error("[PayU Verification Failed]", {
        txnid,
        isHashValid,
        isOrderMatch
      });

      // Never change an order because of a callback that failed verification
      // (anyone could post a forged callback and un-pay a paid order).
      return res.redirect(
        frontendUrl({
          status: "failure",
          msg: "Payment verification failed."
        })
      );
    }

    // Already confirmed earlier (refresh / PayU retry): stay idempotent.
    if (order.status === "SUCCESS") {
      return res.redirect(
        frontendUrl({ status: "success", txnid })
      );
    }

    if (status === "success") {
      updateOrder(txnid, {
        status: "SUCCESS",
        mihpayid: mihpayid || "",
        verifiedAt: new Date().toISOString()
      });

      console.log("[PayU Payment Verified]", {
        txnid,
        mihpayid,
        amount
      });

      return res.redirect(
        frontendUrl({
          status: "success",
          txnid,
          payuMoneyId: mihpayid || "",
          amount
        })
      );
    }

    updateOrder(txnid, {
      status: "FAILURE",
      failureReason: error_Message || "Payment failed"
    });

    return res.redirect(
      frontendUrl({
        status: "failure",
        txnid,
        msg: error_Message || "Payment failed"
      })
    );
  } catch (error) {
    console.error("PayU callback error:", error.message);

    return res.redirect(
      frontendUrl({
        status: "failure",
        msg: "Server callback error."
      })
    );
  }
});

// --------------------------------------------------
// 3b. PAYMENT STATUS (front-end asks this before it unlocks
// the next form - the browser is never trusted for this)
// --------------------------------------------------

app.get("/api/payu/status/:txnid", (req, res) => {
  try {
    const order = findOrder(String(req.params.txnid || ""));

    if (!order) {
      return res.status(404).json({ success: false, status: "NOT_FOUND" });
    }

    return res.json({
      success: true,
      status: order.status,
      verified: order.status === "SUCCESS",
      txnid: order.txnid,
      amount: order.amount,
      mihpayid: order.status === "SUCCESS" ? order.mihpayid || "" : ""
    });
  } catch (error) {
    return res.status(500).json({ success: false, status: "ERROR" });
  }
});

// PayU return URL opened with GET (refresh / back button) -> back to the front-end.
app.get("/api/payu/response", (req, res) => {
  res.redirect(frontendUrl());
});

// --------------------------------------------------
// 4. SUBMIT REGISTRATION
// Only accepts a transaction verified by this server.
// --------------------------------------------------

app.post("/api/registration/submit", (req, res) => {
  try {
    const regData = req.body;

    if (
      !regData ||
      !regData.payment ||
      !(regData.payment.txnId || regData.payment.txnid)
    ) {
      return res.status(400).json({
        success: false,
        message: "A verified payment transaction is required."
      });
    }

    const txnid = String(regData.payment.txnId || regData.payment.txnid);
    const order = findOrder(txnid);

    if (!order || order.status !== "SUCCESS") {
      return res.status(400).json({
        success: false,
        message:
          "Payment has not been verified successfully."
      });
    }

    if (
      !regData.pass ||
      !regData.pass.regId ||
      !regData.section1 ||
      !regData.section1.fullName
    ) {
      return res.status(400).json({
        success: false,
        message: "Registration details are incomplete."
      });
    }

    const registrations = readJson(
      REGISTRATIONS_FILE,
      []
    );

    // Prevent duplicate registration for the same payment.
    const alreadyRegistered = registrations.some(
      (registration) =>
        registration.payment &&
        registration.payment.txnid === txnid
    );

    if (alreadyRegistered) {
      return res.status(409).json({
        success: false,
        message:
          "This payment has already been used for registration."
      });
    }

    // Do not trust client-supplied payment status or amount.
    const submissionRecord = {
      ...regData,

      payment: {
        status: "SUCCESS",
        txnid: order.txnid,
        amount: order.amount,
        mihpayid: order.mihpayid || ""
      },

      submittedAt: new Date().toISOString()
    };

    registrations.push(submissionRecord);

    writeJson(REGISTRATIONS_FILE, registrations);

    console.log("[Registration Saved]", {
      regId: submissionRecord.pass.regId,
      txnid
    });

    return res.json({
      success: true,
      message: "Registration successfully recorded.",
      regId: submissionRecord.pass.regId
    });
  } catch (error) {
    console.error("Registration error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to record registration."
    });
  }
});

// --------------------------------------------------
// 5. HEALTH CHECK
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Zomiss Crown India 2027 API is running.",
    payuMode: PAYU_CONFIG.mode
  });
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Zomiss Crown India 2027 API",
    health: "/api/health"
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found." });
});

app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Upload is too large. Please use smaller photos."
    });
  }

  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Invalid request body."
    });
  }

  console.error("Unhandled error:", err && err.message);
  return res.status(500).json({
    success: false,
    message: "Server error."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log("============================================");
  console.log(" Zomiss Crown India 2027 Server Running");
  console.log(` API:      http://localhost:${PORT}`);
  console.log(` Health:   http://localhost:${PORT}/api/health`);
  console.log(` PayU Mode: ${PAYU_CONFIG.mode.toUpperCase()}`);
  console.log(` Front-end: ${FRONTEND_URL}`);
  console.log(` CORS origins: ${[...allowedOrigins].join(", ") || "(none)"}`);
  console.log("============================================");
});
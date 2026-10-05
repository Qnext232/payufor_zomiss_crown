const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ---------------- CONFIG (edit here) ----------------
const PORT = 5000;
const KEY = "VxG1gd";
const SALT = "rlIla3Gl6ZpypipOFEMpiB2JKG1BuxrR";
const MODE = "live"; // "live" or "test"
const PRODUCT = "ZomissCrownRegistration";
const FEE = "1.00"; // fixed on the server, client amount is ignored




// Public URL of backend (PayU sends webhook/redirects here)
const BACKEND_URL = (process.env.BACKEND_URL || "https://payufor-zomiss-crown.vercel.app").replace(/\/+$/, "");

// Frontend URL (NO trailing slash - critical for CORS)
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://zomisscrownweb.vercel.app").replace(/\/+$/, "");
// ----------------------------------------

const PAYU_URL = MODE === "live" ? "https://secure.payu.in/_payment" : "https://test.payu.in/_payment";
const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");
const back = (q) => `${FRONTEND_URL}/registration?${new URLSearchParams(q)}`;

// In-memory fallback (Note: for zero transaction drops across cold starts, connect Redis/DB)
const orders = new Map();
const registrations = [];

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://zomisscrownweb.vercel.app"
];

// Manual Preflight & Header Guard
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const cleanOrigin = origin ? origin.replace(/\/+$/, "") : "";

  if (allowedOrigins.includes(cleanOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Express CORS middleware
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const cleanOrigin = origin.replace(/\/+$/, "");
      if (allowedOrigins.includes(cleanOrigin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Create a signed PayU order
app.post("/api/payu/create-order", (req, res) => {
  const { fullName = "", email = "", mobile = "" } = req.body;
  const cleanEmail = String(email).trim().toLowerCase();
  const phone = String(mobile).replace(/\D/g, "");
  const name = String(fullName).trim();

if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || !/^\d{10,15}$/.test(phone)) {
  return res.status(400).json({ success: false, message: "Valid name, email and mobile are required." });
  }

  const txnid = "ZCI" + Date.now() + crypto.randomBytes(4).toString("hex").toUpperCase();
  const firstname = name.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, "") || "Candidate";
  const hash = sha512(`${KEY}|${txnid}|${FEE}|${PRODUCT}|${firstname}|${cleanEmail}|||||||||||${SALT}`);

  orders.set(txnid, { txnid, amount: FEE, email: cleanEmail, status: "PENDING" });

  res.json({
    success: true,
    actionUrl: PAYU_URL,
    params: {
      key: KEY,
      txnid,
      amount: FEE,
      productinfo: PRODUCT,
      firstname,
      email: cleanEmail,
      phone,
      hash,
      surl: `${BACKEND_URL}/api/payu/response`,
      furl: `${BACKEND_URL}/api/payu/response`,
    },
  });
});

// PayU callback -> verify hash -> redirect to React app
app.post("/api/payu/response", (req, res) => {
  const b = req.body;
  const order = orders.get(b.txnid);

  // In serverless, if the instance restarted and lost in-memory state, verify via hash & amount fallback
  const udf = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => b["udf" + i] || "");
  const expected = sha512(
    [SALT, b.status || "", ...udf, b.email || "", b.firstname || "", b.productinfo || "", b.amount || "", b.txnid, b.key || ""].join("|")
  );

  const hashValid = expected === String(b.hash || "").toLowerCase() && b.key === KEY;

  if (!hashValid) {
    if (order) order.status = "VERIFICATION_FAILED";
    return res.redirect(back({ status: "failure", msg: "Payment verification failed." }));
  }

  if (b.status !== "success") {
    if (order) order.status = "FAILURE";
    return res.redirect(back({ status: "failure", txnid: b.txnid, msg: b.error_Message || "Payment failed" }));
  }

  // Record verified order
  orders.set(b.txnid, {
    txnid: b.txnid,
    amount: b.amount,
    email: String(b.email).toLowerCase(),
    status: "SUCCESS",
    mihpayid: b.mihpayid || "",
  });

  return res.redirect(back({ status: "success", txnid: b.txnid, payuMoneyId: b.mihpayid || "", amount: b.amount }));
});

// Save registration (only for a verified payment, once per payment)
app.post("/api/registration/submit", (req, res) => {
  const d = req.body || {};
  const order = orders.get(d.payment?.txnid);

  if (!order || order.status !== "SUCCESS") {
    return res.status(400).json({ success: false, message: "Payment has not been verified." });
  }
  if (!d.pass?.regId || !d.section1?.fullName) {
    return res.status(400).json({ success: false, message: "Registration details are incomplete." });
  }
  if (registrations.some((r) => r.payment?.txnid === order.txnid)) {
    return res.status(409).json({ success: false, message: "This payment is already used." });
  }

  registrations.push({
    ...d,
    payment: { status: "SUCCESS", txnid: order.txnid, amount: order.amount, mihpayid: order.mihpayid },
    submittedAt: new Date().toISOString(),
  });

  res.json({ success: true, regId: d.pass.regId });
});

app.get("/api/health", (_, res) => res.json({ success: true, mode: MODE }));

// Support local development while letting Vercel manage serverless execution
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`Server running on port ${PORT} (PayU ${MODE})`));
}

module.exports = app;

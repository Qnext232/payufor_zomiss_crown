const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ---------------- CONFIG ----------------
const PORT = 5000;
const KEY = "VxG1gd";
const SALT = "rlIla3Gl6ZpypipOFEMpiB2JKG1BuxrR";
const MODE = "live"; // "live" or "test"
const DEFAULT_PRODUCT = "CelebsKey";

// Public URL of backend (PayU sends webhook/redirects here)
const BACKEND_URL = ("https://payufor-zomiss-crown.vercel.app").replace(/\/+$/, "");

// Fallback frontend URL (only used if website does not provide redirectUrl)
const DEFAULT_FRONTEND_URL = ("https://zomisscrownweb.vercel.app").replace(/\/+$/, "");
// ----------------------------------------

const PAYU_URL = MODE === "live" ? "https://secure.payu.in/_payment" : "https://test.payu.in/_payment";
const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");

// In-memory fallback (Note: for zero transaction drops across cold starts, connect Redis/DB)
const orders = new Map();
const registrations = [];

const app = express();

// Flexible CORS support allowing local dev and any production website domain
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Create a signed PayU order with dynamic fee & redirectUrl sent by the website
app.post("/api/payu/create-order", (req, res) => {
  const {
    fullName = "",
    email = "",
    mobile = "",
    amount,
    fee,
    productinfo,
    redirectUrl,
    returnUrl,
    frontendUrl
  } = req.body;

  const cleanEmail = String(email).trim().toLowerCase();
  const phone = String(mobile).replace(/\D/g, "");
  const name = String(fullName).trim();

  // Validate attendee info
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Valid name, email and mobile are required." });
  }

  // Validate dynamic fee/amount received from website
  const rawAmount = amount !== undefined && amount !== null ? amount : fee;
  const parsedAmount = parseFloat(rawAmount);

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ success: false, message: "A valid positive payment amount is required." });
  }

  const orderAmount = Number(parsedAmount).toFixed(2);
  const product = String(productinfo || DEFAULT_PRODUCT).trim();

  // Dynamic redirect URL sent from website (e.g. "http://localhost:5173/registration" or "https://yourdomain.com/registration")
  const clientRedirect = String(redirectUrl || returnUrl || (frontendUrl ? `${frontendUrl}/registration` : "") || `${DEFAULT_FRONTEND_URL}/registration`).trim();

  const txnid = "ZCI" + Date.now() + crypto.randomBytes(4).toString("hex").toUpperCase();
  const firstname = name.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, "") || "Attendee";

  // Calculate PayU SHA-512 hash using the dynamic amount sent from the website
  const hash = sha512(`${KEY}|${txnid}|${orderAmount}|${product}|${firstname}|${cleanEmail}|||||||||||${SALT}`);

  // Attach clientRedirect URL query to the PayU callback URL so it survives serverless restarts
  const serverCallbackUrl = `${BACKEND_URL}/api/payu/response?redirectUrl=${encodeURIComponent(clientRedirect)}`;

  orders.set(txnid, {
    txnid,
    amount: orderAmount,
    email: cleanEmail,
    redirectUrl: clientRedirect,
    status: "PENDING"
  });

  res.json({
    success: true,
    actionUrl: PAYU_URL,
    params: {
      key: KEY,
      txnid,
      amount: orderAmount,
      productinfo: product,
      firstname,
      email: cleanEmail,
      phone,
      hash,
      surl: serverCallbackUrl,
      furl: serverCallbackUrl,
    },
  });
});

// PayU callback -> verify hash -> redirect browser back to the website URL sent by the client
app.post("/api/payu/response", (req, res) => {
  const b = req.body;
  const order = orders.get(b.txnid);

  // Read target redirect URL sent by website (from callback query or order store)
  const targetRedirect = req.query.redirectUrl || order?.redirectUrl || `${DEFAULT_FRONTEND_URL}/registration`;
  const redirectTarget = (q) => {
    const sep = targetRedirect.includes("?") ? "&" : "?";
    return `${targetRedirect}${sep}${new URLSearchParams(q)}`;
  };

  const udf = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => b["udf" + i] || "");
  const expected = sha512(
    [SALT, b.status || "", ...udf, b.email || "", b.firstname || "", b.productinfo || "", b.amount || "", b.txnid, b.key || ""].join("|")
  );

  const hashValid = expected === String(b.hash || "").toLowerCase() && b.key === KEY;

  if (!hashValid) {
    if (order) order.status = "VERIFICATION_FAILED";
    return res.redirect(redirectTarget({ status: "failure", msg: "Payment verification failed." }));
  }

  if (b.status !== "success") {
    if (order) order.status = "FAILURE";
    return res.redirect(redirectTarget({ status: "failure", txnid: b.txnid, msg: b.error_Message || "Payment failed" }));
  }

  // Record verified order
  orders.set(b.txnid, {
    txnid: b.txnid,
    amount: b.amount,
    email: String(b.email).toLowerCase(),
    status: "SUCCESS",
    mihpayid: b.mihpayid || "",
    redirectUrl: targetRedirect,
  });

  return res.redirect(redirectTarget({
    status: "success",
    txnid: b.txnid,
    payuMoneyId: b.mihpayid || "",
    amount: b.amount
  }));
});

// Save registration (only for a verified payment, once per payment)
app.post("/api/registration/submit", (req, res) => {
  const d = req.body || {};
  const order = orders.get(d.payment?.txnid);

  if (!order || order.status !== "SUCCESS") {
    return res.status(400).json({ success: false, message: "Payment has not been verified." });
  }
  if (!d.pass?.regId && !d.txnid) {
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

  res.json({ success: true, txnid: order.txnid });
});

app.get("/api/health", (_, res) => res.json({ success: true, mode: MODE }));

// Support local development while letting Vercel manage serverless execution
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`Server running on port ${PORT} (PayU ${MODE})`));
}

module.exports = app;

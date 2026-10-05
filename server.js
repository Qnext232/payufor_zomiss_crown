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

// Public URL of THIS backend (PayU posts the result here). Must be https + reachable by PayU.
const BACKEND_URL = "https://payufor-zomiss-crown.vercel.app";
// Where the React site runs (user is sent back here after payment)
const FRONTEND_URL = "http://localhost:5173";
// ----------------------------------------------------

const PAYU_URL = MODE === "live" ? "https://secure.payu.in/_payment" : "https://test.payu.in/_payment";
const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");
const back = (q) => `${FRONTEND_URL}/registration?${new URLSearchParams(q)}`;

// In-memory store (resets on restart)
const orders = new Map();
const registrations = [];

const app = express();
app.use(cors({ origin: FRONTEND_URL }));
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
      key: KEY, txnid, amount: FEE, productinfo: PRODUCT, firstname,
      email: cleanEmail, phone, hash,
      surl: `${BACKEND_URL}/api/payu/response`,
      furl: `${BACKEND_URL}/api/payu/response`,
    },
  });
});

// PayU callback -> verify hash -> redirect to React app
app.post("/api/payu/response", (req, res) => {
  const b = req.body;
  const order = orders.get(b.txnid);
  if (!order) return res.redirect(back({ status: "failure", msg: "Invalid transaction." }));

  const udf = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => b["udf" + i] || "");
  const expected = sha512(
    [SALT, b.status || "", ...udf, b.email || "", b.firstname || "", b.productinfo || "", b.amount || "", b.txnid, b.key || ""].join("|")
  );
  const valid =
    expected === String(b.hash || "").toLowerCase() &&
    b.key === KEY &&
    Number(b.amount) === Number(order.amount) &&
    String(b.email).toLowerCase() === order.email;

  if (!valid) {
    order.status = "VERIFICATION_FAILED";
    return res.redirect(back({ status: "failure", msg: "Payment verification failed." }));
  }
  if (b.status !== "success") {
    order.status = "FAILURE";
    return res.redirect(back({ status: "failure", txnid: b.txnid, msg: b.error_Message || "Payment failed" }));
  }

  order.status = "SUCCESS";
  order.mihpayid = b.mihpayid || "";
  res.redirect(back({ status: "success", txnid: b.txnid, payuMoneyId: order.mihpayid, amount: order.amount }));
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
  if (registrations.some((r) => r.payment.txnid === order.txnid)) {
    return res.status(409).json({ success: false, message: "This payment is already used." });
  }

  registrations.push({
    ...d,
    payment: { status: "SUCCESS", txnid: order.txnid, amount: order.amount, mihpayid: order.mihpayid },
    submittedAt: new Date().toISOString(),
  });
  console.log("[Registration]", d.pass.regId, order.txnid);
  res.json({ success: true, regId: d.pass.regId });
});

app.get("/api/health", (_, res) => res.json({ success: true, mode: MODE }));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} (PayU ${MODE})`));

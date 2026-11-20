
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { PDFDocument } = require("pdf-lib");
const Razorpay = require("razorpay");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN;

// Test mode only
const TEST_MODE = Boolean(
  KEY_ID &&
  KEY_ID.startsWith("rzp_test_") &&
  KEY_SECRET
);

const razorpay = TEST_MODE
  ? new Razorpay({
      key_id: KEY_ID,
      key_secret: KEY_SECRET
    })
  : null;

// Temporary memory storage for testing
const jobs = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

// Serve only public assets, not private files
app.use(express.static(
  path.join(__dirname, "public"),
  { dotfiles: "deny" }
));

// Your index.html is in the root folder
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Calculate total amount in paise
function calculateAmount(pages) {
  if (
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 500
  ) {
    throw new Error("Invalid page count");
  }

  if (pages === 1) return 500;
  if (pages <= 5) return pages * 300;
  if (pages <= 10) return pages * 200;

  return pages * 150;
}

// Safe comparison
function safeEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) return false;

  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ETAWAH CAFE Self Print Kiosk",
    paymentsEnabled: Boolean(razorpay),
    paymentMode: "test",
    printAgentConfigured: Boolean(AGENT_TOKEN)
  });
});

// PDF upload configuration
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const valid =
      file.mimetype === "application/pdf" &&
      path.extname(file.originalname)
        .toLowerCase() === ".pdf";

    cb(
      valid ? null : new Error("Only PDF files allowed"),
      valid
    );
  }
});

// Upload PDF and calculate amount
app.post(
  "/api/upload",
  upload.single("pdf"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Please select a PDF"
      });
    }

    try {
      const bytes = fs.readFileSync(req.file.path);

      const pdf = await PDFDocument.load(bytes, {
        ignoreEncryption: false
      });

      const pages = pdf.getPageCount();
      const amount = calculateAmount(pages);
      const fileId = crypto.randomUUID();

      const finalPath = path.join(
        UPLOAD_DIR,
        fileId + ".pdf"
      );

      fs.renameSync(req.file.path, finalPath);

      jobs.set(fileId, {
        fileId,
        filePath: finalPath,
        pages,
        amount,
        orderId: null,
        paymentId: null,
        status: "uploaded",
        claimed: false,
        downloaded: false,
        createdAt: Date.now()
      });

      res.json({
        fileId,
        pages,
        amount: amount / 100,
        currency: "INR",
        name: path.basename(req.file.originalname)
      });

    } catch (err) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      res.status(400).json({
        error: err.message || "Invalid PDF"
      });
    }
  }
);

// Create Razorpay payment order
app.post("/api/payment/create-order", async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({
      error: "Razorpay Test Mode not configured"
    });
  }

  const fileId = req.body?.fileId;
  const job = jobs.get(fileId);

  if (!job) {
    return res.status(404).json({
      error: "Please upload PDF first"
    });
  }

  if (job.status === "pending_payment") {
    return res.json({
      key: KEY_ID,
      orderId: job.orderId,
      amount: job.amount,
      currency: "INR",
      pages: job.pages,
      business: "ETAWAH CAFE"
    });
  }

  if (job.status !== "uploaded") {
    return res.status(409).json({
      error: "Payment order cannot be created"
    });
  }

  job.status = "creating_order";

  try {
    const order = await razorpay.orders.create({
      amount: job.amount,
      currency: "INR",
      receipt: fileId.replace(/-/g, "").slice(0, 32),
      notes: {
        fileId,
        pages: String(job.pages)
      }
    });

    job.orderId = order.id;
    job.status = "pending_payment";

    res.json({
      key: KEY_ID,
      orderId: order.id,
      amount: job.amount,
      currency: "INR",
      pages: job.pages,
      business: "ETAWAH CAFE"
    });

  } catch (err) {
    job.status = "uploaded";

    console.error("Razorpay order error:", err.message);

    res.status(502).json({
      error: "Unable to create payment order"
    });
  }
});

// Verify Razorpay payment
app.post("/api/payment/verify", async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({
      error: "Payment gateway unavailable"
    });
  }

  const {
    fileId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  } = req.body || {};

  const job = jobs.get(fileId);

  if (!job || !job.orderId) {
    return res.status(404).json({
      error: "Payment job not found"
    });
  }

  if (
    job.status === "paid" &&
    job.paymentId === razorpay_payment_id
  ) {
    return res.json({
      verified: true,
      printAllowed: !job.claimed,
      fileId
    });
  }

  if (job.status !== "pending_payment") {
    return res.status(409).json({
      error: "Payment is not pending"
    });
  }

  if (
    typeof razorpay_order_id !== "string" ||
    typeof razorpay_payment_id !== "string" ||
    typeof razorpay_signature !== "string" ||
    razorpay_order_id !== job.orderId
  ) {
    return res.status(400).json({
      error: "Invalid payment details"
    });
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(
      job.orderId + "|" + razorpay_payment_id
    )
    .digest("hex");

  if (!safeEqual(expectedSignature, razorpay_signature)) {
    return res.status(403).json({
      error: "Invalid payment signature"
    });
  }

  try {
    // Independently confirm payment with Razorpay
    const payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (
      payment.order_id !== job.orderId ||
      payment.amount !== job.amount ||
      payment.currency !== "INR" ||
      payment.status !== "captured"
    ) {
      return res.status(409).json({
        error: "Payment not captured or amount mismatch"
      });
    }

    job.paymentId = payment.id;
    job.status = "paid";

    res.json({
      verified: true,
      printAllowed: true,
      fileId,
      pages: job.pages,
      amount: job.amount / 100,
      message: "Payment verified successfully"
    });

  } catch (err) {
    console.error("Payment verification error:", err.message);

    res.status(502).json({
      error: "Unable to confirm payment. Retry verification."
    });
  }
});

// Job status
app.get("/api/job/:fileId/status", (req, res) => {
  const job = jobs.get(req.params.fileId);

  if (!job) {
    return res.status(404).json({
      error: "Job not found"
    });
  }

  res.json({
    status: job.status,
    printAllowed:
      job.status === "paid" && !job.claimed
  });
});

// Print Agent authentication
function checkAgent(req, res, next) {
  const token = req.get("x-print-agent-token");

  if (
    !AGENT_TOKEN ||
    !token ||
    !safeEqual(token, AGENT_TOKEN)
  ) {
    return res.status(403).json({
      error: "Unauthorized print agent"
    });
  }

  next();
}

// Claim print authorization
app.post(
  "/api/print/claim/:fileId",
  checkAgent,
  (req, res) => {
    const job = jobs.get(req.params.fileId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    if (job.status !== "paid" || job.claimed) {
      return res.status(409).json({
        error: "Print not authorized or already claimed"
      });
    }

    job.claimed = true;

    res.json({
      authorized: true,
      fileId: job.fileId,
      pages: job.pages,
      downloadPath:
        "/api/print/file/" + job.fileId
    });
  }
);

// Protected PDF download for print agent
app.get(
  "/api/print/file/:fileId",
  checkAgent,
  (req, res) => {
    const job = jobs.get(req.params.fileId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    if (
      job.status !== "paid" ||
      !job.claimed ||
      job.downloaded
    ) {
      return res.status(403).json({
        error: "PDF download not authorized"
      });
    }

    job.downloaded = true;

    res.download(
      job.filePath,
      job.fileId + ".pdf"
    );
  }
);

// Error handler
app.use((err, req, res, next) => {
  console.error("Request error:", err.message);

  res.status(400).json({
    error: err.message || "Request failed"
  });
});

// Start server
app.listen(PORT, () => {
  console.log(
    "ETAWAH CAFE Self Print Kiosk running on port " + PORT
  );
});

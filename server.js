
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

// Temporary Test Mode job storage
const jobs = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

// Website files
app.use(express.static(
  path.join(__dirname, "public"),
  { dotfiles: "deny" }
));

// Serve root-level website assets safely
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", (_req, res) => {
  res.sendFile(path.join(__dirname, "style.css"));
});

app.get("/app.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "app.js"));
});

app.get("/logo.png", (_req, res) => {
  res.sendFile(path.join(__dirname, "logo.png"));
});

// Progressive slab pricing in paise
function calculateAmount(pages) {
  if (
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 500
  ) {
    throw new Error("Invalid total page count");
  }

  return (
    500 +
    Math.min(Math.max(pages - 1, 0), 4) * 300 +
    Math.min(Math.max(pages - 5, 0), 5) * 200 +
    Math.max(pages - 10, 0) * 150
  );
}

// Secure string comparison
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
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ETAWAH CAFE Self Print Kiosk",
    paymentsEnabled: Boolean(razorpay),
    paymentMode: "test",
    printAgentConfigured: Boolean(AGENT_TOKEN)
  });
});

// PDF upload
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
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

      if (pages < 1 || pages > 500) {
        throw new Error("PDF must have 1 to 500 pages");
      }

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
        amount: calculateAmount(pages),
        copies: null,
        printType: null,
        totalPages: null,
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
        amount: calculateAmount(pages) / 100,
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

// Create Razorpay Order
app.post(
  "/api/payment/create-order",
  async (req, res) => {
    if (!razorpay) {
      return res.status(503).json({
        error: "Razorpay Test Mode not configured"
      });
    }

    const fileId = req.body?.fileId;
    const copies = Number(req.body?.copies);
    const printType = req.body?.printType;

    if (
      !Number.isInteger(copies) ||
      copies < 1 ||
      copies > 20 ||
      !["bw", "color"].includes(printType)
    ) {
      return res.status(400).json({
        error: "Invalid print settings"
      });
    }

    const job = jobs.get(fileId);

    if (!job) {
      return res.status(404).json({
        error: "Upload PDF first"
      });
    }

    const totalPages = job.pages * copies;

    if (totalPages < 1 || totalPages > 500) {
      return res.status(400).json({
        error: "Maximum 500 total print pages allowed"
      });
    }

    const amount = calculateAmount(totalPages);

    if (job.status === "pending_payment") {
      if (
        job.copies !== copies ||
        job.printType !== printType ||
        job.amount !== amount
      ) {
        return res.status(409).json({
          error:
            "Print settings changed. Upload PDF again."
        });
      }

      return res.json({
        key: KEY_ID,
        orderId: job.orderId,
        amount: job.amount,
        currency: "INR",
        pages: job.pages,
        totalPages: job.totalPages,
        business: "ETAWAH CAFE"
      });
    }

    if (job.status !== "uploaded") {
      return res.status(409).json({
        error: "Payment order cannot be created"
      });
    }

    job.amount = amount;
    job.copies = copies;
    job.printType = printType;
    job.totalPages = totalPages;
    job.status = "creating_order";

    try {
      const order = await razorpay.orders.create({
        amount: job.amount,
        currency: "INR",
        receipt: fileId.replace(/-/g, "").slice(0, 32),
        notes: {
          fileId,
          pages: String(job.pages),
          copies: String(copies),
          printType
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
        totalPages: job.totalPages,
        business: "ETAWAH CAFE"
      });

    } catch (err) {
      job.status = "uploaded";

      console.error(
        "Order creation error:",
        err.message
      );

      res.status(502).json({
        error: "Unable to create payment order"
      });
    }
  }
);

// Verify Razorpay Payment
app.post(
  "/api/payment/verify",
  async (req, res) => {
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
        error: "Payment not pending"
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

    const expectedSignature = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(
        job.orderId + "|" + razorpay_payment_id
      )
      .digest("hex");

    if (!safeEqual(
      expectedSignature,
      razorpay_signature
    )) {
      return res.status(403).json({
        error: "Invalid payment signature"
      });
    }

    try {
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
          error:
            "Payment not captured or amount mismatch"
        });
      }

      job.paymentId = payment.id;
      job.status = "paid";

      res.json({
        verified: true,
        printAllowed: true,
        fileId,
        pages: job.pages,
        copies: job.copies,
        totalPages: job.totalPages,
        amount: job.amount / 100,
        message: "Payment verified successfully"
      });

    } catch (err) {
      console.error(
        "Payment verification error:",
        err.message
      );

      res.status(502).json({
        error:
          "Unable to confirm payment. Retry verification."
      });
    }
  }
);

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

    if (
      job.status !== "paid" ||
      job.claimed
    ) {
      return res.status(409).json({
        error:
          "Print not authorized or already claimed"
      });
    }

    job.claimed = true;

    res.json({
      authorized: true,
      fileId: job.fileId,
      pages: job.pages,
      copies: job.copies,
      printType: job.printType,
      totalPages: job.totalPages,
      downloadPath:
        "/api/print/file/" + job.fileId
    });
  }
);

// Protected PDF download
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
app.use((err, _req, res, _next) => {
  console.error("Request error:", err.message);

  res.status(400).json({
    error: err.message || "Request failed"
  });
});

// Start server
app.listen(PORT, () => {
  console.log(
    "ETAWAH CAFE Self Print Kiosk running on port " +
    PORT
  );
});


const $ = id => document.getElementById(id);

let selectedFile = null;
let uploaded = null;
let busy = false;
let paymentCompleted = false;
let paymentPending = false;
let uploadVersion = 0;
let checkoutOpen = false;

const money = n => "₹" + Number(n).toFixed(2);

const slabs = [
  { from: 1, to: 1, rate: 5 },
  { from: 2, to: 5, rate: 3 },
  { from: 6, to: 10, rate: 2 },
  { from: 11, to: Infinity, rate: 1.5 }
];

// Progressive slab pricing
function calculateAmount(pages) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 500) {
    return 0;
  }

  return slabs.reduce((sum, slab) => {
    const count = Math.max(
      0,
      Math.min(pages, slab.to) - slab.from + 1
    );

    return sum + count * slab.rate;
  }, 0);
}

function showMessage(message) {
  $("message").textContent = message;
}

function getSettings() {
  const copies = Number($("copies").value);
  const printType = $("printType").value;

  const validCopies =
    Number.isInteger(copies) &&
    copies >= 1 &&
    copies <= 20;

  const totalPages =
    uploaded && validCopies
      ? uploaded.pages * copies
      : 0;

  const valid =
    Boolean(uploaded) &&
    validCopies &&
    totalPages >= 1 &&
    totalPages <= 500 &&
    ["bw", "color"].includes(printType);

  return {
    copies,
    printType,
    validCopies,
    totalPages,
    valid
  };
}

function updateEstimate() {
  const s = getSettings();

  $("copyCount").textContent =
    s.validCopies ? s.copies : "—";

  $("pageCount").textContent =
    s.totalPages || "—";

  $("total").textContent =
    s.valid
      ? money(calculateAmount(s.totalPages))
      : "₹0.00";

  const btn = $("payBtn");

  btn.disabled =
    busy ||
    paymentCompleted ||
    paymentPending ||
    !s.valid;

  if (paymentCompleted) {
    btn.textContent = "Payment Verified ✓";
  } else if (paymentPending) {
    btn.textContent = "Payment Confirmation Pending";
  } else if (busy) {
    btn.textContent = "Please wait...";
  } else {
    btn.textContent = "Pay Securely with Razorpay →";
  }

  if (uploaded && s.totalPages > 500) {
    showMessage(
      "Maximum total print pages including copies is 500."
    );
  }
}

function setBusy(value) {
  busy = value;

  const locked =
    busy || paymentCompleted || paymentPending;

  $("pdf").disabled = locked;
  $("copies").disabled = locked;
  $("printType").disabled = locked;

  updateEstimate();
}

async function readJSON(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || "Server request failed"
    );
  }

  return data;
}

// Set current year
$("year").textContent = new Date().getFullYear();

// Upload PDF
$("pdf").addEventListener("change", async event => {
  if (busy || paymentPending || paymentCompleted) return;

  const version = ++uploadVersion;

  selectedFile = event.target.files[0] || null;
  uploaded = null;

  $("pdfPages").textContent = "—";
  $("fileName").textContent =
    selectedFile
      ? selectedFile.name
      : "No document selected";

  $("fileState").classList.toggle(
    "has-file",
    Boolean(selectedFile)
  );

  showMessage("");
  updateEstimate();

  if (!selectedFile) return;

  const isPDF =
    selectedFile.type === "application/pdf" ||
    selectedFile.name.toLowerCase().endsWith(".pdf");

  if (!isPDF) {
    selectedFile = null;
    showMessage("Please select a PDF file.");
    updateEstimate();
    return;
  }

  if (selectedFile.size > 15 * 1024 * 1024) {
    selectedFile = null;
    showMessage("PDF size must be 15 MB or less.");
    updateEstimate();
    return;
  }

  setBusy(true);
  showMessage("Checking your PDF pages...");

  try {
    const formData = new FormData();
    formData.append("pdf", selectedFile);

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });

    const data = await readJSON(response);

    if (version !== uploadVersion) return;

    uploaded = data;

    $("fileName").textContent = data.name;
    $("pdfPages").textContent = data.pages;

    $("fileState").classList.add("has-file");

    showMessage(
      "PDF uploaded successfully. Your estimate is ready."
    );

  } catch (error) {
    if (version !== uploadVersion) return;

    uploaded = null;

    $("fileState").classList.remove("has-file");

    showMessage(error.message);

  } finally {
    if (version === uploadVersion) {
      setBusy(false);
    }
  }
});

// Copies and print type
$("copies").addEventListener("input", updateEstimate);
$("printType").addEventListener("change", updateEstimate);

// Verify payment
async function verifyPayment(fileId, payment) {
  const response = await fetch(
    "/api/payment/verify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileId,
        razorpay_order_id:
          payment.razorpay_order_id,
        razorpay_payment_id:
          payment.razorpay_payment_id,
        razorpay_signature:
          payment.razorpay_signature
      })
    }
  );

  return readJSON(response);
}

// Razorpay checkout
$("payBtn").addEventListener("click", async () => {
  const settings = getSettings();

  if (
    !settings.valid ||
    busy ||
    paymentPending ||
    paymentCompleted
  ) return;

  if (typeof Razorpay === "undefined") {
    showMessage(
      "Razorpay could not load. Refresh the website."
    );
    return;
  }

  const fileId = uploaded.fileId;

  setBusy(true);
  showMessage("Creating secure payment order...");

  try {
    const response = await fetch(
      "/api/payment/create-order",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fileId,
          copies: settings.copies,
          printType: settings.printType
        })
      }
    );

    const order = await readJSON(response);

    const expectedPaise = Math.round(
      calculateAmount(settings.totalPages) * 100
    );

    // Never proceed if displayed price differs
    // from the amount calculated by the server.
    if (
      order.amount !== expectedPaise ||
      order.currency !== "INR" ||
      !order.orderId ||
      !order.key
    ) {
      throw new Error(
        "Price mismatch. Payment stopped. Check server pricing."
      );
    }

    $("total").textContent =
      money(order.amount / 100);

    const options = {
      key: order.key,
      amount: order.amount,
      currency: "INR",
      name: "ETAWAH CAFE",
      description: "Self Print Kiosk - Test Payment",
      order_id: order.orderId,

      theme: {
        color: "#0b2852"
      },

      handler: async function (payment) {
        checkoutOpen = false;
        paymentPending = true;

        setBusy(true);
        showMessage("Verifying your payment...");

        try {
          const result = await verifyPayment(
            fileId,
            payment
          );

          if (!result.verified) {
            throw new Error(
              "Payment verification unsuccessful"
            );
          }

          paymentCompleted = true;
          paymentPending = false;

          showMessage(
            "Payment verified successfully! " +
            "Your document is ready for the print agent."
          );

        } catch (error) {
          // Do not allow a second payment while
          // verification status is uncertain.
          paymentPending = true;

          showMessage(
            "Payment confirmation pending. " +
            "Do not pay again. " +
            error.message
          );

        } finally {
          setBusy(false);
        }
      },

      modal: {
        ondismiss: function () {
          checkoutOpen = false;
          setBusy(false);

          if (!paymentPending && !paymentCompleted) {
            showMessage(
              "Checkout closed. No payment confirmed."
            );
          }
        }
      }
    };

    const checkout = new Razorpay(options);

    checkout.on("payment.failed", function (response) {
      checkoutOpen = false;

      showMessage(
        "Payment failed: " +
        (
          response.error?.description ||
          "Please try again."
        )
      );

      setBusy(false);
    });

    checkoutOpen = true;
    checkout.open();

    setBusy(false);

  } catch (error) {
    checkoutOpen = false;
    showMessage(error.message);
    setBusy(false);
  }
});

// Initial screen
updateEstimate();

# ETAWAH CAFE — Professional Self Print Website

A responsive website for ETAWAH CAFE. This first release is intentionally prepared for website hosting and review before payment integration.

## Included
- Professional responsive design for mobile, tablet and desktop
- ETAWAH CAFE logo and branding
- Owner: Kapil Kumar
- Address: Infront of Shiv Mandir, Idgah, Etawah
- Contact: 9997881913
- PDF upload and server-side page counting (PDF up to 15 MB; 1–500 pages)
- Print type and copies selection
- Progressive rate calculation:
  - Page 1: ₹5
  - Pages 2–5: ₹3 per page
  - Pages 6–10: ₹2 per page
  - Every page above 10: ₹1.50 per page
- Payment gateway is not connected in this release. The interface clearly marks payment as coming soon.

## Run locally
1. Install Node.js 18 or newer.
2. Extract the ZIP and open the `self-print-kiosk` folder in a terminal.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Hosting
This is a Node.js application, so use a hosting provider that supports Node.js applications and persistent file storage. Set the start command to `npm start`, use Node.js 18+, and make sure the host supports HTTPS and the app's upload directory. Do not deploy this version as a static-only site because PDF page counting uses the server endpoint `/api/upload`.

## Phase two: payment gateway
After the website is hosted and the public HTTPS URL is working, integrate Razorpay on the server side, configure its webhook, test payment verification in test mode, and only then enable payment and printing. Never place Razorpay secret keys in browser-side JavaScript or send them in chat.

## Shop details
- Shop: ETAWAH CAFE
- Owner: Kapil Kumar
- Phone: 9997881913
- Address: Infront of Shiv Mandir, Idgah, Etawah

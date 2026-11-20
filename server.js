const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { PDFDocument } = require("pdf-lib");
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({dest:UPLOAD_DIR,limits:{fileSize:15*1024*1024},fileFilter:(_req,file,cb)=>{
  const ok=file.mimetype==="application/pdf"&&path.extname(file.originalname).toLowerCase()===".pdf";
  cb(ok?null:new Error("Only PDF files are allowed."),ok);
}});
app.use(express.static(__dirname));
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"ETAWAH CAFE Self Print Kiosk",paymentsEnabled:false}));
app.post("/api/upload",upload.single("pdf"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Please choose a PDF file."});
  try{
    const pdf=await PDFDocument.load(fs.readFileSync(req.file.path),{ignoreEncryption:false});
    const pages=pdf.getPageCount();
    if(pages<1||pages>500)throw new Error("PDF must contain 1 to 500 pages.");
    const fileId=require("crypto").randomUUID();
    fs.renameSync(req.file.path,path.join(UPLOAD_DIR,`${fileId}.pdf`));
    res.json({fileId,pages,name:path.basename(req.file.originalname)});
  }catch(err){try{fs.unlinkSync(req.file.path)}catch{}res.status(400).json({error:err.message||"Could not read this PDF."})}
});
app.use((err,_req,res,_next)=>res.status(400).json({error:err.message||"Request failed"}));
app.listen(PORT,()=>console.log(`ETAWAH CAFE website running at http://localhost:${PORT}`));

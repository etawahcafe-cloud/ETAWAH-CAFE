const $ = id => document.getElementById(id);
let selectedFile = null, uploaded = null;
const money = n => "₹" + Number(n).toFixed(2);
const slabs = [{from:1,to:1,rate:5},{from:2,to:5,rate:3},{from:6,to:10,rate:2},{from:11,to:Infinity,rate:1.5}];
function calculateAmount(pages){return slabs.reduce((sum,s)=>sum+Math.max(0,Math.min(pages,s.to)-s.from+1)*s.rate,0)}
function updateEstimate(){
  const copies=Number($("copies").value), validCopies=Number.isInteger(copies)&&copies>=1&&copies<=20;
  const pages=uploaded&&validCopies?uploaded.pages*copies:0;
  $("copyCount").textContent=validCopies?copies:"—";
  $("pageCount").textContent=pages?pages:"—";
  $("total").textContent=pages&&pages<=500?money(calculateAmount(pages)):"₹0.00";
  if(uploaded&&pages>500)$("message").textContent="Maximum total print pages (including copies) is 500.";
  else if(!uploaded&&validCopies)$("message").textContent="Upload a PDF to calculate your estimate.";
}
$("year").textContent=new Date().getFullYear();
$("pdf").addEventListener("change",async e=>{
  selectedFile=e.target.files[0]||null;uploaded=null;$("message").textContent="";
  $("fileName").textContent=selectedFile?selectedFile.name:"No document selected";
  $("fileState").classList.toggle("has-file",!!selectedFile);
  $("pdfPages").textContent="—";
  if(!selectedFile){updateEstimate();return}
  if(selectedFile.type!=="application/pdf"&&!selectedFile.name.toLowerCase().endsWith(".pdf")){$("message").textContent="Please select a PDF file.";selectedFile=null;return updateEstimate()}
  if(selectedFile.size>15*1024*1024){$("message").textContent="PDF size must be 15 MB or less.";selectedFile=null;return updateEstimate()}
  $("message").textContent="Checking your PDF pages…";
  try{
    const fd=new FormData();fd.append("pdf",selectedFile);
    const response=await fetch("/api/upload",{method:"POST",body:fd}),data=await response.json();
    if(!response.ok)throw new Error(data.error||"Could not read this PDF.");
    uploaded=data;$("fileName").textContent=data.name;$("pdfPages").textContent=data.pages;
    $("fileState").classList.add("has-file");$("message").textContent="PDF checked successfully. Your estimate is ready.";
  }catch(err){$("message").textContent=err.message;$("fileState").classList.remove("has-file")}
  updateEstimate();
});
$("copies").addEventListener("input",updateEstimate);
$("printType").addEventListener("change",updateEstimate);

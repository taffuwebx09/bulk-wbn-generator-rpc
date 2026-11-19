async function refresh(){
 const x=await chrome.storage.local.get("activeJob"),j=x.activeJob;
 document.getElementById("job").textContent=j?JSON.stringify(j,null,2):"No active job.";
}
document.getElementById("refresh").addEventListener("click",refresh);refresh();setInterval(refresh,3000);
